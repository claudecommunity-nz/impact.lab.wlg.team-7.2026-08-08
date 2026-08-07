from dataclasses import dataclass

import numpy as np
import pandas as pd


@dataclass(frozen=True)
class DetectorConfig:
    z_threshold: float = 4.5
    min_absolute_change: float = 10.0
    min_relative_change: float = 0.35


SEASONAL_KEYS = ["countline_id", "transport_class", "direction", "dow", "hour"]


def fit_seasonal_baseline(history: pd.DataFrame, min_samples: int = 8) -> pd.DataFrame:
    prepared = history.copy()
    prepared["date"] = pd.to_datetime(prepared["date"])
    prepared["dow"] = prepared["date"].dt.dayofweek

    grouped = prepared.groupby(SEASONAL_KEYS, dropna=False)["count"]
    baseline = grouped.agg(median="median", n="size").reset_index()
    deviations = prepared.merge(
        baseline[SEASONAL_KEYS + ["median"]], on=SEASONAL_KEYS, how="left"
    )
    deviations["absolute_deviation"] = (
        deviations["count"] - deviations["median"]
    ).abs()
    mad = (
        deviations.groupby(SEASONAL_KEYS, dropna=False)["absolute_deviation"]
        .median()
        .rename("mad")
        .reset_index()
    )
    baseline = baseline.merge(mad, on=SEASONAL_KEYS, how="left")
    return baseline[baseline["n"] >= min_samples].reset_index(drop=True)


def score_observations(
    current: pd.DataFrame, baseline: pd.DataFrame, config: DetectorConfig
) -> pd.DataFrame:
    scored = current.copy()
    scored["date"] = pd.to_datetime(scored["date"])
    scored["dow"] = scored["date"].dt.dayofweek
    scored = scored.merge(baseline, on=SEASONAL_KEYS, how="left")
    scored = scored.rename(columns={"median": "expected_count", "n": "history_samples"})

    matched = scored["expected_count"].notna()
    scale = np.maximum.reduce(
        [
            1.4826 * scored["mad"].fillna(0).to_numpy(dtype=float),
            np.sqrt(scored["expected_count"].fillna(0).to_numpy(dtype=float) + 1),
            np.ones(len(scored)),
        ]
    )
    scored["robust_z"] = np.where(
        matched, (scored["count"] - scored["expected_count"]) / scale, np.nan
    )
    scored["absolute_change"] = (scored["count"] - scored["expected_count"]).abs()
    denominator = scored["expected_count"].abs().clip(lower=10)
    scored["relative_change"] = scored["absolute_change"] / denominator
    scored["change_direction"] = np.select(
        [
            scored["count"] < scored["expected_count"],
            scored["count"] > scored["expected_count"],
        ],
        ["decrease", "increase"],
        default="stable",
    )
    candidate = (
        matched
        & (scored["robust_z"].abs() >= config.z_threshold)
        & (scored["absolute_change"] >= config.min_absolute_change)
        & (scored["relative_change"] >= config.min_relative_change)
    )
    scored["status"] = np.select(
        [~matched, candidate], ["insufficient_baseline", "candidate"], default="normal"
    )
    scored["data_quality"] = np.where(matched, "complete", "no_matching_history")
    return scored.drop(columns=["dow"]).reset_index(drop=True)
