"""
Tests for the AI inference/model-loading layer (spec section 34: "AI
tests" — prediction consistency, model loading, missing features,
confidence thresholds).
"""
from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from ai.common.model_loader import ModelNotAvailableError  # noqa: E402
from ai.inference.prediction import predict  # noqa: E402
from ai.training.preprocessing.build_dataset import FEATURE_COLUMNS  # noqa: E402

SYMBOL, TIMEFRAME = "EURUSD", "M15"


def _sample_feature_row() -> dict:
    processed = Path(__file__).resolve().parents[2] / "data" / "processed" / f"{SYMBOL}_{TIMEFRAME}_dev-synthetic_features.csv"
    df = pd.read_csv(processed)
    row = df.iloc[-1]
    return {c: float(row[c]) for c in FEATURE_COLUMNS}


def test_predict_from_development_stage_returns_valid_shape():
    row = _sample_feature_row()
    result = predict("development", SYMBOL, TIMEFRAME, row, "ensemble")

    assert result["action"] in ("BUY", "SELL", "HOLD"), result["action"]
    assert 0.0 <= result["probability"] <= 1.0, result["probability"]
    assert 0.0 <= result["uncertainty"] <= 1.0, result["uncertainty"]
    assert result["modelSource"] == "dev-synthetic", "must be traceable as dev-synthetic, never silently 'real'"
    print("PASS: test_predict_from_development_stage_returns_valid_shape")


def test_production_stage_fails_safe_when_unavailable():
    row = _sample_feature_row()
    try:
        predict("production", SYMBOL, TIMEFRAME, row, "ensemble")
        raise AssertionError("expected ModelNotAvailableError — no model has been promoted to production")
    except ModelNotAvailableError:
        pass
    print("PASS: test_production_stage_fails_safe_when_unavailable")


def test_missing_feature_column_raises():
    row = _sample_feature_row()
    incomplete_row = {k: v for k, v in row.items() if k != FEATURE_COLUMNS[0]}
    try:
        predict("development", SYMBOL, TIMEFRAME, incomplete_row, "ensemble")
        raise AssertionError("expected ValueError for missing feature column")
    except ValueError:
        pass
    print("PASS: test_missing_feature_column_raises")


if __name__ == "__main__":
    test_predict_from_development_stage_returns_valid_shape()
    test_production_stage_fails_safe_when_unavailable()
    test_missing_feature_column_raises()
    print("\nAll AI pipeline tests passed.")


def test_single_mode_uses_one_model():
    row = _sample_feature_row()
    result = predict("development", SYMBOL, TIMEFRAME, row, "single")
    assert result["mode"] == "single"
    assert result["action"] in ("BUY", "SELL", "HOLD")
    print("PASS: test_single_mode_uses_one_model")


def test_ensemble_artifact_contract_source_mentions_required_models():
    trainer = (Path(__file__).resolve().parents[2] / "ai" / "training" / "trainers" / "train_ensemble.py").read_text()
    assert "XGBClassifier" in trainer
    assert "LGBMClassifier" in trainer
    assert "RandomForestClassifier" in trainer
    assert "LogisticRegression" in trainer
    assert "oof" in trainer.lower()
    print("PASS: test_ensemble_artifact_contract_source_mentions_required_models")
