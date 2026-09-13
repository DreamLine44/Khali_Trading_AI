/**
 * Shared domain types for the trading engine.
 *
 * These types are the contract between every stage of the pipeline
 * (market-data -> features -> decision -> risk -> execution). Keeping
 * them centralized means every module agrees on the same shapes and
 * we can validate at each boundary instead of trusting upstream data.
 */

export type Timeframe = "M1" | "M5" | "M15" | "H1" | "H4" | "D1";

export interface Candle {
  symbol: string;
  timeframe: Timeframe;
  /** Unix ms, UTC. Never store or compare local/broker time directly. */
  timestampUtc: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** True only for a fully closed candle. Partial candles must be flagged. */
  isClosed: boolean;
}

export interface SymbolTradingSpec {
  digits: number;
  point: number;
  tickSize: number;
  tickValue: number;
  volumeMin: number;
  volumeMax: number;
  volumeStep: number;
  stopsLevelPoints: number;
  freezeLevelPoints: number;
  /** Account-currency loss for one lot if the requested SL is hit, calculated by MT5. */
  lossPerLotAtStop: number;
}

export interface Quote {
  symbol: string;
  timestampUtc: number;
  bid: number;
  ask: number;
  spread: number;
}

export interface DataQualityReport {
  ok: boolean;
  /** Human-readable reasons, empty when ok === true. */
  issues: string[];
  checkedAt: number;
}

export type MarketRegime =
  | "TRENDING_BULLISH"
  | "TRENDING_BEARISH"
  | "RANGING"
  | "HIGH_VOLATILITY"
  | "LOW_VOLATILITY"
  | "TRANSITION"
  | "ABNORMAL"
  | "UNKNOWN";

export interface FeatureSet {
  symbol: string;
  timeframe: Timeframe;
  asOfUtc: number;
  // Trend / momentum / volatility indicators — see core/features/indicators.ts
  sma20: number | null;
  ema20: number | null;
  rsi14: number | null;
  atr14: number | null;
  // Simple structural context
  swingHigh: number | null;
  swingLow: number | null;
  // Trend strength, price action / market structure, and multi-timeframe
  // context (spec sections 7, 8, 10) — see core/features/indicators.ts.
  // Distances/flags are computed against the PRIOR lookback window (the
  // current candle excluded), so bosBull/bosBear reflect a genuine break
  // of an already-established range, not a window that includes itself.
  adx14: number | null;
  swingHighDist: number | null; // (priorSwingHigh - close) / close
  swingLowDist: number | null; // (close - priorSwingLow) / close
  bosBull: number | null; // 1 if close broke above the prior swing high, else 0
  bosBear: number | null; // 1 if close broke below the prior swing low, else 0
  rangePct: number | null; // (priorSwingHigh - priorSwingLow) / close
  htfTrend: number | null; // close_vs_ema of the latest fully-closed higher-timeframe bar
  wma20: number | null;
  macd: number | null;
  macdSignal: number | null;
  macdHistogram: number | null;
  stochasticK: number | null;
  stochasticD: number | null;
  roc12: number | null;
  bollingerWidth: number | null;
  bollingerPercentB: number | null;
  historicalVolatility20: number | null;
  vwap20: number | null;
  obv: number | null;
  structureTrend: "BULLISH" | "BEARISH" | "RANGE" | "UNKNOWN";
  higherHigh: number;
  higherLow: number;
  lowerHigh: number;
  lowerLow: number;
  chochBull: number;
  chochBear: number;
  candlestickPatterns: string[];
  regime: MarketRegime;
  regimeConfidence: number; // 0..1
  dataQuality: DataQualityReport;
  evidence?: import("./evidence/types").EvidenceSnapshot;
}

export type TradeAction = "BUY" | "SELL" | "HOLD" | "NO_TRADE" | "EXIT" | "INSUFFICIENT_CONFIDENCE";

export interface ModelPrediction {
  modelName: string;
  modelVersion: string;
  action: TradeAction;
  probability: number; // 0..1, raw model output
  uncertainty: number; // 0..1, higher = less certain
}

export interface Decision {
  id: string;
  symbol: string;
  timeframe: Timeframe;
  createdAtUtc: number;
  action: TradeAction;
  confidence: number; // 0..1, post-calibration, may differ from raw model probability
  reasons: string[]; // human-readable evidence trail
  predictions: ModelPrediction[];
  featureSetRef: FeatureSet;
}

export interface RiskCheckResult {
  approved: boolean;
  reasons: string[];
  maxPositionSize: number | null;
  stopLossPrice: number | null;
  takeProfitPrice: number | null;
}

export type OrderState =
  | "PROPOSED"
  | "VALIDATING"
  | "APPROVED"
  | "SUBMITTED"
  | "CONFIRMED"
  | "REJECTED"
  | "CANCELLED"
  | "FILLED"
  | "PARTIALLY_FILLED"
  | "CLOSED"
  | "FAILED";

export interface OrderRequest {
  id: string;
  decisionId: string;
  symbol: string;
  side: "BUY" | "SELL";
  volume: number;
  stopLoss: number | null;
  takeProfit: number | null;
  state: OrderState;
  createdAtUtc: number;
  idempotencyKey: string;
  executionEnvironment?: "paper" | "live";
  // [FIX-PAPER-FILL] The market reference price at order-creation time.
  // Required so a non-live adapter can simulate a real fill instead of
  // reporting a fabricated success with a null price (see paper-execution.adapter.ts).
  referencePrice: number | null;
  brokerOrderId?: string | null;
  filledPrice?: number | null;
  filledVolume?: number | null;
  // [FIX-ENTRY-RETRY] Set only once this order reaches a terminal FAILED
  // state, and only true when the failure is DEFINITELY known to have
  // never reached the broker (see ExecutionResult.retryable). Consumed by
  // OrderManager.createOrderFromDecision to decide whether the same
  // decision may be attempted again on a later cycle. Undefined/false
  // means "do not retry" — the conservative default.
  retryable?: boolean;
}

export interface AuditRecord {
  decision: Decision;
  risk: RiskCheckResult;
  order: OrderRequest | null;
  executionResult: unknown | null;
  notes: string[];
}
