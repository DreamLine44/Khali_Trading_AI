"""
Model registry configuration shared by training, validation, and inference.

Per spec section 28, the system must always be able to distinguish the
production model from a candidate and a previous stable model, and must
support rollback. This module defines where each lives on disk and the
metadata every saved model must carry — it does not itself decide when
a candidate is promoted (see ai/validation for that gate).
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
MODELS_DEVELOPMENT = REPO_ROOT / "models" / "development"
MODELS_STAGING = REPO_ROOT / "models" / "staging"
MODELS_PRODUCTION = REPO_ROOT / "models" / "production"
MODELS_ARCHIVED = REPO_ROOT / "models" / "archived"

DATA_RAW = REPO_ROOT / "data" / "raw"
DATA_PROCESSED = REPO_ROOT / "data" / "processed"

for _dir in (MODELS_DEVELOPMENT, MODELS_STAGING, MODELS_PRODUCTION, MODELS_ARCHIVED, DATA_PROCESSED):
    os.makedirs(_dir, exist_ok=True)


@dataclass
class ModelMetadata:
    """
    Everything needed to answer "what is this model, and can I trust
    it?" without re-running training. Saved as a sidecar JSON next to
    every model artifact.
    """

    model_name: str
    model_version: str
    trained_at_utc: str
    symbol: str
    timeframe: str
    feature_schema: list[str]
    training_data_source: str  # e.g. "dev-synthetic" — must never be silently real-looking
    training_row_count: int
    walk_forward_folds: int
    metrics: dict[str, Any] = field(default_factory=dict)
    notes: list[str] = field(default_factory=list)
    # Per-feature {mean, std} computed over the exact rows this model was
    # trained on (same window as training_row_count). Used at inference time
    # by DriftMonitor (src/core/monitoring/drift-monitor.ts) to detect when
    # live feature values have drifted far from what the model was trained
    # on. None only for artifacts trained before this field existed;
    # model_loader.py requires it for production-stage models.
    feature_baseline_stats: dict[str, dict[str, float]] | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "model_name": self.model_name,
            "model_version": self.model_version,
            "trained_at_utc": self.trained_at_utc,
            "symbol": self.symbol,
            "timeframe": self.timeframe,
            "feature_schema": self.feature_schema,
            "training_data_source": self.training_data_source,
            "training_row_count": self.training_row_count,
            "walk_forward_folds": self.walk_forward_folds,
            "metrics": self.metrics,
            "notes": self.notes,
            "feature_baseline_stats": self.feature_baseline_stats,
        }


def compute_feature_baseline_stats(df, feature_columns: list[str]) -> dict[str, dict[str, float]]:
    """Per-feature mean/std over the given training rows, keyed by the exact
    feature-column names used by both the model and the TS-side feature row
    (see src/core/features/feature-vector.ts). Std is floored so a
    constant/near-constant feature never produces a division-by-zero drift
    z-score downstream; DriftMonitor treats any nonzero deviation from a
    zero-std baseline as infinite drift, so a tiny floor here is safer than
    an exact zero."""
    stats: dict[str, dict[str, float]] = {}
    for col in feature_columns:
        series = df[col].astype(float)
        mean = float(series.mean())
        std = float(series.std(ddof=0))
        stats[col] = {"mean": mean, "std": max(std, 1e-9)}
    return stats


def new_version_tag() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
