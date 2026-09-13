import { Candle, Quote, Timeframe } from "../../types";
import { MarketDataProvider } from "./market-data-provider.interface";
const INTERVAL:Record<Timeframe,string>={M1:"1m",M5:"5m",M15:"15m",H1:"1h",H4:"4h",D1:"1d"};
export interface BinanceConfig{apiKey?:string;baseUrl?:string;timeoutMs?:number;}
export class BinanceMarketDataProvider implements MarketDataProvider{
 readonly name="binance"; readonly isDevProvider=false;
 constructor(private readonly config:BinanceConfig={}){}
 async getHistoricalCandles(symbol:string,timeframe:Timeframe,count:number):Promise<Candle[]>{
  const url=new URL(`${this.config.baseUrl??"https://data-api.binance.vision"}/api/v3/klines`); url.searchParams.set("symbol",symbol.replace("/","").toUpperCase()); url.searchParams.set("interval",INTERVAL[timeframe]); url.searchParams.set("limit",String(Math.min(count,1000)));
  const rows=await this.get(url); if(!Array.isArray(rows)) throw new Error("Binance: invalid klines response");
  return rows.map((r:any)=>({symbol,timeframe,timestampUtc:Number(r[0]),open:Number(r[1]),high:Number(r[2]),low:Number(r[3]),close:Number(r[4]),volume:Number(r[5]),isClosed:Number(r[6])<Date.now()})).filter((c:Candle)=>c.isClosed&&[c.timestampUtc,c.open,c.high,c.low,c.close,c.volume].every(Number.isFinite));
 }
 async getLatestQuote(symbol:string):Promise<Quote>{const s=symbol.replace("/","").toUpperCase(); const url=new URL(`${this.config.baseUrl??"https://data-api.binance.vision"}/api/v3/ticker/bookTicker`); url.searchParams.set("symbol",s); const q=await this.get(url); const bid=Number(q.bidPrice),ask=Number(q.askPrice); if(!(bid>0&&ask>=bid)) throw new Error("Binance: invalid quote"); return {symbol,timestampUtc:Date.now(),bid,ask,spread:ask-bid};}
 async isConnected(){try{const u=new URL(`${this.config.baseUrl??"https://data-api.binance.vision"}/api/v3/ping`); await this.get(u); return true;}catch{return false;}}
 private async get(url:URL){const c=new AbortController();const t=setTimeout(()=>c.abort(),this.config.timeoutMs??10000);try{const r=await fetch(url,{signal:c.signal,headers:{accept:"application/json",...(this.config.apiKey?{"X-MBX-APIKEY":this.config.apiKey}:{})}});if(!r.ok)throw new Error(`HTTP ${r.status}`);return await r.json();}finally{clearTimeout(t);}}
}
