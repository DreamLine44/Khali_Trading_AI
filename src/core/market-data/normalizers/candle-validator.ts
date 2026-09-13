import { Candle, DataQualityReport, Timeframe } from "../../types";

/**
 * Validates a candle series before it is allowed to reach the feature
 * engine. This is the enforcement point for section 6/23 of the spec:
 * if data quality is not OK, the caller MUST treat that as "no new trade",
 * never as "trade with slightly worse data".
 */
export function validateCandles(
  symbol: string,
  timeframe: Timeframe,
  candles: Candle[],
  opts: { maxStaleMs?: number; now?: number; allowWeekendGap?: boolean } = {}
): DataQualityReport {
  const issues: string[] = [];
  const now = opts.now ?? Date.now();
  const maxStaleMs = opts.maxStaleMs ?? timeframeStepMs(timeframe) * 2 + 60_000;

  if (candles.length === 0) {
    return { ok: false, issues: ["no candles supplied"], checkedAt: now };
  }

  const seenTimestamps = new Set<number>();
  let prevTs: number | null = null;
  const expectedStepMs = timeframeStepMs(timeframe);
  const allowWeekendGap = opts.allowWeekendGap ?? symbol.length === 6;

  for (const c of candles) {
    if (c.symbol !== symbol) issues.push(`symbol mismatch: expected ${symbol}, got ${c.symbol}`);
    if (c.timeframe !== timeframe) issues.push(`timeframe mismatch: expected ${timeframe}, got ${c.timeframe}`);
    if (!c.isClosed) {
      issues.push(`unclosed candle at ts=${c.timestampUtc}`);
    }

    if (!Number.isFinite(c.timestampUtc)) {
      issues.push(`non-finite timestamp ${c.timestampUtc}`);
      continue;
    }
    if (c.timestampUtc > now) {
      issues.push(`future timestamp ${c.timestampUtc}`);
    }

    if (![c.open, c.high, c.low, c.close, c.volume].every(Number.isFinite)) {
      issues.push(`non-finite OHLCV at ts=${c.timestampUtc}`);
      continue;
    }
    if (c.open <= 0 || c.high <= 0 || c.low <= 0 || c.close <= 0) {
      issues.push(`non-positive price at ts=${c.timestampUtc}`);
    }
    if (c.high < c.low) {
      issues.push(`high < low at ts=${c.timestampUtc}`);
    }
    if (c.high < c.open || c.high < c.close || c.low > c.open || c.low > c.close) {
      issues.push(`OHLC internally inconsistent at ts=${c.timestampUtc}`);
    }
    if (c.volume < 0) {
      issues.push(`negative volume at ts=${c.timestampUtc}`);
    }

    if (seenTimestamps.has(c.timestampUtc)) {
      issues.push(`duplicate timestamp ${c.timestampUtc}`);
    }
    seenTimestamps.add(c.timestampUtc);

    if (prevTs !== null) {
      const delta = c.timestampUtc - prevTs;
      if (delta <= 0) {
        issues.push(`non-monotonic timestamps around ${c.timestampUtc}`);
      } else if (delta > expectedStepMs * 2) {
        const prevDate = new Date(prevTs);
        const curDate = new Date(c.timestampUtc);
        // [FIX-WEEKEND-GAP-BROKER-VARIANCE] Previously only accepted an
        // exact Friday(5) -> Monday(1) pair. MT5 brokers vary in how they
        // stamp the first bar of the trading week — some use Monday
        // 00:00 server time (day=1), but many stamp the market reopen at
        // Sunday 21:00-22:00 UTC (day=0), and a broker that closes early
        // on Friday can leave a final bar stamped into Saturday (day=6).
        // The narrow Friday->Monday-only check would have flagged every
        // ordinary Sunday-reopen broker's weekly gap as a data-quality
        // failure — forcing NO_TRADE at the start of every single trading
        // week, every week, for those brokers, not as an edge case but as
        // the normal weekly occurrence. Broadened to accept any
        // Friday/Saturday -> Saturday/Sunday/Monday pair, which covers
        // every observed broker convention while still rejecting a
        // same-week midweek gap (e.g. Tuesday -> Thursday), which no
        // combination of these day values can produce.
        const prevDay = prevDate.getUTCDay();
        const curDay = curDate.getUTCDay();
        const weekendGap = allowWeekendGap && (prevDay === 5 || prevDay === 6) && (curDay === 6 || curDay === 0 || curDay === 1);
        if (!weekendGap) issues.push(`gap in series before ts=${c.timestampUtc} (delta=${delta}ms)`);
      }
    }
    prevTs = c.timestampUtc;
  }

  const last = candles[candles.length - 1];
  if (last) {
    if (!last.isClosed) {
      issues.push("latest candle is not closed");
    }
    if (Number.isFinite(last.timestampUtc) && now - last.timestampUtc > maxStaleMs) {
      issues.push(`stale data: last candle is ${(now - last.timestampUtc) / 1000}s old`);
    }
  }

  return { ok: issues.length === 0, issues, checkedAt: now };
}

function timeframeStepMs(tf: Timeframe): number {
  const map: Record<Timeframe, number> = {
    M1: 60_000,
    M5: 5 * 60_000,
    M15: 15 * 60_000,
    H1: 60 * 60_000,
    H4: 4 * 60 * 60_000,
    D1: 24 * 60 * 60_000,
  };
  return map[tf];
}
