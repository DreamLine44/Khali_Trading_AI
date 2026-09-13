import * as assert from "assert";
import { aggregateEvidence } from "../../src/core/evidence/evidence-aggregator";
import { collectEvidence } from "../../src/core/evidence/evidence-service";
import { EvidenceProvider } from "../../src/core/evidence/provider";
import { EvidenceObservation } from "../../src/core/evidence/types";

const now = 1_700_000_000_000;

function observation(overrides: Partial<EvidenceObservation> = {}): EvidenceObservation {
  return {
    source: "delta",
    kind: "MARKET_STRUCTURE",
    symbol: "EURUSD",
    timeframe: "M15",
    observedAtUtc: now - 1_000,
    validUntilUtc: now + 60_000,
    direction: "BULLISH",
    strength: 0.8,
    confidence: 0.8,
    features: {},
    references: ["provider-reference"],
    ...overrides,
  };
}

function provider(name: string, required: boolean, result: EvidenceObservation[] | Error): EvidenceProvider {
  return {
    name,
    required,
    async getObservations() {
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

function testFreshEvidenceAggregates() {
  const snapshot = aggregateEvidence("EURUSD", [observation()], now);
  assert.strictEqual(snapshot.quality.freshSourceCount, 1);
  assert.strictEqual(snapshot.quality.invalidSources.length, 0);
  assert.strictEqual(snapshot.quality.confidence, 1);
  assert.strictEqual(snapshot.regime, "UNKNOWN");
}

function testStaleAndInvalidEvidenceIsRejected() {
  const snapshot = aggregateEvidence("EURUSD", [
    observation({ source: "stale", validUntilUtc: now - 1 }),
    observation({ source: "bad-symbol", symbol: "BTCUSDT" }),
    observation({ source: "bad-confidence", confidence: 2 }),
  ], now);
  assert.strictEqual(snapshot.observations.length, 0);
  assert.ok(snapshot.quality.staleSources.includes("stale"));
  assert.ok(snapshot.quality.invalidSources.includes("bad-symbol"));
  assert.ok(snapshot.quality.invalidSources.includes("bad-confidence"));
}

function testConflictingEvidenceIsMeasured() {
  const snapshot = aggregateEvidence("EURUSD", [
    observation({ source: "bull", strength: 1, confidence: 1, direction: "BULLISH" }),
    observation({ source: "bear", strength: 1, confidence: 1, direction: "BEARISH" }),
  ], now);
  assert.strictEqual(snapshot.quality.conflictScore, 1);
  assert.strictEqual(snapshot.quality.confidence, 0);
}

function testNeutralOnlyEvidenceIsNotTreatedAsConflict() {
  // A quiet economic calendar / near-zero news sentiment reports NEUTRAL,
  // not "conflicting" — this must not trip the decision engine's
  // conflictScore > 0.75 veto (see evidence-aggregator.ts).
  const snapshot = aggregateEvidence("EURUSD", [
    observation({ source: "calendar", direction: "NEUTRAL", strength: 0, confidence: 1 }),
  ], now);
  assert.strictEqual(snapshot.quality.freshSourceCount, 1);
  assert.strictEqual(snapshot.quality.conflictScore, 0);
}

async function testProviderFailurePolicy() {
  const optional = await collectEvidence("EURUSD", [provider("binance", false, new Error("unavailable")), provider("delta", true, [observation()])], now);
  assert.strictEqual(optional.quality.freshSourceCount, 1);
  assert.strictEqual(optional.quality.unavailableSources.length, 1);

  const required = await collectEvidence("EURUSD", [provider("delta", true, new Error("unavailable"))], now);
  assert.strictEqual(required.quality.freshSourceCount, 0);
  assert.ok(required.quality.invalidSources.length > 0);
}

async function testRequiredProviderFailureDoesNotDiscardOtherSources() {
  // [REGRESSION] A required provider failing partway through the list must
  // not erase observations already collected from other (successful)
  // sources, nor skip providers still queued after it.
  const snapshot = await collectEvidence("EURUSD", [
    provider("alpha-vantage", false, [observation({ source: "alpha-vantage", direction: "BULLISH", strength: 1, confidence: 1 })]),
    provider("trading-economics", true, new Error("HTTP 503")),
    provider("finnhub-economic-calendar", false, [observation({ source: "finnhub-economic-calendar", direction: "BULLISH", strength: 1, confidence: 1 })]),
  ], now);
  assert.strictEqual(snapshot.quality.freshSourceCount, 2);
  assert.ok(snapshot.quality.unavailableSources.some((s) => s.includes("trading-economics")));
}

async function testProvidersFetchConcurrentlyNotSequentially() {
  // [FIX-EVIDENCE-PARALLEL-FETCH] Regression coverage: multiple providers
  // must be fetched concurrently, not one after another. A sequential
  // implementation takes roughly the SUM of each provider's delay; a
  // concurrent one takes roughly the MAX.
  const DELAY_MS = 150;
  const slowProvider = (name: string): EvidenceProvider => ({
    name,
    required: false,
    async getObservations() {
      await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
      return [observation({ source: name })];
    },
  });

  const started = Date.now();
  const snapshot = await collectEvidence("EURUSD", [slowProvider("a"), slowProvider("b"), slowProvider("c")], now);
  const elapsedMs = Date.now() - started;

  assert.strictEqual(snapshot.quality.freshSourceCount, 3);
  assert.ok(elapsedMs < DELAY_MS * 3, `expected concurrent fetch to finish well under ${DELAY_MS * 3}ms, took ${elapsedMs}ms`);
}

testFreshEvidenceAggregates();
testStaleAndInvalidEvidenceIsRejected();
testConflictingEvidenceIsMeasured();
testNeutralOnlyEvidenceIsNotTreatedAsConflict();
Promise.all([testProviderFailurePolicy(), testRequiredProviderFailureDoesNotDiscardOtherSources(), testProvidersFetchConcurrentlyNotSequentially()]).then(() => console.log("All evidence quality tests passed.")).catch((error) => {
  console.error(error);
  throw error;
});
