import * as assert from "assert";
import { TradingEconomicsCalendarProvider } from "../../src/core/evidence/providers/trading-economics-calendar.provider";

// [FIX-CALENDAR-DIRECTION] `surprise = actual - forecast` only tells you
// whether a currency itself got stronger news, not which way a PAIR moves —
// that also depends on whether the currency is the base or the quote. This
// test locks in that a positive USD surprise is BEARISH for EURUSD (USD is
// the quote currency), not BULLISH as an unconditional surprise>0 rule would
// wrongly report.
async function testQuoteCurrencySurpriseIsInverted() {
  const originalFetch = globalThis.fetch;
  const now = 1_700_000_000_000;
  (globalThis as any).fetch = async () => ({
    ok: true,
    json: async () => ([
      {
        Date: new Date(now - 3600_000).toISOString(),
        Currency: "USD",
        Country: "United States",
        Event: "Retail Sales",
        Importance: 3,
        Actual: "0.9",
        Forecast: "0.5",
        Previous: "0.4",
      },
    ]),
  });
  try {
    const provider = new TradingEconomicsCalendarProvider({ apiKey: "test-key", countries: ["united states"] });
    const [observation] = await provider.getObservations("EURUSD", now);
    assert.ok(observation, "expected one observation");
    assert.strictEqual(observation.direction, "BEARISH", "a better-than-forecast USD print must be BEARISH for EURUSD, not BULLISH");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testBaseCurrencySurpriseIsNotInverted() {
  const originalFetch = globalThis.fetch;
  const now = 1_700_000_000_000;
  (globalThis as any).fetch = async () => ({
    ok: true,
    json: async () => ([
      {
        Date: new Date(now - 3600_000).toISOString(),
        Currency: "EUR",
        Country: "Euro Area",
        Event: "GDP Growth Rate",
        Importance: 3,
        Actual: "0.9",
        Forecast: "0.5",
        Previous: "0.4",
      },
    ]),
  });
  try {
    const provider = new TradingEconomicsCalendarProvider({ apiKey: "test-key", countries: ["euro area"] });
    const [observation] = await provider.getObservations("EURUSD", now);
    assert.ok(observation, "expected one observation");
    assert.strictEqual(observation.direction, "BULLISH", "a better-than-forecast EUR print must be BULLISH for EURUSD");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// Unemployment rate: a HIGHER actual than forecast is worse news (more
// unemployment), so it must be treated as currency weakness, not strength.
async function testLowerIsStrongerIndicatorIsHandled() {
  const originalFetch = globalThis.fetch;
  const now = 1_700_000_000_000;
  (globalThis as any).fetch = async () => ({
    ok: true,
    json: async () => ([
      {
        Date: new Date(now - 3600_000).toISOString(),
        Currency: "USD",
        Country: "United States",
        Event: "Unemployment Rate",
        Importance: 3,
        Actual: "4.5", // worse (higher) than forecast
        Forecast: "4.0",
        Previous: "4.0",
      },
    ]),
  });
  try {
    const provider = new TradingEconomicsCalendarProvider({ apiKey: "test-key", countries: ["united states"] });
    const [observation] = await provider.getObservations("EURUSD", now);
    assert.ok(observation, "expected one observation");
    // Worse US unemployment -> USD weakness -> quote-currency weakness -> EURUSD BULLISH.
    assert.strictEqual(observation.direction, "BULLISH", "a worse-than-forecast unemployment rate must be read as currency weakness, not strength");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// Inflation-type indicators have genuinely regime-dependent sign conventions
// (hawkish-hike-expectation bullish vs. stagflation-fear bearish) that a
// generic surprise-sign rule cannot resolve — must report NEUTRAL, not guess.
async function testAmbiguousPolarityIndicatorIsNeutral() {
  const originalFetch = globalThis.fetch;
  const now = 1_700_000_000_000;
  (globalThis as any).fetch = async () => ({
    ok: true,
    json: async () => ([
      {
        Date: new Date(now - 3600_000).toISOString(),
        Currency: "USD",
        Country: "United States",
        Event: "Inflation Rate YoY",
        Importance: 3,
        Actual: "3.5",
        Forecast: "3.0",
        Previous: "3.0",
      },
    ]),
  });
  try {
    const provider = new TradingEconomicsCalendarProvider({ apiKey: "test-key", countries: ["united states"] });
    const [observation] = await provider.getObservations("EURUSD", now);
    assert.ok(observation, "expected one observation");
    assert.strictEqual(observation.direction, "NEUTRAL", "an ambiguous-polarity indicator (inflation) must not be assigned a guessed direction");
    assert.ok(observation.confidence < 1, "ambiguous-polarity indicator confidence must be reduced below a clean signed surprise");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

Promise.resolve()
  .then(testQuoteCurrencySurpriseIsInverted)
  .then(testBaseCurrencySurpriseIsNotInverted)
  .then(testLowerIsStrongerIndicatorIsHandled)
  .then(testAmbiguousPolarityIndicatorIsNeutral)
  .then(() => console.log("Trading Economics calendar direction regression tests passed."))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
