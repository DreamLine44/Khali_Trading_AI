import { Candle, ModelPrediction, Timeframe } from "../../core/types";
import { validateCandles } from "../../core/market-data/normalizers/candle-validator";
import { buildFeatureSet } from "../../core/features/feature-engine";
import { makeDecision } from "../../core/decision/decision-engine";
import { AccountState, evaluateRisk, RiskLimits, DEFAULT_RISK_LIMITS } from "../../core/risk/risk-engine";
import { applyEntryCost, applyExitCost, commissionCost, CostModelConfig, DEFAULT_COST_MODEL, validateCostModel } from "../costs/cost-model";
import { BacktestResult, BacktestTrade, EquityPoint } from "./types";

/**
 * Produces model predictions from ONLY the candles visible up to and
 * including the current bar. This signature exists specifically to make
 * look-ahead bias structurally hard to introduce: a predictor cannot see
 * `fullHistory`, only the slice the engine hands it bar by bar.
 *
 * The default predictor used in scripts/run-backtest.ts is a labeled
 * placeholder, not a trained model — see spec section 39: do not pretend
 * a stand-in is the real thing.
 */
export type BacktestPredictor = (visibleClosedCandles: Candle[]) => ModelPrediction[];

export interface BacktestConfig {
  symbol: string;
  timeframe: Timeframe;
  initialBalance: number;
  riskLimits?: RiskLimits;
  costModel?: CostModelConfig;
  /** Minimum bars of history required before the engine will act on a signal. */
  warmupBars?: number;
}

interface OpenPosition {
  decisionId: string;
  side: "BUY" | "SELL";
  entryTimeUtc: number;
  entryPrice: number;
  volume: number;
  stopLoss: number;
  takeProfit: number;
  decision: ReturnType<typeof makeDecision>;
  risk: ReturnType<typeof evaluateRisk>;
  entryCommission: number;
}

