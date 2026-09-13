import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { checkStatusFile } from "../../src/scripts/monitor";

// [FIX-CYCLE-FAILURE-VISIBILITY] Regression coverage for the monitoring
// blind spot found in this audit pass: when a full trading cycle throws
// (runOnce() itself failing, not just a prediction/execution failure
// captured in a normal AuditRecord), nothing used to get written to Mongo
// or the status file — so monitor.ts's Mongo-polling `evaluate` had no
// record to alert on, and the dashboard silently kept showing the last
// healthy snapshot. run-mt5.ts now writes an honest unhealthy status via
// writeCycleFailureStatus on cycle failure; checkStatusFile is what
// watches for that (and for the status file going stale altogether,
// which is the only signal available if the process is too stuck to even
// reach its own catch block).

function freshState() {
  return { lastSeenUpdatedAtUtc: null as number | null, alertedStale: false, alertedCycleFailed: false };
}

function writeStatus(filePath: string, status: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(status));
}

function tmpStatusPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "monitor-status-test-"));
  return path.join(dir, "status.json");
}

function testMissingStatusFileDoesNotThrowOrAlert(): void {
  const filePath = tmpStatusPath(); // deliberately never written
  const state = freshState();
  checkStatusFile(state, 60000, filePath);
  assert.strictEqual(state.alertedStale, false, "no status file yet (e.g. before first cycle) should not itself be treated as staleness");
  assert.strictEqual(state.alertedCycleFailed, false);
  console.log("PASS: testMissingStatusFileDoesNotThrowOrAlert");
}

function testFreshHealthyStatusDoesNotAlert(): void {
  const filePath = tmpStatusPath();
  writeStatus(filePath, { updatedAtUtc: Date.now(), action: "HOLD", healthy: true, notes: [] });
  const state = freshState();
  checkStatusFile(state, 60000, filePath);
  assert.strictEqual(state.alertedStale, false);
  assert.strictEqual(state.alertedCycleFailed, false);
  console.log("PASS: testFreshHealthyStatusDoesNotAlert");
}

function testStaleStatusFileAlertsOnce(): void {
  const filePath = tmpStatusPath();
  writeStatus(filePath, { updatedAtUtc: Date.now() - 120000, action: "HOLD", healthy: true, notes: [] });
  const state = freshState();
  checkStatusFile(state, 60000, filePath); // 120s old, 60s threshold -> stale
  assert.strictEqual(state.alertedStale, true, "a status file older than the staleness threshold must alert");
  console.log("PASS: testStaleStatusFileAlertsOnce");
}

function testStatusFileRecoveringFromStaleClearsFlag(): void {
  const filePath = tmpStatusPath();
  writeStatus(filePath, { updatedAtUtc: Date.now() - 120000, action: "HOLD", healthy: true, notes: [] });
  const state = freshState();
  checkStatusFile(state, 60000, filePath);
  assert.strictEqual(state.alertedStale, true);
  writeStatus(filePath, { updatedAtUtc: Date.now(), action: "HOLD", healthy: true, notes: [] });
  checkStatusFile(state, 60000, filePath);
  assert.strictEqual(state.alertedStale, false, "a fresh update must clear the stale flag so a later stall alerts again rather than staying silent");
  console.log("PASS: testStatusFileRecoveringFromStaleClearsFlag");
}

function testCycleFailedStatusAlerts(): void {
  const filePath = tmpStatusPath();
  writeStatus(filePath, { updatedAtUtc: Date.now(), action: "CYCLE_FAILED", healthy: false, notes: ["cycle failed (2 consecutive): MT5 heartbeat failed"] });
  const state = freshState();
  checkStatusFile(state, 60000, filePath);
  assert.strictEqual(state.alertedCycleFailed, true, "a status file recording CYCLE_FAILED must alert — this is exactly the failure mode that previously left nothing for either the dashboard or monitor to detect");
  console.log("PASS: testCycleFailedStatusAlerts");
}

function testCycleFailedFlagClearsOnRecovery(): void {
  const filePath = tmpStatusPath();
  writeStatus(filePath, { updatedAtUtc: Date.now(), action: "CYCLE_FAILED", healthy: false, notes: ["cycle failed"] });
  const state = freshState();
  checkStatusFile(state, 60000, filePath);
  assert.strictEqual(state.alertedCycleFailed, true);
  writeStatus(filePath, { updatedAtUtc: Date.now(), action: "HOLD", healthy: true, notes: [] });
  checkStatusFile(state, 60000, filePath);
  assert.strictEqual(state.alertedCycleFailed, false, "recovering to a normal action must clear the cycle-failed flag so a future failure alerts again");
  console.log("PASS: testCycleFailedFlagClearsOnRecovery");
}

function testTornOrPartialWriteIsToleratedNotThrown(): void {
  const filePath = tmpStatusPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '{"updatedAtUtc": 12345, "action": "HOL'); // truncated JSON, simulating a read mid-write
  const state = freshState();
  assert.doesNotThrow(() => checkStatusFile(state, 60000, filePath), "a torn read must not crash the monitor loop — writeRuntimeStatus writes via tmp+rename so this should be rare, but the monitor must tolerate it and just re-check next poll");
  console.log("PASS: testTornOrPartialWriteIsToleratedNotThrown");
}

function main(): void {
  testMissingStatusFileDoesNotThrowOrAlert();
  testFreshHealthyStatusDoesNotAlert();
  testStaleStatusFileAlertsOnce();
  testStatusFileRecoveringFromStaleClearsFlag();
  testCycleFailedStatusAlerts();
  testCycleFailedFlagClearsOnRecovery();
  testTornOrPartialWriteIsToleratedNotThrown();
  console.log("\nAll monitor status-file tests passed.");
}

main();
