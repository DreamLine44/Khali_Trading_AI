import { BacktestResult } from "../engine/types";

export interface BacktestMetrics {
  tradeCount: number;
  winRate: number;
  netReturnPct: number;
  profitFactor: number | null; // null when there are no losing trades to divide by
  expectancy: number;
  avgWin: number;
  avgLoss: number;
  maxDrawdownPct: number;
  consecutiveLossesMax: number;
  sharpeApprox: number | null; // simplified, per-bar-return based, no risk-free rate adjustment
  rejectedSignals: number;
}

export function computeMetrics(result: BacktestResult): BacktestMetrics {
  const { trades, equityCurve, initialBalance, finalBalance, rejectedCount } = result;

  const wins = trades.filter((t) => t.netPnl > 0);
  const losses = trades.filter((t) => t.netPnl <= 0);

  const grossProfit = wins.reduce((a, t) => a + t.netPnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.netPnl, 0));

  const winRate = trades.length > 0 ? wins.length / trades.length : 0;
  const avgWin = wins.length > 0 ? grossProfit / wins.length : 0;
  const avgLoss = losses.length > 0 ? grossLoss / losses.length : 0;
  const expectancy = trades.length > 0 ? (winRate * avgWin - (1 - winRate) * avgLoss) : 0;
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : null;

  let peak = initialBalance;
  let maxDrawdownPct = 0;
  for (const point of equityCurve) {
    peak = Math.max(peak, point.equity);
    if (peak > 0) {
      maxDrawdownPct = Math.max(maxDrawdownPct, (peak - point.equity) / peak);
    }
  }

  let consecutiveLosses = 0;
  let consecutiveLossesMax = 0;
  for (const t of trades) {
    if (t.netPnl <= 0) {
      consecutiveLosses++;
      consecutiveLossesMax = Math.max(consecutiveLossesMax, consecutiveLosses);
    } else {
      consecutiveLosses = 0;
    }
  }

  const barReturns: number[] = [];
  for (let i = 1; i < equityCurve.length; i++) {
    const prev = equityCurve[i - 1];
    const cur = equityCurve[i];
    if (prev === undefined || cur === undefined || prev.equity === 0) continue;
    barReturns.push((cur.equity - prev.equity) / prev.equity);
  }
  const sharpeApprox = sharpeRatio(barReturns);

  return {
    tradeCount: trades.length,
    winRate,
    netReturnPct: initialBalance > 0 ? (finalBalance - initialBalance) / initialBalance : 0,
    profitFactor,
    expectancy,
    avgWin,
    avgLoss,
    maxDrawdownPct,
    consecutiveLossesMax,
    sharpeApprox,
    rejectedSignals: rejectedCount,
  };
}

function sharpeRatio(returns: number[]): number | null {
  if (returns.length < 2) return null;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, r) => a + (r - mean) ** 2, 0) / (returns.length - 1);
  const stdDev = Math.sqrt(variance);
  if (stdDev === 0) return null;
  return (mean / stdDev) * Math.sqrt(returns.length);
}
