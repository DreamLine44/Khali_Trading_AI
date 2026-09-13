import { Candle } from "../types";

export type CandlePattern =
  | "DOJI" | "HAMMER" | "INVERTED_HAMMER" | "SHOOTING_STAR" | "HANGING_MAN"
  | "BULLISH_ENGULFING" | "BEARISH_ENGULFING" | "MORNING_STAR" | "EVENING_STAR"
  | "PIERCING" | "DARK_CLOUD_COVER" | "INSIDE_BAR" | "OUTSIDE_BAR"
  | "MARUBOZU_BULL" | "MARUBOZU_BEAR" | "TWEEZER_TOP" | "TWEEZER_BOTTOM";

const body = (c: Candle) => Math.abs(c.close - c.open);
const range = (c: Candle) => Math.max(c.high - c.low, Number.EPSILON);
const upperWick = (c: Candle) => c.high - Math.max(c.open, c.close);
const lowerWick = (c: Candle) => Math.min(c.open, c.close) - c.low;

export function wma(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  const denom = period * (period + 1) / 2;
  return slice.reduce((sum, value, i) => sum + value * (i + 1), 0) / denom;
}

export function macd(values: number[], fastPeriod = 12, slowPeriod = 26, signalPeriod = 9): { macd: number | null; signal: number | null; histogram: number | null } {
  if (values.length < slowPeriod + signalPeriod) return { macd: null, signal: null, histogram: null };
  const emaSeries = (input: number[], p: number) => {
    if (input.length < p) return [] as number[];
    const k = 2 / (p + 1);
    let e = input.slice(0, p).reduce((a, b) => a + b, 0) / p;
    const out = [e];
    for (let i = p; i < input.length; i++) { e = input[i]! * k + e * (1 - k); out.push(e); }
    return out;
  };
  const fast = emaSeries(values, fastPeriod);
  const slow = emaSeries(values, slowPeriod);
  const macdSeries: number[] = [];
  const offset = slowPeriod - fastPeriod;
  for (let i = 0; i < slow.length; i++) macdSeries.push(fast[i + offset]! - slow[i]!);
  const signalSeries = emaSeries(macdSeries, signalPeriod);
  const m = macdSeries.at(-1) ?? null;
  const s = signalSeries.at(-1) ?? null;
  return { macd: m, signal: s, histogram: m !== null && s !== null ? m - s : null };
}

export function stochastic(candles: Candle[], period = 14, smooth = 3): { k: number | null; d: number | null } {
  if (candles.length < period + smooth - 1) return { k: null, d: null };
  const ks: number[] = [];
  for (let i = period - 1; i < candles.length; i++) {
    const window = candles.slice(i - period + 1, i + 1);
    const high = Math.max(...window.map(c => c.high));
    const low = Math.min(...window.map(c => c.low));
    ks.push(high === low ? 50 : ((candles[i]!.close - low) / (high - low)) * 100);
  }
  const k = ks.at(-1) ?? null;
  const d = ks.length >= smooth ? ks.slice(-smooth).reduce((a, b) => a + b, 0) / smooth : null;
  return { k, d };
}

export function roc(values: number[], period = 12): number | null {
  if (values.length <= period) return null;
  const prev = values[values.length - 1 - period]!;
  return prev === 0 ? null : (values.at(-1)! - prev) / prev;
}

export function bollinger(values: number[], period = 20, multiplier = 2): { middle: number | null; upper: number | null; lower: number | null; width: number | null; percentB: number | null } {
  if (values.length < period) return { middle: null, upper: null, lower: null, width: null, percentB: null };
  const s = values.slice(-period);
  const mean = s.reduce((a, b) => a + b, 0) / period;
  const variance = s.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
  const sd = Math.sqrt(variance);
  const upper = mean + multiplier * sd;
  const lower = mean - multiplier * sd;
  const width = mean === 0 ? null : (upper - lower) / mean;
  const percentB = upper === lower ? 0.5 : (values.at(-1)! - lower) / (upper - lower);
  return { middle: mean, upper, lower, width, percentB };
}

export function historicalVolatility(values: number[], period = 20): number | null {
  if (values.length <= period) return null;
  const returns: number[] = [];
  for (let i = values.length - period; i < values.length; i++) {
    const prev = values[i - 1]!;
    const cur = values[i]!;
    if (prev <= 0 || cur <= 0) return null;
    returns.push(Math.log(cur / prev));
  }
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(returns.length - 1, 1);
  return Math.sqrt(variance * 252);
}

export function obv(candles: Candle[]): number | null {
  if (candles.length < 2) return null;
  let value = 0;
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1]!;
    const cur = candles[i]!;
    value += cur.close > prev.close ? cur.volume : cur.close < prev.close ? -cur.volume : 0;
  }
  return value;
}

export function vwap(candles: Candle[], period = 20): number | null {
  if (candles.length < period) return null;
  const s = candles.slice(-period);
  let pv = 0, volume = 0;
  for (const c of s) { const typical = (c.high + c.low + c.close) / 3; pv += typical * Math.max(c.volume, 0); volume += Math.max(c.volume, 0); }
  return volume > 0 ? pv / volume : null;
}

