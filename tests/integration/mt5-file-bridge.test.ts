import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Mt5FileBridge } from "../../src/core/ai-bridge/mt5-file-bridge";
import { Mt5ExecutionAdapter } from "../../src/execution/adapters/mt5/mt5-execution.adapter";
import { OrderRequest } from "../../src/core/types";

const SECRET = "integration-test-secret-1234";

function order(): OrderRequest {
  return {
    id: "ord_test_1",
    decisionId: "dec_test_1",
    symbol: "EURUSD",
    side: "BUY",
    volume: 0.1,
    stopLoss: 1.09,
    takeProfit: 1.12,
    state: "SUBMITTED",
    createdAtUtc: Date.now(),
    idempotencyKey: "AI_test_12345678901234567890",
    executionEnvironment: "live",
    referencePrice: 1.105,
  };
}

function startFakeTerminal(directory: string, behavior: (request: string[]) => string[]) {
  const timer = setInterval(() => {
    const requestPath = path.join(directory, "ai_trading_request.txt");
    const responsePath = path.join(directory, "ai_trading_response.txt");
    if (!fs.existsSync(requestPath)) return;
    const request = fs.readFileSync(requestPath, "ascii").trim().split("|");
    fs.rmSync(requestPath, { force: true });
    const response = behavior(request);
    fs.writeFileSync(responsePath, response.join("\n") + "\n", "ascii");
  }, 2);
  return () => clearInterval(timer);
}

