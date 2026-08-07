import pandas as pd

from .detector import SEASONAL_KEYS, fit_seasonal_baseline, score_observations


def analyze_snapshot(frame, *, target_at, lookback_weeks, config):
    requested_target = pd.Timestamp(target_at)
    target = requested_target
    if requested_target.tzinfo is not None:
        target = requested_target.tz_convert("Pacific/Auckland").tz_localize(None)
    prepared = frame.copy()
    prepared["date"] = pd.to_datetime(prepared["date"]).dt.normalize()
    prepared["timestamp"] = prepared["date"] + pd.to_timedelta(prepared["hour"], unit="h")

    history = prepared[
        (prepared["timestamp"] < target)
        & (prepared["timestamp"] >= target - pd.Timedelta(weeks=lookback_weeks))
    ].drop(columns=["timestamp"])
    current = prepared[prepared["timestamp"] == target].drop(columns=["timestamp"])

    baseline = fit_seasonal_baseline(history, min_samples=8)
    scored = score_observations(current, baseline, config)
    candidates = scored[scored["status"] == "candidate"].reset_index(drop=True)

    target_dow = target.dayofweek
    expected = baseline[
        (baseline["dow"] == target_dow) & (baseline["hour"] == target.hour)
    ].copy()
    observation_keys = ["countline_id", "transport_class", "direction", "hour"]
    observed_keys = current[observation_keys].drop_duplicates()
    gaps = expected.merge(observed_keys, on=observation_keys, how="left", indicator=True)
    gaps = gaps[gaps["_merge"] == "left_only"].drop(columns=["_merge", "dow"])
    gaps["status"] = "data_gap"

    health = {
        "target_at": requested_target.isoformat(),
        "publisher_mode": "batch replay",
        "observed_groups": int(len(current)),
        "expected_groups": int(len(expected)),
        "data_gap_groups": int(len(gaps)),
        "candidate_count": int(len(candidates)),
        "insufficient_baseline_count": int(
            (scored["status"] == "insufficient_baseline").sum()
        ),
    }
    return {
        "scored": scored,
        "candidates": candidates,
        "data_gaps": gaps.reset_index(drop=True),
        "health": health,
    }
