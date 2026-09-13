"""
Regression tests for the promotion gate's provenance-metadata check
(ai/validation/promote_model.py). model_loader.py requires model_name,
model_version, and training_data_source to all be non-empty strings before
even checking for known-bad values; promote_model.py's synthetic-data check
skipped straight to comparing against a fixed set of known-bad strings, so a
metadata sidecar missing the field entirely (None) sailed through instead of
being rejected like every other incomplete-metadata case.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from ai.validation import promote_model  # noqa: E402

SYMBOL, TIMEFRAME = "EURUSD", "M15"

VALID_METRICS = {
    "final_oos_rows": 500,
    "oos_meta_accuracy": 0.50,
    "oos_meta_brier": 0.20,
    "oos_majority_accuracy_baseline": 0.34,
    "oos_balanced_accuracy": 0.45,
    "oos_brier_prior_baseline": 0.30,
}


def _write_candidate(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, metadata: dict) -> Path:
    development = tmp_path / "development"
    staging = tmp_path / "staging"
    production = tmp_path / "production"
    archived = tmp_path / "archived"
    for directory in (development, staging, production, archived):
        directory.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(promote_model, "MODELS_DEVELOPMENT", development)
    monkeypatch.setattr(promote_model, "MODELS_STAGING", staging)
    monkeypatch.setattr(promote_model, "MODELS_PRODUCTION", production)
    monkeypatch.setattr(promote_model, "MODELS_ARCHIVED", archived)

    artifact = development / f"{SYMBOL}_{TIMEFRAME}_20260101T000000Z.joblib"
    artifact.write_bytes(b"not a real model, promote() never loads this")
    artifact.with_suffix(".json").write_text(json.dumps(metadata))
    return production


def test_promote_rejects_metadata_missing_training_data_source(tmp_path, monkeypatch):
    production = _write_candidate(tmp_path, monkeypatch, {
        "model_name": "ensemble",
        "model_version": "1",
        # training_data_source omitted entirely, unlike the known-bad-value case.
        "metrics": VALID_METRICS,
    })
    with pytest.raises(RuntimeError, match="incomplete metadata"):
        promote_model.promote(SYMBOL, TIMEFRAME, confirm=True)
    assert not any(production.iterdir()), "nothing should be copied to production on rejection"


def test_promote_rejects_metadata_missing_model_version(tmp_path, monkeypatch):
    _write_candidate(tmp_path, monkeypatch, {
        "model_name": "ensemble",
        "training_data_source": "mt5-live-export-2026",
        "metrics": VALID_METRICS,
    })
    with pytest.raises(RuntimeError, match="incomplete metadata"):
        promote_model.promote(SYMBOL, TIMEFRAME, confirm=True)


def test_promote_still_rejects_known_synthetic_value(tmp_path, monkeypatch):
    _write_candidate(tmp_path, monkeypatch, {
        "model_name": "ensemble",
        "model_version": "1",
        "training_data_source": "dev-synthetic",
        "metrics": VALID_METRICS,
    })
    with pytest.raises(RuntimeError, match="synthetic/unknown"):
        promote_model.promote(SYMBOL, TIMEFRAME, confirm=True)


def test_promote_succeeds_with_complete_metadata(tmp_path, monkeypatch):
    production = _write_candidate(tmp_path, monkeypatch, {
        "model_name": "ensemble",
        "model_version": "1",
        "training_data_source": "mt5-live-export-2026",
        "metrics": VALID_METRICS,
        "feature_schema": ["rsi14", "atr14"],
        "feature_baseline_stats": {
            "rsi14": {"mean": 50.0, "std": 12.0},
            "atr14": {"mean": 0.001, "std": 0.0002},
        },
    })
    result = promote_model.promote(SYMBOL, TIMEFRAME, confirm=True)
    assert Path(result["promoted"]).exists()
    assert any(production.glob(f"{SYMBOL}_{TIMEFRAME}_*.joblib"))


def test_promote_rejects_candidate_missing_feature_baseline_stats(tmp_path, monkeypatch):
    # [FIX-DRIFT-BASELINE] Without this, a candidate could be promoted and
    # then immediately fail to load in production (model_loader.py requires
    # feature_baseline_stats for the production stage) — this should be
    # caught here, at promotion time, with a clear error instead.
    _write_candidate(tmp_path, monkeypatch, {
        "model_name": "ensemble",
        "model_version": "1",
        "training_data_source": "mt5-live-export-2026",
        "metrics": VALID_METRICS,
        "feature_schema": ["rsi14", "atr14"],
        # feature_baseline_stats omitted entirely
    })
    with pytest.raises(RuntimeError, match="feature_baseline_stats"):
        promote_model.promote(SYMBOL, TIMEFRAME, confirm=True)


def test_promote_rejects_candidate_with_incomplete_feature_baseline_stats(tmp_path, monkeypatch):
    _write_candidate(tmp_path, monkeypatch, {
        "model_name": "ensemble",
        "model_version": "1",
        "training_data_source": "mt5-live-export-2026",
        "metrics": VALID_METRICS,
        "feature_schema": ["rsi14", "atr14"],
        # atr14 missing from baseline stats even though it's in feature_schema
        "feature_baseline_stats": {"rsi14": {"mean": 50.0, "std": 12.0}},
    })
    with pytest.raises(RuntimeError, match="feature_baseline_stats"):
        promote_model.promote(SYMBOL, TIMEFRAME, confirm=True)
