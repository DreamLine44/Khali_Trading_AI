import { env, requireEnv } from "../config/env";
import * as fs from "fs";
import * as path from "path";
import { Mt5FileBridge } from "../core/ai-bridge/mt5-file-bridge";
import { getPythonModelPrediction } from "../core/ai-bridge/python-model-bridge";
import { Mt5MarketDataProvider } from "../core/market-data/providers/mt5-market-data.provider";
import { Mt5ExecutionAdapter } from "../execution/adapters/mt5/mt5-execution.adapter";
import { PaperExecutionAdapter } from "../execution/adapters/paper/paper-execution.adapter";
import { OrderManager } from "../execution/orders/order-manager";
import { MongoAuditLog } from "../database/audit-log";
import { runOnce } from "../core/orchestration/trading-loop";
import { Timeframe } from "../core/types";
import { MongoOrderStore } from "../database/order-store";
import { MongoAccountStore } from "../database/account-store";
import { reconcileOrders } from "../execution/orders/reconciliation";
import { AuthorizedHttpEvidenceProvider } from "../core/evidence/authorized-http-provider";
import { AlphaVantageNewsProvider } from "../core/evidence/providers/alpha-vantage-news.provider";
import { TradingEconomicsCalendarProvider } from "../core/evidence/providers/trading-economics-calendar.provider";
import { FinnhubEconomicCalendarProvider } from "../core/evidence/providers/finnhub-economic-calendar.provider";
import { CachedEvidenceProvider } from "../core/evidence/cached-evidence-provider";
import { toModelFeatureRow } from "../core/features/feature-vector";
import { writeRuntimeStatus, writeCycleFailureStatus } from "../core/monitoring/runtime-status";
import { AutomaticMarketDataOrchestrator } from "../core/market-data/automatic-market-data-orchestrator";
import { assertProductionModelQualityGates } from "../core/ai-bridge/model-quality-gate";
import { DriftMonitor, checkFeatureDrift } from "../core/monitoring/drift-monitor";

function timeframe(value: string): Timeframe {
  if (!["M1", "M5", "M15", "H1", "H4", "D1"].includes(value)) throw new Error(`unsupported MT5_TIMEFRAME: ${value}`);
  return value as Timeframe;
}

