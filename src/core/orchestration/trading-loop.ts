import { AuditRecord, Candle, FeatureSet, ModelPrediction, Timeframe } from "../types";
import { MarketDataProvider } from "../market-data/providers/market-data-provider.interface";
import { validateCandles } from "../market-data/normalizers/candle-validator";
import { buildFeatureSet } from "../features/feature-engine";
import { makeDecision } from "../decision/decision-engine";
import { AccountState, evaluateRisk, RiskLimits } from "../risk/risk-engine";
import { env } from "../../config/env";
import { OrderManager } from "../../execution/orders/order-manager";
import { ExecutionAdapter } from "../../execution/adapters/execution-adapter.interface";
import { AuditLog } from "../../database/audit-log";
import { collectEvidence } from "../evidence/evidence-service";
import { EvidenceProvider } from "../evidence/provider";
import { AutomaticMarketDataOrchestrator } from "../market-data/automatic-market-data-orchestrator";

export interface TradingLoopDeps {
  dataProvider: MarketDataProvider;
  executionAdapter: ExecutionAdapter;
  orderManager: OrderManager;
  auditLog: AuditLog;
  riskLimits?: RiskLimits;
  predictionProvider?: (features: FeatureSet, candles: Candle[]) => Promise<ModelPrediction[]>;
  evidenceProviders?: EvidenceProvider[];
  existingManagedSymbol?: boolean;
  historyBars?: number;
  automaticMarketData?: AutomaticMarketDataOrchestrator;
}

/**
 * One full pass of the pipeline for a single symbol/timeframe:
 *   data -> validation -> features -> (placeholder) predictions ->
 *   decision -> risk -> order -> execution -> audit
 *
 * This is the vertical slice from spec section 36, minus the real AI
 * models and real news/sentiment inputs — those plug in as additional
 * evidence feeding `predictions` and the decision engine without
 * changing this control flow.
 */
