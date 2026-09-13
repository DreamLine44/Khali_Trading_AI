import assert from "node:assert/strict";
import { DriftMonitor, checkFeatureDrift } from "../../src/core/monitoring/drift-monitor";

function testNoDriftWithinThreshold() {
  const monitor = new DriftMonitor(3);
  const baseline = { rsi14: { mean: 50, std: 10 } };
  const observations = monitor.compare(baseline, { rsi14: 55 }); // z = 0.5
  assert.equal(observations.length, 1);
  assert.equal(observations[0]!.drifted, false);
  assert.equal(monitor.shouldBlock(observations), false);
  console.log("PASS: testNoDriftWithinThreshold");
}

function testDriftDetectedAboveThreshold() {
  const monitor = new DriftMonitor(3);
  const baseline = { rsi14: { mean: 50, std: 10 } };
  const observations = monitor.compare(baseline, { rsi14: 90 }); // z = 4
  assert.equal(observations[0]!.drifted, true);
  assert.equal(observations[0]!.zScore, 4);
  assert.equal(monitor.shouldBlock(observations), true);
  console.log("PASS: testDriftDetectedAboveThreshold");
}

function testZeroStdBaselineWithDeviationIsInfiniteDrift() {
  const monitor = new DriftMonitor(3);
  const baseline = { choch_bull: { mean: 0, std: 0 } };
  const drifted = monitor.compare(baseline, { choch_bull: 1 });
  assert.equal(drifted[0]!.zScore, Infinity);
  assert.equal(drifted[0]!.drifted, true);

  const notDrifted = monitor.compare(baseline, { choch_bull: 0 });
  assert.equal(notDrifted[0]!.zScore, 0);
  assert.equal(notDrifted[0]!.drifted, false);
  console.log("PASS: testZeroStdBaselineWithDeviationIsInfiniteDrift");
}

function testFeatureMissingFromBaselineOrNonFiniteIsSkippedNotBlocked() {
  const monitor = new DriftMonitor(3);
  const baseline = { rsi14: { mean: 50, std: 10 } };
  // "unknown_feature" has no baseline entry; NaN is non-finite. Neither
  // should silently count as drift (that would fail closed for the wrong
  // reason) nor silently count as "fine" (they're just not evaluable).
  const observations = monitor.compare(baseline, { rsi14: 50, unknown_feature: 999, other: NaN });
  assert.equal(observations.length, 1, "only the feature present in both baseline and current should be evaluated");
  assert.equal(observations[0]!.feature, "rsi14");
  assert.equal(monitor.shouldBlock(observations), false);
  console.log("PASS: testFeatureMissingFromBaselineOrNonFiniteIsSkippedNotBlocked");
}

function testShouldBlockIsTrueIfAnySingleFeatureDrifts() {
  const monitor = new DriftMonitor(3);
  const baseline = { rsi14: { mean: 50, std: 10 }, atr14: { mean: 0.001, std: 0.0002 } };
  const observations = monitor.compare(baseline, { rsi14: 51, atr14: 0.01 }); // atr14 drifts hard
  assert.equal(observations.find((o) => o.feature === "rsi14")!.drifted, false);
  assert.equal(observations.find((o) => o.feature === "atr14")!.drifted, true);
  assert.equal(monitor.shouldBlock(observations), true, "a single drifted feature must be enough to block");
  console.log("PASS: testShouldBlockIsTrueIfAnySingleFeatureDrifts");
}

function testCheckFeatureDriftBlocksOnDrift() {
  const monitor = new DriftMonitor(3);
  const baseline = { rsi14: { mean: 50, std: 10 } };
  const result = checkFeatureDrift(monitor, baseline, { rsi14: 95 }, true);
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /feature drift detected/);
  assert.match(result.reason ?? "", /rsi14/);
  console.log("PASS: testCheckFeatureDriftBlocksOnDrift");
}

function testCheckFeatureDriftPassesWithoutDrift() {
  const monitor = new DriftMonitor(3);
  const baseline = { rsi14: { mean: 50, std: 10 } };
  const result = checkFeatureDrift(monitor, baseline, { rsi14: 52 }, true);
  assert.equal(result.ok, true);
  assert.equal(result.reason, undefined);
  console.log("PASS: testCheckFeatureDriftPassesWithoutDrift");
}

function testCheckFeatureDriftFailsClosedWhenBaselineMissingInLiveMode() {
  const monitor = new DriftMonitor(3);
  // This is the live-mode case: model_loader.py's production gate always
  // attaches feature_baseline_stats, so seeing none here means that gate
  // was bypassed — must fail closed, not trade unmonitored.
  const result = checkFeatureDrift(monitor, undefined, { rsi14: 52 }, true);
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /no feature_baseline_stats/);
  console.log("PASS: testCheckFeatureDriftFailsClosedWhenBaselineMissingInLiveMode");
}

function testCheckFeatureDriftToleratesMissingBaselineOutsideLiveMode() {
  const monitor = new DriftMonitor(3);
  // Paper/dev mode: dev-stage artifacts trained before this field existed
  // must not be blocked from running at all.
  const result = checkFeatureDrift(monitor, undefined, { rsi14: 52 }, false);
  assert.equal(result.ok, true);
  console.log("PASS: testCheckFeatureDriftToleratesMissingBaselineOutsideLiveMode");
}

function main() {
  testNoDriftWithinThreshold();
  testDriftDetectedAboveThreshold();
  testZeroStdBaselineWithDeviationIsInfiniteDrift();
  testFeatureMissingFromBaselineOrNonFiniteIsSkippedNotBlocked();
  testShouldBlockIsTrueIfAnySingleFeatureDrifts();
  testCheckFeatureDriftBlocksOnDrift();
  testCheckFeatureDriftPassesWithoutDrift();
  testCheckFeatureDriftFailsClosedWhenBaselineMissingInLiveMode();
  testCheckFeatureDriftToleratesMissingBaselineOutsideLiveMode();
  console.log("All DriftMonitor tests passed.");
}

main();
