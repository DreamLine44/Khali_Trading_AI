"""
Trains a calibrated UP/DOWN/FLAT classifier using walk-forward
validation, and saves a versioned candidate artifact.

This does NOT touch models/production — per spec section 28, a new
model must prove itself (walk-forward + out-of-sample) before any
promotion step, and promotion is a separate, explicit action.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.calibration import CalibratedClassifierCV
from sklearn.ensemble import GradientBoostingClassifier

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from ai.common.config import MODELS_DEVELOPMENT, ModelMetadata, compute_feature_baseline_stats, new_version_tag  # noqa: E402
from ai.training.preprocessing.build_dataset import FEATURE_COLUMNS, HORIZON_BARS  # noqa: E402
from ai.validation.metrics import brier_score_multiclass, classification_report  # noqa: E402
from ai.validation.walk_forward import make_walk_forward_folds  # noqa: E402

CLASSES = ["DOWN", "FLAT", "UP"]


def train_and_validate(dataset_path: Path, symbol: str, timeframe: str, n_folds: int = 5) -> dict:
    df = pd.read_csv(dataset_path)
    X = df[FEATURE_COLUMNS].to_numpy()
    y = df["label"].to_numpy()

    n_rows = len(df)
    min_train_size = max(200, n_rows // (n_folds + 2))
    folds = make_walk_forward_folds(n_rows, n_folds=n_folds, min_train_size=min_train_size, embargo=HORIZON_BARS)
    if len(folds) == 0:
        raise ValueError("no walk-forward folds could be formed — dataset too small for this fold/embargo config")

    fold_reports = []
    all_y_true, all_y_proba = [], []

    for fold in folds:
        X_train, y_train = X[fold.train_start:fold.train_end], y[fold.train_start:fold.train_end]
        X_test, y_test = X[fold.test_start:fold.test_end], y[fold.test_start:fold.test_end]
        if len(np.unique(y_train)) < 2 or len(X_test) == 0:
            continue  # cannot train/evaluate meaningfully on a degenerate fold

        base = GradientBoostingClassifier(n_estimators=50, max_depth=2, random_state=fold.fold_index)
        # cv=3 here is calibration's OWN internal split of the training
        # slice — still strictly before fold.test_start, so this does
        # not leak into the walk-forward test window.
        calibrated = CalibratedClassifierCV(base, method="isotonic", cv=3)
        calibrated.fit(X_train, y_train)

        y_proba = calibrated.predict_proba(X_test)
        y_pred = calibrated.classes_[np.argmax(y_proba, axis=1)]

        report = classification_report(y_test, y_pred, y_proba, list(calibrated.classes_))
        report["fold_index"] = fold.fold_index
        report["train_rows"] = int(fold.train_end - fold.train_start)
        report["test_rows"] = int(fold.test_end - fold.test_start)
        fold_reports.append(report)

        all_y_true.extend(y_test.tolist())
        all_y_proba.append(pd.DataFrame(y_proba, columns=list(calibrated.classes_)).reindex(columns=CLASSES, fill_value=0.0).to_numpy())

    if not fold_reports:
        raise ValueError("every walk-forward fold was degenerate — cannot validate this model")

    stacked_proba = np.vstack(all_y_proba)
    overall_brier = brier_score_multiclass(np.array(all_y_true), stacked_proba, CLASSES)
    overall_accuracy = float(np.mean([r["accuracy"] for r in fold_reports]))

    # Final artifact: retrain on ALL available rows for deployment. Its
    # quality claim rests entirely on the walk-forward numbers above,
    # not on any metric computed from this final fit.
    final_base = GradientBoostingClassifier(n_estimators=50, max_depth=2, random_state=0)
    final_model = CalibratedClassifierCV(final_base, method="isotonic", cv=3)
    final_model.fit(X, y)

    version = new_version_tag()
    model_path = MODELS_DEVELOPMENT / f"{symbol}_{timeframe}_{version}.joblib"
    joblib.dump({"model": final_model, "classes": list(final_model.classes_), "feature_columns": FEATURE_COLUMNS}, model_path)

    training_source = "dev-synthetic" if "dev-synthetic" in dataset_path.name else "unknown"
    # Computed over the same full `df` the final deployed model (final_model)
    # was fit on above, so the baseline matches what's actually shipped.
    feature_baseline_stats = compute_feature_baseline_stats(df, FEATURE_COLUMNS)
    metadata = ModelMetadata(
        model_name="gbdt-calibrated-updownflat",
        model_version=version,
        trained_at_utc=pd.Timestamp.now("UTC").isoformat(),
        symbol=symbol,
        timeframe=timeframe,
        feature_schema=FEATURE_COLUMNS,
        training_data_source=training_source,
        training_row_count=n_rows,
        walk_forward_folds=len(fold_reports),
        metrics={
            "walk_forward_overall_accuracy": overall_accuracy,
            "walk_forward_overall_brier": overall_brier,
            "per_fold": fold_reports,
        },
        notes=(
            ["TRAINED ON DEV-SYNTHETIC DATA — pipeline validation only, not a real trading model"]
            if training_source == "dev-synthetic"
            else []
        ),
        feature_baseline_stats=feature_baseline_stats,
    )
    metadata_path = MODELS_DEVELOPMENT / f"{symbol}_{timeframe}_{version}.json"
    metadata_path.write_text(json.dumps(metadata.to_dict(), indent=2))

    return {
        "model_path": str(model_path),
        "metadata_path": str(metadata_path),
        "overall_accuracy": overall_accuracy,
        "overall_brier": overall_brier,
        "n_folds_used": len(fold_reports),
        "training_source": training_source,
    }


def main():
    processed_dir = Path(__file__).resolve().parents[3] / "data" / "processed"
    dataset_files = sorted(processed_dir.glob("*_features.csv"))
    if not dataset_files:
        raise SystemExit("no processed feature files found — run ai/training/preprocessing/build_dataset.py first")

    for dataset_path in dataset_files:
        name_parts = dataset_path.name.replace("_features.csv", "").split("_")
        symbol, timeframe = name_parts[0], name_parts[1]
        result = train_and_validate(dataset_path, symbol, timeframe)
        print(json.dumps(result, indent=2))
        if result["training_source"] == "dev-synthetic":
            print(
                "\n*** WARNING: trained on dev-synthetic data. High accuracy here reflects "
                "how learnable the synthetic series is, NOT real predictive edge. Do not "
                "promote this artifact past models/development. ***\n"
            )


if __name__ == "__main__":
    main()