export async function runOnce(
  symbol: string,
  timeframe: Timeframe,
  account: AccountState,
  deps: TradingLoopDeps,
  predictions: ModelPrediction[] = []
): Promise<AuditRecord> {
  const notes: string[] = [];

  if (deps.executionAdapter.isLive && env.tradingMode !== "live") {
    throw new Error("live execution adapter requires TRADING_MODE=live");
  }
  if (deps.executionAdapter.isLive && !env.liveTradingEnabled) {
    throw new Error("live execution is disabled by LIVE_TRADING_ENABLED");
  }
  if (deps.executionAdapter.isLive && !deps.predictionProvider) {
    throw new Error("live execution requires a real prediction provider");
  }
  if (deps.executionAdapter.isLive && deps.existingManagedSymbol) {
    notes.push("managed position already exists for this symbol — no additional entry");
    const record = emptyAudit(symbol, timeframe, notes);
    await deps.auditLog.append(record);
    return record;
  }

  if (deps.executionAdapter.isLive && deps.dataProvider.isDevProvider) {
    throw new Error("refusing to run: live execution adapter paired with a dev/synthetic data provider");
  }

  const connected = await deps.dataProvider.isConnected();
  if (!connected) {
    notes.push("data provider not connected — no new trade");
    const record = emptyAudit(symbol, timeframe, notes);
    await deps.auditLog.append(record);
    return record;
  }

  // [FIX-ENTRY-LATENCY-PARALLEL-FETCH] Candle history, supplementary
  // market-data refresh, and evidence collection are three independent I/O
  // operations — none of their inputs depend on either of the other two's
  // output (evidence and the market-data refresh only need `symbol`/
  // `timeframe`, not the candles themselves). They previously ran strictly
  // one after another, adding each one's latency on top of the others on
  // every single cycle, on top of the MT5 bridge's own inherent per-request
  // latency (see mt5-file-bridge.ts). Fetching them concurrently bounds
  // this section to roughly the single slowest of the three. Neither
  // automaticMarketData.refresh() nor collectEvidence() ever rejects (both
  // catch per-source failures internally and report them via their return
  // value), so a getHistoricalCandles() rejection here still propagates
  // exactly as before — Promise.all rejects as soon as any input does — and
  // the other two simply finish in the background with their results
  // discarded, matching the prior fail-fast behavior for a genuine data
  // provider outage.
  const [candles, research, evidence] = await Promise.all([
    deps.dataProvider.getHistoricalCandles(symbol, timeframe, deps.historyBars ?? 200),
    deps.automaticMarketData ? deps.automaticMarketData.refresh(symbol, timeframe) : Promise.resolve(null),
    deps.evidenceProviders ? collectEvidence(symbol, deps.evidenceProviders) : Promise.resolve(undefined),
  ]);

  // Supplementary market-data providers are acquired autonomously. Their
  // output is never used as execution truth; MT5 remains authoritative.
  // Failures are surfaced in the audit trail and only become fatal when the
  // configured orchestrator explicitly requires them.
  if (research) {
    if (research.failures.length > 0) {
      notes.push(`automatic supplementary market-data failures: ${research.failures.join("; ")}`);
      if (env.autoResearchRequired && deps.executionAdapter.isLive) {
        return await appendNoTradeAudit(symbol, timeframe, notes, deps);
      }
    }
    if (research.snapshots.length > 0) {
      notes.push(`automatic supplementary market-data refreshed: ${research.snapshots.map((s) => s.provider).join(", ")}`);
    }
  }
  const dataQuality = validateCandles(symbol, timeframe, candles);
  const baseFeatures = buildFeatureSet(symbol, timeframe, candles, dataQuality);
  const features = evidence ? { ...baseFeatures, evidence } : baseFeatures;

  let effectivePredictions = predictions;
  if (effectivePredictions.length === 0 && deps.predictionProvider) {
    try {
      effectivePredictions = await deps.predictionProvider(features, candles);
    } catch (error) {
      notes.push(`model unavailable — no new trade: ${error instanceof Error ? error.message : String(error)}`);
      effectivePredictions = [];
    }
  }
  const decision = makeDecision(features, effectivePredictions);

  let risk = evaluateRisk(decision, features, account, 0, 0, deps.riskLimits);
  // [FIX-PAPER-FILL] Captured whenever a valid quote is available so a
  // paper-mode fill can be simulated at a real price (see order-manager.ts).
  let orderReferencePrice: number | null = null;
  if (decision.action === "BUY" || decision.action === "SELL") {
    const quote = await deps.dataProvider.getLatestQuote(symbol);
    const quoteValid = quote.symbol === symbol
      && Number.isFinite(quote.timestampUtc)
      && quote.timestampUtc <= Date.now()
      && Date.now() - quote.timestampUtc <= env.quoteMaxAgeMs
      && Number.isFinite(quote.bid)
      && Number.isFinite(quote.ask)
      && Number.isFinite(quote.spread)
      && quote.bid > 0
      && quote.ask >= quote.bid
      && quote.spread >= 0;
    if (!quoteValid) {
      risk = {
        approved: false,
        reasons: ["invalid or inconsistent market quote"],
        maxPositionSize: null,
        stopLossPrice: null,
        takeProfitPrice: null,
      };
    } else {
      const entryPriceRef = decision.action === "SELL" ? quote.bid : quote.ask;
      orderReferencePrice = entryPriceRef;

      // If compatible supplementary providers are configured, automatically
      // cross-check their latest quotes against MT5. This does NOT replace
      // broker-authoritative pricing; it is a data-integrity circuit breaker.
      let crosscheckRejected = false;
      if (deps.automaticMarketData?.enabled && env.autoResearchCrosscheck) {
        const researchQuotes = deps.automaticMarketData.getCompatibleQuotes(symbol, timeframe);
        const outliers = researchQuotes.filter((researchQuote) => {
          const researchMid = (researchQuote.bid + researchQuote.ask) / 2;
          const mt5Mid = (quote.bid + quote.ask) / 2;
          return mt5Mid > 0 && Math.abs(researchMid - mt5Mid) / mt5Mid > env.autoResearchMaxQuoteDeviationPct;
        });
        if (outliers.length > 0) {
          crosscheckRejected = true;
          risk = {
            approved: false,
            reasons: [`supplementary market-data cross-check failed: ${outliers.length} provider quote(s) deviate beyond ${env.autoResearchMaxQuoteDeviationPct * 100}% from MT5`],
            maxPositionSize: null,
            stopLossPrice: null,
            takeProfitPrice: null,
          };
        }
      }

      // [FIX-ATR-NULL-GUARD] `features.atr14 as number` below was a type
      // cast, not a runtime check. decision-engine.ts's invalidFeature scan
      // only rejects atr14 when it is present AND non-finite (NaN/Infinity);
      // a genuinely null atr14 (e.g. insufficient warmup history) passes
      // that check and reaches here. `null * 1.5` silently evaluates to 0 in
      // JS, so this would have computed a degenerate stop reference equal to
      // entryPriceRef itself and handed it to the broker/getTradingSpec call
      // — still caught downstream by risk-engine's own explicit `atr14 ===
      // null` rejection, but only after an unnecessary broker round-trip and
      // with a misleading "broker trading specification unavailable" reason
      // in the audit trail instead of the real one. Same audit-trail-honesty
      // concern as the crosscheck-ordering fix immediately above; fail
      // closed here directly instead of relying on the downstream net.
      let tradingSpec;
      if (features.atr14 === null || !Number.isFinite(features.atr14)) {
        risk = { approved: false, reasons: ["ATR unavailable — cannot size stop distance for broker trading spec"], maxPositionSize: null, stopLossPrice: null, takeProfitPrice: null };
      } else if (!crosscheckRejected) {
        const atr14 = features.atr14;
        try {
          tradingSpec = deps.dataProvider.getTradingSpec
            ? await deps.dataProvider.getTradingSpec(symbol, decision.action, entryPriceRef, decision.action === "BUY" ? entryPriceRef - atr14 * 1.5 : entryPriceRef + atr14 * 1.5)
            : undefined;
          if (deps.executionAdapter.isLive && !tradingSpec) throw new Error("broker trading specification is unavailable");
        } catch (error) {
          risk = { approved: false, reasons: [`broker trading specification unavailable: ${error instanceof Error ? error.message : String(error)}`], maxPositionSize: null, stopLossPrice: null, takeProfitPrice: null };
          tradingSpec = undefined;
        }
        if (tradingSpec || !deps.executionAdapter.isLive) {
          risk = evaluateRisk(decision, features, account, quote.spread, entryPriceRef, deps.riskLimits, tradingSpec);
        }
      }
    }
  }

  const order = await deps.orderManager.createOrderFromDecision(decision, risk, orderReferencePrice);
  let executionResult: unknown = null;

  if (order) {
    await deps.orderManager.transition(order.id, "VALIDATING");
    await deps.orderManager.transition(order.id, "APPROVED");
    await deps.orderManager.transition(order.id, "SUBMITTED");
    const result = await deps.executionAdapter.submitOrder(order);
    executionResult = result;
    // [FIX-PAPER-FILL] Previously this exempted non-live adapters from the
    // filledPrice check, so a paper "success" with filledPrice: null passed
    // confirmation, got transitioned to CONFIRMED/FILLED, but never had
    // recordExecution() called (guarded separately below on filledPrice !==
    // null) — leaving FILLED orders with no recorded brokerOrderId/price/
    // volume. Both paper and live adapters must now report a real fill.
    const confirmationValid = result.success
      && typeof result.brokerOrderId === "string"
      && result.brokerOrderId.length > 0
      && Number.isFinite(result.filledPrice) && result.filledPrice !== null && result.filledPrice > 0
      && Number.isFinite(result.filledVolume)
      && result.filledVolume !== null
      && result.filledVolume > 0
      && result.filledVolume <= order.volume;
    if (confirmationValid && result.brokerOrderId && result.filledPrice !== null && result.filledVolume !== null) {
      await deps.orderManager.recordExecution(order.id, {
        brokerOrderId: result.brokerOrderId,
        filledPrice: result.filledPrice,
        filledVolume: result.filledVolume,
      });
    }
    await deps.orderManager.transition(order.id, confirmationValid ? "CONFIRMED" : "FAILED");
    // [FIX-ENTRY-RETRY] Only a FAILED order needs a retry classification —
    // record it right after the state transition so a later cycle's
    // createOrderFromDecision() for this same decision can see it. See
    // ExecutionResult.retryable for what makes a failure safe to retry.
    if (!confirmationValid) {
      await deps.orderManager.recordFailureClassification(order.id, result.retryable === true);
    }
    if (confirmationValid && result.filledVolume === order.volume) {
      await deps.orderManager.transition(order.id, "FILLED");
    } else if (confirmationValid) {
      await deps.orderManager.transition(order.id, "PARTIALLY_FILLED");
    }
  } else {
    notes.push(risk.approved ? "no order: decision was not an entry action" : `no order: risk rejected (${risk.reasons.join("; ")})`);
  }

  const record: AuditRecord = {
    decision,
    risk,
    order: order ?? null,
    executionResult,
    notes,
  };
  await deps.auditLog.append(record);
  return record;
}

