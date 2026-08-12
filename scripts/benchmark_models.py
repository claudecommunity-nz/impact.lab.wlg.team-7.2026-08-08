"""Re-run the model benchmark behind docs/model-card.md.

Regenerates `artifacts/model-benchmark.json`: the chronological
train/validation/test comparison of count-forecasting models over the ten
highest-volume countlines. Requires the gitignored WCC Parquet shards in
`data/transport_sensors/` and the benchmark extra
(`pip install -e ".[benchmark]"`).

Protocol, matching the committed result and the model card:

- scope: the ten countlines with the highest total count over the full frame;
- split: `movement_anomaly.validation.chronological_split` — train through
  31 May 2026, validation June 2026, test July 2026 (time ordered, no random
  split, no future leakage);
- seasonal model: matched `countline × transport_class × direction ×
  weekday × hour` median fit on train only;
- regressors (XGBoost, linear SVR, ridge) fit on train with one-hot
  countline/class/direction and cyclical hour/weekday features, evaluated on
  the same held-out months;
- metric: mean absolute error on the July test month. Unmatched test rows
  fall back to the model's global training median so every model is scored
  on every test row.

No verified incident labels exist in the source, so no classifier is fit:
pseudo-labels would make the evaluation circular (see the model card).

The committed `artifacts/model-benchmark.json` was produced by this protocol
at build time; re-running reproduces it up to library-version variance in the
trained regressors (the seasonal median is deterministic).
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd

from movement_anomaly.io import load_parquet_shards
from movement_anomaly.validation import chronological_split

ROOT = Path(__file__).resolve().parents[1]

TRAIN_END = "2026-05-31"
VALIDATION_END = "2026-06-30"
TEST_END = "2026-07-31"
TOP_COUNTLINES = 10
SEASONAL_KEYS = ["countline_id", "transport_class", "direction", "dow", "hour"]
CATEGORICAL = ["countline_id", "transport_class", "direction"]
RANDOM_STATE = 7


def _with_time_features(frame: pd.DataFrame) -> pd.DataFrame:
    prepared = frame.copy()
    prepared["dow"] = prepared["date"].dt.dayofweek
    prepared["hour_sin"] = np.sin(2 * np.pi * prepared["hour"] / 24)
    prepared["hour_cos"] = np.cos(2 * np.pi * prepared["hour"] / 24)
    prepared["dow_sin"] = np.sin(2 * np.pi * prepared["dow"] / 7)
    prepared["dow_cos"] = np.cos(2 * np.pi * prepared["dow"] / 7)
    return prepared


def seasonal_median_mae(train: pd.DataFrame, test: pd.DataFrame) -> float:
    baseline = (
        train.groupby(SEASONAL_KEYS, dropna=False)["count"].median().rename("expected")
    )
    joined = test.join(baseline, on=SEASONAL_KEYS)
    joined["expected"] = joined["expected"].fillna(train["count"].median())
    return float((joined["count"] - joined["expected"]).abs().mean())


def regressor_mae(model, train: pd.DataFrame, test: pd.DataFrame) -> float:
    feature_columns = ["hour_sin", "hour_cos", "dow_sin", "dow_cos"]
    encoded = pd.get_dummies(
        pd.concat([train, test], keys=["train", "test"]),
        columns=CATEGORICAL,
        dtype=float,
    )
    dummy_columns = [
        column
        for column in encoded.columns
        if any(column.startswith(f"{name}_") for name in CATEGORICAL)
    ]
    features = feature_columns + dummy_columns
    train_encoded = encoded.loc["train"]
    test_encoded = encoded.loc["test"]
    model.fit(train_encoded[features], train_encoded["count"])
    predicted = model.predict(test_encoded[features])
    return float(np.abs(test_encoded["count"].to_numpy() - predicted).mean())


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--data-dir", type=Path, default=ROOT / "data" / "transport_sensors"
    )
    parser.add_argument(
        "--output", type=Path, default=ROOT / "artifacts" / "model-benchmark.json"
    )
    args = parser.parse_args()

    try:
        from sklearn.linear_model import Ridge
        from sklearn.svm import LinearSVR
        from xgboost import XGBRegressor
    except ImportError as error:
        raise SystemExit(
            f'benchmark extras missing ({error}); run: pip install -e ".[benchmark]"'
        ) from None

    shards = sorted(args.data_dir.glob("*.parquet"))
    if not shards:
        raise SystemExit(
            f"no Parquet shards in {args.data_dir} — the WCC source data is "
            "gitignored and must be supplied locally"
        )
    frame = load_parquet_shards(shards, end_date=TEST_END)

    volume = frame.groupby("countline_id")["count"].sum().nlargest(TOP_COUNTLINES)
    scoped = frame[frame["countline_id"].isin(volume.index)].reset_index(drop=True)

    split = chronological_split(
        scoped,
        train_end=TRAIN_END,
        validation_end=VALIDATION_END,
        test_end=TEST_END,
    )
    train = _with_time_features(split["train"])
    test = _with_time_features(split["test"])

    models = [
        ("matched_weekday_hour_median", None),
        (
            "xgboost_regressor",
            XGBRegressor(
                n_estimators=200,
                max_depth=6,
                learning_rate=0.1,
                random_state=RANDOM_STATE,
                n_jobs=-1,
            ),
        ),
        ("linear_svr", LinearSVR(random_state=RANDOM_STATE, max_iter=10_000)),
        ("ridge_regression", Ridge(random_state=RANDOM_STATE)),
    ]
    results = []
    for name, model in models:
        if model is None:
            mae = seasonal_median_mae(train, test)
        else:
            mae = regressor_mae(model, train, test)
        results.append({"model": name, "mae": round(mae, 3)})
        print(f"{name}: test MAE {mae:.3f}")
    results.sort(key=lambda row: row["mae"])
    for row in results:
        row["selected"] = row["model"] == "matched_weekday_hour_median"

    benchmark = {
        "schema": "movement-model-benchmark/v1",
        "source": "Wellington City Council Transport Sensors",
        "scope": f"{TOP_COUNTLINES} highest-volume countlines",
        "metric": "mean_absolute_error",
        "split": {
            "method": "chronological",
            "train_rows": int(len(split["train"])),
            "validation_period": "2026-06",
            "validation_rows": int(len(split["validation"])),
            "test_period": "2026-07",
            "test_rows": int(len(split["test"])),
        },
        "test_results": results,
        "classification_note": (
            "No verified incident labels are present. Logistic regression and "
            "classification SVM were not fit because pseudo-labels would make "
            "the evaluation circular."
        ),
    }
    args.output.write_text(
        json.dumps(benchmark, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(f"-> {args.output}")


if __name__ == "__main__":
    main()
