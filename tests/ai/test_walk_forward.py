"""
Tests for ai/validation/walk_forward.py's fold splitter.

This function is the mechanism that prevents label leakage across the
train/test boundary (see build_dataset.py's HORIZON_BARS docstring), so
its embargo and expanding-window behavior are tested directly rather
than only indirectly through the trainer.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from ai.validation.walk_forward import make_walk_forward_folds  # noqa: E402


def test_embargo_gap_is_maintained_between_every_train_end_and_test_start():
    horizon = 5
    folds = make_walk_forward_folds(n_rows=200, n_folds=4, min_train_size=100, embargo=horizon)
    assert len(folds) > 0
    for fold in folds:
        gap = fold.test_start - fold.train_end
        assert gap == horizon, (
            f"fold {fold.fold_index}: embargo gap {gap} must equal the configured embargo "
            f"({horizon}) or a label depending on {horizon} future bars can leak across the boundary"
        )
    print("PASS: test_embargo_gap_is_maintained_between_every_train_end_and_test_start")


def test_folds_expand_and_stay_chronological_and_non_overlapping():
    folds = make_walk_forward_folds(n_rows=200, n_folds=4, min_train_size=100, embargo=5)
    prev_train_end = None
    for fold in folds:
        assert fold.train_start == 0, "training window must always start at row 0 (expanding window)"
        if prev_train_end is not None:
            assert fold.train_end >= prev_train_end, "training window must never shrink between folds"
        assert fold.train_end <= fold.test_start, "train and test ranges must not overlap"
        assert fold.test_start < fold.test_end, "every fold must cover at least one test row"
        prev_train_end = fold.train_end
    assert folds[-1].test_end == 200, "the final fold must extend through the last row"
    print("PASS: test_folds_expand_and_stay_chronological_and_non_overlapping")


def test_zero_embargo_still_produces_adjacent_non_overlapping_folds():
    folds = make_walk_forward_folds(n_rows=120, n_folds=3, min_train_size=60, embargo=0)
    for fold in folds:
        assert fold.test_start == fold.train_end, "zero embargo means test starts exactly where train ends"
    print("PASS: test_zero_embargo_still_produces_adjacent_non_overlapping_folds")


def test_insufficient_rows_raise_instead_of_silently_producing_bad_folds():
    try:
        make_walk_forward_folds(n_rows=50, n_folds=4, min_train_size=100, embargo=5)
        raise AssertionError("expected ValueError for n_rows <= min_train_size")
    except ValueError:
        pass
    print("PASS: test_insufficient_rows_raise_instead_of_silently_producing_bad_folds")


test_embargo_gap_is_maintained_between_every_train_end_and_test_start()
test_folds_expand_and_stay_chronological_and_non_overlapping()
test_zero_embargo_still_produces_adjacent_non_overlapping_folds()
test_insufficient_rows_raise_instead_of_silently_producing_bad_folds()
print("\nAll walk-forward fold tests passed.")