export function runBacktest(fullHistory: Candle[], predictor: BacktestPredictor, config: BacktestConfig): BacktestResult {
  if (fullHistory.length === 0) throw new Error("backtest requires historical candles");
  if (!Number.isFinite(config.initialBalance) || config.initialBalance <= 0) throw new Error("initial balance must be finite and positive");
  if (!Number.isInteger(config.warmupBars ?? 50) || (config.warmupBars ?? 50) < 1) throw new Error("warmup bars must be a positive integer");
  const riskLimits = config.riskLimits ?? DEFAULT_RISK_LIMITS;
  const costModel = config.costModel ?? DEFAULT_COST_MODEL;
  validateCostModel(costModel);
  const warmupBars = config.warmupBars ?? 50;
  if (warmupBars >= fullHistory.length) throw new Error("warmup bars must be smaller than history length");

  let balance = config.initialBalance;
  let peakEquity = config.initialBalance;
  let openPosition: OpenPosition | null = null;

  const trades: BacktestTrade[] = [];
  const equityCurve: EquityPoint[] = [];
  let rejectedCount = 0;
  let sessionStartTimestamp = fullHistory[warmupBars]?.timestampUtc ?? Date.now();
  let sessionStartBalance = balance;
  let sessionPeakEquity = balance;

  for (let i = warmupBars; i < fullHistory.length; i++) {
    const bar = fullHistory[i];
    if (bar === undefined) continue;
    const sessionDate = new Date(bar.timestampUtc).toISOString().slice(0, 10);
    const previousSessionDate = new Date(sessionStartTimestamp).toISOString().slice(0, 10);
    if (sessionDate !== previousSessionDate) {
      sessionStartTimestamp = bar.timestampUtc;
      sessionStartBalance = balance;
      sessionPeakEquity = balance;
    }
    const visible = fullHistory.slice(0, i + 1); // no look-ahead: only up to this bar

    // If a position is open, check whether THIS bar's range hit the
    // stop or target before considering any new signal. Stop-loss is
    // checked before take-profit on the same bar (conservative
    // assumption when both could theoretically be hit intrabar).
    if (openPosition !== null) {
      const pos = openPosition;
      const hitStop = pos.side === "BUY" ? bar.low <= pos.stopLoss : bar.high >= pos.stopLoss;
      const hitTarget = pos.side === "BUY" ? bar.high >= pos.takeProfit : bar.low <= pos.takeProfit;

      if (hitStop || hitTarget) {
        const exitReason = hitStop ? "STOP_LOSS" : "TAKE_PROFIT";
        const theoreticalExit = hitStop ? pos.stopLoss : pos.takeProfit;
        const atrAtExit = buildFeatureSet(config.symbol, config.timeframe, visible, validateCandles(config.symbol, config.timeframe, visible, { now: bar.timestampUtc })).atr14 ?? 0;
        const exitPrice = applyExitCost(pos.side, theoreticalExit, atrAtExit, costModel);
        const exitCommission = commissionCost(pos.volume, costModel);
        const commission = pos.entryCommission + exitCommission;
        const grossPnl = pos.side === "BUY" ? (exitPrice - pos.entryPrice) * pos.volume : (pos.entryPrice - exitPrice) * pos.volume;
        const netPnl = grossPnl - commission;
        balance += netPnl;

        trades.push({
          decisionId: pos.decisionId,
          symbol: config.symbol,
          side: pos.side,
          entryTimeUtc: pos.entryTimeUtc,
          exitTimeUtc: bar.timestampUtc,
          entryPrice: pos.entryPrice,
          exitPrice,
          volume: pos.volume,
          stopLoss: pos.stopLoss,
          takeProfit: pos.takeProfit,
          exitReason,
          grossPnl,
          commission,
          netPnl,
          decision: pos.decision,
          risk: pos.risk,
        });
        openPosition = null;
      }
    }

    // Mark-to-market equity for this bar (unrealized P&L on any still-open position).
    const unrealized = openPosition
      ? (openPosition.side === "BUY" ? bar.close - openPosition.entryPrice : openPosition.entryPrice - bar.close) * openPosition.volume
      : 0;
    const equity = balance + unrealized;
    sessionPeakEquity = Math.max(sessionPeakEquity, equity);
    peakEquity = Math.max(peakEquity, equity);
    equityCurve.push({ timestampUtc: bar.timestampUtc, equity });

    if (openPosition !== null) continue; // one open position at a time — don't stack signals

    const dataQuality = validateCandles(config.symbol, config.timeframe, visible, { now: bar.timestampUtc });
    const features = buildFeatureSet(config.symbol, config.timeframe, visible, dataQuality);
    const predictions = predictor(visible);
    const decision = makeDecision(features, predictions);

    if (decision.action !== "BUY" && decision.action !== "SELL") continue;

    const account: AccountState = {
      balance,
      equity,
      freeMargin: equity, // simplification: no margin/leverage model yet
      openPositionsCount: 0,
      dailyLossPct: sessionStartBalance > 0 ? (equity - sessionStartBalance) / sessionStartBalance : 0,
      currentDrawdownPct: sessionPeakEquity > 0 ? (sessionPeakEquity - equity) / sessionPeakEquity : 0,
    };

    const spreadForRisk = costModel.spread;
    const risk = evaluateRisk(decision, features, account, spreadForRisk, bar.close, riskLimits);

    if (!risk.approved || risk.maxPositionSize === null || risk.stopLossPrice === null || risk.takeProfitPrice === null) {
      rejectedCount++;
      continue;
    }

    const atrAtEntry = features.atr14 ?? 0;
    const entryPrice = applyEntryCost(decision.action, bar.close, atrAtEntry, costModel);
    // Per cost-model.ts's own contract ("commission per unit volume,
    // charged on both entry and exit"), entry commission must be tracked
    // and later deducted alongside the exit commission. It is applied to
    // balance once, at close, together with the exit commission — see
    // the exit and forced-close blocks below — so every trade still
    // produces exactly one balance-changing netPnl (kept in sync with
    // `testMetricsMatchTradeLedger`, which asserts finalBalance equals
    // initialBalance plus the sum of trade netPnl).
    const entryCommission = commissionCost(risk.maxPositionSize, costModel);

    openPosition = {
      decisionId: decision.id,
      side: decision.action,
      entryTimeUtc: bar.timestampUtc,
      entryPrice,
      volume: risk.maxPositionSize,
      stopLoss: risk.stopLossPrice,
      takeProfit: risk.takeProfitPrice,
      decision,
      risk,
      entryCommission,
    };
  }

  // Force-close anything still open at the end of the data window so
  // every trade is accounted for in the results.
  if (openPosition !== null) {
    const pos = openPosition;
    const lastBar = fullHistory[fullHistory.length - 1];
    if (lastBar !== undefined) {
      const commission = pos.entryCommission + commissionCost(pos.volume, costModel);
      const grossPnl = pos.side === "BUY" ? (lastBar.close - pos.entryPrice) * pos.volume : (pos.entryPrice - lastBar.close) * pos.volume;
      const netPnl = grossPnl - commission;
      balance += netPnl;
      trades.push({
        decisionId: pos.decisionId,
        symbol: config.symbol,
        side: pos.side,
        entryTimeUtc: pos.entryTimeUtc,
        exitTimeUtc: lastBar.timestampUtc,
        entryPrice: pos.entryPrice,
        exitPrice: lastBar.close,
        volume: pos.volume,
        stopLoss: pos.stopLoss,
        takeProfit: pos.takeProfit,
        exitReason: "FORCED_CLOSE_END_OF_DATA",
        grossPnl,
        commission,
        netPnl,
        decision: pos.decision,
        risk: pos.risk,
      });
    }
  }

  return {
    symbol: config.symbol,
    initialBalance: config.initialBalance,
    finalBalance: balance,
    trades,
    equityCurve,
    rejectedCount,
    barsProcessed: fullHistory.length - warmupBars,
  };
}
