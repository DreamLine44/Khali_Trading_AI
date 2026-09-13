import * as assert from "assert";
import { OrderManager } from "../../src/execution/orders/order-manager";
import { PaperExecutionAdapter } from "../../src/execution/adapters/paper/paper-execution.adapter";
import { Decision, FeatureSet, RiskCheckResult } from "../../src/core/types";

// [FIX-PAPER-FILL] Regression coverage for the bug where the paper adapter
// returned filledPrice: null, which trading-loop.ts's confirmation check
// let through for non-live adapters — resulting in orders transitioned to
// CONFIRMED/FILLED whose brokerOrderId/filledPrice/filledVolume were never
// actually recorded (recordExecution requires a non-null price).

function decision(): Decision {
  return {
    id: "dec_test_1",
    symbol: "EURUSD",
    timeframe: "M15",
    createdAtUtc: Date.now(),
    action: "BUY",
    confidence: 0.8,
    reasons: [],
    predictions: [],
    featureSetRef: {} as FeatureSet,
  };
}

function risk(): RiskCheckResult {
  return {
    approved: true,
    reasons: [],
    maxPositionSize: 0.1,
    stopLossPrice: 1.095,
    takeProfitPrice: 1.115,
  };
}

async function testPaperFillWithReferencePriceRecordsExecution() {
  const manager = new OrderManager(undefined, "paper");
  const order = await manager.createOrderFromDecision(decision(), risk(), 1.105);
  assert.ok(order, "order should be created");
  assert.strictEqual(order!.referencePrice, 1.105);

  const adapter = new PaperExecutionAdapter();
  const result = await adapter.submitOrder(order!);
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.filledPrice, 1.105, "paper fill must use the order's reference price, not null");
  assert.ok(result.brokerOrderId, "paper fill must report a brokerOrderId");

  await manager.transition(order!.id, "VALIDATING");
  await manager.transition(order!.id, "APPROVED");
  await manager.transition(order!.id, "SUBMITTED");
  assert.ok(result.brokerOrderId && result.filledPrice !== null && result.filledVolume !== null);
  await manager.recordExecution(order!.id, {
    brokerOrderId: result.brokerOrderId!,
    filledPrice: result.filledPrice!,
    filledVolume: result.filledVolume!,
  });

  const recorded = manager.get(order!.id);
  assert.strictEqual(recorded?.filledPrice, 1.105, "order must have its fill price recorded, not left undefined");
  assert.strictEqual(recorded?.brokerOrderId, result.brokerOrderId);
}

async function testPaperFillFailsClosedWithoutReferencePrice() {
  const manager = new OrderManager(undefined, "paper");
  const order = await manager.createOrderFromDecision(decision(), risk(), null);
  assert.ok(order, "order should be created even without a reference price");
  assert.strictEqual(order!.referencePrice, null);

  const adapter = new PaperExecutionAdapter();
  const result = await adapter.submitOrder(order!);
  assert.strictEqual(result.success, false, "must fail closed instead of fabricating a fill price");
  assert.strictEqual(result.filledPrice, null);
  assert.ok(result.error);
}

async function main() {
  await testPaperFillWithReferencePriceRecordsExecution();
  await testPaperFillFailsClosedWithoutReferencePrice();
  console.log("Paper-fill order-recording regression tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
