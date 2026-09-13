import * as fs from "fs";
import * as path from "path";
import { AuditRecord } from "../types";

export interface RuntimeStatus { updatedAtUtc:number; mode:string; healthy:boolean; symbol:string; timeframe:string; action:string; confidence:number; regime:string; riskApproved:boolean; notes:string[]; }
const defaultPath=path.join(process.cwd(),"src/monitoring/runtime/status.json");
export function writeRuntimeStatus(record:AuditRecord, mode:string, filePath=defaultPath):void {
  // [FIX-RUNTIME-HEALTH] risk.approved is only ever true for a BUY/SELL
  // decision (evaluateRisk in risk-engine.ts short-circuits to
  // approved:false for every other action). HOLD is the decision engine's
  // routine, frequent "no strong signal" outcome, and EXIT is a deliberate
  // normal action too — neither is an error condition. Previously only
  // NO_TRADE and INSUFFICIENT_CONFIDENCE were exempted, so this reported
  // healthy:false on ordinary HOLD cycles, which is likely most cycles in
  // real operation — defeating the point of a health signal.
  const nonEntryHealthyActions = new Set(["NO_TRADE","INSUFFICIENT_CONFIDENCE","HOLD","EXIT"]);
  const status:RuntimeStatus={updatedAtUtc:Date.now(),mode,healthy:record.risk.approved || nonEntryHealthyActions.has(record.decision.action),symbol:record.decision.symbol,timeframe:record.decision.timeframe,action:record.decision.action,confidence:record.decision.confidence,regime:record.decision.featureSetRef.regime,riskApproved:record.risk.approved,notes:[...record.decision.reasons,...record.notes].slice(-20)};
  fs.mkdirSync(path.dirname(filePath),{recursive:true});
  const tmp=filePath+".tmp"; fs.writeFileSync(tmp,JSON.stringify(status,null,2)); fs.renameSync(tmp,filePath);
}

// [FIX-CYCLE-FAILURE-VISIBILITY] Companion to writeRuntimeStatus, used
// when a full trading cycle throws before any AuditRecord exists (e.g.
// runOnce() itself fails) rather than producing a normal
// NO_TRADE/INSUFFICIENT_CONFIDENCE decision. Without this, such a
// failure left the status file showing whatever the last *successful*
// cycle reported — indefinitely — so both the dashboard and anything
// polling this file would report healthy while the bot process was
// actually stuck or crash-looping.
export function writeCycleFailureStatus(mode: string, errorMessage: string, consecutiveFailures: number, filePath = defaultPath): void {
  const status: RuntimeStatus = {
    updatedAtUtc: Date.now(),
    mode,
    healthy: false,
    symbol: "",
    timeframe: "",
    action: "CYCLE_FAILED",
    confidence: 0,
    regime: "",
    riskApproved: false,
    notes: [`cycle failed (${consecutiveFailures} consecutive): ${errorMessage}`],
  };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(status, null, 2));
  fs.renameSync(tmp, filePath);
}
