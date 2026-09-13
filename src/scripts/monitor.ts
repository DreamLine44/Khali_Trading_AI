import { MongoClient } from "mongodb";
import * as fs from "fs";
import * as path from "path";
import { env } from "../config/env";
import { AuditRecord } from "../core/types";
import { RuntimeStatus } from "../core/monitoring/runtime-status";

/**
 * Free, local monitoring for run:mt5. No dashboard, no paid service —
 * this polls the same MongoDB `trade_decisions` collection that
 * MongoAuditLog writes to, and prints human-readable alerts to stdout
 * (and appends them to monitoring/logs/alerts.log) when something looks
 * worth a human checking. Run this in a second terminal alongside
 * `npm run run:mt5`.
 *
 * This is intentionally simple: no email/SMS/webhook integration is
 * wired in, because every free option for that either requires a paid
 * tier past a trivial volume or an external account you'd have to set
 * up yourself. Pipe stdout to whatever you already have (a terminal
 * you watch, `tee` to a file, systemd + journalctl, etc).
 */

const POLL_MS = env.monitorPollIntervalMs;
const NO_TRADE_STREAK_ALERT = env.monitorNoTradeStreakAlert;
const ERROR_STREAK_ALERT = env.monitorErrorStreakAlert;

interface MonitorState {
  lastSeenId: string | null;
  consecutiveNoTrade: number;
  consecutiveErrors: number;
}

function logAlert(message: string): void {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.warn(line);
  const fs = require("fs") as typeof import("fs");
  const path = require("path") as typeof import("path");
  const outPath = path.join(__dirname, "../../monitoring/logs/alerts.log");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.appendFileSync(outPath, line + "\n", "utf-8");
}

function evaluate(record: AuditRecord, state: MonitorState): void {
  const action = record.decision.action;
  const hadExecutionFailure = record.executionResult !== null
    && typeof record.executionResult === "object"
    && record.executionResult !== null
    && "success" in record.executionResult
    && (record.executionResult as { success: boolean }).success === false;
  const hadPipelineError = record.notes.some((note) => /cycle failed|not connected|model unavailable/i.test(note));

  if (hadExecutionFailure || hadPipelineError) {
    state.consecutiveErrors += 1;
    state.consecutiveNoTrade = 0;
  } else {
    state.consecutiveErrors = 0;
  }

  if (action === "NO_TRADE" || action === "INSUFFICIENT_CONFIDENCE") {
    state.consecutiveNoTrade += 1;
  } else {
    state.consecutiveNoTrade = 0;
  }

  if (state.consecutiveErrors >= ERROR_STREAK_ALERT) {
    logAlert(`ALERT: ${state.consecutiveErrors} consecutive execution/pipeline failures. Latest reasons: ${record.decision.reasons.join("; ")}`);
  }
  if (state.consecutiveNoTrade === NO_TRADE_STREAK_ALERT) {
    logAlert(`NOTICE: ${state.consecutiveNoTrade} consecutive bars with no trade (${action}). This can be normal (low-confidence market) or a sign the model/data feed is stuck — check the latest reasons: ${record.decision.reasons.join("; ")}`);
  }
  if (record.risk && record.risk.approved === false && /drawdown|margin/i.test(record.risk.reasons.join(" "))) {
    logAlert(`RISK ALERT: order rejected for drawdown/margin reasons: ${record.risk.reasons.join("; ")}`);
  }
}

interface StatusFileState {
  lastSeenUpdatedAtUtc: number | null;
  alertedStale: boolean;
  alertedCycleFailed: boolean;
}

const defaultStatusPath = path.join(__dirname, "../../src/monitoring/runtime/status.json");

/**
 * [FIX-CYCLE-FAILURE-VISIBILITY] Complements the Mongo-polling `evaluate`
 * above, which has no signal at all for "the bot process died or is
 * stuck before producing any AuditRecord" — that failure mode writes
 * nothing to Mongo. run-mt5.ts now writes an honest unhealthy status
 * (via writeCycleFailureStatus) on every full-cycle exception, and this
 * function is what actually watches for it: it alerts once when the
 * status file itself reports a cycle failure, and separately once the
 * status file stops being updated altogether (the file's mtime/
 * updatedAtUtc going stale is the only signal available if the process
 * has hung so badly it can't even reach its own catch block).
 */
export function checkStatusFile(state: StatusFileState, staleMs: number, filePath = defaultStatusPath): void {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    return; // no status file yet (e.g. bot hasn't completed a first cycle) — nothing to check
  }
  let status: RuntimeStatus;
  try {
    status = JSON.parse(raw);
  } catch {
    return; // mid-write / torn read; writeRuntimeStatus writes via tmp+rename, so this should be rare and self-corrects next poll
  }

  if (status.action === "CYCLE_FAILED") {
    if (!state.alertedCycleFailed) {
      logAlert(`ALERT: run-mt5 reported a full trading-cycle failure: ${status.notes.join("; ")}`);
      state.alertedCycleFailed = true;
    }
  } else {
    state.alertedCycleFailed = false;
  }

  const age = Date.now() - status.updatedAtUtc;
  if (age > staleMs) {
    if (!state.alertedStale) {
      logAlert(`ALERT: status file has not updated in ${Math.round(age / 1000)}s (threshold ${Math.round(staleMs / 1000)}s) — the bot process may be stuck or dead`);
      state.alertedStale = true;
    }
  } else {
    state.alertedStale = false;
  }
  state.lastSeenUpdatedAtUtc = status.updatedAtUtc;
}

async function main(): Promise<void> {
  const uri = env.mongodbUri;
  const databaseName = env.mongodbDatabase;
  if (!uri) throw new Error("MONGODB_URI is required for monitor");
  const client = new MongoClient(uri);
  await client.connect();
  const collection = client.db(databaseName).collection<AuditRecord & { _id?: unknown }>("trade_decisions");

  console.log(`monitoring ${env.mt5Symbol} ${env.mt5Timeframe} — polling every ${POLL_MS / 1000}s. Ctrl+C to stop.`);
  const state: MonitorState = { lastSeenId: null, consecutiveNoTrade: 0, consecutiveErrors: 0 };
  const statusFileState: StatusFileState = { lastSeenUpdatedAtUtc: null, alertedStale: false, alertedCycleFailed: false };
  let stopping = false;
  process.on("SIGINT", () => { stopping = true; });
  process.on("SIGTERM", () => { stopping = true; });

  while (!stopping) {
    try {
      const query = state.lastSeenId ? { "decision.createdAtUtc": { $gt: Number(state.lastSeenId) } } : {};
      const records = await collection.find(query).sort({ "decision.createdAtUtc": 1 }).limit(500).toArray();
      for (const record of records) {
        evaluate(record, state);
        state.lastSeenId = String(record.decision.createdAtUtc);
      }
    } catch (error) {
      logAlert(`monitor lost its own MongoDB connection: ${error instanceof Error ? error.message : String(error)}`);
    }
    checkStatusFile(statusFileState, env.monitorStatusStaleMs);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  await client.close();
}

// [FIX-MONITOR-TESTABILITY] Previously main() ran unconditionally at
// module scope, matching server.ts's original bug: merely importing this
// file (e.g. from a test wanting checkStatusFile/evaluate) would open a
// real MongoDB connection and enter the infinite polling loop as a side
// effect. Guarding behind require.main === module keeps `ts-node
// src/scripts/monitor.ts` working exactly as before while making the
// exported functions safely importable.
if (require.main === module) {
  main().catch((error) => {
    console.error("monitor failed:", error);
    throw error;
  });
}
