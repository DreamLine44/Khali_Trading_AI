import { Candle, Quote, SymbolTradingSpec, Timeframe } from "../../types";
import { MarketDataProvider } from "./market-data-provider.interface";
import { Mt5FileBridge } from "../../ai-bridge/mt5-file-bridge";

export interface Mt5ConnectionConfig {
  accountId: string;
  server: string;
  commonDirectory: string;
  bridgeSecret: string;
  timeoutMs?: number;
  maxRequestAgeMs?: number;
  /**
   * Required so isConnected() can verify EA identity (magic number, not
   * just account/server) on its own. Previously this class had no way to
   * check magic number at all, and isConnected() took no arguments, so it
   * degraded to a bare PING/PONG with zero identity verification. The only
   * thing standing between "connected" and "connected to the wrong EA/
   * account/server" was run-mt5.ts separately re-checking identity outside
   * this class before each cycle — correct today, but fragile: any other
   * caller of this provider (or a future refactor of run-mt5.ts) would
   * silently lose that protection since nothing in the MarketDataProvider
   * contract required it.
   */
  magicNumber: number;
}

/**
 * MT5 is the authoritative source for bid/ask, spread, symbol specs,
 * account/position state, and execution (spec 6A). This class delegates
 * every call to Mt5FileBridge, which talks to a real, running MT5
 * terminal via the file-based protocol implemented by
 * AITradingBot.mq5 (mt5/Experts/AITradingBot/) — it is a real
 * integration, not a stub or placeholder.
 *
 * It returns no data (throws) if the bridge can't reach a live
 * terminal (isConnected() returns false; getHistoricalCandles /
 * getLatestQuote throw): per spec section 39, this class must never
 * mask a disconnected terminal by returning synthetic or stale data.
 * `isDevProvider` is `false` for exactly this reason — callers may
 * trust its output once `isConnected()` succeeds.
 */
export class Mt5MarketDataProvider implements MarketDataProvider {
  readonly name = "mt5";
  readonly isDevProvider = false;
  private readonly bridge: Mt5FileBridge;
  private readonly config: Mt5ConnectionConfig;

  constructor(config: Mt5ConnectionConfig) {
    if (!config.accountId || !config.server || !config.commonDirectory || !config.bridgeSecret) {
      throw new Error("Mt5MarketDataProvider: missing MT5_ACCOUNT_ID / MT5_SERVER / bridge configuration");
    }
    if (!Number.isInteger(config.magicNumber)) {
      throw new Error("Mt5MarketDataProvider: magicNumber is required to verify EA identity");
    }
    this.config = config;
    this.bridge = new Mt5FileBridge({ commonDirectory: config.commonDirectory, secret: config.bridgeSecret, timeoutMs: config.timeoutMs, maxRequestAgeMs: config.maxRequestAgeMs });
  }

  async getHistoricalCandles(symbol: string, timeframe: Timeframe, count: number): Promise<Candle[]> {
    return this.bridge.getHistoricalCandles(symbol, timeframe, count);
  }

  async getLatestQuote(symbol: string): Promise<Quote> {
    return this.bridge.getLatestQuote(symbol);
  }

  async getTradingSpec(symbol: string, side: "BUY" | "SELL", entryPrice: number, stopLossPrice: number): Promise<SymbolTradingSpec> {
    return this.bridge.getTradingSpec(symbol, side, entryPrice, stopLossPrice);
  }

  async isConnected(): Promise<boolean> {
    return this.bridge.isConnected(this.config.magicNumber, this.config.accountId, this.config.server);
  }
}
