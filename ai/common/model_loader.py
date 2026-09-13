"""
Resolves and loads a model artifact from the registry (development /
staging / production / archived). Deliberately has no "fall back to a
different stage if this one is missing" behavior — per spec section 23,
an unavailable model must mean NO TRADE, not a silent substitution.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

import joblib
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from ai.common.config import MODELS_ARCHIVED, MODELS_DEVELOPMENT, MODELS_PRODUCTION, MODELS_STAGING  # noqa: E402

_STAGE_DIRS = {
    "development": MODELS_DEVELOPMENT,
    "staging": MODELS_STAGING,
    "production": MODELS_PRODUCTION,
    "archived": MODELS_ARCHIVED,
}


class ModelNotAvailableError(RuntimeError):
    pass


def latest_model_path(stage: str, symbol: str, timeframe: str) -> Path:
    if stage not in _STAGE_DIRS:
        raise ValueError(f"unknown model stage '{stage}', expected one of {list(_STAGE_DIRS)}")
    stage_dir = _STAGE_DIRS[stage]
    candidates = sorted(stage_dir.glob(f"{symbol}_{timeframe}_*.joblib"))
    if not candidates:
        raise ModelNotAvailableError(f"no {stage} model found for {symbol}/{timeframe} in {stage_dir}")
    return candidates[-1]  # version tags are UTC timestamps -> lexical sort == chronological


def load_model(stage: str, symbol: str, timeframe: str) -> dict[str, Any]:
    model_path = latest_model_path(stage, symbol, timeframe)
    metadata_path = model_path.with_suffix(".json")
    if not metadata_path.exists():
        raise ModelNotAvailableError(f"model artifact {model_path} has no metadata sidecar — refusing to load")

    try:
        bundle = joblib.load(model_path)
        metadata = json.loads(metadata_path.read_text())
        models = bundle.get("models")
        model = bundle.get("model")
        if models is None and model is None:
            raise KeyError("model(s)")
        classes = bundle["classes"]
        feature_columns = bundle["feature_columns"]
    except (OSError, ValueError, KeyError, TypeError) as exc:
        raise ModelNotAvailableError(f"invalid model artifact {model_path}: {exc}") from exc

    if not isinstance(feature_columns, list) or not feature_columns or not all(isinstance(c, str) and c for c in feature_columns):
        raise ModelNotAvailableError(f"model artifact {model_path} has an invalid feature schema")
    if not isinstance(classes, list) or classes != ["DOWN", "FLAT", "UP"]:
        raise ModelNotAvailableError(f"model artifact {model_path} has invalid class schema")
    if metadata.get("feature_schema") != feature_columns:
        raise ModelNotAvailableError("model artifact metadata feature schema does not match serialized model schema")
    if models is not None and len(models) != 3:
        raise ModelNotAvailableError("ensemble artifact must contain exactly three base models")
    if models is not None and "meta_model" not in bundle:
        raise ModelNotAvailableError("ensemble artifact is missing its meta-model")
    required_metadata = ("model_name", "model_version", "training_data_source")
    if not all(isinstance(metadata.get(key), str) and metadata[key] for key in required_metadata):
        raise ModelNotAvailableError(f"model artifact {model_path} has incomplete metadata")
    if stage == "production":
        if metadata.get("training_data_source") in {"dev-synthetic", "synthetic", "unknown", ""}:
            raise ModelNotAvailableError("production stage refuses synthetic/unknown training data")
        metrics = metadata.get("metrics", {})
        if not isinstance(metrics, dict) or int(metrics.get("final_oos_rows", 0)) < 200:
            raise ModelNotAvailableError("production model lacks a meaningful final OOS qualification set")
        if not np.isfinite(float(metrics.get("oos_meta_accuracy", -1))) or not np.isfinite(float(metrics.get("oos_meta_brier", -1))):
            raise ModelNotAvailableError("production model lacks finite final OOS metrics")
        # [FIX-MODEL-LOADER-PARITY] promote_model.py enforces these two
        # "beats baseline" gates before a model is ever moved into
        # models/production/, and run-mt5.ts re-checks them again at live
        # startup — but this loader is the function EVERY inference call
        # actually passes through, and it previously only re-checked
        # provenance/row-count/finiteness, not the qualification gates
        # themselves. That left a silent bypass path: any production/
        # artifact placed there by hand (or left over from a promotion
        # bug, or from run-mt5.ts being started before this file existed)
        # would be loaded and traded on without ever having its edge over
        # baseline verified by the one function that always runs.
        oos_accuracy = float(metrics.get("oos_meta_accuracy", -1))
        majority_baseline = float(metrics.get("oos_majority_accuracy_baseline", 1.0))
        if oos_accuracy < majority_baseline + 0.02:
            raise ModelNotAvailableError("production model does not beat the final OOS majority baseline by the required edge")
        oos_brier = float(metrics.get("oos_meta_brier", 999.0))
        prior_brier = float(metrics.get("oos_brier_prior_baseline", -1.0))
        if not (prior_brier > oos_brier):
            raise ModelNotAvailableError("production model Brier score does not beat the final OOS class-prior baseline")
        # [FIX-DRIFT-BASELINE] A production model with no recorded training
        # feature distribution can never have live drift checked against it —
        # DriftMonitor (TS side) silently has nothing to compare against,
        # which is the same "quietly permissive" failure mode the other
        # gates in this function exist to close off. Fail closed instead.
        baseline_stats = metadata.get("feature_baseline_stats")
        if not isinstance(baseline_stats, dict) or set(baseline_stats) != set(feature_columns):
            raise ModelNotAvailableError("production model is missing feature_baseline_stats for drift monitoring")
        for col, stat in baseline_stats.items():
            if not isinstance(stat, dict) or not np.isfinite(stat.get("mean", float("nan"))) or not np.isfinite(stat.get("std", float("nan"))) or stat.get("std", 0) <= 0:
                raise ModelNotAvailableError(f"production model feature_baseline_stats for '{col}' is invalid")
    result = {"model": model, "classes": classes, "feature_columns": feature_columns, "metadata": metadata, "path": str(model_path)}
    if models is not None: result["models"] = models
    if "meta_model" in bundle: result["meta_model"] = bundle["meta_model"]
    if "ensemble_version" in bundle: result["ensemble_version"] = bundle["ensemble_version"]
    return result
