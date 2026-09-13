/**
 * [AUDIT-FIX-GATE-PARITY] Both run-mt5.ts (live startup) and
 * preflight-live.ts (no-order preflight) re-verify production-model
 * quality independently of ai/validation/promote_model.py, which is the
 * script that actually places an artifact into models/production/.
 * Re-verification exists because promotion is the *intended* only path
 * into that folder, not the only physically possible one — docs warn
 * against hand-copying files between stage folders, but nothing at the
 * filesystem level prevents it, so the live-startup checks are the real
 * last line of defense before an order can be placed with real money.
 *
 * Before this fix, that re-verification checked a *smaller* gate set than
 * promote_model.py itself required: it was missing the absolute OOS-accuracy
 * floor, the absolute Brier ceiling, and the balanced-accuracy-beats-random
 * check. A model that failed one of those three specific gates in
 * promote_model.py could never have been promoted the normal way — but if
 * it ever ended up in models/production/ by any other route, both
 * run-mt5.ts and preflight-live.ts would have accepted it anyway, silently
 * trusting a weaker check than promotion demanded.
 *
 * This function is the single source of truth for that check, used by both
 * call sites, so they cannot drift apart the way they had before. Every
 * threshold matches ai/validation/promote_model.py exactly.
 */
export interface ProductionModelMetrics {
  final_oos_rows?: unknown;
  oos_meta_accuracy?: unknown;
  oos_meta_brier?: unknown;
  oos_balanced_accuracy?: unknown;
  oos_majority_accuracy_baseline?: unknown;
  oos_brier_prior_baseline?: unknown;
}

export const MIN_OOS_ROWS = 200;
export const MIN_OOS_ACCURACY_FLOOR = 0.34;
export const MAX_OOS_BRIER_CEILING = 0.90;
export const MIN_BALANCED_ACCURACY = 1 / 3;
export const MIN_OOS_ACCURACY_EDGE = 0.02;

/** Throws with a descriptive message on the first failing gate; returns void on success. */
export function assertProductionModelQualityGates(metrics: ProductionModelMetrics): void {
  const oosRows = Number(metrics.final_oos_rows);
  const oosAccuracy = Number(metrics.oos_meta_accuracy);
  const oosBrier = Number(metrics.oos_meta_brier);

  if (oosRows < MIN_OOS_ROWS || !Number.isFinite(oosAccuracy) || !Number.isFinite(oosBrier)) {
    throw new Error("production model lacks final OOS qualification metrics");
  }
  if (oosAccuracy < MIN_OOS_ACCURACY_FLOOR) {
    throw new Error(`production model final OOS accuracy is below the absolute minimum floor (${MIN_OOS_ACCURACY_FLOOR})`);
  }
  if (oosBrier > MAX_OOS_BRIER_CEILING) {
    throw new Error(`production model final OOS Brier score exceeds the absolute maximum ceiling (${MAX_OOS_BRIER_CEILING})`);
  }
  const balancedAccuracy = Number(metrics.oos_balanced_accuracy);
  if (!Number.isFinite(balancedAccuracy) || balancedAccuracy <= MIN_BALANCED_ACCURACY) {
    throw new Error("production model final OOS balanced accuracy is missing or no better than random");
  }
  const majorityBaseline = Number(metrics.oos_majority_accuracy_baseline ?? 1);
  if (oosAccuracy < majorityBaseline + MIN_OOS_ACCURACY_EDGE) {
    throw new Error("production model does not beat the final OOS majority baseline by the required edge");
  }
  const priorBrier = Number(metrics.oos_brier_prior_baseline);
  if (!(priorBrier > oosBrier)) {
    throw new Error("production model Brier score does not beat the final OOS class-prior baseline");
  }
}
