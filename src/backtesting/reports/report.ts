import { BacktestResult } from "../engine/types";
import { BacktestMetrics } from "../metrics/metrics";

export function formatReport(result: BacktestResult, metrics: BacktestMetrics): string {
  const pct = (n: number) => `${(n * 100).toFixed(2)}%`;
  return [
    `Backtest report — ${result.symbol}`,
    `Bars processed:        ${result.barsProcessed}`,
    `Initial balance:       ${result.initialBalance.toFixed(2)}`,
    `Final balance:         ${result.finalBalance.toFixed(2)}`,
    `Net return:            ${pct(metrics.netReturnPct)}`,
    `Trades taken:          ${metrics.tradeCount}`,
    `Signals rejected:      ${metrics.rejectedSignals}  (risk engine veto or insufficient confidence)`,
    `Win rate:              ${pct(metrics.winRate)}`,
    `Profit factor:         ${metrics.profitFactor === null ? "n/a (no losing trades)" : metrics.profitFactor.toFixed(2)}`,
    `Expectancy per trade:  ${metrics.expectancy.toFixed(4)}`,
    `Avg win / avg loss:    ${metrics.avgWin.toFixed(4)} / ${metrics.avgLoss.toFixed(4)}`,
    `Max drawdown:          ${pct(metrics.maxDrawdownPct)}`,
    `Max consecutive losses:${metrics.consecutiveLossesMax}`,
    `Sharpe (approx):       ${metrics.sharpeApprox === null ? "n/a" : metrics.sharpeApprox.toFixed(2)}`,
    "",
    "NOTE: this run used a placeholder rule-based predictor and a",
    "placeholder regime detector, not a trained/validated model.",
    "These numbers demonstrate the ENGINE is correct (no look-ahead,",
    "realistic costs, proper risk gating) — they say nothing yet about",
    "real predictive edge. Do not treat this as a profitability claim.",
  ].join("\n");
}
