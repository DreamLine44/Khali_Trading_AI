"""
Classification + calibration metrics for walk-forward evaluation.

Per spec section 26, evaluate more than win rate/accuracy: calibration
quality matters because the decision engine treats model probability as
a confidence signal, not just a class label.
"""
from __future__ import annotations

import numpy as np
from sklearn.metrics import accuracy_score, log_loss, precision_recall_fscore_support


def classification_report(y_true: np.ndarray, y_pred: np.ndarray, y_proba: np.ndarray, classes: list[str]) -> dict:
    precision, recall, f1, support = precision_recall_fscore_support(
        y_true, y_pred, labels=classes, zero_division=0
    )
    per_class = {
        cls: {"precision": float(p), "recall": float(r), "f1": float(f), "support": int(s)}
        for cls, p, r, f, s in zip(classes, precision, recall, f1, support)
    }
    try:
        loss = float(log_loss(y_true, y_proba, labels=classes))
    except ValueError:
        loss = None  # e.g. a class missing entirely from a small test fold

    return {
        "accuracy": float(accuracy_score(y_true, y_pred)),
        "log_loss": loss,
        "per_class": per_class,
        "n_samples": int(len(y_true)),
    }


def brier_score_multiclass(y_true: np.ndarray, y_proba: np.ndarray, classes: list[str]) -> float:
    """
    Multiclass Brier score: mean squared error between predicted
    probability vectors and one-hot true labels. Lower is better
    calibrated; 0 is perfect, ~2 is worst possible for 3 classes.
    """
    one_hot = np.zeros_like(y_proba)
    class_index = {c: i for i, c in enumerate(classes)}
    for row, label in enumerate(y_true):
        one_hot[row, class_index[label]] = 1.0
    return float(np.mean(np.sum((y_proba - one_hot) ** 2, axis=1)))
