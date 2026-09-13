import { env } from "../../config/env";
import { Candle, Quote, Timeframe } from "../types";
import { createResearchProvider } from "./providers/provider-registry";
import { MarketDataProvider } from "./providers/market-data-provider.interface";

export interface ResearchMarketDataSnapshot {
  provider: string;
  applicable: boolean;
  quote: Quote | null;
  candles: Candle[];
  fetchedAtUtc: number;
  nextQuoteFetchAtUtc: number;
  nextHistoryFetchAtUtc: number;
  error: string | null;
}

export interface AutomaticMarketDataResult {
  enabled: boolean;
  snapshots: ResearchMarketDataSnapshot[];
  failures: string[];
  fetchedAtUtc: number;
}

/**
 * Autonomous supplementary market-data acquisition.
 *
 * MT5 remains the execution-authoritative source. This component never
 * replaces MT5 prices and never grants a research provider order authority.
 * It automatically polls configured supplementary providers, caches their
 * latest validated data, respects per-provider refresh intervals, and exposes
 * failures explicitly so the caller can decide whether they are fatal.
 */
export class AutomaticMarketDataOrchestrator {
  private readonly providers: MarketDataProvider[];
  private readonly cache = new Map<string, ResearchMarketDataSnapshot>();
  private readonly quoteIntervalMs: number;
  private readonly historyIntervalMs: number;
  // [FIX-ORCHESTRATOR-TESTABILITY] Whether `enabled` should also re-check
  // the global env flag. False when providers were injected explicitly —
  // otherwise `enabled` silently depended on the ambient env singleton
  // even for an injected provider list, which is the opposite of what an
  // injection seam is for: it meant a unit test's pass/fail could change
  // depending on whatever AUTO_RESEARCH_MARKET_DATA happens to be set to
  // in whatever .env file is sitting on disk when the test runs, not on
  // anything the test itself controls.
  private readonly envGateApplies: boolean;

  constructor(injectedProviders?: MarketDataProvider[]) {
    this.quoteIntervalMs = env.autoResearchQuoteIntervalMs;
    this.historyIntervalMs = env.autoResearchHistoryIntervalMs;

    // An optional injected provider list preserves the exact production
    // behavior (omit the argument) while letting tests pass in fakes.
    if (injectedProviders) {
      this.providers = injectedProviders;
      this.envGateApplies = false;
      return;
    }

    this.envGateApplies = true;
    this.providers = [];

    if (env.autoResearchMarketData) {
      if (env.twelveDataApiKey) {
        this.providers.push(createResearchProvider("twelvedata", {
          apiKey: env.twelveDataApiKey,
          timeoutMs: env.autoResearchTimeoutMs,
          probeSymbol: env.mt5Symbol,
        }));
      }
      if (env.binanceApiKey) {
        this.providers.push(createResearchProvider("binance", {
          apiKey: env.binanceApiKey,
          timeoutMs: env.autoResearchTimeoutMs,
        }));
      }
      if (env.vendorDataApiKey && env.vendorDataProvider !== "mt5" && env.vendorDataEndpoint) {
        this.providers.push(createResearchProvider("vendor", {
          apiKey: env.vendorDataApiKey,
          vendorId: env.vendorDataProvider,
          endpoint: env.vendorDataEndpoint,
          timeoutMs: env.autoResearchTimeoutMs,
          probeSymbol: env.mt5Symbol,
        }));
      }
    }
  }

  get enabled(): boolean {
    return (!this.envGateApplies || env.autoResearchMarketData) && this.providers.length > 0;
  }

  /** Returns the latest validated snapshot for a provider/symbol/timeframe. */
  getSnapshot(providerName: string, symbol: string, timeframe: Timeframe): ResearchMarketDataSnapshot | null {
    return this.cache.get(`${providerName}|${symbol}|${timeframe}`) ?? null;
  }

  /** Returns compatible, currently cached quotes for the requested instrument. */
  getCompatibleQuotes(symbol: string, timeframe: Timeframe, now = Date.now()): Quote[] {
    const quotes: Quote[] = [];
    for (const snapshot of this.cache.values()) {
      if (!snapshot.quote || snapshot.quote.symbol !== symbol) continue;
      if (snapshot.error) continue;
      if (now - snapshot.quote.timestampUtc > this.quoteIntervalMs * 2) continue;
      quotes.push(snapshot.quote);
    }
    return quotes;
  }

