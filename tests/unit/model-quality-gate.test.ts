import * as assert from "assert";
import { assertProductionModelQualityGates } from "../../src/core/ai-bridge/model-quality-gate";

// Mirrors the fixture in tests/ai/test_promote_model.py so both sides of
// the Node/Python boundary agree on what a qualifying model looks like.
function qualifyingMetrics() {
  return {
    final_oos_rows: 500,
    oos_meta_accuracy: 0.50,
    oos_meta_brier: 0.20,
    oos_balanced_accuracy: 0.45,
    oos_majority_accuracy_baseline: 0.34,
    oos_brier_prior_baseline: 0.30,
  };
}

function testQualifyingModelPasses() {
  assert.doesNotThrow(() => assertProductionModelQualityGates(qualifyingMetrics()));
}

function testTooFewOosRowsRejected() {
  assert.throws(
    () => assertProductionModelQualityGates({ ...qualifyingMetrics(), final_oos_rows: 199 }),
    /lacks final OOS qualification metrics/,
  );
}

// [AUDIT-FIX-GATE-PARITY] The three gates that were missing from the TS
// live-startup checks before this fix — each must independently reject a
// model that would have failed promote_model.py, even when every other
// metric looks fine.
function testAbsoluteAccuracyFloorRejected() {
  assert.throws(
    () => assertProductionModelQualityGates({ ...qualifyingMetrics(), oos_meta_accuracy: 0.33, oos_majority_accuracy_baseline: 0.30 }),
    /below the absolute minimum floor/,
  );
}

function testAbsoluteBrierCeilingRejected() {
  assert.throws(
    () => assertProductionModelQualityGates({ ...qualifyingMetrics(), oos_meta_brier: 0.95, oos_brier_prior_baseline: 0.99 }),
    /exceeds the absolute maximum ceiling/,
  );
}

function testBalancedAccuracyNoBetterThanRandomRejected() {
  assert.throws(
    () => assertProductionModelQualityGates({ ...qualifyingMetrics(), oos_balanced_accuracy: 0.30 }),
    /no better than random/,
  );
}

function testMissingBalancedAccuracyRejected() {
  const { oos_balanced_accuracy, ...rest } = qualifyingMetrics();
  assert.throws(
    () => assertProductionModelQualityGates(rest),
    /no better than random/,
  );
}

function testMajorityBaselineEdgeStillEnforced() {
  assert.throws(
    () => assertProductionModelQualityGates({ ...qualifyingMetrics(), oos_meta_accuracy: 0.35, oos_majority_accuracy_baseline: 0.34 }),
    /does not beat the final OOS majority baseline/,
  );
}

function testPriorBrierEdgeStillEnforced() {
  assert.throws(
    () => assertProductionModelQualityGates({ ...qualifyingMetrics(), oos_meta_brier: 0.30, oos_brier_prior_baseline: 0.30 }),
    /does not beat the final OOS class-prior baseline/,
  );
}

testQualifyingModelPasses();
testTooFewOosRowsRejected();
testAbsoluteAccuracyFloorRejected();
testAbsoluteBrierCeilingRejected();
testBalancedAccuracyNoBetterThanRandomRejected();
testMissingBalancedAccuracyRejected();
testMajorityBaselineEdgeStillEnforced();
testPriorBrierEdgeStillEnforced();
console.log("Production model quality gate parity tests passed.");