async function appendNoTradeAudit(symbol: string, timeframe: Timeframe, notes: string[], deps: TradingLoopDeps): Promise<AuditRecord> {
  const record = emptyAudit(symbol, timeframe, notes);
  await deps.auditLog.append(record);
  return record;
}

function emptyAudit(symbol: string, timeframe: Timeframe, notes: string[]): AuditRecord {
  const now = Date.now();
  return {
    decision: {
      id: `dec_${symbol}_${timeframe}_${now}`,
      symbol,
      timeframe,
      createdAtUtc: now,
      action: "NO_TRADE",
      confidence: 0,
      reasons: notes,
      predictions: [],
      featureSetRef: {
        symbol,
        timeframe,
        asOfUtc: now,
        sma20: null,
        ema20: null,
        rsi14: null,
        atr14: null,
        swingHigh: null,
        swingLow: null,
        adx14: null,
        swingHighDist: null,
        swingLowDist: null,
        bosBull: null,
        bosBear: null,
        rangePct: null,
        htfTrend: null,
        wma20: null,
        macd: null,
        macdSignal: null,
        macdHistogram: null,
        stochasticK: null,
        stochasticD: null,
        roc12: null,
        bollingerWidth: null,
        bollingerPercentB: null,
        historicalVolatility20: null,
        vwap20: null,
        obv: null,
        structureTrend: "UNKNOWN",
        higherHigh: 0,
        higherLow: 0,
        lowerHigh: 0,
        lowerLow: 0,
        chochBull: 0,
        chochBear: 0,
        candlestickPatterns: [],
        regime: "UNKNOWN",
        regimeConfidence: 0,
        dataQuality: { ok: false, issues: notes, checkedAt: now },
      },
    },
    risk: { approved: false, reasons: notes, maxPositionSize: null, stopLossPrice: null, takeProfitPrice: null },
    order: null,
    executionResult: null,
    notes,
  };
}
