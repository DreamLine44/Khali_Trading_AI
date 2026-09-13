import { Candle, Quote, Timeframe } from "../../types";
import { MarketDataProvider } from "./market-data-provider.interface";

export interface VendorConnectionConfig {
  apiKey: string;
  /**
   * Which vendor implementation to call. Left as a string rather than a
   * hard-coded union so a new vendor can be added without touching this
   * interface — per spec 6A, no vendor is locked in at the architecture
   * level. Evaluate coverage/quality/cost/latency before picking one.
   */
  vendorId: string;
  endpoint: string;
  timeoutMs?: number;
  /**
   * [FIX-HARDCODED-PROBE-SYMBOL] isConnected() used to always probe a
   * hardcoded "EURUSD" regardless of which symbol this instance actually
   * trades. Unlike TwelveData, a generic vendor endpoint has no guaranteed
   * baseline pair — a vendor specializing in, say, only exotic or metal
   * pairs may genuinely not carry EURUSD at all, which would make
   * isConnected() report false for a vendor that's perfectly healthy for
   * the symbol actually being traded. Defaults to "EURUSD" (unchanged
   * behavior) when the caller doesn't pass the real trading symbol.
   */
  probeSymbol?: string;
}

/**
 * Research/historical data provider — deep OHLCV history, additional
 * symbols/timeframes for backtesting and feature research. Per spec 6A
 * this is explicitly NOT authoritative for bid/ask, spread, or account
 * state; that always comes from MT5 (Mt5MarketDataProvider).
 *
 * The configured endpoint must be an authorized adapter returning the
 * normalized response shape documented in README_FILES/docs/market-data.md. Vendor
 * authentication and vendor-specific mapping belong outside this core.
 */
export class VendorMarketDataProvider implements MarketDataProvider {
  readonly name: string;
  readonly isDevProvider = false;

  constructor(private readonly config: VendorConnectionConfig) {
    if (!config.apiKey || !config.vendorId || !config.endpoint) {
      throw new Error("VendorMarketDataProvider: missing API key, vendor ID, or endpoint");
    }
    this.name = `vendor:${config.vendorId}`;
  }

  async getHistoricalCandles(symbol: string, timeframe: Timeframe, count: number): Promise<Candle[]> {
    const payload = await this.fetchJson(symbol, timeframe, count);
    if (!Array.isArray(payload.candles)) throw new Error(`${this.name}: normalized response has no candles array`);
    const candles = payload.candles
      .map((c: Partial<Candle>) => ({ ...c, symbol, timeframe }))
      .filter((c): c is Candle => (
        c.isClosed === true
        && Number.isFinite(c.timestampUtc)
        && Number.isFinite(c.open)
        && Number.isFinite(c.high)
        && Number.isFinite(c.low)
        && Number.isFinite(c.close)
        && Number.isFinite(c.volume)
      ));
    if (candles.length !== payload.candles.length || candles.length === 0) throw new Error(`${this.name}: response contains no valid closed candles`);
    if (!candles.every((c) => [c.timestampUtc, c.open, c.high, c.low, c.close, c.volume].every(Number.isFinite))) throw new Error(`${this.name}: response contains non-finite candles`);
    return candles;
  }

  async getLatestQuote(symbol: string): Promise<Quote> {
    const payload = await this.fetchJson(symbol, "M1", 1);
    const quote = payload.quote as Partial<Quote> | undefined;
    const { timestampUtc, bid, ask, spread } = quote ?? {};
    if (
      !quote ||
      quote.symbol !== symbol ||
      typeof timestampUtc !== "number" || !Number.isFinite(timestampUtc) ||
      typeof bid !== "number" || !Number.isFinite(bid) ||
      typeof ask !== "number" || !Number.isFinite(ask) ||
      typeof spread !== "number" || !Number.isFinite(spread)
    ) {
      throw new Error(`${this.name}: invalid normalized quote`);
    }
    if (bid <= 0 || ask < bid || spread < 0) throw new Error(`${this.name}: invalid normalized quote values`);
    return quote as Quote;
  }

  async isConnected(): Promise<boolean> {
    try {
      await this.fetchJson(this.config.probeSymbol ?? "EURUSD", "M1", 1);
      return true;
    } catch {
      return false;
    }
  }

  private async fetchJson(symbol: string, timeframe: Timeframe, count: number): Promise<{ candles?: Candle[]; quote?: Quote }> {
    const url = new URL(this.config.endpoint);
    url.searchParams.set("symbol", symbol);
    url.searchParams.set("timeframe", timeframe);
    url.searchParams.set("count", String(count));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 5000);
    try {
      const response = await fetch(url, { signal: controller.signal, headers: { accept: "application/json", authorization: `Bearer ${this.config.apiKey}` } });
      if (!response.ok) throw new Error(`${this.name}: HTTP ${response.status}`);
      return await response.json() as { candles?: Candle[]; quote?: Quote };
    } finally {
      clearTimeout(timeout);
    }
  }
}
