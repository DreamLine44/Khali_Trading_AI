import { env } from "../config/env";
import * as fs from "fs";
import * as path from "path";
import { DevMarketDataProvider } from "../core/market-data/providers/dev-market-data.provider";
import { runBacktest, BacktestPredictor } from "../backtesting/engine/backtest-engine";
import { computeMetrics } from "../backtesting/metrics/metrics";
import { formatReport } from "../backtesting/reports/report";
import { Candle, ModelPrediction } from "../core/types";
import { rsi } from "../core/features/indicators";

/**
 * Development-only smoke test. It is deliberately impossible to mistake this
 * for a production validation run. Real model backtests must use a prepared
 * historical dataset and a batch inference adapter; this smoke test exists
 * only to verify the simulation engine itself.
 */
// [FIX-SMOKE-CONFIDENCE] probability/uncertainty must clear the decision
// engine's *combined* confidence gate (avgProb * (1 - maxUncertainty) >=
// DECISION_MIN_CONFIDENCE, default 0.55), not just the separate
// avgProb/maxUncertainty floors individually. The previous values (0.65
// probability, 0.35 uncertainty) passed both individual floors but
// combined to 0.4225 < 0.55 — structurally below threshold on every
// call, regardless of what RSI did. That silently meant this "engine
// correctness" smoke test could never open a single position: 2,950
// synthetic bars, 0 trades, 0 rejects, every single cycle. It looked
// like a passing run but never actually exercised entry, fill,
// stop/target, or cost-application code paths — the entire point of
// the smoke test. 0.85/0.20 combines to 0.68, comfortably above every
// gate, so RSI-triggered signals actually reach the risk/execution path.
const smokePredictor: BacktestPredictor = (visible: Candle[]): ModelPrediction[] => {
  const closes = visible.filter((c) => c.isClosed).map((c) => c.close);
  const value = rsi(closes, 14);
  if (value === null) return [];
  if (value < 35) return [{ modelName: "dev-smoke-rsi", modelVersion: "dev-only", action: "BUY", probability: 0.85, uncertainty: 0.2 }];
  if (value > 65) return [{ modelName: "dev-smoke-rsi", modelVersion: "dev-only", action: "SELL", probability: 0.85, uncertainty: 0.2 }];
  return [{ modelName: "dev-smoke-rsi", modelVersion: "dev-only", action: "HOLD", probability: 0.5, uncertainty: 0.5 }];
};

async function main() {
  if (process.argv.includes("--production")) {
    throw new Error("production backtesting is not permitted through the development smoke-test runner; use the leakage-safe Python training/validation pipeline and an OOS-qualified model artifact");
  }
  if (env.nodeEnv === "production") throw new Error("development backtest smoke test cannot run with NODE_ENV=production");
  const provider = new DevMarketDataProvider();
  const symbol = "EURUSD";
  const timeframe = "M15" as const;
  const history = await provider.getHistoricalCandles(symbol, timeframe, 3000);
  const result = runBacktest(history, smokePredictor, { symbol, timeframe, initialBalance: 10_000, warmupBars: 50 });
  const metrics = computeMetrics(result);
  console.log(formatReport(result, metrics));
  const outDir = path.join(__dirname, "../backtesting/reports/output");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `backtest_${symbol}_DEV_SMOKE_${Date.now()}.json`);
  fs.writeFileSync(outFile, JSON.stringify({ result, metrics, productionValidation: false }, null, 2), "utf-8");
  console.log(`\nDevelopment smoke-test result written to ${outFile}`);
}

main().catch((err) => {
  console.error("backtest run failed:", err);
  throw err;
});
