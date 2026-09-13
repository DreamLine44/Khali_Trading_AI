import * as assert from "assert";
import { Mt5MarketDataProvider } from "../../src/core/market-data/providers/mt5-market-data.provider";

// Regression coverage: isConnected() used to call the bridge with no
// arguments at all, degrading to a bare PING/PONG with zero verification
// that the terminal on the other end is actually running the expected EA
// (magic number) against the expected account/server. The only thing
// protecting against "connected, but to the wrong EA/account" was
// run-mt5.ts separately re-checking identity before each cycle -- correct
// today, but not guaranteed by this class's own contract, so any other
// caller (or a future refactor) could silently lose that protection.
// Mt5MarketDataProvider must now carry and enforce its own expected
// identity.

async function testMissingMagicNumberIsRejectedAtConstruction() {
  assert.throws(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    new Mt5MarketDataProvider({
      accountId: "12345",
      server: "Broker-Live",
      commonDirectory: "/tmp/mt5-common",
      bridgeSecret: "secret",
    } as any);
  }, /magicNumber is required/);
}

async function testIsConnectedPassesFullIdentityToTheBridge() {
  const provider = new Mt5MarketDataProvider({
    accountId: "12345",
    server: "Broker-Live",
    commonDirectory: "/tmp/mt5-common-" + Date.now(),
    bridgeSecret: "a-secret-at-least-16-chars",
    magicNumber: 26090601,
  });

  const bridge = (provider as unknown as { bridge: { isConnected: (...args: unknown[]) => Promise<boolean> } }).bridge;
  let capturedArgs: unknown[] = [];
  bridge.isConnected = async (...args: unknown[]) => {
    capturedArgs = args;
    return true;
  };

  const connected = await provider.isConnected();
  assert.strictEqual(connected, true);
  assert.deepStrictEqual(
    capturedArgs,
    [26090601, "12345", "Broker-Live"],
    "isConnected() must verify magic number, account, and server itself, not just PING/PONG",
  );
}

async function main() {
  await testMissingMagicNumberIsRejectedAtConstruction();
  await testIsConnectedPassesFullIdentityToTheBridge();
  console.log("Mt5MarketDataProvider identity-verification regression tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
