import { FeatureSet } from "../types";

export function toModelFeatureRow(features: FeatureSet, latestClose: number): Record<string, number> | null {
  const row: Record<string, number> = {
    sma20: features.sma20 ?? NaN,
    ema20: features.ema20 ?? NaN,
    rsi14: features.rsi14 ?? NaN,
    atr14: features.atr14 ?? NaN,
    close_vs_sma20: features.sma20 ? (latestClose - features.sma20) / features.sma20 : NaN,
    close_vs_ema20: features.ema20 ? (latestClose - features.ema20) / features.ema20 : NaN,
    atr_pct: features.atr14 ? features.atr14 / latestClose : NaN,
    adx14: features.adx14 ?? NaN,
    swing_high_dist: features.swingHighDist ?? NaN,
    swing_low_dist: features.swingLowDist ?? NaN,
    bos_bull: features.bosBull ?? NaN,
    bos_bear: features.bosBear ?? NaN,
    range_pct: features.rangePct ?? NaN,
    htf_trend: features.htfTrend ?? NaN,
    wma20: features.wma20 ?? NaN,
    macd: features.macd ?? NaN,
    macd_signal: features.macdSignal ?? NaN,
    macd_histogram: features.macdHistogram ?? NaN,
    stochastic_k: features.stochasticK ?? NaN,
    stochastic_d: features.stochasticD ?? NaN,
    roc12: features.roc12 ?? NaN,
    bollinger_width: features.bollingerWidth ?? NaN,
    bollinger_percent_b: features.bollingerPercentB ?? NaN,
    historical_volatility20: features.historicalVolatility20 ?? NaN,
    vwap_distance: features.vwap20 ? (latestClose - features.vwap20) / features.vwap20 : NaN,
    obv: features.obv ?? NaN,
    higher_high: features.higherHigh,
    higher_low: features.higherLow,
    lower_high: features.lowerHigh,
    lower_low: features.lowerLow,
    choch_bull: features.chochBull,
    choch_bear: features.chochBear,
    pattern_bullish: bullishPatternScore(features.candlestickPatterns),
    pattern_bearish: bearishPatternScore(features.candlestickPatterns),
  };
  return Object.values(row).every(Number.isFinite) ? row : null;
}

function bullishPatternScore(patterns: string[]): number {
  const bullish = new Set(["HAMMER", "INVERTED_HAMMER", "BULLISH_ENGULFING", "MORNING_STAR", "PIERCING", "MARUBOZU_BULL", "TWEEZER_BOTTOM"]);
  return patterns.filter(p => bullish.has(p)).length;
}
function bearishPatternScore(patterns: string[]): number {
  const bearish = new Set(["SHOOTING_STAR", "HANGING_MAN", "BEARISH_ENGULFING", "EVENING_STAR", "DARK_CLOUD_COVER", "MARUBOZU_BEAR", "TWEEZER_TOP"]);
  return patterns.filter(p => bearish.has(p)).length;
}