async function withDirectory<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ai-trading-mt5-"));
  try {
    return await run(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function testProtocolRoundTripAndAdapter() {
  await withDirectory(async (directory) => {
    const stop = startFakeTerminal(directory, (request) => {
      const requestId = request[0]!;
      switch (request[2]) {
        case "PING":
          return [`${requestId}|OK|PONG|26090601|123456|Test-Server|2.0.0`];
        case "HISTORY":
          return [
            `${requestId}|OK|C|1700000000000|1.1|1.11|1.09|1.105|100|1`,
            `${requestId}|OK|C|1700000900000|1.105|1.115|1.1|1.11|120|1`,
          ];
        case "QUOTE":
          return [`${requestId}|OK|Q|1700000900000|1.1099|1.1101|0.0002`];
        case "ACCOUNT":
          return [`${requestId}|OK|A|10000|10100|9000|1`];
        case "SYMBOL":
          return [`${requestId}|OK|S|5|0.00001|0.00001|1|0.01|100|0.01|10|10|100`];
        case "ORDER":
          return [`${requestId}|OK|O|broker-123|deal-456|1.1101|0.1`];
        default:
          return [`${requestId}|ERROR|unsupported operation`];
      }
    });
    try {
      const bridge = new Mt5FileBridge({ commonDirectory: directory, secret: SECRET, timeoutMs: 500, pollMs: 2 });
      assert.strictEqual(await bridge.isConnected(), true);
      assert.strictEqual(await bridge.isConnected(26090601), true);
      assert.strictEqual(await bridge.isConnected(99999999), false);
      const candles = await bridge.getHistoricalCandles("EURUSD", "M15", 2);
      assert.strictEqual(candles.length, 2);
      const quote = await bridge.getLatestQuote("EURUSD");
      assert.strictEqual(quote.ask, 1.1101);
      const spec = await bridge.getTradingSpec("EURUSD", "BUY", quote.ask, quote.ask - 0.0015);
      assert.strictEqual(spec.volumeStep, 0.01);
      assert.strictEqual(spec.lossPerLotAtStop, 100);
      const account = await bridge.getAccount();
      assert.strictEqual(account.account.equity, 10100);
      const result = await new Mt5ExecutionAdapter(bridge).submitOrder(order());
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.brokerOrderId, "broker-123");
      assert.strictEqual(result.filledVolume, 0.1);
    } finally {
      stop();
    }
  });
  console.log("PASS: testProtocolRoundTripAndAdapter");
}

async function testMalformedResponseFailsClosed() {
  await withDirectory(async (directory) => {
    const stop = startFakeTerminal(directory, (request) => [`${request[0]}|OK|Q|bad|1.1|1.2|0.1`]);
    try {
      const bridge = new Mt5FileBridge({ commonDirectory: directory, secret: SECRET, timeoutMs: 200, pollMs: 2 });
      await assert.rejects(() => bridge.getLatestQuote("EURUSD"), /malformed quote/);
    } finally {
      stop();
    }
  });
  console.log("PASS: testMalformedResponseFailsClosed");
}

// [FIX-POSITIONS-FIELD-COUNT] / [FIX-POSITIONS-EMPTY-RESPONSE] regression
// coverage. Neither reconciliation.test.ts (mocks getPositions() directly)
// nor the round-trip test above (never sends a POSITIONS request) actually
// exercised Mt5FileBridge.getPositions()'s real field-parsing logic against
// the wire format AITradingBot.mq5's HandlePositions() actually emits. That
// gap is exactly how the field-count-off-by-one (11 expected vs. 10 actual)
// and the empty-response-on-zero-positions bug both went undetected through
// prior audit passes: getPositions() threw on every call, in every account
// state, on the real live/paper reconciliation path.
async function testGetPositionsParsesRealEaWireFormat() {
  await withDirectory(async (directory) => {
    const stop = startFakeTerminal(directory, (request) => {
      const requestId = request[0]!;
      // Mirrors AITradingBot.mq5's HandlePositions(): zero positions ->
      // a single sentinel "NONE" line (no "P" marker, no position fields).
      return [`${requestId}|OK|NONE`];
    });
    try {
      const bridge = new Mt5FileBridge({ commonDirectory: directory, secret: SECRET, timeoutMs: 500, pollMs: 2 });
      const positions = await bridge.getPositions();
      assert.deepStrictEqual(positions, []);
    } finally {
      stop();
    }
  });

  await withDirectory(async (directory) => {
    const stop = startFakeTerminal(directory, (request) => {
      const requestId = request[0]!;
      // Mirrors HandlePositions()'s actual StringFormat: P|ticket|magic|
      // side|volume|open_price|stop_loss|take_profit|symbol|comment — 10
      // fields including the "P" marker, not 11.
      return [
        `${requestId}|OK|P|555666|26090601|BUY|0.10|1.10500|1.09000|1.12000|EURUSD|ai-bot`,
        `${requestId}|OK|P|555667|26090601|SELL|0.20|1.20000|1.21000|1.18000|GBPUSD|ai-bot`,
      ];
    });
    try {
      const bridge = new Mt5FileBridge({ commonDirectory: directory, secret: SECRET, timeoutMs: 500, pollMs: 2 });
      const positions = await bridge.getPositions();
      assert.strictEqual(positions.length, 2);
      assert.deepStrictEqual(positions[0], {
        ticket: "555666", magic: 26090601, comment: "ai-bot", symbol: "EURUSD",
        side: "BUY", volume: 0.10, openPrice: 1.105, stopLoss: 1.09, takeProfit: 1.12,
      });
      assert.strictEqual(positions[1]!.symbol, "GBPUSD");
      assert.strictEqual(positions[1]!.side, "SELL");
    } finally {
      stop();
    }
  });
  console.log("PASS: testGetPositionsParsesRealEaWireFormat");
}

async function testMismatchedResponseAndTimeoutFailClosed() {
  await withDirectory(async (directory) => {
    const stop = startFakeTerminal(directory, (_request) => [`wrong-request|OK|PONG`]);
    try {
      const bridge = new Mt5FileBridge({ commonDirectory: directory, secret: SECRET, timeoutMs: 100, pollMs: 2 });
      // isConnected() is fail-safe by design: it never rejects, it resolves
      // to false on any error (including a request ID mismatch).
      assert.strictEqual(await bridge.isConnected(), false);
    } finally {
      stop();
    }
  });

  await withDirectory(async (directory) => {
    const bridge = new Mt5FileBridge({ commonDirectory: directory, secret: SECRET, timeoutMs: 30, pollMs: 2 });
    assert.strictEqual(await bridge.isConnected(), false);
  });
  console.log("PASS: testMismatchedResponseAndTimeoutFailClosed");
}

// [FIX-ENTRY-RETRY] submitOrder() must classify failures as retryable only
// when it is certain the broker was never reached (an explicit EA ERROR
// response) and non-retryable for anything ambiguous (a bridge timeout, or
// an OK response the EA sent after Trade.Buy/Sell already succeeded but
// whose fields came back malformed) — see order-manager.ts for how this
// flag gates re-attempting the same decision.
async function testSubmitOrderRetryableClassification() {
  await withDirectory(async (directory) => {
    const stop = startFakeTerminal(directory, (request) => [
      `${request[0]}|ERROR|stop or target violates broker minimum/freeze distance`,
    ]);
    try {
      const bridge = new Mt5FileBridge({ commonDirectory: directory, secret: SECRET, timeoutMs: 500, pollMs: 2 });
      const result = await new Mt5ExecutionAdapter(bridge).submitOrder(order());
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.retryable, true, "an explicit EA-side decline never reached the broker and must be retryable");
    } finally {
      stop();
    }
  });

  await withDirectory(async (directory) => {
    // No fake terminal running at all -> the request will time out, which
    // is the textbook ambiguous case: the broker's true state is unknown.
    const bridge = new Mt5FileBridge({ commonDirectory: directory, secret: SECRET, timeoutMs: 30, pollMs: 2 });
    const result = await new Mt5ExecutionAdapter(bridge).submitOrder(order());
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.retryable, false, "a bridge timeout is ambiguous and must never be treated as retryable");
  });

  await withDirectory(async (directory) => {
    // EA claims OK (meaning Trade.Buy/Sell already succeeded server-side)
    // but the fill fields are garbage -- still ambiguous, must not retry.
    const stop = startFakeTerminal(directory, (request) => [`${request[0]}|OK|O|broker-9|deal-9|not-a-number|0.1`]);
    try {
      const bridge = new Mt5FileBridge({ commonDirectory: directory, secret: SECRET, timeoutMs: 500, pollMs: 2 });
      const result = await new Mt5ExecutionAdapter(bridge).submitOrder(order());
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.retryable, false, "an OK-but-malformed fill means the broker may already hold the position");
    } finally {
      stop();
    }
  });
  console.log("PASS: testSubmitOrderRetryableClassification");
}

async function main() {
  await testProtocolRoundTripAndAdapter();
  await testMalformedResponseFailsClosed();
  await testGetPositionsParsesRealEaWireFormat();
  await testMismatchedResponseAndTimeoutFailClosed();
  await testSubmitOrderRetryableClassification();
  console.log("All MT5 bridge integration and failure tests passed.");
}

main().catch((error) => {
  console.error(error);
  throw error;
});
