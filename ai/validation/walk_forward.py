"""
Walk-forward validation splits (spec section 25).

Generates chronological (train, test) index ranges using an expanding
training window. This is deliberately NOT sklearn's TimeSeriesSplit
wrapped silently — the embargo gap is explicit so a label that depends
on future bars (e.g. "return over the next N bars") cannot leak across
the train/test boundary.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class WalkForwardFold:
    fold_index: int
    train_start: int
    train_end: int  # exclusive
    test_start: int
    test_end: int  # exclusive


def make_walk_forward_folds(
    n_rows: int,
    n_folds: int,
    min_train_size: int,
    embargo: int = 0,
) -> list[WalkForwardFold]:
    """
    Splits [0, n_rows) into `n_folds` expanding-window folds.

    `embargo` rows are excluded between the end of a training window and
    the start of its test window — this must be >= the label horizon
    (e.g. if a label is "return over the next 5 bars", embargo must be
    >= 5) or the test set can still be contaminated by information that
    leaked into training via overlapping label windows.
    """
    if n_rows <= min_train_size:
        raise ValueError(f"not enough rows ({n_rows}) for min_train_size ({min_train_size})")

    remaining = n_rows - min_train_size
    if remaining < n_folds:
        raise ValueError(f"not enough remaining rows ({remaining}) to form {n_folds} folds")

    test_size = remaining // n_folds
    folds: list[WalkForwardFold] = []

    train_end = min_train_size
    for i in range(n_folds):
        test_start = train_end + embargo
        test_end = test_start + test_size if i < n_folds - 1 else n_rows
        if test_start >= test_end:
            break
        folds.append(WalkForwardFold(fold_index=i, train_start=0, train_end=train_end, test_start=test_start, test_end=test_end))
        # Next fold's training set grows to include this fold's test data
        # (expanding window). The embargo gap itself is re-applied fresh
        # on the next iteration via `test_start = train_end + embargo`
        # above, so it does not need to be (and must not be) subtracted
        # again here — an earlier version of this line computed a
        # `test_end - embargo` value that was immediately overwritten and
        # never took effect; it's removed rather than restored, since the
        # unconditional `train_end = test_end` is the correct behavior.
        train_end = test_end

    return folds
