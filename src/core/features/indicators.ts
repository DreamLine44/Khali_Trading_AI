import { Candle } from "../types";

/** All indicators return null when there isn't enough history — callers
 * must treat null as "insufficient data", never coerce to 0. */

export function sma(closes: number[], period: number): number | null {
  if (closes.length < period) return null;
  const slice = closes.slice(closes.length - period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

export function ema(closes: number[], period: number): number | null {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let emaVal = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    const c = closes[i];
    if (c === undefined) continue;
    emaVal = c * k + emaVal * (1 - k);
  }
  return emaVal;
}

export function rsi(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const cur = closes[i];
    const prev = closes[i - 1];
    if (cur === undefined || prev === undefined) continue;
    const delta = cur - prev;
    if (delta >= 0) gains += delta;
    else losses -= delta;
  }
  if (losses === 0) return 100;
  const rs = gains / period / (losses / period);
  return 100 - 100 / (1 + rs);
}

export function atr(candles: Candle[], period = 14): number | null {
  if (candles.length < period + 1) return null;
  const trueRanges: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const cur = candles[i];
    const prev = candles[i - 1];
    if (cur === undefined || prev === undefined) continue;
    const tr = Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prev.close),
      Math.abs(cur.low - prev.close)
    );
    trueRanges.push(tr);
  }
  const slice = trueRanges.slice(trueRanges.length - period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

/**
 * Swing high/low as the rolling max/min high/low over `lookback` candles.
 *
 * [FIX-STALE-PLACEHOLDER-COMMENT] This used to be marked as a placeholder
 * "before this feeds real decisions" — but feature-engine.ts already wires
 * its output directly into swingHigh/swingLow/swingHighDist/swingLowDist/
 * bosBull/bosBear, which are real FeatureSet fields consumed by both the
 * deterministic engine and the ML model on every live/paper cycle. That
 * comment was stale and actively misleading: this is not gated off from
 * real decisions, it already is one. As with priorSwingHighLow below, any
 * change to this calculation must be mirrored exactly in
 * ai/training/preprocessing/build_dataset.py's `_swing_levels`, or live
 * predictions will drift from what the model was trained on.
 */
export function swingHighLow(candles: Candle[], lookback = 20): { high: number | null; low: number | null } {
  if (candles.length < lookback) return { high: null, low: null };
  const window = candles.slice(candles.length - lookback);
  return {
    high: Math.max(...window.map((c) => c.high)),
    low: Math.min(...window.map((c) => c.low)),
  };
}

/**
 * Prior-bar swing high/low: the same window as swingHighLow, but
 * evaluated over the `lookback` candles BEFORE the most recent one
 * (i.e. excludes the current/last candle). This is what makes "did the
 * latest close break structure" a real comparison against a range that
 * was already established, rather than a range that includes the very
 * bar being tested. Must mirror ai/training/preprocessing/build_dataset.py
 * `_swing_levels` (high.shift(1).rolling(lookback).max()) exactly, or
 * live predictions will drift from what the model was trained on.
 */
export function priorSwingHighLow(candles: Candle[], lookback = 20): { high: number | null; low: number | null } {
  if (candles.length < lookback + 1) return { high: null, low: null };
  const withoutLast = candles.slice(0, candles.length - 1);
  return swingHighLow(withoutLast, lookback);
}

/** Wilder's ADX (trend strength, no direction): rolling-mean smoothing
 * of +DM/-DM/TR over `period`, then a rolling mean of DX over `period`
 * — mirrors build_dataset.py `_adx` bar-for-bar (same simple-rolling-
 * mean approximation of Wilder's method used there and in rsi()/atr()
 * above). Needs 2*period candles of history; keep both in sync if
 * either changes. */
export function adx(candles: Candle[], period = 14): number | null {
  if (candles.length < 2 * period + 1) return null;

  const plusDm: number[] = [];
  const minusDm: number[] = [];
  const trueRanges: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const cur = candles[i];
    const prev = candles[i - 1];
    if (cur === undefined || prev === undefined) continue;
    const upMove = cur.high - prev.high;
    const downMove = prev.low - cur.low;
    plusDm.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDm.push(downMove > upMove && downMove > 0 ? downMove : 0);
    trueRanges.push(Math.max(cur.high - cur.low, Math.abs(cur.high - prev.close), Math.abs(cur.low - prev.close)));
  }

  const rollingMean = (values: number[], w: number): (number | null)[] =>
    values.map((_, i) => (i < w - 1 ? null : values.slice(i - w + 1, i + 1).reduce((a, b) => a + b, 0) / w));

  const trSmooth = rollingMean(trueRanges, period);
  const plusDmSmooth = rollingMean(plusDm, period);
  const minusDmSmooth = rollingMean(minusDm, period);

  const dx: number[] = [];
  for (let i = 0; i < trSmooth.length; i++) {
    const tr = trSmooth[i];
    const pDm = plusDmSmooth[i];
    const mDm = minusDmSmooth[i];
    if (tr === null || tr === undefined || pDm === null || pDm === undefined || mDm === null || mDm === undefined || tr === 0) continue;
    const plusDi = (100 * pDm) / tr;
    const minusDi = (100 * mDm) / tr;
    const diSum = plusDi + minusDi;
    dx.push(diSum === 0 ? 0 : (100 * Math.abs(plusDi - minusDi)) / diSum);
  }
  if (dx.length < period) return 0; // not enough directional history yet -> no trend strength, matches fillna(0) in Python
  const lastDx = dx.slice(dx.length - period);
  return lastDx.reduce((a, b) => a + b, 0) / period;
}

