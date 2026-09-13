import * as assert from "assert";
import { validateCandles } from "../../src/core/market-data/normalizers/candle-validator";
import { Candle } from "../../src/core/types";

function candle(timestampUtc: number, overrides: Partial<Candle> = {}): Candle {
  return {
    symbol: "EURUSD",
    timeframe: "M15",
    timestampUtc,
    open: 1.1,
    high: 1.101,
    low: 1.099,
    close: 1.1005,
    volume: 100,
    isClosed: true,
    ...overrides,
  };
}

// Friday 20:00 UTC (day=5) close, Sunday 22:00 UTC (day=0) reopen — the
// common convention for brokers that stamp the first weekly bar at market
// reopen rather than Monday 00:00 server time. Must NOT be flagged as a
// data gap.
function testSundayReopenIsNotFlaggedAsGap() {
  const fridayClose = Date.UTC(2026, 8, 4, 20, 0, 0); // Friday
  const sundayReopen = Date.UTC(2026, 8, 6, 22, 0, 0); // Sunday, ~50h later
  const now = sundayReopen + 15 * 60_000;
  const report = validateCandles(
    "EURUSD",
    "M15",
    [candle(fridayClose), candle(sundayReopen)],
    { now }
  );
  assert.ok(
    !report.issues.some((issue) => issue.includes("gap in series")),
    `expected no gap-in-series issue for Friday->Sunday reopen, got: ${JSON.stringify(report.issues)}`
  );
}

// Friday close, Monday 00:00 UTC reopen — the other common broker
// convention. Must also NOT be flagged.
function testMondayReopenIsNotFlaggedAsGap() {
  const fridayClose = Date.UTC(2026, 8, 4, 21, 0, 0); // Friday
  const mondayReopen = Date.UTC(2026, 8, 7, 0, 0, 0); // Monday
  const now = mondayReopen + 15 * 60_000;
  const report = validateCandles(
    "EURUSD",
    "M15",
    [candle(fridayClose), candle(mondayReopen)],
    { now }
  );
  assert.ok(
    !report.issues.some((issue) => issue.includes("gap in series")),
    `expected no gap-in-series issue for Friday->Monday reopen, got: ${JSON.stringify(report.issues)}`
  );
}

// A genuine midweek gap (Tuesday -> Thursday, market open the whole time)
// must still be flagged — the broadened weekend allowance must not swallow
// a real data outage.
function testMidweekGapIsStillFlagged() {
  const tuesday = Date.UTC(2026, 8, 1, 12, 0, 0); // Tuesday
  const thursday = Date.UTC(2026, 8, 3, 12, 0, 0); // Thursday, 48h later
  const now = thursday + 15 * 60_000;
  const report = validateCandles(
    "EURUSD",
    "M15",
    [candle(tuesday), candle(thursday)],
    { now }
  );
  assert.ok(
    report.issues.some((issue) => issue.includes("gap in series")),
    `expected a gap-in-series issue for a midweek outage, got: ${JSON.stringify(report.issues)}`
  );
}

testSundayReopenIsNotFlaggedAsGap();
testMondayReopenIsNotFlaggedAsGap();
testMidweekGapIsStillFlagged();
console.log("All weekend-gap regression tests passed.");