  async refresh(symbol: string, timeframe: Timeframe, now = Date.now()): Promise<AutomaticMarketDataResult> {
    if (!this.enabled) return { enabled: false, snapshots: [], failures: [], fetchedAtUtc: now };

    const applicableProviders = this.providers.filter((provider) => this.isApplicable(provider.name, symbol));

    // [FIX-ORCHESTRATOR-PARALLEL-FETCH] Each configured provider is an
    // independent external HTTP call bounded by its own timeout
    // (env.autoResearchTimeoutMs). This previously fetched providers one at
    // a time in a sequential for/await loop despite them having no
    // dependency on each other. Every provider's "next due" time starts
    // undefined, so on the very first live cycle — and periodically
    // afterwards whenever equal-length refresh intervals realign — ALL
    // configured providers become due simultaneously. With N providers due,
    // the old sequential loop could block runOnce() (which awaits this
    // before it will even fetch the MT5 execution quote) for up to N times
    // a single provider's timeout, purely from avoidable added latency on
    // the entry path with no correctness benefit. Fetching concurrently
    // bounds one refresh() call to roughly the single slowest provider.
    const results = await Promise.all(applicableProviders.map(async (provider) => {
      const key = `${provider.name}|${symbol}|${timeframe}`;
      const previous = this.cache.get(key);
      const quoteDue = !previous || now >= previous.nextQuoteFetchAtUtc;
      const historyDue = !previous || now >= previous.nextHistoryFetchAtUtc;

      if (!quoteDue && !historyDue) {
        return { snapshot: previous!, failure: null as string | null };
      }

      let quote = previous?.quote ?? null;
      let candles = previous?.candles ?? [];
      let error: string | null = null;
      let failure: string | null = null;

      try {
        if (quoteDue) quote = await provider.getLatestQuote(symbol);
        if (historyDue) candles = await provider.getHistoricalCandles(symbol, timeframe, env.autoResearchHistoryBars);
        validateQuote(provider.name, symbol, quote);
        validateCandles(provider.name, symbol, timeframe, candles);
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
        failure = `${provider.name}: ${error}`;
      }

      const snapshot: ResearchMarketDataSnapshot = {
        provider: provider.name,
        applicable: true,
        quote,
        candles,
        fetchedAtUtc: now,
        nextQuoteFetchAtUtc: now + this.quoteIntervalMs,
        nextHistoryFetchAtUtc: now + this.historyIntervalMs,
        error,
      };
      this.cache.set(key, snapshot);
      return { snapshot, failure };
    }));

    const snapshots = results.map((r) => r.snapshot);
    const failures = results.map((r) => r.failure).filter((f): f is string => f !== null);

    return { enabled: true, snapshots, failures, fetchedAtUtc: now };
  }

  private isApplicable(providerName: string, symbol: string): boolean {
    if (providerName !== "binance") return true;
    const normalized = symbol.replace(/[/:_-]/g, "").toUpperCase();
    return /(?:USDT|USDC|BTC|ETH|BNB|SOL|XRP|ADA|DOGE)$/.test(normalized);
  }
}

function validateQuote(provider: string, symbol: string, quote: Quote | null): void {
  if (!quote || quote.symbol !== symbol || !Number.isFinite(quote.timestampUtc) || quote.timestampUtc > Date.now()) {
    throw new Error(`${provider}: invalid quote identity/timestamp`);
  }
  if (!(quote.bid > 0 && quote.ask >= quote.bid && Number.isFinite(quote.spread) && quote.spread >= 0)) {
    throw new Error(`${provider}: invalid quote values`);
  }
}

function validateCandles(provider: string, symbol: string, timeframe: Timeframe, candles: Candle[]): void {
  if (candles.length === 0) throw new Error(`${provider}: no valid candles`);
  for (const candle of candles) {
    if (candle.symbol !== symbol || candle.timeframe !== timeframe || !candle.isClosed) {
      throw new Error(`${provider}: invalid candle identity/closed state`);
    }
    if (![candle.timestampUtc, candle.open, candle.high, candle.low, candle.close, candle.volume].every(Number.isFinite)) {
      throw new Error(`${provider}: non-finite candle`);
    }
  }
}
