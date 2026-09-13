import * as assert from "assert";
import { runOnce } from "../../src/core/orchestration/trading-loop";
import { OrderManager } from "../../src/execution/orders/order-manager";
import { AuditLog } from "../../src/database/audit-log";
import { AccountState } from "../../src/core/risk/risk-engine";
import { Candle, Quote, SymbolTradingSpec } from "../../src/core/types";
import { MarketDataProvider } from "../../src/core/market-data/providers/market-data-provider.interface";
import { ExecutionAdapter } from "../../src/execution/adapters/execution-adapter.interface";
import { AutomaticMarketDataOrchestrator } from "../../src/core/market-data/automatic-market-data-orchestrator";

// Regression coverage: an automatic supplementary-market-data cross-check
// rejection used to be silently overwritten by the unrelated
// getTradingSpec() call that ran right after it -- the trade was still
// correctly blocked either way, but the audit trail's stated reason was
// wrong, which matters when diagnosing why the bot stopped trading.

function candles(symbol: string, timeframe: "M15", count = 60): Candle[] {
  const stepMs = 15 * 60_000;
  const now = Date.now();
  const out: Candle[] = [];
  let price = 1.1;
  for (let i = count; i > 0; i--) {
    const ts = now - i * stepMs;
    price += (i % 2 === 0 ? 1 : -1) * 0.0002;
    out.push({
      symbol,
      timeframe,
      timestampUtc: ts,
      open: price,
      high: price + 0.0006,
      low: price - 0.0006,
      close: price + 0.0001,
      volume: 100,
      isClosed: true,
    });
  }
  return out;
}

class FakeAuditLog implements AuditLog {
  records: any[] = [];
  async append(record: any): Promise<void> {
    this.records.push(record);
  }
}

function fakeDataProvider(): MarketDataProvider {
  return {
    name: "fake",
    isDevProvider: false,
    async getHistoricalCandles(symbol, timeframe) {
      return candles(symbol, timeframe as "M15");
    },
    async getLatestQuote(symbol): Promise<Quote> {
      return { symbol, bid: 1.1049, ask: 1.1051, spread: 0.0002, timestampUtc: Date.now() };
    },
    async getTradingSpec(): Promise<SymbolTradingSpec> {
      return { volumeMin: 0.01, volumeMax: 100, volumeStep: 0.01, point: 0.0001, stopsLevelPoints: 10, lossPerLotAtStop: 10, digits: 5, tickSize: 0.00001, tickValue: 1, freezeLevelPoints: 0 };
    },
    async isConnected() {
      return true;
    },
  };
}

function fakeExecutionAdapter(): ExecutionAdapter {
  return {
    name: "fake-paper",
    isLive: false,
    async submitOrder() {
      return { success: true, brokerOrderId: "b1", filledPrice: 1.105, filledVolume: 0.1, error: null, rawResponse: null };
    },
  };
}

function fakeAutomaticMarketData(): AutomaticMarketDataOrchestrator {
  return {
    enabled: true,
    async refresh() {
      return { enabled: true, snapshots: [], failures: [], fetchedAtUtc: Date.now() };
    },
    getCompatibleQuotes() {
      // Deviates far more than the default 0.5% threshold from the MT5 mid (~1.105).
      return [{ symbol: "EURUSD", bid: 1.2, ask: 1.2002, spread: 0.0002, timestampUtc: Date.now() }];
    },
  } as unknown as AutomaticMarketDataOrchestrator;
}

async function testCrosscheckRejectionReasonSurvives() {
  const account: AccountState = {
    balance: 10000,
    equity: 10000,
    freeMargin: 9000,
    openPositionsCount: 0,
    dailyLossPct: 0,
    currentDrawdownPct: 0,
  };
  const auditLog = new FakeAuditLog();
  const record = await runOnce("EURUSD", "M15", account, {
    dataProvider: fakeDataProvider(),
    executionAdapter: fakeExecutionAdapter(),
    orderManager: new OrderManager(undefined, "paper"),
    auditLog,
    automaticMarketData: fakeAutomaticMarketData(),
    predictionProvider: async () => [{ modelName: "test", modelVersion: "1", action: "BUY", probability: 0.9, uncertainty: 0.05 }],
  });

  assert.strictEqual(record.risk.approved, false, "trade must still be blocked");
  assert.ok(
    record.risk.reasons.some((reason) => reason.includes("supplementary market-data cross-check failed")),
    `expected the crosscheck reason to survive, got: ${JSON.stringify(record.risk.reasons)}`,
  );
  assert.ok(
    !record.risk.reasons.some((reason) => reason.includes("broker trading specification unavailable")),
    "the unrelated getTradingSpec call must not run once the crosscheck has already rejected the trade",
  );
}

async function testCandleFetchEvidenceAndResearchRunConcurrently() {
  // [FIX-ENTRY-LATENCY-PARALLEL-FETCH] Regression coverage: candle history,
  // supplementary market-data refresh, and evidence collection must be
  // fetched concurrently, not one after another. A sequential
  // implementation takes roughly the SUM of each delay; a concurrent one
  // takes roughly the MAX.
  const DELAY_MS = 150;
  const delay = () => new Promise((resolve) => setTimeout(resolve, DELAY_MS));

  const account: AccountState = {
    balance: 10000,
    equity: 10000,
    freeMargin: 9000,
    openPositionsCount: 0,
    dailyLossPct: 0,
    currentDrawdownPct: 0,
  };
  const auditLog = new FakeAuditLog();

  const slowDataProvider: MarketDataProvider = {
    name: "slow-fake",
    isDevProvider: false,
    async getHistoricalCandles(symbol, timeframe) {
      await delay();
      return candles(symbol, timeframe as "M15");
    },
    async getLatestQuote(symbol): Promise<Quote> {
      return { symbol, bid: 1.1049, ask: 1.1051, spread: 0.0002, timestampUtc: Date.now() };
    },
    async getTradingSpec(): Promise<SymbolTradingSpec> {
      return { volumeMin: 0.01, volumeMax: 100, volumeStep: 0.01, point: 0.0001, stopsLevelPoints: 10, lossPerLotAtStop: 10, digits: 5, tickSize: 0.00001, tickValue: 1, freezeLevelPoints: 0 };
    },
    async isConnected() {
      return true;
    },
  };

  const slowAutomaticMarketData = {
    enabled: true,
    async refresh() {
      await delay();
      return { enabled: true, snapshots: [], failures: [], fetchedAtUtc: Date.now() };
    },
    getCompatibleQuotes() {
      return [];
    },
  } as unknown as AutomaticMarketDataOrchestrator;

  const slowEvidenceProvider = {
    name: "slow-evidence",
    required: false,
    async getObservations() {
      await delay();
      return [];
    },
  };

  const started = Date.now();
  await runOnce("EURUSD", "M15", account, {
    dataProvider: slowDataProvider,
    executionAdapter: fakeExecutionAdapter(),
    orderManager: new OrderManager(undefined, "paper"),
    auditLog,
    automaticMarketData: slowAutomaticMarketData,
    evidenceProviders: [slowEvidenceProvider],
    predictionProvider: async () => [],
  });
  const elapsedMs = Date.now() - started;

  assert.ok(elapsedMs < DELAY_MS * 3, `expected concurrent fetch to finish well under ${DELAY_MS * 3}ms, took ${elapsedMs}ms`);
}

testCrosscheckRejectionReasonSurvives()
  .then(() => testCandleFetchEvidenceAndResearchRunConcurrently())
  .then(() => console.log("Trading-loop crosscheck-reason regression test passed."))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
