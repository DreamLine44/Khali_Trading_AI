import * as assert from "assert";
import { VendorMarketDataProvider } from "../../src/core/market-data/providers/vendor-market-data.provider";
import { TwelveDataMarketDataProvider } from "../../src/core/market-data/providers/twelve-data-market-data.provider";

// [FIX-HARDCODED-PROBE-SYMBOL] Both providers' isConnected() used to always
// probe a hardcoded symbol (EURUSD / EUR/USD) regardless of which pair the
// running instance actually trades. For a generic vendor endpoint that
// genuinely doesn't carry EURUSD (e.g. one specializing in exotic or metal
// pairs), that made a perfectly healthy provider report isConnected()===false
// for the pair that matters, or the reverse: report healthy while the real
// trading symbol was unreachable. These tests lock in that the configured
// probeSymbol is what actually gets requested, not the old hardcoded literal.

async function testVendorProviderProbesConfiguredSymbolNotHardcodedEurUsd() {
  const originalFetch = globalThis.fetch;
  let requestedSymbol: string | null = null;

  (globalThis as any).fetch = async (url: URL) => {
    requestedSymbol = new URL(url).searchParams.get("symbol");
    return {
      ok: true,
      json: async () => ({ quote: { symbol: requestedSymbol, timestampUtc: Date.now(), bid: 1, ask: 1.001, spread: 0.001 } }),
    };
  };

  try {
    const provider = new VendorMarketDataProvider({
      apiKey: "test-key",
      vendorId: "test-vendor",
      endpoint: "https://vendor.example.com/data",
      probeSymbol: "USDJPY",
    });
    const connected = await provider.isConnected();
    assert.strictEqual(connected, true);
    assert.strictEqual(requestedSymbol, "USDJPY", "isConnected() must probe the configured symbol, not a hardcoded EURUSD");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testVendorProviderDefaultsToEurUsdWhenNoProbeSymbolGiven() {
  const originalFetch = globalThis.fetch;
  let requestedSymbol: string | null = null;

  (globalThis as any).fetch = async (url: URL) => {
    requestedSymbol = new URL(url).searchParams.get("symbol");
    return {
      ok: true,
      json: async () => ({ quote: { symbol: requestedSymbol, timestampUtc: Date.now(), bid: 1, ask: 1.001, spread: 0.001 } }),
    };
  };

  try {
    // No probeSymbol passed — must preserve prior behavior exactly.
    const provider = new VendorMarketDataProvider({
      apiKey: "test-key",
      vendorId: "test-vendor",
      endpoint: "https://vendor.example.com/data",
    });
    await provider.isConnected();
    assert.strictEqual(requestedSymbol, "EURUSD", "omitting probeSymbol must preserve the prior EURUSD default");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testTwelveDataProviderProbesConfiguredSymbolInSlashFormat() {
  const originalFetch = globalThis.fetch;
  let requestedUrl: string | null = null;

  (globalThis as any).fetch = async (url: URL) => {
    requestedUrl = url.toString();
    return { ok: true, json: async () => ({ price: "150.123" }) };
  };

  try {
    const provider = new TwelveDataMarketDataProvider({ apiKey: "test-key", probeSymbol: "USDJPY" });
    const connected = await provider.isConnected();
    assert.strictEqual(connected, true);
    assert.ok(requestedUrl !== null, "expected a request to have been made");
    const url = requestedUrl as string;
    assert.ok(url.includes(encodeURIComponent("USD/JPY")), `expected the probe request to use USD/JPY, got: ${url}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function main() {
  await testVendorProviderProbesConfiguredSymbolNotHardcodedEurUsd();
  await testVendorProviderDefaultsToEurUsdWhenNoProbeSymbolGiven();
  await testTwelveDataProviderProbesConfiguredSymbolInSlashFormat();
  console.log("All probe-symbol regression tests passed.");
}

main();
