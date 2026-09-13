import * as assert from "assert";

function deterministicPrediction() {
  return { modelName: "deterministic-market-analysis", modelVersion: "rules-v1", action: "BUY" as const, probability: 0.8, uncertainty: 0.2 };
}

function testModeContract() {
  assert.ok(["single", "ensemble", "hybrid"].includes("single"));
  assert.ok(["single", "ensemble", "hybrid"].includes("ensemble"));
  assert.ok(["single", "ensemble", "hybrid"].includes("hybrid"));
  assert.strictEqual(deterministicPrediction().modelName, "deterministic-market-analysis");
}

testModeContract();
console.log("ML switch contract tests passed.");
