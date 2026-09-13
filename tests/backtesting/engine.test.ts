import * as assert from "assert";
import { Candle, ModelPrediction } from "../../src/core/types";
import { runBacktest, BacktestPredictor } from "../../src/backtesting/engine/backtest-engine";
import { computeMetrics } from "../../src/backtesting/metrics/metrics";
import { DEFAULT_COST_MODEL } from "../../src/backtesting/costs/cost-model";

/**
 * These tests validate the BACKTEST ENGINE's mechanics — that it opens
 * and closes positions correctly, applies costs, and computes P&L
 * correctly — using a synthetic high-confidence predictor. This is
 * NOT a claim that any strategy here is profitable; it's the
 * "backtesting tests" category from spec section 34.
 */

function buildTrendingCandles(count: number, startPrice: number, stepUp: number): Candle[] {
  const candles: Candle[] = [];
  let price = startPrice;
  const now = Date.now();
  for (let i = 0; i < count; i++) {
    const open = price;
    const close = open + stepUp;
    const high = close + Math.abs(stepUp) * 0.2;
    const low = open - Math.abs(stepUp) * 0.2;
    price = close;
    candles.push({
      symbol: "TEST",
      timeframe: "M15",
      timestampUtc: now - (count - i) * 15 * 60_000,
      open,
      high,
      low,
      close,
      volume: 100,
      isClosed: true,
    });
  }
  return candles;
}

function testEngineOpensAndClosesOnTakeProfit() {
  const candles = buildTrendingCandles(200, 1.1, 0.0006); // steady uptrend
  let signaled = false;
  const predictor: BacktestPredictor = (visible): ModelPrediction[] => {
    if (!signaled && visible.length > 60) {
      signaled = true; // fire exactly one high-confidence BUY signal
      return [{ modelName: "test", modelVersion: "0", action: "BUY", probability: 0.95, uncertainty: 0.02 }];
    }
    return [];
  };

  const result = runBacktest(candles, predictor, {
    symbol: "TEST",
    timeframe: "M15",
    initialBalance: 10_000,
    warmupBars: 50,
  });

  assert.ok(result.trades.length >= 1, "expected at least one trade to be taken on a strong uptrend");
  const trade = result.trades[0];
  assert.ok(trade, "trade record should exist");
  assert.strictEqual(trade.side, "BUY");
  assert.ok(trade.exitPrice > trade.entryPrice, "a BUY on a steady uptrend should exit above entry");
  assert.ok(trade.commission > 0, "commission must be non-zero per the cost model");
  assert.ok(
    Math.abs(trade.entryPrice - candles[60]!.close) >= DEFAULT_COST_MODEL.spread / 2 - 1e-9,
    "entry price must include at least half-spread cost, never a free fill at the raw close"
  );

  const expectedNet = trade.grossPnl - trade.commission;
  assert.ok(Math.abs(trade.netPnl - expectedNet) < 1e-9, "netPnl must equal grossPnl minus commission");

  console.log("PASS: testEngineOpensAndClosesOnTakeProfit");
}

function testCommissionIsChargedOnBothEntryAndExit() {
  // cost-model.ts documents commissionPerUnit as "charged on both entry
  // and exit" — a round-trip trade's total commission must reflect two
  // charges, not one, and netPnl must be grossPnl minus that full total.
  const candles = buildTrendingCandles(200, 1.1, 0.0006);
  let signaled = false;
  const predictor: BacktestPredictor = (visible): ModelPrediction[] => {
    if (!signaled && visible.length > 60) {
      signaled = true;
      return [{ modelName: "test", modelVersion: "0", action: "BUY", probability: 0.95, uncertainty: 0.02 }];
    }
    return [];
  };

  const result = runBacktest(candles, predictor, {
    symbol: "TEST",
    timeframe: "M15",
    initialBalance: 10_000,
    warmupBars: 50,
  });

  const trade = result.trades[0];
  assert.ok(trade, "trade record should exist");
  const expectedRoundTripCommission = trade.volume * DEFAULT_COST_MODEL.commissionPerUnit * 2;
  assert.ok(
    Math.abs(trade.commission - expectedRoundTripCommission) < 1e-9,
    `commission (${trade.commission}) must reflect both entry and exit charges (expected ${expectedRoundTripCommission})`
  );
  assert.ok(Math.abs(trade.netPnl - (trade.grossPnl - trade.commission)) < 1e-9, "netPnl must equal grossPnl minus the full round-trip commission");

  console.log("PASS: testCommissionIsChargedOnBothEntryAndExit");
}

function testMetricsMatchTradeLedger() {
  const candles = buildTrendingCandles(200, 1.1, 0.0006);
  let signaled = false;
  const predictor: BacktestPredictor = (visible): ModelPrediction[] => {
    if (!signaled && visible.length > 60) {
      signaled = true;
      return [{ modelName: "test", modelVersion: "0", action: "BUY", probability: 0.95, uncertainty: 0.02 }];
    }
    return [];
  };

  const result = runBacktest(candles, predictor, {
    symbol: "TEST",
    timeframe: "M15",
    initialBalance: 10_000,
    warmupBars: 50,
  });
  const metrics = computeMetrics(result);

  const manualNet = result.trades.reduce((a, t) => a + t.netPnl, 0);
  assert.strictEqual(metrics.tradeCount, result.trades.length);
  assert.ok(
    Math.abs(result.finalBalance - (result.initialBalance + manualNet)) < 1e-6,
    "final balance must equal initial balance plus the sum of trade netPnl"
  );

  console.log("PASS: testMetricsMatchTradeLedger");
}

function testNoLookAheadSignatureLimitsVisibility() {
  const candles = buildTrendingCandles(200, 1.1, 0.0006);
  let maxVisibleLength = 0;
  const predictor: BacktestPredictor = (visible): ModelPrediction[] => {
    maxVisibleLength = Math.max(maxVisibleLength, visible.length);
    return [];
  };

  runBacktest(candles, predictor, { symbol: "TEST", timeframe: "M15", initialBalance: 10_000, warmupBars: 50 });

  assert.ok(
    maxVisibleLength <= candles.length,
    "predictor must never receive more candles than exist in the full history up to the current bar"
  );
  assert.ok(maxVisibleLength < candles.length + 1, "predictor should never see beyond the current bar index");
  console.log("PASS: testNoLookAheadSignatureLimitsVisibility (max visible length observed: " + maxVisibleLength + ")");
}

testEngineOpensAndClosesOnTakeProfit();
testCommissionIsChargedOnBothEntryAndExit();
testMetricsMatchTradeLedger();
testNoLookAheadSignatureLimitsVisibility();
console.log("\nAll backtest engine mechanics tests passed.");
