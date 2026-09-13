import { EvidenceObservation, EvidenceKind } from "../types";
import { EvidenceProvider } from "../provider";

export interface FinnhubEconomicCalendarConfig { apiKey: string; timeoutMs?: number; }

// Same direction-inference rules as trading-economics-calendar.provider.ts —
// see that file's comment for why surprise sign alone isn't enough (base vs
// quote currency) and why inflation-style prints are deliberately left
// NEUTRAL rather than guessed. Kept in sync manually since Finnhub's payload
// shape (country codes + impact strings) differs enough from Trading
// Economics' (country names + numeric importance) that a shared helper would
// need its own normalization layer for little benefit at this size.
const LOWER_IS_STRONGER: readonly string[] = [
  "unemployment rate", "unemployment claims", "jobless claims", "initial jobless claims", "continuing jobless claims",
];
const AMBIGUOUS_POLARITY: readonly string[] = [
  "inflation", "cpi", "ppi", "price index",
];
const IMPACT_WEIGHT: Record<string, number> = { high: 3, medium: 2, low: 1 };

// Finnhub reports country as a short code/name, not the currency itself.
const COUNTRY_TO_CURRENCY: Record<string, string> = {
  US: "USD", "UNITED STATES": "USD",
  EU: "EUR", "EURO AREA": "EUR", "EUROZONE": "EUR", DE: "EUR", FR: "EUR", IT: "EUR", ES: "EUR", GERMANY: "EUR", FRANCE: "EUR", ITALY: "EUR", SPAIN: "EUR",
  GB: "GBP", UK: "GBP", "UNITED KINGDOM": "GBP",
  JP: "JPY", JAPAN: "JPY",
  CN: "CNY", CHINA: "CNY",
  CA: "CAD", CANADA: "CAD",
  AU: "AUD", AUSTRALIA: "AUD",
  NZ: "NZD", "NEW ZEALAND": "NZD",
  CH: "CHF", SWITZERLAND: "CHF",
};

/** Free-tier Finnhub /calendar/economic adapter — an alternative economic-calendar
 * source to Trading Economics that doesn't require a paid plan. Can run alongside
 * TradingEconomicsCalendarProvider; evidence-aggregator.ts combines whatever
 * sources are configured rather than picking exactly one. */
export class FinnhubEconomicCalendarProvider implements EvidenceProvider {
  readonly name = "finnhub-economic-calendar";
  readonly required = false;
  constructor(private readonly config: FinnhubEconomicCalendarConfig) { if (!config.apiKey) throw new Error("Finnhub API key required"); }

  async getObservations(symbol: string, now = Date.now()): Promise<EvidenceObservation[]> {
    const from = new Date(now - 24 * 3600000).toISOString().slice(0, 10);
    const to = new Date(now + 7 * 24 * 3600000).toISOString().slice(0, 10);
    const u = new URL("https://finnhub.io/api/v1/calendar/economic");
    u.searchParams.set("from", from); u.searchParams.set("to", to); u.searchParams.set("token", this.config.apiKey);
    const c = new AbortController(); const t = setTimeout(() => c.abort(), this.config.timeoutMs ?? 10000);
    let data: any;
    try {
      const r = await fetch(u, { signal: c.signal, headers: { accept: "application/json" } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      data = await r.json();
    } finally { clearTimeout(t); }
    const events: any[] = Array.isArray(data?.economicCalendar) ? data.economicCalendar : [];
    const base = symbol.slice(0, 3).toUpperCase(), quote = symbol.slice(-3).toUpperCase();

    return events.map((e: any): EvidenceObservation => {
      const eventTime = Date.parse(String(e.time ?? ""));
      const currency = COUNTRY_TO_CURRENCY[String(e.country ?? "").toUpperCase()] ?? "";
      const actual = parseNumber(e.actual), forecast = parseNumber(e.estimate), previous = parseNumber(e.prev);
      const surprise = Number.isFinite(actual) && Number.isFinite(forecast) ? actual - forecast : null;
      const futureEvent = Number.isFinite(eventTime) && eventTime > now;
      const observedAtUtc = futureEvent ? now : (Number.isFinite(eventTime) ? eventTime : now);
      const validUntilUtc = futureEvent ? Math.min(eventTime, now + 6 * 3600000) : Math.max(now + 60_000, observedAtUtc + 24 * 3600000);
      const eventLabel = String(e.event ?? "").toLowerCase();
      const ambiguousPolarity = AMBIGUOUS_POLARITY.some((k) => eventLabel.includes(k));
      const lowerIsStronger = LOWER_IS_STRONGER.some((k) => eventLabel.includes(k));
      const isBaseCurrency = currency === base, isQuoteCurrency = currency === quote && currency !== base;
      const relevant = isBaseCurrency || isQuoteCurrency;
      const currencyStrengthSurprise = surprise === null || ambiguousPolarity ? null : (lowerIsStronger ? -surprise : surprise);
      const pairSurprise = currencyStrengthSurprise === null || !relevant ? null : (isQuoteCurrency ? -currencyStrengthSurprise : currencyStrengthSurprise);
      const direction = pairSurprise === null ? "NEUTRAL" : pairSurprise > 0 ? "BULLISH" : pairSurprise < 0 ? "BEARISH" : "NEUTRAL";
      const importance = IMPACT_WEIGHT[String(e.impact ?? "").toLowerCase()] ?? 0;
      const confidence = !relevant ? 0.25 : ambiguousPolarity ? 0.4 : 1;
      return {
        source: this.name, kind: "ECONOMIC_EVENT" as EvidenceKind, symbol, timeframe: null,
        observedAtUtc, validUntilUtc, direction: direction as any, strength: relevant ? Math.min(1, importance / 3) : 0, confidence,
        features: { event: String(e.event ?? ""), country: String(e.country ?? ""), currency, importance, actual: Number.isFinite(actual) ? actual : null, forecast: Number.isFinite(forecast) ? forecast : null, previous: Number.isFinite(previous) ? previous : null, surprise, isBaseCurrency, isQuoteCurrency, lowerIsStronger, ambiguousPolarity, relevant, eventTimeUtc: Number.isFinite(eventTime) ? eventTime : null },
        references: [],
      };
    }).filter((x) => x.features.relevant);
  }
}

function parseNumber(v: unknown): number { const n = Number(String(v ?? "").replace(/,/g, "").replace(/[^0-9.+-]/g, "")); return Number.isFinite(n) ? n : NaN; }
