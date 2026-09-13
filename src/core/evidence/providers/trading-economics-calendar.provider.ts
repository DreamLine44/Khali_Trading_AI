import { EvidenceObservation, EvidenceKind } from "../types";
import { EvidenceProvider } from "../provider";

export interface TradingEconomicsConfig { apiKey:string; countries?:string[]; timeoutMs?:number; }

// [FIX-CALENDAR-DIRECTION] `surprise = actual - forecast` only tells you
// whether a currency itself got stronger or weaker news — it does NOT
// tell you which way the PAIR moves without knowing whether that
// currency is the base or the quote. For EURUSD (EUR/USD), a
// better-than-expected USD print strengthens USD, which makes EURUSD
// FALL (USD is the quote currency) — i.e. BEARISH for the pair, not
// BULLISH. The previous version mapped surprise>0 to BULLISH
// unconditionally, so every event on the quote currency (roughly half
// of all relevant events for a typical pair) fed an inverted directional
// signal straight into decision-engine.ts's evidence-conflict veto.
//
// Separately, "higher actual than forecast" is not universally good news
// for a currency — for indicators in LOWER_IS_STRONGER below (jobless
// claims, unemployment rate), a higher actual is worse news and implies
// currency WEAKNESS, not strength. For indicators whose sign convention
// is genuinely regime-dependent (inflation/CPI/PPI — a hot print can be
// currency-bullish via rate-hike expectations or currency-bearish via
// growth/stagflation fears, and which one dominates is not something a
// generic surprise-sign rule can determine), we deliberately report
// NEUTRAL rather than guess a direction the data doesn't actually support.
const LOWER_IS_STRONGER: readonly string[] = [
  "unemployment rate", "unemployment claims", "jobless claims", "initial jobless claims", "continuing jobless claims",
];
const AMBIGUOUS_POLARITY: readonly string[] = [
  "inflation", "cpi", "ppi", "price index",
];

/** Official Trading Economics calendar API adapter. Requires an API key. */
export class TradingEconomicsCalendarProvider implements EvidenceProvider {
  readonly name="trading-economics-calendar";
  readonly required=true;
  constructor(private readonly config:TradingEconomicsConfig){ if(!config.apiKey) throw new Error("Trading Economics API key required"); }
  async getObservations(symbol:string, now=Date.now()):Promise<EvidenceObservation[]> {
    const from=new Date(now-24*3600000).toISOString().slice(0,10);
    const to=new Date(now+7*24*3600000).toISOString().slice(0,10);
    const countries=this.config.countries??["united states","euro area","united kingdom","japan","china"];
    const all:any[]=[];
    for(const country of countries){
      const u=new URL(`https://api.tradingeconomics.com/calendar/country/${encodeURIComponent(country)}/${from}/${to}`);
      u.searchParams.set("c",this.config.apiKey); u.searchParams.set("f","json");
      const data=await this.get(u); if(!Array.isArray(data)) throw new Error(`Trading Economics: invalid calendar response for ${country}`); all.push(...data);
    }
    const currencies=new Set([symbol.slice(0,3).toUpperCase(),symbol.slice(-3).toUpperCase()]);
    const base=symbol.slice(0,3).toUpperCase(), quote=symbol.slice(-3).toUpperCase();
    return all.map((e:any)=>{
      const eventTime=Date.parse(String(e.Date??"")); const currency=String(e.Currency??"").toUpperCase();
      const relevant=currencies.has(currency); const importance=Number(e.Importance??0);
      const actual=parseNumber(e.Actual), forecast=parseNumber(e.Forecast), previous=parseNumber(e.Previous);
      const surprise=Number.isFinite(actual)&&Number.isFinite(forecast)?actual-forecast:null;
      const futureEvent=Number.isFinite(eventTime) && eventTime > now;
      const observedAtUtc=futureEvent ? now : (Number.isFinite(eventTime) ? eventTime : now);
      const validUntilUtc=futureEvent ? Math.min(eventTime, now+6*3600000) : Math.max(now+60_000, observedAtUtc+24*3600000);
      const eventLabel=String(e.Event??e.Category??"").toLowerCase();
      const ambiguousPolarity=AMBIGUOUS_POLARITY.some((k)=>eventLabel.includes(k));
      const lowerIsStronger=LOWER_IS_STRONGER.some((k)=>eventLabel.includes(k));
      // Currency-strength surprise: positive means the event's OWN currency
      // got stronger news, after correcting for indicators where a lower
      // actual is the stronger outcome.
      const currencyStrengthSurprise=surprise===null||ambiguousPolarity?null:(lowerIsStronger?-surprise:surprise);
      // Pair direction: base-currency strength moves the pair the same way;
      // quote-currency strength moves the pair the opposite way. An event
      // matching neither base nor quote (shouldn't reach here — filtered by
      // `relevant` below) or matching both (e.g. a same-currency pair) is
      // left unsigned rather than guessed.
      const isBaseCurrency=currency===base, isQuoteCurrency=currency===quote&&currency!==base;
      const pairSurprise=currencyStrengthSurprise===null||!(isBaseCurrency||isQuoteCurrency)?null:(isQuoteCurrency?-currencyStrengthSurprise:currencyStrengthSurprise);
      const direction=pairSurprise === null ? "NEUTRAL" : pairSurprise > 0 ? "BULLISH" : pairSurprise < 0 ? "BEARISH" : "NEUTRAL";
      // Ambiguous-polarity indicators carry no reliable direction, so they
      // shouldn't be scored as confidently as a clean, signed surprise.
      const confidence=!relevant?0.25:ambiguousPolarity?0.4:1;
      return {source:this.name,kind:"ECONOMIC_EVENT" as EvidenceKind,symbol,timeframe:null,observedAtUtc,validUntilUtc,direction:direction as any,strength:relevant?Math.min(1,importance/3):0,confidence,features:{event:String(e.Event??e.Category??""),country:String(e.Country??""),currency,importance,actual:Number.isFinite(actual)?actual:null,forecast:Number.isFinite(forecast)?forecast:null,previous:Number.isFinite(previous)?previous:null,surprise,isBaseCurrency,isQuoteCurrency,lowerIsStronger,ambiguousPolarity,relevant,eventTimeUtc:Number.isFinite(eventTime)?eventTime:null},references:[String(e.URL??e.SourceURL??"")]};
    }).filter((x:any)=>x.features.relevant);
  }
  private async get(url:URL):Promise<any>{ const c=new AbortController(); const t=setTimeout(()=>c.abort(),this.config.timeoutMs??10000); try{const r=await fetch(url,{signal:c.signal,headers:{accept:"application/json"}});if(!r.ok)throw new Error(`HTTP ${r.status}`);return await r.json();}finally{clearTimeout(t);} }
}
function parseNumber(v:unknown):number{const n=Number(String(v??"").replace(/,/g,"").replace(/[^0-9.+-]/g,""));return Number.isFinite(n)?n:NaN;}
