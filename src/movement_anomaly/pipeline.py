import numpy as np
import pandas as pd

from .detector import SEASONAL_KEYS, fit_seasonal_baseline, score_observations


GROUP_KEYS = ["countline_id", "transport_class", "direction"]


def _local_wall_clock(value):
    timestamp = pd.Timestamp(value)
    if timestamp.tzinfo is not None:
        return timestamp.tz_convert("Pacific/Auckland").tz_localize(None)
    return timestamp


def _slot_iso(local_timestamp, timezone_aware):
    timestamp = pd.Timestamp(local_timestamp)
    if timezone_aware:
        timestamp = timestamp.tz_localize(
            "Pacific/Auckland",
            ambiguous=False,
            nonexistent="shift_forward",
        )
    return timestamp.isoformat()


def analyze_snapshot(frame, *, target_at, lookback_weeks, config):
    requested_target = pd.Timestamp(target_at)
    target = _local_wall_clock(requested_target)
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
        "low_baseline_count": int((scored["status"] == "low_baseline").sum()),
    }
    return {
        "scored": scored,
        "candidates": candidates,
        "data_gaps": gaps.reset_index(drop=True),
        "health": health,
    }


def analyze_replay(frame, *, start_at, end_at, lookback_weeks, config):
    requested_start = pd.Timestamp(start_at)
    requested_end = pd.Timestamp(end_at)
    start = _local_wall_clock(requested_start)
    end = _local_wall_clock(requested_end)
    if end < start:
        raise ValueError("replay end must not be before replay start")

    prepared = frame.copy()
    prepared["date"] = pd.to_datetime(prepared["date"]).dt.normalize()
    prepared["hour"] = pd.to_numeric(prepared["hour"]).astype(int)
    prepared["timestamp"] = prepared["date"] + pd.to_timedelta(
        prepared["hour"], unit="h"
    )
    slot_times = (
        prepared.loc[
            (prepared["timestamp"] >= start) & (prepared["timestamp"] <= end),
            "timestamp",
        ]
        .drop_duplicates()
        .sort_values()
        .tolist()
    )
    if not slot_times:
        raise ValueError("no published observations in replay range")

    timezone_aware = requested_start.tzinfo is not None
    date_hour_indices = prepared.groupby(["date", "hour"], sort=False).indices
    slots = []
    for target in slot_times:
        target = pd.Timestamp(target)
        matched_dates = [
            (target - pd.Timedelta(weeks=week)).normalize()
            for week in range(1, lookback_weeks + 1)
        ]
        history_indices = [
            date_hour_indices[(matched_date, target.hour)]
            for matched_date in matched_dates
            if (matched_date, target.hour) in date_hour_indices
        ]
        combined_history_indices = (
            np.concatenate(history_indices) if history_indices else np.array([], dtype=int)
        )
        current_indices = date_hour_indices.get((target.normalize(), target.hour), [])
        history = prepared.iloc[combined_history_indices].drop(columns=["timestamp"])
        current = prepared.iloc[current_indices].drop(columns=["timestamp"])

        baseline = fit_seasonal_baseline(history, min_samples=8)
        scored = score_observations(current, baseline, config)
        candidates = scored[scored["status"] == "candidate"].reset_index(drop=True)
        observation_keys = GROUP_KEYS + ["hour"]
        observed_keys = current[observation_keys].drop_duplicates()
        expected = baseline[baseline["hour"] == target.hour].copy()
        gaps = expected.merge(observed_keys, on=observation_keys, how="left", indicator=True)
        gaps = gaps[gaps["_merge"] == "left_only"]

        history_groups = {
            key: group.sort_values(["date", "hour"])
            for key, group in history.groupby(GROUP_KEYS, dropna=False)
        }
        signals = []
        observed_at = _slot_iso(target, timezone_aware)
        for row in candidates.to_dict(orient="records"):
            group_key = tuple(row[key] for key in GROUP_KEYS)
            matched = history_groups.get(group_key)
            matched_history = []
            if matched is not None:
                for point in matched.to_dict(orient="records"):
                    point_at = pd.Timestamp(point["date"]) + pd.Timedelta(
                        hours=int(point["hour"])
                    )
                    matched_history.append(
                        {
                            "observed_at": _slot_iso(point_at, timezone_aware),
                            "observed_count": float(point["count"]),
                        }
                    )
            signals.append(
                {
                    "id": (
                        f"movement:{row['countline_id']}:{row['transport_class']}:"
                        f"{row['direction']}:{observed_at}"
                    ),
                    "countline_id": str(row["countline_id"]),
                    "transport_class": row["transport_class"],
                    "direction": row["direction"],
                    "change_direction": row["change_direction"],
                    "observed_count": float(row["count"]),
                    "expected_count": float(row["expected_count"]),
                    "robust_z": float(row["robust_z"]),
                    "history_samples": int(row["history_samples"]),
                    "data_quality": row["data_quality"],
                    "observed_at": observed_at,
                    "matched_history": matched_history,
                }
            )
        slots.append(
            {
                "target_at": observed_at,
                "observed_groups": int(len(current)),
                "expected_groups": int(len(expected)),
                "data_gap_groups": int(len(gaps)),
                "candidate_count": int(len(signals)),
                "low_baseline_count": int((scored["status"] == "low_baseline").sum()),
                "signals": signals,
            }
        )

    return {
        "available_from": slots[0]["target_at"],
        "available_to": slots[-1]["target_at"],
        "slots": slots,
    }
