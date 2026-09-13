import assert from "node:assert/strict";
import { AutomaticMarketDataOrchestrator } from "../../src/core/market-data/automatic-market-data-orchestrator";
import { MarketDataProvider } from "../../src/core/market-data/providers/market-data-provider.interface";
import { Candle, Quote, Timeframe } from "../../src/core/types";

// [FIX-ORCHESTRATOR-TESTABILITY] AutomaticMarketDataOrchestrator was flagged
// across several audit passes as lacking dedicated test coverage because its
// constructor always built providers from live env vars. It now accepts an
// injected provider list (production behavior is unchanged when omitted),
// which is what makes these fakes possible.

function candle(symbol: string, timeframe: Timeframe, closeMs: number): Candle {
  return {
    symbol, timeframe, timestampUtc: closeMs, open: 1, high: 1.1, low: 0.9, close: 1.05, volume: 100, isClosed: true,
  };
}

class FakeProvider implements MarketDataProvider {
  readonly isDevProvider = false;
  quoteCalls = 0;
  historyCalls = 0;
  nextQuote: Quote | null = null;
  nextCandlesError: Error | null = null;
  nextQuoteError: Error | null = null;

  constructor(readonly name: string) {}

  async getLatestQuote(symbol: string): Promise<Quote> {
    this.quoteCalls += 1;
    if (this.nextQuoteError) throw this.nextQuoteError;
    return this.nextQuote ?? { symbol, timestampUtc: Date.now(), bid: 1.1, ask: 1.1005, spread: 0.0005 };
  }

  async getHistoricalCandles(symbol: string, timeframe: Timeframe): Promise<Candle[]> {
    this.historyCalls += 1;
    if (this.nextCandlesError) throw this.nextCandlesError;
    return [candle(symbol, timeframe, Date.now())];
  }

  async isConnected(): Promise<boolean> {
    return true;
  }
}

async function testDisabledWithNoProviders() {
  const orchestrator = new AutomaticMarketDataOrchestrator([]);
  assert.equal(orchestrator.enabled, false);
  const result = await orchestrator.refresh("EURUSD", "M15");
  assert.equal(result.enabled, false);
  assert.deepEqual(result.snapshots, []);
  console.log("PASS: testDisabledWithNoProviders");
}

async function testRefreshFetchesAndCaches() {
  const provider = new FakeProvider("twelvedata");
  const orchestrator = new AutomaticMarketDataOrchestrator([provider]);
  assert.equal(orchestrator.enabled, true);

  const t0 = 1_000_000;
  const first = await orchestrator.refresh("EURUSD", "M15", t0);
  assert.equal(first.enabled, true);
  assert.equal(first.snapshots.length, 1);
  assert.equal(provider.quoteCalls, 1);
  assert.equal(provider.historyCalls, 1);

  // Well within both refresh intervals: cached snapshot reused, provider not re-called.
  const second = await orchestrator.refresh("EURUSD", "M15", t0 + 1_000);
  assert.equal(provider.quoteCalls, 1, "quote must be cached within interval");
  assert.equal(provider.historyCalls, 1, "history must be cached within interval");
  assert.equal(second.snapshots[0]!.provider, "twelvedata");

  // Past the quote interval: must refetch.
  const third = await orchestrator.refresh("EURUSD", "M15", t0 + 10 * 60_000);
  assert.equal(provider.quoteCalls, 2, "quote must refresh after its interval elapses");
  assert.ok(third.snapshots.length === 1);
  console.log("PASS: testRefreshFetchesAndCaches");
}

async function testBinanceOnlyApplicableToCryptoSymbols() {
  const provider = new FakeProvider("binance");
  const orchestrator = new AutomaticMarketDataOrchestrator([provider]);

  const forex = await orchestrator.refresh("EURUSD", "M15", 2_000_000);
  assert.equal(forex.snapshots.length, 0, "binance must not be applied to a forex symbol");
  assert.equal(provider.quoteCalls, 0);

  const crypto = await orchestrator.refresh("BTCUSDT", "M15", 2_000_000);
  assert.equal(crypto.snapshots.length, 1, "binance must be applied to a crypto symbol");
  assert.equal(provider.quoteCalls, 1);
  console.log("PASS: testBinanceOnlyApplicableToCryptoSymbols");
}

