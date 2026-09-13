import { EvidenceObservation } from "../types";
import { EvidenceProvider } from "../provider";
export interface AlphaVantageNewsConfig{apiKey:string;timeoutMs?:number;}
// Alpha Vantage's time_published is "YYYYMMDDTHHMMSS" (UTC, no separators) —
// not ISO-8601, so Date.parse() silently returns NaN for it. That NaN used
// to fall through to the `now` fallback below, meaning every article was
// recorded as published "now" regardless of its real age: staleness checks
// in evidence-aggregator.ts could never age old news out, and the evidence
// would look artificially fresh on every poll.
function parseAlphaVantageTimestamp(raw: string): number {
 const m=/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(raw);
 if(!m)return NaN;
 const [,y,mo,d,h,mi,s]=m;
 return Date.UTC(Number(y),Number(mo)-1,Number(d),Number(h),Number(mi),Number(s));
}
export class AlphaVantageNewsProvider implements EvidenceProvider{
 readonly name="alpha-vantage-news-sentiment"; readonly required=false;
 constructor(private readonly config:AlphaVantageNewsConfig){if(!config.apiKey)throw new Error("Alpha Vantage API key required");}
 async getObservations(symbol:string,now=Date.now()):Promise<EvidenceObservation[]>{
  const av=symbol.length===6?`FOREX:${symbol.slice(0,3)},FOREX:${symbol.slice(-3)}`:symbol.includes("/")?`FOREX:${symbol.slice(0,3)},FOREX:${symbol.slice(-3)}`:symbol;
  const u=new URL("https://www.alphavantage.co/query");u.searchParams.set("function","NEWS_SENTIMENT");u.searchParams.set("tickers",av);u.searchParams.set("limit","50");u.searchParams.set("apikey",this.config.apiKey);
  const c=new AbortController();const t=setTimeout(()=>c.abort(),this.config.timeoutMs??10000);try{const r=await fetch(u,{signal:c.signal,headers:{accept:"application/json"}});if(!r.ok)throw new Error(`HTTP ${r.status}`);const d:any=await r.json();if(d.Note||d.Information)throw new Error(d.Note??d.Information);if(!Array.isArray(d.feed))throw new Error("Alpha Vantage: missing feed");
   return d.feed.map((x:any)=>{const score=Number(x.overall_sentiment_score);const conf=Math.min(1,Math.abs(score)*2);const dir=score>0.05?"BULLISH":score<-0.05?"BEARISH":"NEUTRAL";const ts=parseAlphaVantageTimestamp(String(x.time_published??""));return {source:this.name,kind:"SENTIMENT",symbol,timeframe:null,observedAtUtc:Number.isFinite(ts)?ts:now,validUntilUtc:now+30*60_000,direction:dir as any,strength:Math.min(1,Math.abs(score)),confidence:conf,features:{sentimentScore:score,relevance:Number(x.relevance_score??0),title:String(x.title??"")},references:[String(x.url??"")]};});
  }finally{clearTimeout(t);}}
}
