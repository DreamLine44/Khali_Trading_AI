import { Candle, Quote, Timeframe } from "../../types";
import { MarketDataProvider } from "./market-data-provider.interface";

/**
 * DEVELOPMENT / TEST PROVIDER — NOT REAL MARKET DATA.
 *
 * Generates a deterministic synthetic price series so the rest of the
 * pipeline (validation -> features -> decision -> risk -> paper
 * execution) can be built and tested end-to-end before real credentials
 * for MT5 / Polygon / Twelve Data are wired in.
 *
 * `isDevProvider` is true so downstream code (and the orchestrator) can
 * refuse to run in LIVE mode against this provider. Never remove that
 * flag or route real orders based on this data.
 */
export class DevMarketDataProvider implements MarketDataProvider {
  readonly name = "dev-synthetic";
  readonly isDevProvider = true;

  private readonly seedPrice = 1.1;

  async getHistoricalCandles(symbol: string, timeframe: Timeframe, count: number): Promise<Candle[]> {
    const candles: Candle[] = [];
    const stepMs = timeframeToMs(timeframe);
    const now = Date.now();
    let price = this.seedPrice;

    for (let i = count - 1; i >= 0; i--) {
      // Deterministic pseudo-random walk (seeded by index, not Math.random)
      // so re-running produces identical data for reproducible tests.
      const noise = Math.sin(i * 0.37 + symbol.length) * 0.0015;
      const open = price;
      const close = open + noise;
      const high = Math.max(open, close) + Math.abs(noise) * 0.5;
      const low = Math.min(open, close) - Math.abs(noise) * 0.5;
      price = close;

      candles.push({
        symbol,
        timeframe,
        timestampUtc: now - i * stepMs,
        open,
        high,
        low,
        close,
        volume: 100 + (i % 50),
        isClosed: true,
      });
    }
    return candles;
  }

  async getLatestQuote(symbol: string): Promise<Quote> {
    const spread = 0.0002;
    return {
      symbol,
      timestampUtc: Date.now(),
      bid: this.seedPrice,
      ask: this.seedPrice + spread,
      spread,
    };
  }

  async isConnected(): Promise<boolean> {
    return true;
  }
}

function timeframeToMs(tf: Timeframe): number {
  switch (tf) {
    case "M1":
      return 60_000;
    case "M5":
      return 5 * 60_000;
    case "M15":
      return 15 * 60_000;
    case "H1":
      return 60 * 60_000;
    case "H4":
      return 4 * 60 * 60_000;
    case "D1":
      return 24 * 60 * 60_000;
  }
}
