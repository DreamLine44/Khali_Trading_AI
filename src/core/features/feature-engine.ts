import { Candle, DataQualityReport, FeatureSet, MarketRegime, Timeframe } from "../types";
import { adx, atr, ema, htfTrend, priorSwingHighLow, rangePct, rsi, sma, swingHighLow } from "./indicators";
import { bollinger, detectCandlestickPatterns, historicalVolatility, macd, marketStructure, obv, roc, stochastic, vwap, wma } from "./advanced";

// Structure/HTF lookback config — MUST match ai/training/preprocessing/
// build_dataset.py exactly, or live features silently drift from training.
const SWING_LOOKBACK = 20;
const HTF_BY_TIMEFRAME: Record<Timeframe, number | null> = {
  M1: 60,
  M5: 60,
  M15: 60,
  H1: 240,
  H4: 1440,
  D1: null,
};

const TIMEFRAME_MINUTES: Record<Timeframe, number> = { M1: 1, M5: 5, M15: 15, H1: 60, H4: 240, D1: 1440 };

/**
 * Builds a FeatureSet from a validated candle series.
 *
 * IMPORTANT: this only uses candles up to and including the last CLOSED
 * candle at call time — callers must never pass an in-progress candle
 * as if it were closed, or this becomes a look-ahead-bias bug (spec
 * section 7).
 */
export function buildFeatureSet(
  symbol: string,
  timeframe: Timeframe,
  candles: Candle[],
  dataQuality: DataQualityReport
): FeatureSet {
  const closedCandles = candles.filter((c) => c.isClosed);
  const closes = closedCandles.map((c) => c.close);
  const last = closedCandles[closedCandles.length - 1];

  const { regime, regimeConfidence } = detectRegime(closedCandles);

  const priorSwing = priorSwingHighLow(closedCandles, SWING_LOOKBACK);
  const lastClose = last?.close ?? null;
  const swingHighDist = priorSwing.high !== null && lastClose !== null ? (priorSwing.high - lastClose) / lastClose : null;
  const swingLowDist = priorSwing.low !== null && lastClose !== null ? (lastClose - priorSwing.low) / lastClose : null;
  const bosBull = priorSwing.high !== null && lastClose !== null ? (lastClose > priorSwing.high ? 1 : 0) : null;
  const bosBear = priorSwing.low !== null && lastClose !== null ? (lastClose < priorSwing.low ? 1 : 0) : null;

  // HTF context uses the explicit training-time mapping. D1 has no higher
  // timeframe in the current feature contract, so it receives a neutral 0.
  const baseMinutes = TIMEFRAME_MINUTES[timeframe];
  const htfMinutes = HTF_BY_TIMEFRAME[timeframe];
  const htf = htfMinutes === null
    ? 0
    : htfTrend(closedCandles, baseMinutes, htfMinutes, 20);

  const macdValue = macd(closes);
  const stoch = stochastic(closedCandles);
  const bb = bollinger(closes);
  const structure = marketStructure(closedCandles, SWING_LOOKBACK);
  return {
    symbol,
    timeframe,
    asOfUtc: last?.timestampUtc ?? Date.now(),
    sma20: sma(closes, 20),
    ema20: ema(closes, 20),
    rsi14: rsi(closes, 14),
    atr14: atr(closedCandles, 14),
    swingHigh: swingHighLow(closedCandles, 20).high,
    swingLow: swingHighLow(closedCandles, 20).low,
    adx14: adx(closedCandles, 14),
    swingHighDist,
    swingLowDist,
    bosBull,
    bosBear,
    rangePct: rangePct(closedCandles, SWING_LOOKBACK),
    htfTrend: htf,
    wma20: wma(closes, 20),
    macd: macdValue.macd,
    macdSignal: macdValue.signal,
    macdHistogram: macdValue.histogram,
    stochasticK: stoch.k,
    stochasticD: stoch.d,
    roc12: roc(closes, 12),
    bollingerWidth: bb.width,
    bollingerPercentB: bb.percentB,
    historicalVolatility20: historicalVolatility(closes, 20),
    vwap20: vwap(closedCandles, 20),
    obv: obv(closedCandles),
    structureTrend: structure.trend,
    higherHigh: structure.higherHigh,
    higherLow: structure.higherLow,
    lowerHigh: structure.lowerHigh,
    lowerLow: structure.lowerLow,
    chochBull: structure.chochBull,
    chochBear: structure.chochBear,
    candlestickPatterns: detectCandlestickPatterns(closedCandles),
    regime,
    regimeConfidence,
    dataQuality,
  };
}

/**
 * Deterministic regime gate. It is intentionally conservative and is not
 * treated as an ML claim; production model qualification must still prove
 * its value on real out-of-sample data before thresholds are relaxed.
 */
function detectRegime(candles: Candle[]): { regime: MarketRegime; regimeConfidence: number } {
  if (candles.length < 20) return { regime: "UNKNOWN", regimeConfidence: 0 };
  const closes = candles.map((c) => c.close);
  const first = closes[closes.length - 20];
  const last = closes[closes.length - 1];
  if (first === undefined || last === undefined) return { regime: "UNKNOWN", regimeConfidence: 0 };
  const change = (last - first) / first;
  const vol = atr(candles, 14);
  // [FIX-REGIME-PRICE-REFERENCE] Previously divided by the average close
  // across the ENTIRE candles array passed in — which can be far longer
  // than the 20-bar window `change` above looks at (buildFeatureSet is
  // typically called with ~200 bars of history). That makes regime
  // classification silently depend on how much unrelated history happened
  // to be fetched (deps.historyBars in trading-loop.ts, or a backtest's
  // window length) rather than on current market conditions: for a symbol
  // that has drifted meaningfully over the full fetched window, the
  // long-run average price can differ substantially from where price
  // actually is right now, skewing the ATR-to-price ratio that decides
  // HIGH_VOLATILITY in either direction. "ATR as a fraction of price" is
  // conventionally normalized by the CURRENT price, which is also what
  // volRatio is meant to represent here — not a price from potentially
  // weeks/months earlier in the fetched window.
  const volRatio = vol && last ? vol / last : 0;

  if (volRatio > 0.01) return { regime: "HIGH_VOLATILITY", regimeConfidence: 0.4 };
  if (change > 0.01) return { regime: "TRENDING_BULLISH", regimeConfidence: 0.4 };
  if (change < -0.01) return { regime: "TRENDING_BEARISH", regimeConfidence: 0.4 };
  return { regime: "RANGING", regimeConfidence: 0.4 };
}
