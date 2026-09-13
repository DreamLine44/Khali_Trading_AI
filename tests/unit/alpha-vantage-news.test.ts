import * as assert from "assert";
import { AlphaVantageNewsProvider } from "../../src/core/evidence/providers/alpha-vantage-news.provider";

// Alpha Vantage's time_published is "YYYYMMDDTHHMMSS" (UTC, no separators),
// which Date.parse() cannot understand and silently returns NaN for. That
// used to fall through to the `now` fallback, so every article was recorded
// as published "now" regardless of its real age -- staleness checks could
// never age old news out. This test locks in a real parsed timestamp instead
// of the `now` fallback.
async function testRealTimePublishedIsParsedNotFallenBackToNow() {
  const originalFetch = globalThis.fetch;
  const now = 1_700_000_000_000; // 2023-11-14T22:13:20.000Z
  const timePublished = "20231110T090000"; // 2023-11-10T09:00:00Z -- days before `now`

  (globalThis as any).fetch = async () => ({
    ok: true,
    json: async () => ({
      feed: [
        {
          overall_sentiment_score: "0.2",
          time_published: timePublished,
          relevance_score: "0.5",
          title: "Sample headline",
          url: "https://example.com/article",
        },
      ],
    }),
  });

  try {
    const provider = new AlphaVantageNewsProvider({ apiKey: "test-key" });
    const [observation] = await provider.getObservations("EURUSD", now);
    assert.ok(observation, "expected one observation");
    assert.strictEqual(
      observation.observedAtUtc,
      Date.UTC(2023, 10, 10, 9, 0, 0),
      "observedAtUtc should reflect the article's real publish time, not fall back to `now`",
    );
    assert.notStrictEqual(observation.observedAtUtc, now, "must not silently fall back to `now`");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

testRealTimePublishedIsParsedNotFallenBackToNow()
  .then(() => console.log("Alpha Vantage news timestamp regression test passed."))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
