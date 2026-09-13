import * as assert from "assert";
import { OrderManager } from "../../src/execution/orders/order-manager";
import { Decision, FeatureSet, RiskCheckResult } from "../../src/core/types";

// [FIX-ENTRY-RETRY] Regression coverage for the gap where a single
// broker-side rejection (often caused purely by MT5 file-bridge latency —
// sequential, polled round trips letting the price drift between the quote
// used to size a stop/target and the broker actually evaluating the order)
// permanently burned a decision's one idempotency slot, discarding an
// otherwise-valid signal for the rest of that candle. A decision must now
// get up to OrderManager's bounded attempt cap, but ONLY when every prior
// attempt failed for a reason DEFINITIVELY known to have never reached the
// broker — anything ambiguous must still permanently lock the decision out.

function decision(): Decision {
  return {
    id: "dec_retry_test_1",
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

async function testDefinitiveFailureAllowsRetryWithFreshOrder() {
  const manager = new OrderManager(undefined, "live");
  const d = decision();

  const first = await manager.createOrderFromDecision(d, risk(), 1.105);
  assert.ok(first, "first attempt should be created");
  assert.ok(first!.idempotencyKey.endsWith("_1"), "first attempt should occupy attempt slot 1");

  await manager.transition(first!.id, "VALIDATING");
  await manager.transition(first!.id, "APPROVED");
  await manager.transition(first!.id, "SUBMITTED");
  await manager.transition(first!.id, "FAILED");
  // Simulate a definitive, broker-never-saw-it rejection.
  await manager.recordFailureClassification(first!.id, true);

  const second = await manager.createOrderFromDecision(d, risk(), 1.106);
  assert.ok(second, "a second attempt must be allowed after a definitive failure");
  assert.notStrictEqual(second!.id, first!.id, "the retry must be a distinct order/idempotency slot");
  assert.ok(second!.idempotencyKey.endsWith("_2"), "the retry should occupy the next attempt slot");
  assert.strictEqual(second!.referencePrice, 1.106, "the retry should use the fresh reference price, not the stale one");
}

async function testAmbiguousFailureBlocksRetry() {
  const manager = new OrderManager(undefined, "live");
  const d = decision();

  const first = await manager.createOrderFromDecision(d, risk(), 1.105);
  assert.ok(first, "first attempt should be created");

  await manager.transition(first!.id, "VALIDATING");
  await manager.transition(first!.id, "APPROVED");
  await manager.transition(first!.id, "SUBMITTED");
  await manager.transition(first!.id, "FAILED");
  // Simulate an ambiguous outcome (e.g. a bridge timeout) -- explicit false.
  await manager.recordFailureClassification(first!.id, false);

  const second = await manager.createOrderFromDecision(d, risk(), 1.106);
  assert.strictEqual(second, null, "an ambiguous failure must permanently lock the decision out — never retry");
}

async function testUnclassifiedFailureDefaultsToNoRetry() {
  const manager = new OrderManager(undefined, "live");
  const d = decision();

  const first = await manager.createOrderFromDecision(d, risk(), 1.105);
  assert.ok(first);
  await manager.transition(first!.id, "VALIDATING");
  await manager.transition(first!.id, "APPROVED");
  await manager.transition(first!.id, "SUBMITTED");
  await manager.transition(first!.id, "FAILED");
  // No recordFailureClassification call at all -- must default to locked.

  const second = await manager.createOrderFromDecision(d, risk(), 1.106);
  assert.strictEqual(second, null, "an unclassified failure must default to the conservative, non-retryable outcome");
}

async function testSuccessfulOrderIsNeverSuperseded() {
  const manager = new OrderManager(undefined, "live");
  const d = decision();

  const first = await manager.createOrderFromDecision(d, risk(), 1.105);
  assert.ok(first);
  await manager.transition(first!.id, "VALIDATING");
  await manager.transition(first!.id, "APPROVED");
  await manager.transition(first!.id, "SUBMITTED");
  await manager.transition(first!.id, "CONFIRMED");
  await manager.transition(first!.id, "FILLED");

  const second = await manager.createOrderFromDecision(d, risk(), 1.106);
  assert.strictEqual(second, null, "a decision that already resulted in a live fill must never get a second order");
}

async function testRetryAttemptsAreBoundedAndFailClosed() {
  const manager = new OrderManager(undefined, "live");
  const d = decision();

  // Exhaust every attempt with definitive failures.
  for (let i = 0; i < 5; i++) {
    const attempt = await manager.createOrderFromDecision(d, risk(), 1.1 + i * 0.001);
    if (!attempt) {
      // Ran out of attempts -- the bound was enforced before this iteration.
      assert.ok(i >= 3, `expected the attempt cap to trigger by iteration 3, got iteration ${i}`);
      return;
    }
    await manager.transition(attempt.id, "VALIDATING");
    await manager.transition(attempt.id, "APPROVED");
    await manager.transition(attempt.id, "SUBMITTED");
    await manager.transition(attempt.id, "FAILED");
    await manager.recordFailureClassification(attempt.id, true);
  }
  assert.fail("the retry cap must eventually stop producing new attempts for the same decision");
}

async function main() {
  await testDefinitiveFailureAllowsRetryWithFreshOrder();
  await testAmbiguousFailureBlocksRetry();
  await testUnclassifiedFailureDefaultsToNoRetry();
  await testSuccessfulOrderIsNeverSuperseded();
  await testRetryAttemptsAreBoundedAndFailClosed();
  console.log("All entry-retry regression tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
