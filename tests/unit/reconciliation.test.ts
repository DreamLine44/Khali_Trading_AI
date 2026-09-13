import * as assert from "assert";
import { reconcileOrders } from "../../src/execution/orders/reconciliation";
import { Mt5FileBridge, Mt5Position } from "../../src/core/ai-bridge/mt5-file-bridge";
import { OrderStore } from "../../src/database/order-store";
import { OrderRequest, OrderState } from "../../src/core/types";

const MAGIC = 12345;

function fakeBridge(positions: Mt5Position[]): Mt5FileBridge {
  return { getPositions: async () => positions } as unknown as Mt5FileBridge;
}

class FakeOrderStore implements OrderStore {
  orders: OrderRequest[];
  executions: Array<{ orderId: string; brokerOrderId: string; filledPrice: number; filledVolume: number }> = [];
  stateChanges: Array<{ orderId: string; state: OrderState; expectedState?: OrderState }> = [];

  constructor(orders: OrderRequest[]) {
    this.orders = orders;
  }

  async reserve(order: OrderRequest): Promise<OrderRequest | null> {
    this.orders.push(order);
    return order;
  }

  async updateState(orderId: string, state: OrderState, expectedState?: OrderState): Promise<void> {
    const order = this.orders.find((candidate) => candidate.id === orderId);
    if (!order) throw new Error(`order ${orderId} not found`);
    if (expectedState && order.state !== expectedState) {
      throw new Error(`durable order transition rejected for ${orderId}: expected ${expectedState}, was ${order.state}`);
    }
    this.stateChanges.push({ orderId, state, expectedState });
    order.state = state;
  }

  async updateExecution(orderId: string, brokerOrderId: string, filledPrice: number, filledVolume: number): Promise<void> {
    this.executions.push({ orderId, brokerOrderId, filledPrice, filledVolume });
    const order = this.orders.find((candidate) => candidate.id === orderId);
    if (order) {
      order.brokerOrderId = brokerOrderId;
      order.filledPrice = filledPrice;
      order.filledVolume = filledVolume;
    }
  }

  async get(orderId: string): Promise<OrderRequest | null> {
    return this.orders.find((order) => order.id === orderId) ?? null;
  }

  async listActive(): Promise<OrderRequest[]> {
    return this.orders.filter((order) =>
      ["PROPOSED", "VALIDATING", "APPROVED", "SUBMITTED", "CONFIRMED", "PARTIALLY_FILLED", "FILLED"].includes(order.state),
    );
  }

  async listRecentFailedLive(sinceUtc: number): Promise<OrderRequest[]> {
    return this.orders.filter(
      (order) => order.state === "FAILED" && order.executionEnvironment === "live" && order.createdAtUtc >= sinceUtc,
    );
  }
}

function order(overrides: Partial<OrderRequest> = {}): OrderRequest {
  return {
    id: "order-1",
    decisionId: "decision-1",
    symbol: "EURUSD",
    side: "BUY",
    volume: 0.1,
    stopLoss: null,
    takeProfit: null,
    state: "FAILED",
    createdAtUtc: Date.now(),
    idempotencyKey: "idem-1",
    executionEnvironment: "live",
    referencePrice: 1.1,
    ...overrides,
  };
}

function position(overrides: Partial<Mt5Position> = {}): Mt5Position {
  return {
    ticket: "ticket-1",
    magic: MAGIC,
    comment: "idem-1",
    symbol: "EURUSD",
    side: "BUY",
    volume: 0.1,
    openPrice: 1.1005,
    stopLoss: 1.095,
    takeProfit: 1.11,
    ...overrides,
  };
}

async function testRecoversTimedOutButFilledOrder() {
  const failed = order({ state: "FAILED" });
  const store = new FakeOrderStore([failed]);
  const bridge = fakeBridge([position()]);

  const result = await reconcileOrders(bridge, store, MAGIC, 24 * 60 * 60 * 1000);

  assert.strictEqual(failed.state, "FILLED", "the order should be recovered to FILLED");
  assert.strictEqual(store.executions.length, 1, "recovery should record the broker execution");
  assert.strictEqual(store.executions[0]?.brokerOrderId, "ticket-1");
  assert.ok(
    !result.reasons.some((reason) => reason.includes("no matching durable order")),
    "the recovered order should prevent an orphan-position reason",
  );
  assert.strictEqual(result.safe, true, "reconciliation should be safe once the order is recovered");
}

async function testGenuinelyFailedOrderIsLeftAlone() {
  // No matching position at all: this really did fail, and must not be touched.
  const failed = order({ state: "FAILED" });
  const store = new FakeOrderStore([failed]);
  const bridge = fakeBridge([]);

  const result = await reconcileOrders(bridge, store, MAGIC, 24 * 60 * 60 * 1000);

  assert.strictEqual(failed.state, "FAILED", "a genuinely failed order must not be mutated");
  assert.strictEqual(store.executions.length, 0);
  assert.strictEqual(store.stateChanges.length, 0);
  assert.strictEqual(result.safe, true, "an untouched FAILED order is not an orphan and should not trip a reason");
}

async function testOldFailedOrderOutsideLookbackIsIgnored() {
  const old = order({ state: "FAILED", createdAtUtc: Date.now() - 48 * 60 * 60 * 1000 });
  const store = new FakeOrderStore([old]);
  const bridge = fakeBridge([position()]);

  await reconcileOrders(bridge, store, MAGIC, 24 * 60 * 60 * 1000);

  assert.strictEqual(old.state, "FAILED", "an order outside the lookback window should not be recovered");
  assert.strictEqual(store.executions.length, 0);
}

async function testOrphanPositionWithNoFailedOrderStillFlagged() {
  // Sanity check the fix didn't widen recovery beyond FAILED orders: a
  // position with no order record at all (failed or otherwise) is still a
  // genuine orphan.
  const store = new FakeOrderStore([]);
  const bridge = fakeBridge([position()]);

  const result = await reconcileOrders(bridge, store, MAGIC, 24 * 60 * 60 * 1000);

  assert.strictEqual(result.safe, false);
  assert.ok(result.reasons.some((reason) => reason.includes("no matching durable order")));
}

async function main() {
  await testRecoversTimedOutButFilledOrder();
  await testGenuinelyFailedOrderIsLeftAlone();
  await testOldFailedOrderOutsideLookbackIsIgnored();
  await testOrphanPositionWithNoFailedOrderStillFlagged();
  console.log("All reconciliation regression tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
