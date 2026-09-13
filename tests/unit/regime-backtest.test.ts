import * as assert from "assert";
import { buildFeatureSet } from "../../src/core/features/feature-engine";
import { Candle } from "../../src/core/types";
import { runBacktest } from "../../src/backtesting/engine/backtest-engine";

function candles(count: number, step: number): Candle[] {
  const now = Date.now();
  return Array.from({ length: count }, (_, index) => {
    const close = 1 + index * step;
    return {
      symbol: "EURUSD",
      timeframe: "M15" as const,
      timestampUtc: now - (count - index) * 15 * 60_000,
      open: close - step,
      high: close + Math.abs(step),
      low: close - Math.abs(step),
      close,
      volume: 100,
      isClosed: true,
    };
  });
}

function testRegimeIsNotPlaceholderConstant() {
  const bullish = buildFeatureSet("EURUSD", "M15", candles(100, 0.001), { ok: true, issues: [], checkedAt: Date.now() });
  const flat = buildFeatureSet("EURUSD", "M15", candles(100, 0), { ok: true, issues: [], checkedAt: Date.now() });
  assert.strictEqual(bullish.regime, "TRENDING_BULLISH");
  assert.notStrictEqual(flat.regime, bullish.regime);
}

// [FIX-REGIME-PRICE-REFERENCE] Regression coverage: regime detection's
// volatility ratio must be normalized against the CURRENT price, not the
// average close across the entire fetched history. A price series that
// spent most of its (irrelevant, older) history far from where it trades
// now must not have that stale average spuriously trip HIGH_VOLATILITY
// for a perfectly ordinary, flat recent range.
function mkCandle(now: number, total: number, index: number, close: number, halfRange: number): Candle {
  return {
    symbol: "EURUSD",
    timeframe: "M15",
    timestampUtc: now - (total - index) * 15 * 60_000,
    open: close,
    high: close + halfRange,
    low: close - halfRange,
    close,
    volume: 100,
    isClosed: true,
  };
}

function testRegimeVolatilityNormalizesByCurrentPriceNotHistoricalAverage() {
  const now = Date.now();
  const total = 200;
  const bars: Candle[] = [];
  // First 150 bars: price parked near 0.1 -- ancient history the 20-bar
  // change/ATR window regime detection actually looks at never touches,
  // but which used to drag the old full-history average price down hard.
  for (let i = 0; i < 150; i++) bars.push(mkCandle(now, total, i, 0.1, 0.0005));
  // Last 50 bars: price sitting flat near 10.0 with an ordinary ~0.6%-of-
  // price true range -- comfortably under the 1% HIGH_VOLATILITY cutoff
  // when measured against the CURRENT price, but well over it when
  // measured against the stale ~2.6 historical average the old code used.
  for (let i = 150; i < total; i++) bars.push(mkCandle(now, total, i, 10.0, 0.03));

  const features = buildFeatureSet("EURUSD", "M15", bars, { ok: true, issues: [], checkedAt: Date.now() });
  assert.strictEqual(features.regime, "RANGING", `expected RANGING (flat, ordinary recent volatility), got ${features.regime}`);
}

function testBacktestAcceptsSessionRiskAccounting() {
  const history = candles(200, -0.0001);
  const result = runBacktest(history, () => [], { symbol: "EURUSD", timeframe: "M15", initialBalance: 10_000, warmupBars: 50 });
  assert.strictEqual(result.barsProcessed, 150);
  assert.ok(result.finalBalance === result.initialBalance);
}

testRegimeIsNotPlaceholderConstant();
testRegimeVolatilityNormalizesByCurrentPriceNotHistoricalAverage();
testBacktestAcceptsSessionRiskAccounting();
console.log("All regime and backtest accounting tests passed.");
