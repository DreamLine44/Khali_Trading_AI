import { Decision, RiskCheckResult } from "../../core/types";

export interface BacktestTrade {
  decisionId: string;
  symbol: string;
  side: "BUY" | "SELL";
  entryTimeUtc: number;
  exitTimeUtc: number;
  entryPrice: number;
  exitPrice: number;
  volume: number;
  stopLoss: number;
  takeProfit: number;
  exitReason: "STOP_LOSS" | "TAKE_PROFIT" | "FORCED_CLOSE_END_OF_DATA";
  grossPnl: number;
  commission: number;
  netPnl: number;
  decision: Decision;
  risk: RiskCheckResult;
}

export interface EquityPoint {
  timestampUtc: number;
  equity: number;
}

export interface BacktestResult {
  symbol: string;
  initialBalance: number;
  finalBalance: number;
  trades: BacktestTrade[];
  equityCurve: EquityPoint[];
  rejectedCount: number;
  barsProcessed: number;
}
