import * as assert from "assert";
import { OrderManager } from "../../src/execution/orders/order-manager";
import { Decision, RiskCheckResult } from "../../src/core/types";

const decision: Decision = {
  id: "dec_EURUSDm_M5_1",
  symbol: "EURUSDm",
  timeframe: "M5",
  createdAtUtc: 1,
  action: "BUY",
  confidence: 0.9,
  reasons: [],
  predictions: [],
  featureSetRef: {} as Decision["featureSetRef"],
};

const risk: RiskCheckResult = {
  approved: true,
  reasons: [],
  maxPositionSize: 0.01,
  stopLossPrice: 1.1,
  takeProfitPrice: 1.2,
};

async function main() {
  const accountA = await new OrderManager(undefined, "live", "live-account-2").createOrderFromDecision(decision, risk, 1.15);
  const accountB = await new OrderManager(undefined, "live", "live-account-3").createOrderFromDecision(decision, risk, 1.15);
  assert.ok(accountA && accountB);
  assert.notStrictEqual(accountA!.id, accountB!.id, "tenant order IDs must not collide");
  assert.notStrictEqual(accountA!.idempotencyKey, accountB!.idempotencyKey, "tenant broker idempotency keys must not collide");
  assert.ok(accountA!.idempotencyKey.length <= 31, "MT5 comment/idempotency key must fit EA limit");
  assert.ok(accountB!.idempotencyKey.length <= 31, "MT5 comment/idempotency key must fit EA limit");
  console.log("Tenant isolation regression test passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});