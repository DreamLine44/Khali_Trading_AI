"""Explicit model promotion gate.

Nothing is promoted automatically. Production requires real historical
provenance, a non-empty untouched final OOS qualification report, and an
explicit confirmation flag. Existing production artifacts are archived
before replacement so rollback remains possible.
"""
from __future__ import annotations
import argparse, json, shutil
from pathlib import Path
from ai.common.config import MODELS_ARCHIVED, MODELS_DEVELOPMENT, MODELS_PRODUCTION, MODELS_STAGING

MIN_OOS_ROWS = 200
MIN_OOS_ACCURACY = 0.34
MAX_OOS_BRIER = 0.90
MIN_OOS_ACCURACY_EDGE = 0.02


def promote(symbol: str, timeframe: str, confirm: bool = False) -> dict:
    candidates = sorted(MODELS_DEVELOPMENT.glob(f"{symbol}_{timeframe}_*.joblib"))
    if not candidates:
        raise RuntimeError(f"no development candidate for {symbol}/{timeframe}")
    artifact = candidates[-1]
    metadata_path = artifact.with_suffix(".json")
    if not metadata_path.exists():
        raise RuntimeError("candidate has no metadata sidecar")
    metadata = json.loads(metadata_path.read_text())
    required_metadata = ("model_name", "model_version", "training_data_source")
    if not all(isinstance(metadata.get(key), str) and metadata[key] for key in required_metadata):
        raise RuntimeError(f"candidate {artifact} has incomplete metadata")
    if metadata.get("training_data_source") in {"dev-synthetic", "synthetic", "unknown", ""}:
        raise RuntimeError("synthetic/unknown candidate cannot be promoted")
    metrics = metadata.get("metrics", {})
    oos_rows = int(metrics.get("final_oos_rows", 0))
    oos_accuracy = float(metrics.get("oos_meta_accuracy", 0.0))
    oos_brier = float(metrics.get("oos_meta_brier", 999.0))
    if oos_rows < MIN_OOS_ROWS:
        raise RuntimeError(f"final OOS set too small: {oos_rows} < {MIN_OOS_ROWS}")
    if oos_accuracy < MIN_OOS_ACCURACY:
        raise RuntimeError(f"final OOS meta accuracy too low: {oos_accuracy:.4f} < {MIN_OOS_ACCURACY}")
    if oos_brier > MAX_OOS_BRIER:
        raise RuntimeError(f"final OOS Brier score too high: {oos_brier:.4f} > {MAX_OOS_BRIER}")
    majority_baseline = float(metrics.get("oos_majority_accuracy_baseline", 1.0))
    if oos_accuracy < majority_baseline + MIN_OOS_ACCURACY_EDGE:
        raise RuntimeError(f"final OOS accuracy does not beat majority baseline by required edge: {oos_accuracy:.4f} < {majority_baseline + MIN_OOS_ACCURACY_EDGE:.4f}")
    balanced = float(metrics.get("oos_balanced_accuracy", 0.0))
    if balanced <= 1.0 / 3.0:
        raise RuntimeError(f"final OOS balanced accuracy is no better than random: {balanced:.4f}")
    prior_brier = float(metrics.get("oos_brier_prior_baseline", 999.0))
    if not (prior_brier == prior_brier) or prior_brier <= 0:
        raise RuntimeError("candidate is missing a valid class-prior Brier baseline")
    if oos_brier >= prior_brier:
        raise RuntimeError(f"final OOS Brier does not beat class-prior baseline: {oos_brier:.4f} >= {prior_brier:.4f}")
    # [FIX-DRIFT-BASELINE] model_loader.py refuses to load a production
    # artifact without feature_baseline_stats (needed for live drift
    # monitoring) — check it here too, at promotion time, so a candidate
    # missing this data fails with a clear promotion error instead of
    # silently becoming an unloadable production artifact discovered only
    # when the live process next tries to start.
    feature_schema = metadata.get("feature_schema")
    baseline_stats = metadata.get("feature_baseline_stats")
    if not isinstance(baseline_stats, dict) or not isinstance(feature_schema, list) or set(baseline_stats) != set(feature_schema):
        raise RuntimeError("candidate is missing feature_baseline_stats required for live drift monitoring")
    for col, stat in baseline_stats.items():
        mean, std = (stat or {}).get("mean"), (stat or {}).get("std")
        if not isinstance(mean, (int, float)) or not isinstance(std, (int, float)) or std <= 0:
            raise RuntimeError(f"candidate feature_baseline_stats for '{col}' is invalid")
    if not confirm:
        raise RuntimeError("promotion is intentionally blocked without --confirm-production")

    MODELS_PRODUCTION.mkdir(parents=True, exist_ok=True)
    MODELS_ARCHIVED.mkdir(parents=True, exist_ok=True)
    for current in MODELS_PRODUCTION.glob(f"{symbol}_{timeframe}_*.joblib"):
        shutil.move(str(current), str(MODELS_ARCHIVED / current.name))
        sidecar = current.with_suffix(".json")
        if sidecar.exists(): shutil.move(str(sidecar), str(MODELS_ARCHIVED / sidecar.name))
    shutil.copy2(artifact, MODELS_PRODUCTION / artifact.name)
    shutil.copy2(metadata_path, MODELS_PRODUCTION / metadata_path.name)
    return {"promoted": str(MODELS_PRODUCTION / artifact.name), "oos_rows": oos_rows, "oos_accuracy": oos_accuracy, "oos_brier": oos_brier}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("symbol")
    parser.add_argument("timeframe")
    parser.add_argument("--confirm-production", action="store_true")
    args = parser.parse_args()
    print(json.dumps(promote(args.symbol, args.timeframe, args.confirm_production), indent=2))

if __name__ == "__main__":
    main()