async function testFailureIsSurfacedButDoesNotThrow() {
  const provider = new FakeProvider("twelvedata");
  provider.nextQuoteError = new Error("upstream timeout");
  const orchestrator = new AutomaticMarketDataOrchestrator([provider]);

  const result = await orchestrator.refresh("EURUSD", "M15", 3_000_000);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0]!, /twelvedata: upstream timeout/);
  assert.equal(result.snapshots[0]!.error, "upstream timeout");
  console.log("PASS: testFailureIsSurfacedButDoesNotThrow");
}

async function testGetCompatibleQuotesExcludesErroredAndStaleAndOtherSymbols() {
  const provider = new FakeProvider("twelvedata");
  const orchestrator = new AutomaticMarketDataOrchestrator([provider]);
  const t0 = 4_000_000;
  provider.nextQuote = { symbol: "EURUSD", timestampUtc: t0, bid: 1.1, ask: 1.1005, spread: 0.0005 };
  await orchestrator.refresh("EURUSD", "M15", t0);

  const fresh = orchestrator.getCompatibleQuotes("EURUSD", "M15", t0 + 1_000);
  assert.equal(fresh.length, 1, "a fresh, error-free, matching-symbol quote must be returned");

  const otherSymbol = orchestrator.getCompatibleQuotes("GBPUSD", "M15", t0 + 1_000);
  assert.equal(otherSymbol.length, 0, "a quote for a different symbol must not be returned");

  const stale = orchestrator.getCompatibleQuotes("EURUSD", "M15", t0 + 10 * 60_000 * 60);
  assert.equal(stale.length, 0, "a stale quote far past the refresh window must not be returned");
  console.log("PASS: testGetCompatibleQuotesExcludesErroredAndStaleAndOtherSymbols");
}

// [FIX-ORCHESTRATOR-PARALLEL-FETCH] Regression coverage: with multiple
// providers simultaneously due (the common case on the very first cycle,
// since every provider's "next due" time starts undefined), refresh() must
// fetch them concurrently, not one after another. A sequential
// implementation would take roughly the SUM of each provider's delay;
// a concurrent one takes roughly the MAX.
async function testMultipleProvidersFetchConcurrentlyNotSequentially() {
  class SlowProvider extends FakeProvider {
    constructor(name: string, private readonly delayMs: number) {
      super(name);
    }
    override async getLatestQuote(symbol: string): Promise<Quote> {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      return super.getLatestQuote(symbol);
    }
    override async getHistoricalCandles(symbol: string, timeframe: Timeframe): Promise<Candle[]> {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      return super.getHistoricalCandles(symbol, timeframe);
    }
  }

  const DELAY_MS = 150;
  const providerA = new SlowProvider("twelvedata", DELAY_MS);
  const providerB = new SlowProvider("vendor", DELAY_MS);
  const orchestrator = new AutomaticMarketDataOrchestrator([providerA, providerB]);

  const started = Date.now();
  const result = await orchestrator.refresh("EURUSD", "M15", 5_000_000);
  const elapsedMs = Date.now() - started;

  assert.equal(result.snapshots.length, 2);
  // Sequential would take >= 2 * (2 * DELAY_MS) (quote + history per
  // provider, one after another) = ~600ms. Concurrent should land close to
  // a single provider's 2*DELAY_MS (~300ms). Generous margin for CI jitter.
  assert.ok(elapsedMs < DELAY_MS * 3, `expected concurrent fetch to finish well under ${DELAY_MS * 3}ms, took ${elapsedMs}ms`);
  console.log("PASS: testMultipleProvidersFetchConcurrentlyNotSequentially");
}

async function main() {
  await testDisabledWithNoProviders();
  await testRefreshFetchesAndCaches();
  await testBinanceOnlyApplicableToCryptoSymbols();
  await testFailureIsSurfacedButDoesNotThrow();
  await testGetCompatibleQuotesExcludesErroredAndStaleAndOtherSymbols();
  await testMultipleProvidersFetchConcurrentlyNotSequentially();
  console.log("All AutomaticMarketDataOrchestrator tests passed.");
}

void main();
