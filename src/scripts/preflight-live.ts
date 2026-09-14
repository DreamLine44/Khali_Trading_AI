import { env, requireEnv } from "../config/env";
import * as fs from "fs";
import * as path from "path";
import { Mt5FileBridge } from "../core/ai-bridge/mt5-file-bridge";
import { MongoOrderStore } from "../database/order-store";
import { reconcileOrders } from "../execution/orders/reconciliation";
import { assertProductionModelQualityGates } from "../core/ai-bridge/model-quality-gate";

async function main(): Promise<void> {
  if (env.tradingMode !== "live" || env.nodeEnv !== "production" || !env.liveTradingEnabled) {
    throw new Error("preflight requires NODE_ENV=production, TRADING_MODE=live and LIVE_TRADING_ENABLED=true");
  }
  if (!env.aiEnabled || env.modelStage !== "production") throw new Error("live preflight requires AI_ENABLED=true and MODEL_STAGE=production");
  if (!env.mt5Symbol || !env.mt5Timeframe) throw new Error("live preflight requires explicit MT5_SYMBOL and MT5_TIMEFRAME for model identity");
  if (env.liveActivationToken.length < 32) throw new Error("LIVE_ACTIVATION_TOKEN is missing or too short");
  if (!env.liveRequireEvidence) throw new Error("live preflight requires LIVE_REQUIRE_EVIDENCE=true");
  if (env.liveRequireEvidence && !(env.alphaVantageApiKey || env.newsEvidenceEndpoint)) throw new Error("live preflight: news/sentiment provider missing");
  if (env.liveRequireEvidence && !(env.economicApiKey || env.economicEvidenceEndpoint || env.finnhubApiKey)) throw new Error("live preflight: economic-calendar provider missing");

  const modelDir = path.join(env.appRoot, "models", "production");
  // `fs.Dirent` objects sort as "[object Dirent]" under the default
  // comparator, which is a no-op — every prior run of this script picked
  // an arbitrary, filesystem-order-dependent "latest" model rather than
  // the actual most recent one by filename. Sorting explicitly by name
  // is what makes `.at(-1)` correct for the zero-padded/timestamped
  // model filenames this project uses.
  const candidates = fs.readdirSync(modelDir, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.startsWith(`${env.mt5Symbol}_${env.mt5Timeframe}_`) && entry.name.endsWith(".joblib")).sort((a, b) => a.name.localeCompare(b.name));
  if (!candidates.length) throw new Error(`no production model for ${env.mt5Symbol}/${env.mt5Timeframe}`);
  const artifact = candidates.at(-1)!;
  const metadataPath = path.join(modelDir, artifact.name.replace(/\.joblib$/, ".json"));
  if (!fs.existsSync(metadataPath)) throw new Error("production model metadata sidecar is missing");
  const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
  const metrics = metadata.metrics ?? {};
  // [FIX-PREFLIGHT-PARITY] This script previously checked fewer gates than
  // run-mt5.ts enforces at actual live startup (identity match, edge over
  // the majority baseline, and Brier-vs-class-prior). A model could pass
  // this preflight with "ok: true" and then be rejected outright when
  // live trading actually starts — the opposite of what a preflight check
  // is for. Every gate here must mirror run-mt5.ts's production-model checks.
  if (!metadata || metadata.symbol !== env.mt5Symbol || metadata.timeframe !== env.mt5Timeframe) throw new Error("production model identity does not match configured symbol/timeframe");
  if (["dev-synthetic", "synthetic", "unknown", ""].includes(metadata.training_data_source)) throw new Error("production model has synthetic/unknown provenance");
  // [FIX-DRIFT-BASELINE] Mirrors the same check added to run-mt5.ts's live
  // startup path — see its comment for why this must be checked eagerly
  // here rather than only discovered on the first live prediction call.
  const preflightFeatureSchema = metadata.feature_schema;
  const preflightBaselineStats = metadata.feature_baseline_stats;
  if (!Array.isArray(preflightFeatureSchema) || !preflightBaselineStats || typeof preflightBaselineStats !== "object"
    || !preflightFeatureSchema.every((col: unknown) => typeof col === "string" && Object.prototype.hasOwnProperty.call(preflightBaselineStats, col))) {
    throw new Error("production model is missing feature_baseline_stats required for live drift monitoring");
  }
  // [AUDIT-FIX-GATE-PARITY] See model-quality-gate.ts for why this must be
  // the same shared check run-mt5.ts uses, not a locally re-typed subset.
  assertProductionModelQualityGates(metrics);

  const bridge = new Mt5FileBridge({ commonDirectory: requireEnv("mt5CommonDirectory"), secret: requireEnv("mt5BridgeSecret"), timeoutMs: env.mt5BridgeTimeoutMs, maxRequestAgeMs: env.mt5MaxRequestAgeMs });
  if (fs.existsSync(env.liveKillSwitchFile)) throw new Error(`live kill switch is active: ${env.liveKillSwitchFile}`);
  if (!(await bridge.isConnected(env.mt5MagicNumber, env.mt5AccountId, env.mt5Server))) throw new Error("MT5 bridge heartbeat failed or EA magic/account/server identity does not match");
  const store = new MongoOrderStore();
  try {
    await store.connect();
    const reconciliation = await reconcileOrders(bridge, store, env.mt5MagicNumber);
    if (!reconciliation.safe) throw new Error(`durable reconciliation failed: ${reconciliation.reasons.join("; ")}`);
  } finally {
    await store.close();
  }
  console.log(JSON.stringify({ ok: true, model: artifact.name, trainingSource: metadata.training_data_source, oosRows: metrics.final_oos_rows, oosAccuracy: metrics.oos_meta_accuracy, oosBrier: metrics.oos_meta_brier, mt5Magic: env.mt5MagicNumber }, null, 2));
}

main().catch((error) => {
  console.error("LIVE PREFLIGHT FAILED:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
