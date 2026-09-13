import { MarketDataProvider } from "./market-data-provider.interface";
import { Mt5MarketDataProvider, Mt5ConnectionConfig } from "./mt5-market-data.provider";
import { TwelveDataMarketDataProvider } from "./twelve-data-market-data.provider";
import { BinanceMarketDataProvider } from "./binance-market-data.provider";
import { VendorMarketDataProvider } from "./vendor-market-data.provider";

export function createResearchProvider(kind:string, config:{apiKey?:string;timeoutMs?:number;vendorId?:string;endpoint?:string;probeSymbol?:string}):MarketDataProvider {
  switch(kind.toLowerCase()){
    case "twelvedata": if(!config.apiKey) throw new Error("TWELVE_DATA_API_KEY is required"); return new TwelveDataMarketDataProvider({apiKey:config.apiKey,timeoutMs:config.timeoutMs,probeSymbol:config.probeSymbol});
    case "binance": return new BinanceMarketDataProvider({apiKey:config.apiKey,timeoutMs:config.timeoutMs});
    case "vendor":
      if (!config.apiKey || !config.vendorId || !config.endpoint) throw new Error("vendor provider requires api key, vendor id, and endpoint");
      return new VendorMarketDataProvider({apiKey:config.apiKey,vendorId:config.vendorId,endpoint:config.endpoint,timeoutMs:config.timeoutMs,probeSymbol:config.probeSymbol});
    default: throw new Error(`unsupported research market-data provider: ${kind}`);
  }
}

export function createMt5Provider(config:Mt5ConnectionConfig):MarketDataProvider { return new Mt5MarketDataProvider(config); }
