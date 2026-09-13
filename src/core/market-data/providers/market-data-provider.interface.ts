import { Candle, Quote, SymbolTradingSpec, Timeframe } from "../../types";

export interface MarketDataProvider {
  readonly name: string;
  readonly isDevProvider: boolean;

  getHistoricalCandles(symbol: string, timeframe: Timeframe, count: number): Promise<Candle[]>;
  getLatestQuote(symbol: string): Promise<Quote>;
  /** Broker-authoritative symbol specifications and stop-risk calculation. */
  getTradingSpec?(symbol: string, side: "BUY" | "SELL", entryPrice: number, stopLossPrice: number): Promise<SymbolTradingSpec>;
  isConnected(): Promise<boolean>;
}
