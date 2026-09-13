"""
Builds a feature/label dataset from a raw OHLCV CSV exported by
scripts/export-historical-data.ts.

LABEL DEFINITION (documented explicitly per spec section 2 — "look-ahead
bias" and "data leakage" are named failure modes):

    label(t) = sign of (close[t + horizon] - close[t]) / close[t],
               thresholded into {DOWN, FLAT, UP}

This means label(t) is NOT knowable until `horizon` bars after t. Any
model trained on rows near the end of the dataset, or any walk-forward
split that doesn't embargo at least `horizon` bars between train and
test, will leak future information. `HORIZON_BARS` here must match the
`embargo` passed to make_walk_forward_folds.
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from ai.common.config import DATA_PROCESSED  # noqa: E402

HORIZON_BARS = 5
FLAT_THRESHOLD = 0.0005  # +/- 0.05% over the horizon counts as FLAT, not UP/DOWN

# Structure/price-action lookback (bars). 20 on M15 ~= 5 hours of context.
SWING_LOOKBACK = 20

# Higher-timeframe context (spec section 7). The mapping is explicit so
# training and live serving use the same higher-timeframe relationship.
HTF_EMA_PERIOD = 20
HTF_BY_TIMEFRAME = {"M1": 60, "M5": 60, "M15": 60, "H1": 240, "H4": 1440, "D1": None}

FEATURE_COLUMNS = [
    "sma20", "ema20", "rsi14", "atr14", "close_vs_sma20", "close_vs_ema20", "atr_pct",
    "adx14", "swing_high_dist", "swing_low_dist", "bos_bull", "bos_bear", "range_pct", "htf_trend",
    "wma20", "macd", "macd_signal", "macd_histogram", "stochastic_k", "stochastic_d",
    "roc12", "bollinger_width", "bollinger_percent_b", "historical_volatility20", "vwap_distance", "obv",
    "higher_high", "higher_low", "lower_high", "lower_low", "choch_bull", "choch_bear",
    "pattern_bullish", "pattern_bearish",
]


def _wma(series: pd.Series, period: int) -> pd.Series:
    weights = np.arange(1, period + 1, dtype=float)
    return series.rolling(period, min_periods=period).apply(lambda x: float(np.dot(x, weights) / weights.sum()), raw=True)

def _macd(series: pd.Series, fast: int = 12, slow: int = 26, signal: int = 9) -> tuple[pd.Series, pd.Series, pd.Series]:
    fast_ema = series.ewm(span=fast, min_periods=fast, adjust=False).mean()
    slow_ema = series.ewm(span=slow, min_periods=slow, adjust=False).mean()
    line = fast_ema - slow_ema
    sig = line.ewm(span=signal, min_periods=signal, adjust=False).mean()
    return line, sig, line - sig

def _stochastic(df: pd.DataFrame, period: int = 14, smooth: int = 3) -> tuple[pd.Series, pd.Series]:
    low = df["low"].rolling(period, min_periods=period).min()
    high = df["high"].rolling(period, min_periods=period).max()
    k = 100 * (df["close"] - low) / (high - low).replace(0, np.nan)
    d = k.rolling(smooth, min_periods=smooth).mean()
    return k, d

def _roc(series: pd.Series, period: int = 12) -> pd.Series:
    return series.pct_change(periods=period)

def _bollinger(series: pd.Series, period: int = 20, mult: float = 2.0) -> tuple[pd.Series, pd.Series]:
    mid = series.rolling(period, min_periods=period).mean()
    sd = series.rolling(period, min_periods=period).std(ddof=0)
    upper, lower = mid + mult * sd, mid - mult * sd
    width = (upper - lower) / mid.replace(0, np.nan)
    pct_b = (series - lower) / (upper - lower).replace(0, np.nan)
    return width, pct_b

def _historical_volatility(series: pd.Series, period: int = 20) -> pd.Series:
    return np.log(series / series.shift(1)).rolling(period, min_periods=period).std(ddof=1) * np.sqrt(252)

def _obv(df: pd.DataFrame, period: int = 20) -> pd.Series:
    direction = np.sign(df["close"].diff()).fillna(0)
    signed_volume = direction * df["volume"].clip(lower=0)
    # Live inference calculates OBV from the bounded candle window, so a
    # rolling signed-volume measure keeps train/serve semantics stable and
    # prevents the absolute value from depending on dataset start date.
    return signed_volume.rolling(period, min_periods=period).sum()

def _pattern_scores(df: pd.DataFrame) -> tuple[pd.Series, pd.Series]:
    body = (df["close"] - df["open"]).abs()
    rng = (df["high"] - df["low"]).replace(0, np.nan)
    upper = df["high"] - df[["open", "close"]].max(axis=1)
    lower = df[["open", "close"]].min(axis=1) - df["low"]
    a_open, a_close = df["open"].shift(2), df["close"].shift(2)
    b_open, b_close = df["open"].shift(1), df["close"].shift(1)
    b_high, b_low = df["high"].shift(1), df["low"].shift(1)
    bull = (
        ((lower >= body * 2) & (upper <= body * .75))
        | ((upper >= body * 2) & (lower <= body * .75))
        | ((b_close < b_open) & (df["close"] > df["open"]) & (df["open"] <= b_close) & (df["close"] >= b_open))
        | ((a_close < a_open) & (df["close"] > df["open"]) & (body.shift(1) < body.shift(2) * .6) & (df["close"] > (a_open + a_close) / 2))
        | ((b_close < b_open) & (df["close"] > df["open"]) & (df["open"] < b_low) & (df["close"] > (b_open + b_close) / 2))
        | ((body / rng >= .9) & (df["close"] > df["open"]))
        | ((abs(b_low - df["low"]) <= rng * .15) & (b_close < b_open) & (df["close"] > df["open"]))
    )
    bear = (
        ((upper >= body * 2) & (lower <= body * .75))
        | ((upper >= body * 2) & (lower <= body * .5) & (df["close"] < df["open"]))
        | ((lower >= body * 2) & (upper <= body * .5) & (df["close"] < df["open"]))
        | ((b_close > b_open) & (df["close"] < df["open"]) & (df["open"] >= b_close) & (df["close"] <= b_open))
        | ((a_close > a_open) & (df["close"] < df["open"]) & (body.shift(1) < body.shift(2) * .6) & (df["close"] < (a_open + a_close) / 2))
        | ((b_close > b_open) & (df["close"] < df["open"]) & (df["open"] > b_high) & (df["close"] < (b_open + b_close) / 2))
        | ((body / rng >= .9) & (df["close"] < df["open"]))
        | ((abs(b_high - df["high"]) <= rng * .15) & (b_close > b_open) & (df["close"] < df["open"]))
    )
    return bull.astype(float), bear.astype(float)

def _structure_features(df: pd.DataFrame, lookback: int = SWING_LOOKBACK) -> pd.DataFrame:
    rh = df["high"].rolling(lookback, min_periods=lookback).max()
    rl = df["low"].rolling(lookback, min_periods=lookback).min()
    ph = rh.shift(lookback)
    pl = rl.shift(lookback)
    # Compare completed blocks only; no current/future bars are introduced.
    hh = (rh > ph).astype(float)
    hl = (rl > pl).astype(float)
    lh = (rh < ph).astype(float)
    ll = (rl < pl).astype(float)
    bos_bull = (df["close"] > df["high"].shift(1).rolling(lookback, min_periods=lookback).max()).astype(float)
    bos_bear = (df["close"] < df["low"].shift(1).rolling(lookback, min_periods=lookback).min()).astype(float)
    return pd.DataFrame({"higher_high": hh, "higher_low": hl, "lower_high": lh, "lower_low": ll, "choch_bull": ((bos_bull > 0) & (lh > 0)).astype(float), "choch_bear": ((bos_bear > 0) & (hl > 0)).astype(float)})

def _sma(series: pd.Series, period: int) -> pd.Series:
    return series.rolling(period, min_periods=period).mean()


def _ema(series: pd.Series, period: int) -> pd.Series:
    return series.ewm(span=period, min_periods=period, adjust=False).mean()


def _rsi(series: pd.Series, period: int = 14) -> pd.Series:
    delta = series.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)
    avg_gain = gain.rolling(period, min_periods=period).mean()
    avg_loss = loss.rolling(period, min_periods=period).mean()
    rs = avg_gain / avg_loss.replace(0, np.nan)
    rsi = 100 - (100 / (1 + rs))
    return rsi.fillna(100)  # avg_loss == 0 -> maximally overbought, matches core/features/indicators.ts


def _atr(df: pd.DataFrame, period: int = 14) -> pd.Series:
    prev_close = df["close"].shift(1)
    tr = pd.concat(
        [df["high"] - df["low"], (df["high"] - prev_close).abs(), (df["low"] - prev_close).abs()],
        axis=1,
    ).max(axis=1)
    return tr.rolling(period, min_periods=period).mean()


def _true_range(df: pd.DataFrame) -> pd.Series:
    prev_close = df["close"].shift(1)
    return pd.concat(
        [df["high"] - df["low"], (df["high"] - prev_close).abs(), (df["low"] - prev_close).abs()],
        axis=1,
    ).max(axis=1)


def _adx(df: pd.DataFrame, period: int = 14) -> pd.Series:
    """
    Wilder's Average Directional Index, trend-strength only (no direction
    sign — direction is already carried by close_vs_sma20/ema20). Uses a
    simple rolling mean rather than Wilder's exponential smoothing, for
    consistency with how _rsi/_atr already approximate Wilder's method in
    this codebase; this is a documented simplification, not a bug.
    """
    up_move = df["high"].diff()
    down_move = -df["low"].diff()
    plus_dm = np.where((up_move > down_move) & (up_move > 0), up_move, 0.0)
    minus_dm = np.where((down_move > up_move) & (down_move > 0), down_move, 0.0)

    tr_smooth = _true_range(df).rolling(period, min_periods=period).mean()
    plus_dm_smooth = pd.Series(plus_dm, index=df.index).rolling(period, min_periods=period).mean()
    minus_dm_smooth = pd.Series(minus_dm, index=df.index).rolling(period, min_periods=period).mean()

    plus_di = 100 * (plus_dm_smooth / tr_smooth.replace(0, np.nan))
    minus_di = 100 * (minus_dm_smooth / tr_smooth.replace(0, np.nan))
    di_sum = (plus_di + minus_di).replace(0, np.nan)
    dx = 100 * (plus_di - minus_di).abs() / di_sum
    adx = dx.rolling(period, min_periods=period).mean()
    return adx.fillna(0)  # no directional movement at all -> no trend strength, not "unknown"


def _swing_levels(df: pd.DataFrame, lookback: int = SWING_LOOKBACK) -> tuple[pd.Series, pd.Series]:
    """
    Prior-bar swing high/low: the highest high and lowest low over the
    `lookback` bars BEFORE the current one (shift(1) first). Using
    shift(1) is what makes "close broke above the recent range" a real
    statistical event rather than the current bar trivially satisfying a
    window that includes itself.
    """
    swing_high = df["high"].shift(1).rolling(lookback, min_periods=lookback).max()
    swing_low = df["low"].shift(1).rolling(lookback, min_periods=lookback).min()
    return swing_high, swing_low


def _htf_trend(df: pd.DataFrame, base_minutes: int, htf_minutes: int | None, ema_period: int = HTF_EMA_PERIOD) -> pd.Series:
    """
    For each base-timeframe bar, looks up the close_vs_ema of the most
    recent HIGHER-timeframe bar that had already fully CLOSED by that
    bar's timestamp (open time + htf_minutes), via merge_asof(direction=
    "backward"). This is the no-lookahead mechanism spec section 7 asks
    for: it's mechanically impossible for this feature to see an HTF bar
    that wasn't yet closed at decision time.

    HTF bars are grouped by actual UTC clock boundaries
    (timestamp // htf_interval_ms), NOT by row position. Position-based
    grouping (row_index // bars_per_htf) would make "which bars form an
    HTF candle" depend on wherever the input happened to start — fine
    for a full historical CSV starting at row 0, but silently wrong for
    a live sliding window of candles that doesn't start at the same
    offset. Clock-boundary grouping gives the same HTF bars regardless
    of where the candle window starts, which is what core/features/
    indicators.ts `htfTrend` also relies on for train/serve parity.
    """
    if htf_minutes is None:
        return pd.Series(0.0, index=df.index)
    if htf_minutes % base_minutes != 0 or htf_minutes // base_minutes < 2:
        raise ValueError(f"htf_minutes ({htf_minutes}) must be a multiple of base_minutes ({base_minutes}) >= 2x")

    htf_interval_ms = htf_minutes * 60_000
    bucket = df["timestamp_utc"] // htf_interval_ms
    htf = df.groupby(bucket)["close"].last().reset_index()
    htf.columns = ["bucket", "close"]
    htf = htf.sort_values("bucket").reset_index(drop=True)
    htf["htf_ema"] = _ema(htf["close"], ema_period)
    htf["htf_close_vs_ema"] = (htf["close"] - htf["htf_ema"]) / htf["htf_ema"]
    # The bucket boundary IS the close time of the HTF bar it identifies
    # (bucket N covers [N*interval, (N+1)*interval), which closes at
    # (N+1)*interval).
    htf_close_time_ms = (htf["bucket"] + 1) * htf_interval_ms

    right = pd.DataFrame({"htf_close_time_ms": htf_close_time_ms, "htf_close_vs_ema": htf["htf_close_vs_ema"]}).sort_values("htf_close_time_ms")
    left = df[["timestamp_utc"]].reset_index().sort_values("timestamp_utc")
    merged = pd.merge_asof(left, right, left_on="timestamp_utc", right_on="htf_close_time_ms", direction="backward")
    return merged.sort_values("index")["htf_close_vs_ema"].reset_index(drop=True)


def build_dataset(raw_csv_path: Path) -> pd.DataFrame:
    df = pd.read_csv(raw_csv_path)
    df = df.sort_values("timestamp_utc").reset_index(drop=True)

    if not df["is_closed"].all():
        raise ValueError("dataset builder requires all-closed candles; found an in-progress candle")

    source = df["source"].iloc[0]
    if source == "dev-synthetic":
        pass  # allowed for pipeline development; caller must not treat resulting model as production-ready
    else:
        # Real data path — no special handling needed yet, but this branch
        # exists so a future real-data quirk doesn't get silently absorbed
        # into the dev-only code path above.
        pass

    df["sma20"] = _sma(df["close"], 20)
    df["ema20"] = _ema(df["close"], 20)
    df["rsi14"] = _rsi(df["close"], 14)
    df["atr14"] = _atr(df, 14)
    df["close_vs_sma20"] = (df["close"] - df["sma20"]) / df["sma20"]
    df["close_vs_ema20"] = (df["close"] - df["ema20"]) / df["ema20"]
    df["atr_pct"] = df["atr14"] / df["close"]

    df["adx14"] = _adx(df, 14)

    swing_high, swing_low = _swing_levels(df, SWING_LOOKBACK)
    df["swing_high_dist"] = (swing_high - df["close"]) / df["close"]
    df["swing_low_dist"] = (df["close"] - swing_low) / df["close"]
    df["bos_bull"] = (df["close"] > swing_high).astype(float)
    df["bos_bear"] = (df["close"] < swing_low).astype(float)
    df["range_pct"] = (swing_high - swing_low) / df["close"]

    timeframe = str(df["timeframe"].iloc[0])
    base_minutes = {"M1": 1, "M5": 5, "M15": 15, "H1": 60, "H4": 240, "D1": 1440}.get(timeframe)
    if base_minutes is None or timeframe not in HTF_BY_TIMEFRAME:
        raise ValueError(f"unsupported timeframe for HTF feature: {timeframe}")
    df["htf_trend"] = _htf_trend(df, base_minutes, HTF_BY_TIMEFRAME[timeframe])
    df["wma20"] = _wma(df["close"], 20)
    df["macd"], df["macd_signal"], df["macd_histogram"] = _macd(df["close"])
    df["stochastic_k"], df["stochastic_d"] = _stochastic(df)
    df["roc12"] = _roc(df["close"], 12)
    df["bollinger_width"], df["bollinger_percent_b"] = _bollinger(df["close"])
    df["historical_volatility20"] = _historical_volatility(df["close"])
    vwap_num = (((df["high"] + df["low"] + df["close"]) / 3) * df["volume"].clip(lower=0)).rolling(20, min_periods=20).sum()
    vwap_den = df["volume"].clip(lower=0).rolling(20, min_periods=20).sum()
    df["vwap_distance"] = (df["close"] - vwap_num / vwap_den.replace(0, np.nan)) / (vwap_num / vwap_den.replace(0, np.nan))
    df["obv"] = _obv(df)
    structure = _structure_features(df)
    for col in structure.columns: df[col] = structure[col].values
    df["pattern_bullish"], df["pattern_bearish"] = _pattern_scores(df)

    future_close = df["close"].shift(-HORIZON_BARS)
    forward_return = (future_close - df["close"]) / df["close"]
    df["forward_return"] = forward_return
    df["label"] = np.select(
        [forward_return > FLAT_THRESHOLD, forward_return < -FLAT_THRESHOLD],
        ["UP", "DOWN"],
        default="FLAT",
    )

    # Drop rows where features aren't fully warmed up, and the LAST
    # `HORIZON_BARS` rows, whose label depends on close prices that
    # don't exist yet (would otherwise be NaN and silently misleading).
    df = df.iloc[:-HORIZON_BARS] if HORIZON_BARS > 0 else df
    df = df.dropna(subset=FEATURE_COLUMNS + ["label"]).reset_index(drop=True)

    return df


def main():
    raw_files = sorted(Path(__file__).resolve().parents[3].joinpath("data", "raw").glob("*.csv"))
    if not raw_files:
        raise SystemExit("no raw CSV files found in data/raw — run scripts/export-historical-data.ts first")

    for raw_path in raw_files:
        dataset = build_dataset(raw_path)
        out_path = DATA_PROCESSED / raw_path.name.replace(".csv", "_features.csv")
        dataset.to_csv(out_path, index=False)
        print(f"{raw_path.name}: {len(dataset)} labeled rows -> {out_path}")
        print(dataset["label"].value_counts(normalize=True).rename("label_share"))


if __name__ == "__main__":
    main()
