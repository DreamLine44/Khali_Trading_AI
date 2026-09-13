import { Candle, Quote, Timeframe } from "../../types";
import { MarketDataProvider } from "./market-data-provider.interface";

const INTERVAL: Record<Timeframe,string> = { M1:"1min", M5:"5min", M15:"15min", H1:"1h", H4:"4h", D1:"1day" };

export interface TwelveDataConfig {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  /**
   * [FIX-HARDCODED-PROBE-SYMBOL] isConnected() used to always probe
   * EUR/USD regardless of which symbol this instance actually trades.
   * TwelveData carries EUR/USD on every plan so this rarely misfired in
   * practice, but it was still checking the wrong thing: a provider that
   * genuinely can't serve the configured trading symbol (wrong plan tier,
   * delisted pair, etc.) would still report isConnected()===true, and
   * AutomaticMarketDataOrchestrator's crosscheck would trust a health
   * signal that never actually asked about the pair being traded.
   * Defaults to "EUR/USD" (unchanged behavior) when the caller doesn't
   * pass the real trading symbol.
   */
  probeSymbol?: string;
}

export class TwelveDataMarketDataProvider implements MarketDataProvider {
  readonly name = "twelvedata";
  readonly isDevProvider = false;
  constructor(private readonly config:TwelveDataConfig){ if(!config.apiKey) throw new Error("TwelveData API key required"); }
  async getHistoricalCandles(symbol:string,timeframe:Timeframe,count:number):Promise<Candle[]> {
    const url=new URL(`${this.config.baseUrl??"https://api.twelvedata.com"}/time_series`);
    url.searchParams.set("symbol",symbol.includes("/")?symbol:symbol.length===6?`${symbol.slice(0,3)}/${symbol.slice(3)}`:symbol);
    url.searchParams.set("interval",INTERVAL[timeframe]); url.searchParams.set("outputsize",String(Math.min(count,5000))); url.searchParams.set("apikey",this.config.apiKey); url.searchParams.set("timezone","UTC");
    const data=await this.get(url); if(data.status==="error") throw new Error(`TwelveData: ${data.message??"API error"}`);
    if(!Array.isArray(data.values)) throw new Error("TwelveData: missing values");
    return data.values.map((r:any)=>({symbol,timeframe,timestampUtc:Date.parse(r.datetime),open:Number(r.open),high:Number(r.high),low:Number(r.low),close:Number(r.close),volume:Number(r.volume??0),isClosed:true})).filter((c:Candle)=>[c.timestampUtc,c.open,c.high,c.low,c.close,c.volume].every(Number.isFinite)).reverse();
  }
  async getLatestQuote(symbol:string):Promise<Quote>{
    const url=new URL(`${this.config.baseUrl??"https://api.twelvedata.com"}/quote`); url.searchParams.set("symbol",symbol.includes("/")?symbol:symbol.length===6?`${symbol.slice(0,3)}/${symbol.slice(3)}`:symbol); url.searchParams.set("apikey",this.config.apiKey);
    const q=await this.get(url); const bid=Number(q.bid), ask=Number(q.ask), price=Number(q.close??q.price); if(!Number.isFinite(price)) throw new Error("TwelveData: invalid quote");
    const b=Number.isFinite(bid)?bid:price, a=Number.isFinite(ask)?ask:price; return {symbol,timestampUtc:Date.now(),bid:b,ask:a,spread:Math.max(0,a-b)};
  }
  async isConnected(){ const raw=this.config.probeSymbol??"EUR/USD"; const probe=raw.includes("/")?raw:raw.length===6?`${raw.slice(0,3)}/${raw.slice(3)}`:raw; try { await this.get(new URL(`${this.config.baseUrl??"https://api.twelvedata.com"}/price?symbol=${encodeURIComponent(probe)}&apikey=${encodeURIComponent(this.config.apiKey)}`)); return true; } catch { return false; } }
  private async get(url:URL):Promise<any>{ const c=new AbortController(); const t=setTimeout(()=>c.abort(),this.config.timeoutMs??10000); try{const r=await fetch(url,{signal:c.signal,headers:{accept:"application/json"}}); if(!r.ok) throw new Error(`HTTP ${r.status}`); return await r.json();}finally{clearTimeout(t);} }
}