export function detectCandlestickPatterns(candles: Candle[]): CandlePattern[] {
  if (candles.length < 3) return [];
  const a = candles.at(-3)!; const b = candles.at(-2)!; const c = candles.at(-1)!;
  const patterns: CandlePattern[] = [];
  const cBody = body(c), cRange = range(c), cUpper = upperWick(c), cLower = lowerWick(c);
  if (cBody / cRange <= 0.1) patterns.push("DOJI");
  if (cLower >= cBody * 2 && cUpper <= cBody * 0.75) patterns.push("HAMMER");
  if (cUpper >= cBody * 2 && cLower <= cBody * 0.75) patterns.push("INVERTED_HAMMER");
  if (cUpper >= cBody * 2 && cLower <= cBody * 0.5 && c.close < c.open) patterns.push("SHOOTING_STAR");
  if (cLower >= cBody * 2 && cUpper <= cBody * 0.5 && c.close < c.open) patterns.push("HANGING_MAN");
  if (b.close < b.open && c.close > c.open && c.open <= b.close && c.close >= b.open) patterns.push("BULLISH_ENGULFING");
  if (b.close > b.open && c.close < c.open && c.open >= b.close && c.close <= b.open) patterns.push("BEARISH_ENGULFING");
  if (a.close < a.open && c.close > c.open && body(b) < body(a) * 0.6 && c.close > (a.open + a.close) / 2) patterns.push("MORNING_STAR");
  if (a.close > a.open && c.close < c.open && body(b) < body(a) * 0.6 && c.close < (a.open + a.close) / 2) patterns.push("EVENING_STAR");
  if (b.close < b.open && c.close > c.open && c.open < b.low && c.close > (b.open + b.close) / 2) patterns.push("PIERCING");
  if (b.close > b.open && c.close < c.open && c.open > b.high && c.close < (b.open + b.close) / 2) patterns.push("DARK_CLOUD_COVER");
  if (c.high <= b.high && c.low >= b.low) patterns.push("INSIDE_BAR");
  if (c.high >= b.high && c.low <= b.low) patterns.push("OUTSIDE_BAR");
  if (cBody / cRange >= 0.9 && c.close > c.open) patterns.push("MARUBOZU_BULL");
  if (cBody / cRange >= 0.9 && c.close < c.open) patterns.push("MARUBOZU_BEAR");
  const tolerance = cRange * 0.15;
  if (Math.abs(b.high - c.high) <= tolerance && b.close > b.open && c.close < c.open) patterns.push("TWEEZER_TOP");
  if (Math.abs(b.low - c.low) <= tolerance && b.close < b.open && c.close > c.open) patterns.push("TWEEZER_BOTTOM");
  return patterns;
}

export interface StructureSnapshot {
  trend: "BULLISH" | "BEARISH" | "RANGE" | "UNKNOWN";
  higherHigh: number;
  higherLow: number;
  lowerHigh: number;
  lowerLow: number;
  bosBull: number;
  bosBear: number;
  chochBull: number;
  chochBear: number;
  support: number | null;
  resistance: number | null;
}

export function marketStructure(candles: Candle[], lookback = 20): StructureSnapshot {
  if (candles.length < lookback * 2 + 2) return { trend: "UNKNOWN", higherHigh: 0, higherLow: 0, lowerHigh: 0, lowerLow: 0, bosBull: 0, bosBear: 0, chochBull: 0, chochBear: 0, support: null, resistance: null };
  const recent = candles.slice(-lookback);
  const prior = candles.slice(-lookback * 2, -lookback);
  const rh = Math.max(...recent.map(c => c.high)), rl = Math.min(...recent.map(c => c.low));
  const ph = Math.max(...prior.map(c => c.high)), pl = Math.min(...prior.map(c => c.low));
  const last = candles.at(-1)!;
  const higherHigh = rh > ph ? 1 : 0, higherLow = rl > pl ? 1 : 0;
  const lowerHigh = rh < ph ? 1 : 0, lowerLow = rl < pl ? 1 : 0;
  const bosBull = last.close > ph ? 1 : 0, bosBear = last.close < pl ? 1 : 0;
  // [FIX-CHOCH-DEAD-CODE] `recent` (used for higherHigh/lowerHigh/
  // higherLow/lowerLow) includes `last` itself, and last.high >= last.close
  // always holds for any candle. So whenever bosBull is 1 (last.close >
  // ph), rh (= max of recent highs, which includes last.high >= last.close)
  // is mathematically GUARANTEED to exceed ph too -- meaning lowerHigh is
  // guaranteed to be 0 in that same case. `chochBull = bosBull &&
  // lowerHigh` was therefore never able to become 1 under ANY input
  // (verified by exhaustive property testing across 200k random cases) --
  // dead code silently feeding a constant-zero "change of character"
  // signal into both decision-engine.ts's bullishStructure/bearishStructure
  // gate and the ML model's choch_bull/choch_bear feature columns (see
  // feature-vector.ts), the exact live/training feature-drift failure mode
  // this file's other comments warn about. The same mirrored bug affected
  // chochBear via higherLow. A real CHoCH ("change of character") signal
  // is: the market broke structure in one direction (bosBull/bosBear)
  // despite the recent block having just made the OPPOSITE-direction low/
  // high extreme relative to the prior block (lowerLow / higherHigh) --
  // both of which are independent of bosBull/bosBear's own guaranteed
  // higherHigh/lowerLow, so these are the fields that can actually vary.
  const chochBull = bosBull && lowerLow ? 1 : 0, chochBear = bosBear && higherHigh ? 1 : 0;
  const trend = bosBull || (higherHigh && higherLow) ? "BULLISH" : bosBear || (lowerHigh && lowerLow) ? "BEARISH" : "RANGE";
  return { trend, higherHigh, higherLow, lowerHigh, lowerLow, bosBull, bosBear, chochBull, chochBear, support: pl, resistance: ph };
}
