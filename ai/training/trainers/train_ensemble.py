"""Train a calibrated, leakage-safe ML ensemble.

Production design:
- XGBoost is the primary tree model.
- LightGBM is a second, deliberately different boosting implementation.
- Random Forest provides model diversity.
- A logistic-regression meta-model learns how to combine OUT-OF-FOLD member
  probabilities. It is trained only on predictions generated without seeing
  the corresponding validation rows.

Synthetic/development data may validate the pipeline but is never a
production-quality trading claim.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.calibration import CalibratedClassifierCV
from sklearn.ensemble import RandomForestClassifier
from sklearn.model_selection import TimeSeriesSplit
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import balanced_accuracy_score

try:
    from xgboost import XGBClassifier
except ImportError as exc:  # pragma: no cover - dependency guard
    XGBClassifier = None
    _XGB_IMPORT_ERROR = exc

try:
    from lightgbm import LGBMClassifier
except ImportError as exc:  # pragma: no cover - dependency guard
    LGBMClassifier = None
    _LGBM_IMPORT_ERROR = exc

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from ai.common.config import MODELS_DEVELOPMENT, ModelMetadata, compute_feature_baseline_stats, new_version_tag  # noqa: E402
from ai.training.preprocessing.build_dataset import FEATURE_COLUMNS, HORIZON_BARS  # noqa: E402
from ai.validation.metrics import brier_score_multiclass  # noqa: E402
from ai.validation.walk_forward import make_walk_forward_folds  # noqa: E402

CLASSES = ["DOWN", "FLAT", "UP"]


def _require_dependencies() -> None:
    missing = []
    if XGBClassifier is None:
        missing.append(f"xgboost ({_XGB_IMPORT_ERROR})")
    if LGBMClassifier is None:
        missing.append(f"lightgbm ({_LGBM_IMPORT_ERROR})")
    if missing:
        raise RuntimeError("Required ML dependencies are missing: " + "; ".join(missing))


def factories(seed: int) -> list:
    """Return deliberately diverse base learners."""
    _require_dependencies()
    return [
        XGBClassifier(
            n_estimators=200, max_depth=4, learning_rate=0.03,
            subsample=0.85, colsample_bytree=0.85,
            min_child_weight=5, reg_lambda=2.0,
            objective="multi:softprob", num_class=3,
            eval_metric="mlogloss", random_state=seed,
            n_jobs=-1, tree_method="hist",
        ),
        LGBMClassifier(
            n_estimators=200, num_leaves=31, max_depth=-1,
            learning_rate=0.03, subsample=0.85, colsample_bytree=0.85,
            min_child_samples=30, reg_lambda=2.0,
            objective="multiclass", num_class=3,
            random_state=seed, n_jobs=-1, verbosity=-1,
        ),
        RandomForestClassifier(
            n_estimators=300, max_depth=10, min_samples_leaf=5,
            class_weight="balanced_subsample", random_state=seed, n_jobs=-1,
        ),
    ]


def _aligned_proba(model, X: np.ndarray) -> np.ndarray:
    p = model.predict_proba(X)
    classes = list(model.classes_)
    aligned = np.zeros((len(X), len(CLASSES)), dtype=float)
    for i, cls in enumerate(CLASSES):
        key = i if i in classes else cls
        if key in classes:
            aligned[:, i] = p[:, classes.index(key)]
    sums = aligned.sum(axis=1)
    if np.any(~np.isfinite(aligned)) or np.any(sums <= 0):
        raise ValueError("model produced invalid probabilities")
    return aligned / sums[:, None]


def _fit_calibrated(base, X, y):
    # Calibration remains chronological: no future calibration fold is used
    # to calibrate an earlier fold inside the training window.
    n_splits = min(3, max(2, len(X) // 200))
    if n_splits < 2:
        raise ValueError("not enough rows for chronological probability calibration")
    return CalibratedClassifierCV(base, method="sigmoid", cv=TimeSeriesSplit(n_splits=n_splits), n_jobs=-1).fit(X, y)


def train_and_validate(dataset_path: Path, symbol: str, timeframe: str, n_folds: int = 3) -> dict:
    _require_dependencies()
    df = pd.read_csv(dataset_path)
    required = FEATURE_COLUMNS + ["label", "timestamp_utc", "source"]
    missing = [c for c in required if c not in df.columns]
    if missing:
        raise ValueError(f"dataset missing required columns: {missing}")
    if df["source"].dropna().nunique() != 1:
        raise ValueError("dataset must contain exactly one source provenance value")
    source = str(df["source"].dropna().iloc[0])
    if source in {"", "unknown", "dev", "synthetic"}:
        raise ValueError(f"dataset provenance is not production-identifiable: {source!r}")
    df = df.sort_values("timestamp_utc").dropna(subset=FEATURE_COLUMNS + ["label", "timestamp_utc"]).reset_index(drop=True)
    X = df[FEATURE_COLUMNS].to_numpy(dtype=float)
    label_to_int = {"DOWN": 0, "FLAT": 1, "UP": 2}
    if not df["label"].isin(label_to_int).all():
        raise ValueError("dataset contains unknown labels")
    y = df["label"].map(label_to_int).to_numpy(dtype=int)
    if len(df) < 1000:
        raise ValueError("dataset too small for a meaningful ensemble evaluation; need at least 1000 clean rows")
    if len(np.unique(y)) < 3:
        raise ValueError("training dataset must contain DOWN, FLAT and UP classes")

    # Keep a completely untouched final chronological OOS block. It is not
    # used for feature selection, walk-forward fitting, calibration, or meta
    # training. This is the production qualification set.
    final_oos_rows = max(200, int(len(df) * 0.15))
    if len(df) - final_oos_rows < 1000:
        raise ValueError("dataset needs at least 1200 clean rows to reserve a meaningful final OOS block")
    dev_end = len(df) - final_oos_rows
    X_dev, y_dev = X[:dev_end], y[:dev_end]
    X_oos, y_oos = X[dev_end:], y[dev_end:]
    if len(np.unique(y_dev)) < 3 or len(np.unique(y_oos)) < 3:
        raise ValueError("development and final OOS windows must each contain all three classes")

    folds = make_walk_forward_folds(
        len(X_dev), n_folds=n_folds,
        min_train_size=max(500, len(X_dev) // (n_folds + 2)),
        embargo=HORIZON_BARS,
    )
    if not folds:
        raise ValueError("no walk-forward folds available")

    fold_reports = []
    oof_member = []
    oof_y = []

    for fold in folds:
        Xtr, ytr = X_dev[fold.train_start:fold.train_end], y_dev[fold.train_start:fold.train_end]
        Xte, yte = X_dev[fold.test_start:fold.test_end], y_dev[fold.test_start:fold.test_end]
        yte_names = np.array(CLASSES)[yte]
        if len(np.unique(ytr)) < 3 or not len(Xte):
            continue
        member_proba = []
        for base in factories(fold.fold_index):
            calibrated = _fit_calibrated(base, Xtr, ytr)
            member_proba.append(_aligned_proba(calibrated, Xte))
        member_matrix = np.hstack(member_proba)
        oof_member.append(member_matrix)
        oof_y.extend(yte.tolist())
        simple_avg = np.mean(np.stack(member_proba), axis=0)
        pred = np.array(CLASSES)[np.argmax(simple_avg, axis=1)]
        fold_reports.append({
            "fold_index": fold.fold_index,
            "train_rows": int(fold.train_end - fold.train_start),
            "test_rows": int(fold.test_end - fold.test_start),
            "accuracy": float(np.mean(pred == yte_names)),
            "brier": brier_score_multiclass(yte_names, simple_avg, CLASSES),
        })

    if not fold_reports:
        raise ValueError("all walk-forward folds were degenerate")

    meta_X = np.vstack(oof_member)
    meta_y = np.asarray(oof_y, dtype=int)
    if len(np.unique(meta_y)) < 3:
        raise ValueError("OOF meta-dataset does not contain all classes")

    meta_base = LogisticRegression(
        max_iter=2000, C=0.5, class_weight="balanced", random_state=0,
    )
    meta_splits = min(3, max(2, len(meta_X) // 200))
    if len(meta_X) <= meta_splits * (HORIZON_BARS + 20):
        raise ValueError("OOF meta-dataset too small for embargoed chronological calibration")
    meta_model = CalibratedClassifierCV(
        meta_base, method="sigmoid", cv=TimeSeriesSplit(n_splits=meta_splits, gap=HORIZON_BARS), n_jobs=-1
    ).fit(meta_X, meta_y)

    # Deployment candidate is trained only on the development window. The
    # final OOS window remains untouched for the qualification report.
    members = [_fit_calibrated(base, X_dev, y_dev) for base in factories(0)]
    oos_member = [_aligned_proba(member, X_oos) for member in members]
    oos_simple = np.mean(np.stack(oos_member), axis=0)
    oos_meta = _aligned_proba(meta_model, np.hstack(oos_member))
    oos_simple_pred = np.array(CLASSES)[np.argmax(oos_simple, axis=1)]
    oos_meta_pred = np.array(CLASSES)[np.argmax(oos_meta, axis=1)]

    version = new_version_tag()
    artifact = {
        "models": members,
        "meta_model": meta_model,
        "classes": CLASSES,
        "feature_columns": FEATURE_COLUMNS,
        "ensemble_version": "xgboost-lightgbm-randomforest-meta-v2",
        "qualification": {
            "development_rows": int(dev_end),
            "final_oos_rows": int(final_oos_rows),
            "final_oos_start_timestamp": str(df.iloc[dev_end]["timestamp_utc"]),
        },
    }
    path = MODELS_DEVELOPMENT / f"{symbol}_{timeframe}_{version}.joblib"
    temp_path = path.with_suffix(".joblib.tmp")
    joblib.dump(artifact, temp_path)

    y_oos_names = np.array(CLASSES)[y_oos]
    class_counts = np.bincount(y_oos, minlength=3)
    majority_baseline = float(class_counts.max() / len(y_oos))
    prior = class_counts / len(y_oos)
    baseline_proba = np.tile(prior, (len(y_oos), 1))
    metrics = {
        "oos_majority_accuracy_baseline": majority_baseline,
        "oos_balanced_accuracy": float(balanced_accuracy_score(y_oos_names, oos_meta_pred, labels=CLASSES)),
        "oos_brier_prior_baseline": brier_score_multiclass(y_oos_names, baseline_proba, CLASSES),
        "oof_simple_ensemble_accuracy": float(np.mean([x["accuracy"] for x in fold_reports])),
        "oof_simple_ensemble_brier": float(np.mean([x["brier"] for x in fold_reports])),
        "oos_simple_ensemble_accuracy": float(np.mean(oos_simple_pred == np.array(CLASSES)[y_oos])),
        "oos_simple_ensemble_brier": brier_score_multiclass(np.array(CLASSES)[y_oos], oos_simple, CLASSES),
        "oos_meta_accuracy": float(np.mean(oos_meta_pred == np.array(CLASSES)[y_oos])),
        "oos_meta_brier": brier_score_multiclass(np.array(CLASSES)[y_oos], oos_meta, CLASSES),
        "final_oos_rows": int(final_oos_rows),
        "final_oos_start_timestamp": str(df.iloc[dev_end]["timestamp_utc"]),
        "per_fold": fold_reports,
    }
    # Computed over the same development-window rows (X_dev) the deployed
    # `members` were actually fit on above — not the untouched final OOS
    # block, and not the full df.
    feature_baseline_stats = compute_feature_baseline_stats(df.iloc[:dev_end], FEATURE_COLUMNS)
    notes = []
    if source == "dev-synthetic":
        notes.append("TRAINED ON DEV-SYNTHETIC DATA — pipeline validation only; never promote to production")
    notes.append("Final OOS block is chronologically held out from walk-forward training and meta-model fitting.")

    metadata = ModelMetadata(
        model_name="xgboost-lightgbm-randomforest-meta-ensemble",
        model_version=version,
        trained_at_utc=pd.Timestamp.now("UTC").isoformat(),
        symbol=symbol, timeframe=timeframe, feature_schema=FEATURE_COLUMNS,
        training_data_source=source, training_row_count=int(dev_end),
        walk_forward_folds=len(fold_reports), metrics=metrics, notes=notes,
        feature_baseline_stats=feature_baseline_stats,
    )
    meta_path = path.with_suffix(".json")
    meta_path.write_text(json.dumps(metadata.to_dict(), indent=2))
    temp_path.replace(path)
    return {"model_path": str(path), "metadata_path": str(meta_path), "training_source": source, **metrics}



def main():
    files = sorted((Path(__file__).resolve().parents[3] / "data" / "processed").glob("*_features.csv"))
    if not files:
        raise SystemExit("no processed datasets")
    for p in files:
        parts = p.name.replace("_features.csv", "").split("_")
        if len(parts) < 2:
            raise SystemExit(f"cannot infer symbol/timeframe from {p.name}")
        print(json.dumps(train_and_validate(p, parts[0], parts[1]), indent=2))


if __name__ == "__main__":
    main()