async function main(): Promise<void> {
  const mode = env.tradingMode;
  if (mode !== "paper" && mode !== "live") {
    throw new Error("run:mt5 requires TRADING_MODE=paper or TRADING_MODE=live");
  }
  if (mode === "live") {
    if (env.nodeEnv !== "production" || !env.liveTradingEnabled || env.liveActivationToken.length < 32) {
      throw new Error("live activation requires NODE_ENV=production, LIVE_TRADING_ENABLED=true and a valid LIVE_ACTIVATION_TOKEN");
    }
    if (!env.aiEnabled || env.modelStage !== "production") {
      throw new Error("live activation requires AI_ENABLED=true and MODEL_STAGE=production");
    }
    const modelDir = path.join(env.appRoot, "models", "production");
    // Same fix as preflight-live.ts: `fs.Dirent` objects sort as
    // "[object Dirent]" under the default comparator (a no-op), so this
    // must sort explicitly by filename to actually select the latest
    // artifact rather than an arbitrary filesystem-order one.
    const modelCandidates = fs.readdirSync(modelDir, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.startsWith(`${env.mt5Symbol}_${env.mt5Timeframe}_`) && entry.name.endsWith(".joblib")).sort((a, b) => a.name.localeCompare(b.name));
    if (modelCandidates.length === 0) throw new Error(`no production model artifact exists for ${env.mt5Symbol}/${env.mt5Timeframe}`);
    const latestModel = modelCandidates.at(-1)!;
    const metadataPath = path.join(modelDir, latestModel.name.replace(/\.joblib$/, ".json"));
    if (!fs.existsSync(metadataPath)) throw new Error("production model metadata sidecar is missing");
    const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
    const metrics = metadata?.metrics ?? {};
    if (!metadata || metadata.symbol !== env.mt5Symbol || metadata.timeframe !== env.mt5Timeframe) throw new Error("production model identity does not match configured symbol/timeframe");
    if (["dev-synthetic", "synthetic", "unknown", ""].includes(String(metadata.training_data_source ?? ""))) throw new Error("production model has synthetic/unknown training provenance");
    // [FIX-DRIFT-BASELINE] Mirrors model_loader.py's production-stage gate:
    // without feature_baseline_stats, DriftMonitor has nothing to compare
    // live features against, and predictionProvider (below) fails closed on
    // exactly that. Checking it here at startup, rather than discovering it
    // only on the first prediction call, matches how every other production
    // gate in this block is checked eagerly rather than deferred.
    const productionFeatureSchema = metadata.feature_schema;
    const productionBaselineStats = metadata.feature_baseline_stats;
    if (!Array.isArray(productionFeatureSchema) || !productionBaselineStats || typeof productionBaselineStats !== "object"
      || !productionFeatureSchema.every((col: unknown) => typeof col === "string" && Object.prototype.hasOwnProperty.call(productionBaselineStats, col))) {
      throw new Error("production model is missing feature_baseline_stats required for live drift monitoring");
    }
    // [AUDIT-FIX-GATE-PARITY] See model-quality-gate.ts for why this must be
    // the same shared check preflight-live.ts uses, not a locally re-typed
    // subset that can silently drift weaker over time.
    assertProductionModelQualityGates(metrics);
  }

  const symbol = env.mt5Symbol;
  const selectedTimeframe = timeframe(env.mt5Timeframe);
  const historyBars = { M1: 1500, M5: 400, M15: 250, H1: 120, H4: 120, D1: 120 }[selectedTimeframe];
  const commonDirectory = requireEnv("mt5CommonDirectory");
  const bridgeSecret = requireEnv("mt5BridgeSecret");
  const bridge = new Mt5FileBridge({ commonDirectory, secret: bridgeSecret, timeoutMs: env.mt5BridgeTimeoutMs, maxRequestAgeMs: env.mt5MaxRequestAgeMs });
  const provider = new Mt5MarketDataProvider({
    accountId: requireEnv("mt5AccountId"),
    server: requireEnv("mt5Server"),
    commonDirectory,
    bridgeSecret,
    timeoutMs: env.mt5BridgeTimeoutMs,
    maxRequestAgeMs: env.mt5MaxRequestAgeMs,
    magicNumber: env.mt5MagicNumber,
  });

  if (!(await bridge.isConnected(env.mt5MagicNumber, requireEnv("mt5AccountId"), requireEnv("mt5Server")))) throw new Error("MT5 EA bridge is not connected or MT5 magic/account/server identity does not match configured values");

  const accountStore = new MongoAccountStore();
  const orderStore = new MongoOrderStore();
  const auditLog = new MongoAuditLog();
  const accountId = requireEnv("mt5AccountId");

  const configuredEvidenceProviders = [
    env.deltaEvidenceEndpoint ? new AuthorizedHttpEvidenceProvider({ name: "delta", endpoint: env.deltaEvidenceEndpoint, apiKey: env.deltaApiKey, required: false }) : null,
    env.binanceEvidenceEndpoint ? new AuthorizedHttpEvidenceProvider({ name: "binance", endpoint: env.binanceEvidenceEndpoint, apiKey: env.binanceEvidenceApiKey, required: false }) : null,
    env.newsEvidenceEndpoint ? new AuthorizedHttpEvidenceProvider({ name: "news", endpoint: env.newsEvidenceEndpoint, apiKey: env.newsApiKey, required: true }) : null,
    env.economicEvidenceEndpoint ? new AuthorizedHttpEvidenceProvider({ name: "economic-calendar", endpoint: env.economicEvidenceEndpoint, apiKey: env.economicApiKey, required: true }) : null,
    env.alphaVantageApiKey ? new AlphaVantageNewsProvider({ apiKey: env.alphaVantageApiKey }) : null,
    env.economicApiKey ? new TradingEconomicsCalendarProvider({ apiKey: env.economicApiKey }) : null,
    // Free-tier alternative to the paid Trading Economics key — runs
    // alongside it (not instead of) when both are configured, since
    // evidence-aggregator.ts already combines all fresh sources rather
    // than requiring exactly one per category.
    env.finnhubApiKey ? new FinnhubEconomicCalendarProvider({ apiKey: env.finnhubApiKey }) : null,
  ].filter((provider): provider is NonNullable<typeof provider> => provider !== null);

  if (mode === "live" && env.liveRequireEvidence) {
    const hasNews = Boolean(env.alphaVantageApiKey || env.newsEvidenceEndpoint);
    const hasEconomic = Boolean(env.economicApiKey || env.economicEvidenceEndpoint || env.finnhubApiKey);
    if (!hasNews || !hasEconomic) {
      throw new Error("live activation requires both a news/sentiment provider and an economic-calendar provider");
    }
  }
  const evidenceProviders = configuredEvidenceProviders.length > 0
    ? configuredEvidenceProviders.map((provider) => new CachedEvidenceProvider(
        provider,
        provider.name.includes("economic") ? env.economicRefreshIntervalMs : env.newsRefreshIntervalMs,
      ))
    : undefined;
  const automaticMarketData = new AutomaticMarketDataOrchestrator();

  const executionAdapter = mode === "live" ? new Mt5ExecutionAdapter(bridge) : new PaperExecutionAdapter();
  const orderManager = new OrderManager(orderStore, mode);
  const driftMonitor = new DriftMonitor();
  const predictionProvider = async (
    features: Parameters<NonNullable<Parameters<typeof runOnce>[3]["predictionProvider"]>>[0],
    candles: Parameters<NonNullable<Parameters<typeof runOnce>[3]["predictionProvider"]>>[1],
  ) => {
    const deterministic = buildNonMlPrediction(features);
    if (!env.aiEnabled) {
      if (mode === "live") throw new Error("AI_ENABLED=false is forbidden in live mode");
      return [deterministic];
    }
    const latest = candles.filter((c) => c.isClosed).at(-1);
    if (!latest) return [];
    const row = toModelFeatureRow(features, latest.close);
    if (!row) return [];
    const stage = env.modelStage as "development" | "staging" | "production";
    const mlPrediction = await getPythonModelPrediction(stage, symbol, selectedTimeframe, row, env.aiMode);
    // [FIX-DRIFT-WIRING] DriftMonitor previously existed but was never
    // called anywhere in the live pipeline. A production model's
    // feature_baseline_stats (required by model_loader.py) captures the
    // distribution the model was actually trained on; comparing today's
    // live feature row against it catches the case where the market has
    // moved into a regime the model never saw, which the model's own
    // probability/uncertainty output cannot detect on its own (a
    // confidently wrong prediction still looks confident). Fails closed
    // the same way a missing/invalid prediction already does, via the
    // existing catch in trading-loop.ts — this never silently downgrades
    // to "trade anyway". See checkFeatureDrift() for the exact, unit-tested
    // gate logic.
    const drift = checkFeatureDrift(driftMonitor, mlPrediction.featureBaselineStats, row, mode === "live");
    if (!drift.ok) throw new Error(drift.reason);
    return env.aiMode === "hybrid" ? [mlPrediction, deterministic] : [mlPrediction];
  };

  const riskLimits = {
    maxRiskPerTradePct: env.riskMaxPerTradePct,
    maxOpenPositions: env.riskMaxOpenPositions,
    maxDailyLossPct: env.riskMaxDailyLossPct,
    maxDrawdownPct: env.riskMaxDrawdownPct,
    maxSpreadAsAtrFraction: env.riskMaxSpreadAtrFraction,
  };

  let stopping = false;
  let consecutiveCycleErrors = 0;
  const maxConsecutiveCycleErrors = 3;
  const stop = () => { stopping = true; };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  try {
    await accountStore.connect();
    await orderStore.connect();
    await auditLog.connect();

    const initialReconciliation = await reconcileOrders(bridge, orderStore, env.mt5MagicNumber);
    if (!initialReconciliation.safe) throw new Error(`MT5 reconciliation failed: ${initialReconciliation.reasons.join("; ")}`);

    while (!stopping) {
      try {
        if (!(await bridge.isConnected(env.mt5MagicNumber, env.mt5AccountId, env.mt5Server))) throw new Error("MT5 heartbeat failed or EA magic/account/server identity changed");
        const snapshot = await bridge.getAccount();
        const currentAccount = await accountStore.enrich(accountId, snapshot.account);
        await accountStore.record(accountId, currentAccount);

        const reconciliation = await reconcileOrders(bridge, orderStore, env.mt5MagicNumber);
        if (!reconciliation.safe) throw new Error(`MT5 reconciliation failed: ${reconciliation.reasons.join("; ")}`);

        if (fs.existsSync(env.liveKillSwitchFile)) {
          console.error("LIVE KILL SWITCH ACTIVE: new entries are disabled");
          await new Promise((resolve) => setTimeout(resolve, env.mt5PollIntervalMs));
          continue;
        }

        const existingManagedSymbol = reconciliation.managedPositions.some((position) => position.symbol === symbol);
        const record = await runOnce(symbol, selectedTimeframe, currentAccount, {
          dataProvider: provider,
          executionAdapter,
          orderManager,
          auditLog,
          riskLimits,
          evidenceProviders,
          predictionProvider,
          existingManagedSymbol,
          historyBars,
          automaticMarketData,
        });
        writeRuntimeStatus(record, mode);
        console.log(JSON.stringify(record));
        consecutiveCycleErrors = 0;
      } catch (error) {
        consecutiveCycleErrors += 1;
        const message = error instanceof Error ? error.message : String(error);
        console.error(`MT5 cycle failed closed (${consecutiveCycleErrors}/${maxConsecutiveCycleErrors}): ${message}`);
        // [FIX-CYCLE-FAILURE-VISIBILITY] Previously, when runOnce() itself
        // threw (as opposed to a prediction/execution failure captured
        // inside a normal AuditRecord), nothing was written anywhere: the
        // dashboard's /api/status kept serving the last healthy snapshot
        // indefinitely, and monitor.ts (which only polls Mongo audit
        // records) had no record to alert on. The single worst failure
        // mode — the bot process stuck or repeatedly crashing before it
        // can even produce a decision — was invisible to both tools meant
        // to catch it. Write an honest unhealthy status directly here so
        // both surfaces reflect reality.
        try {
          writeCycleFailureStatus(mode, message, consecutiveCycleErrors);
        } catch (statusWriteError) {
          console.error(`failed to record cycle-failure status: ${statusWriteError instanceof Error ? statusWriteError.message : String(statusWriteError)}`);
        }
        if (consecutiveCycleErrors >= maxConsecutiveCycleErrors) {
          console.error("MT5 safety circuit breaker tripped after consecutive cycle failures; stopping new-trade process");
          stopping = true;
        }
      }
      if (!stopping) await new Promise((resolve) => setTimeout(resolve, env.mt5PollIntervalMs));
    }
  } finally {
    await auditLog.close();
    await orderStore.close();
    await accountStore.close();
  }
}
function buildNonMlPrediction(features: Parameters<NonNullable<Parameters<typeof runOnce>[3]["predictionProvider"]>>[0]) {
  const bullish = [
    features.structureTrend === "BULLISH",
    features.bosBull === 1,
    features.chochBull === 1,
    (features.macdHistogram ?? 0) > 0,
    (features.roc12 ?? 0) > 0,
    features.htfTrend !== null && features.htfTrend > 0,
  ].filter(Boolean).length;
  const bearish = [
    features.structureTrend === "BEARISH",
    features.bosBear === 1,
    features.chochBear === 1,
    (features.macdHistogram ?? 0) < 0,
    (features.roc12 ?? 0) < 0,
    features.htfTrend !== null && features.htfTrend < 0,
  ].filter(Boolean).length;
  const total = Math.max(1, bullish + bearish);
  if (bullish === bearish || Math.max(bullish, bearish) < 2) {
    return { modelName: "deterministic-market-analysis", modelVersion: "rules-v1", action: "HOLD" as const, probability: 0.5, uncertainty: 0.5 };
  }
  const action = bullish > bearish ? "BUY" as const : "SELL" as const;
  const probability = Math.min(0.95, 0.55 + (Math.max(bullish, bearish) / total) * 0.35);
  return { modelName: "deterministic-market-analysis", modelVersion: "rules-v1", action, probability, uncertainty: 1 - probability };
}

main().catch((error) => {
  console.error("MT5 run failed:", error);
  throw error;
});