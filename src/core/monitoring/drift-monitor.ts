import { env } from "../../config/env";

export interface DriftObservation { feature: string; baselineMean: number; baselineStd: number; currentMean: number; zScore: number; drifted: boolean; }

/** Lightweight online drift detector. It does not retrain or change models. */
export class DriftMonitor {
  constructor(private readonly zThreshold = env.driftZThreshold) {}
  compare(baseline: Record<string,{mean:number;std:number}>, current: Record<string,number>): DriftObservation[] {
    return Object.entries(current).flatMap(([feature, value]) => {
      const b=baseline[feature]; if (!b || !Number.isFinite(value) || !Number.isFinite(b.mean) || !Number.isFinite(b.std)) return [];
      const z=b.std>0 ? Math.abs(value-b.mean)/b.std : (Math.abs(value-b.mean)>0 ? Infinity : 0);
      return [{feature,baselineMean:b.mean,baselineStd:b.std,currentMean:value,zScore:z,drifted:z>=this.zThreshold}];
    });
  }
  shouldBlock(observations: DriftObservation[]): boolean { return observations.some(o=>o.drifted); }
}

export interface FeatureDriftCheckResult {
  ok: boolean;
  /** Present only when ok === false; describes which feature(s) drifted and by how much. */
  reason?: string;
}

/**
 * The exact live-pipeline drift gate used by run-mt5.ts's predictionProvider:
 * given a model prediction that may carry feature_baseline_stats, checks the
 * live feature row against it. Extracted as a standalone function (rather
 * than inlined in run-mt5.ts) specifically so it has direct unit coverage —
 * run-mt5.ts itself is a long-running process script, not something tests
 * invoke directly.
 *
 * `requireBaseline`: when true (live mode), a prediction with no baseline
 * stats at all is itself treated as a failure — model_loader.py's
 * production-stage gate always attaches baseline stats, so its absence in
 * live mode means that gate was bypassed somehow. When false (paper/dev),
 * a missing baseline is tolerated so dev-stage models trained before this
 * field existed don't block non-live runs.
 */
export function checkFeatureDrift(
  monitor: DriftMonitor,
  featureBaselineStats: Record<string, { mean: number; std: number }> | undefined,
  liveFeatureRow: Record<string, number>,
  requireBaseline: boolean
): FeatureDriftCheckResult {
  if (!featureBaselineStats) {
    if (requireBaseline) {
      return { ok: false, reason: "model prediction carried no feature_baseline_stats — cannot drift-check a live prediction" };
    }
    return { ok: true };
  }
  const observations = monitor.compare(featureBaselineStats, liveFeatureRow);
  if (!monitor.shouldBlock(observations)) return { ok: true };
  const drifted = observations.filter((o) => o.drifted).map((o) => `${o.feature} (z=${o.zScore.toFixed(2)})`);
  return { ok: false, reason: `feature drift detected vs model training baseline: ${drifted.join(", ")}` };
}