/** (swingHigh - swingLow) / close over the prior-bar window — a
 * consolidation/expansion proxy: small = tight range, large = wide
 * range. Mirrors build_dataset.py's `range_pct`. */
export function rangePct(candles: Candle[], lookback = 20): number | null {
  const { high, low } = priorSwingHighLow(candles, lookback);
  const last = candles[candles.length - 1];
  if (high === null || low === null || !last) return null;
  return (high - low) / last.close;
}

/**
 * Higher-timeframe trend context: close_vs_ema of the most recent HTF
 * bar that had already fully CLOSED as of the last candle's timestamp.
 *
 * HTF bars are grouped by actual UTC clock boundaries
 * (timestampUtc / htfIntervalMs, floored), NOT by position in the
 * `candles` array — a live candle window rarely starts at the same
 * offset training data did, so position-based grouping would silently
 * put different bars into "the same HTF candle" than build_dataset.py
 * did. Clock-boundary grouping is what makes this match
 * ai/training/preprocessing/build_dataset.py `_htf_trend` regardless of
 * where the live window starts — keep both in sync if either changes.
 */
export function htfTrend(candles: Candle[], baseMinutes: number, htfMinutes = 60, emaPeriod = 20): number | null {
  if (htfMinutes % baseMinutes !== 0 || htfMinutes / baseMinutes < 2) return null;
  const htfIntervalMs = htfMinutes * 60_000;

  const bucketCloses = new Map<number, number>(); // bucket -> last close seen in that bucket, in candle order
  for (const c of candles) {
    const bucket = Math.floor(c.timestampUtc / htfIntervalMs);
    bucketCloses.set(bucket, c.close); // later candles overwrite -> "last" close per bucket, matches groupby(...).last()
  }
  const buckets = Array.from(bucketCloses.keys()).sort((a, b) => a - b);
  if (buckets.length < emaPeriod) return null;

  const asOf = candles[candles.length - 1]?.timestampUtc;
  if (asOf === undefined) return null;

  // Latest HTF bar whose close time (bucket end) is <= the current candle's timestamp.
  let usableCount = 0;
  for (let i = 0; i < buckets.length; i++) {
    const closeTime = ((buckets[i] as number) + 1) * htfIntervalMs;
    if (closeTime <= asOf) usableCount = i + 1;
    else break;
  }
  if (usableCount < emaPeriod) return null;

  const usableCloses = buckets.slice(0, usableCount).map((b) => bucketCloses.get(b) as number);
  const htfEma = ema(usableCloses, emaPeriod);
  const latestHtfClose = usableCloses[usableCloses.length - 1];
  if (htfEma === null || latestHtfClose === undefined) return null;
  return (latestHtfClose - htfEma) / htfEma;
}
