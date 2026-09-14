import * as assert from "assert";
import { makeDecision } from "../../src/core/decision/decision-engine";
import { validateCandles } from "../../src/core/market-data/normalizers/candle-validator";
import { evaluateRisk, DEFAULT_RISK_LIMITS } from "../../src/core/risk/risk-engine";
import { env } from "../../src/config/env";
import { Candle, FeatureSet } from "../../src/core/types";

const now = Date.now();

function featureSet(overrides: Partial<FeatureSet> = {}): FeatureSet {
  return {
    symbol: "EURUSD",
    timeframe: "M15",
    asOfUtc: now,
    sma20: 1.1,
    ema20: 1.1,
    rsi14: 50,
    atr14: 0.001,
    swingHigh: 1.11,
    swingLow: 1.09,
    adx14: 20,
    swingHighDist: 0.003,
    swingLowDist: 0.003,
    bosBull: 0,
    bosBear: 0,
    rangePct: 0.006,
    htfTrend: 0,
    wma20: 1.1,
    macd: 0,
    macdSignal: 0,
    macdHistogram: 0,
    stochasticK: 50,
    stochasticD: 50,
    roc12: 0,
    bollingerWidth: 0.01,
    bollingerPercentB: 0.5,
    historicalVolatility20: 0.1,
    vwap20: 1.1,
    obv: 0,
    structureTrend: "RANGE",
    higherHigh: 0,
    higherLow: 0,
    lowerHigh: 0,
    lowerLow: 0,
    chochBull: 0,
    chochBear: 0,
    candlestickPatterns: [],
    regime: "RANGING",
    regimeConfidence: 0.8,
    dataQuality: { ok: true, issues: [], checkedAt: now },
    ...overrides,
  };
}

function candle(timestampUtc: number, overrides: Partial<Candle> = {}): Candle {
  return {
    symbol: "EURUSD",
    timeframe: "M15",
    timestampUtc,
    open: 1.1,
    high: 1.101,
    low: 1.099,
    close: 1.1005,
    volume: 100,
    isClosed: true,
    ...overrides,
  };
}

function testInvalidMarketDataIsRejected() {
  const report = validateCandles("EURUSD", "M15", [candle(now - 15 * 60_000), candle(Number.NaN)]);
  assert.strictEqual(report.ok, false);
  assert.ok(report.issues.some((issue) => issue.includes("non-finite timestamp")));

  const openReport = validateCandles("EURUSD", "M15", [candle(now - 15 * 60_000), candle(now, { isClosed: false })], { now });
  assert.strictEqual(openReport.ok, false);
  assert.ok(openReport.issues.some((issue) => issue.includes("not closed")));
}

function testInvalidPredictionIsRejected() {
  const decision = makeDecision(featureSet(), [{
    modelName: "model",
    modelVersion: "1",
    action: "BUY",
    probability: Number.NaN,
    uncertainty: 0.1,
  }]);
  assert.strictEqual(decision.action, "NO_TRADE");
  assert.strictEqual(decision.confidence, 0);
}

function testInvalidRiskInputsAreRejected() {
  const decision = makeDecision(featureSet({
    structureTrend: "BULLISH",
    macdHistogram: 0.001,
  }), [{
    modelName: "model",
    modelVersion: "1",
    action: "BUY",
    probability: 0.9,
    uncertainty: 0.05,
  }]);
  const result = evaluateRisk(decision, featureSet(), {
    balance: 10_000,
    equity: Number.NaN,
    freeMargin: 5_000,
    openPositionsCount: 0,
    dailyLossPct: 0,
    currentDrawdownPct: 0,
  }, 0.0001, 1.1);
  assert.strictEqual(result.approved, false);
  assert.ok(result.reasons.some((reason) => reason.includes("balance/equity")));
}

function testDirectionalEntriesNeedConfluenceAndRoom() {
  const prediction = [{
    modelName: "model",
    modelVersion: "1",
    action: "SELL" as const,
    probability: 0.9,
    uncertainty: 0.05,
  }];
  const noConfluence = makeDecision(featureSet({ htfTrend: -0.01 }), prediction);
  assert.strictEqual(noConfluence.action, "NO_TRADE");
  assert.ok(noConfluence.reasons.some((reason) => reason.includes("insufficient market confluence")));

  const tooCloseToSupport = makeDecision(featureSet({
    htfTrend: -0.01,
    structureTrend: "BEARISH",
    macdHistogram: -0.001,
    swingLowDist: 0.0001,
    rangePct: 0.006,
  }), prediction);
  assert.strictEqual(tooCloseToSupport.action, "NO_TRADE");
  assert.ok(tooCloseToSupport.reasons.some((reason) => reason.includes("opposing structure")));

  const alignedPullback = makeDecision(featureSet({
    htfTrend: -0.01,
    structureTrend: "BEARISH",
    macdHistogram: -0.001,
    swingLowDist: 0.003,
    rangePct: 0.006,
  }), prediction);
  assert.strictEqual(alignedPullback.action, "SELL");
}

testInvalidMarketDataIsRejected();
testInvalidPredictionIsRejected();
testInvalidRiskInputsAreRejected();
testDirectionalEntriesNeedConfluenceAndRoom();

// [FIX-RISK-DEFAULT-PARITY] Regression coverage: DEFAULT_RISK_LIMITS (what
// runBacktest()/evaluateRisk() silently fall back to without explicit risk
// config) must not drift from what run-mt5.ts's live/paper path actually
// uses by default (RISK_MAX_PER_TRADE_PCT et al. in env.ts) — otherwise an
// unconfigured backtest silently tests a different risk profile than what
// really gets traded.
function testDefaultRiskLimitsMatchLiveEnvDefaults() {
  assert.strictEqual(DEFAULT_RISK_LIMITS.maxRiskPerTradePct, env.riskMaxPerTradePct);
  assert.strictEqual(DEFAULT_RISK_LIMITS.maxOpenPositions, env.riskMaxOpenPositions);
  assert.strictEqual(DEFAULT_RISK_LIMITS.maxDailyLossPct, env.riskMaxDailyLossPct);
  assert.strictEqual(DEFAULT_RISK_LIMITS.maxDrawdownPct, env.riskMaxDrawdownPct);
  assert.strictEqual(DEFAULT_RISK_LIMITS.maxSpreadAsAtrFraction, env.riskMaxSpreadAtrFraction);
}
testDefaultRiskLimitsMatchLiveEnvDefaults();

console.log("All safety regression tests passed.");