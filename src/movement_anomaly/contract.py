import pandas as pd


LIMITATIONS = [
    "Fixed sensors do not represent every city journey.",
    "A counted vehicle is not a passenger count.",
    "Nearby countlines may count the same traveller more than once.",
    "Missing records are data gaps, not zero movement.",
    "Publisher data is batch refreshed, not a live emergency feed.",
]


def _confidence(samples: int, data_quality: str) -> dict:
    if data_quality != "complete":
        level = "low"
    elif samples >= 12:
        level = "high"
    else:
        level = "medium"
    return {
        "level": level,
        "history_samples": int(samples),
        "basis": "matched weekday and hour",
    }


def to_feature_collection(
    signals: pd.DataFrame, metadata: pd.DataFrame, data_as_of: str
) -> dict:
    meta = metadata.copy()
    meta["COUNTLINE_ID"] = meta["COUNTLINE_ID"].astype(str)
    joined = signals.copy()
    joined["countline_id"] = joined["countline_id"].astype(str)
    joined = joined.merge(meta, left_on="countline_id", right_on="COUNTLINE_ID", how="inner")

    features = []
    for row in joined.to_dict(orient="records"):
        observed_at = pd.Timestamp(row["date"]) + pd.Timedelta(hours=int(row["hour"]))
        feature_id = (
            f"movement:{row['countline_id']}:{row['transport_class']}:"
            f"{row['direction']}:{observed_at.isoformat()}"
        )
        features.append(
            {
                "type": "Feature",
                "id": feature_id,
                "geometry": {
                    "type": "LineString",
                    "coordinates": [
                        [
                            float(row["LONGITUDE_START_LINE"]),
                            float(row["LATITUDE_START_LINE"]),
                        ],
                        [
                            float(row["LONGITUDE_END_LINE"]),
                            float(row["LATITUDE_END_LINE"]),
                        ],
                    ],
                },
                "properties": {
                    "schema": "movement-signal/v1",
                    "signal_type": "classified_count_change",
                    "status": row["status"],
                    "attention": "investigate",
                    "countline_id": row["countline_id"],
                    "viewpoint_id": str(row["VIEWPOINT_ID"]),
                    "name": row["NAME"],
                    "transport_class": row["transport_class"],
                    "direction": row["direction"],
                    "change_direction": row["change_direction"],
                    "observed_count": float(row["count"]),
                    "expected_count": float(row["expected_count"]),
                    "robust_z": float(row["robust_z"]),
                    "observed_at": observed_at.isoformat(),
                    "data_as_of": data_as_of,
                    "publisher_cadence": "at least monthly",
                    "data_quality": row["data_quality"],
                    "signal_confidence": _confidence(
                        row["history_samples"], row["data_quality"]
                    ),
                    "location_confidence": "metadata coordinates",
                    "limitations": LIMITATIONS,
                    "attribution": "Wellington City Council Transport Sensors",
                },
            }
        )
    return {
        "type": "FeatureCollection",
        "schema": "movement-signal-collection/v1",
        "data_as_of": data_as_of,
        "features": features,
    }


def to_replay_collection(
    replay: dict,
    metadata: pd.DataFrame,
    data_as_of: str,
    default_target_at: str,
    lookback_weeks: int = 12,
) -> dict:
    meta = metadata.copy()
    meta["COUNTLINE_ID"] = meta["COUNTLINE_ID"].astype(str)
    metadata_by_countline = {
        row["COUNTLINE_ID"]: row for row in meta.to_dict(orient="records")
    }
    slots = []
    for slot in replay["slots"]:
        signals = []
        for signal in slot["signals"]:
            row = metadata_by_countline.get(signal["countline_id"])
            if row is None:
                continue
            signals.append(
                {
                    **signal,
                    "viewpoint_id": str(row["VIEWPOINT_ID"]),
                    "name": row["NAME"],
                    "signal_confidence": _confidence(
                        signal["history_samples"], signal["data_quality"]
                    ),
                }
            )
        slots.append({**slot, "candidate_count": len(signals), "signals": signals})

    input_observation_count = sum(int(slot["observed_groups"]) for slot in slots)
    candidate_count = sum(int(slot["candidate_count"]) for slot in slots)
    return {
        "schema": "movement-replay/v1",
        "available_from": replay["available_from"],
        "available_to": replay["available_to"],
        "default_target_at": pd.Timestamp(default_target_at).isoformat(),
        "display_timezone": "Pacific/Auckland",
        "data_as_of": data_as_of,
        "publisher_mode": "batch replay",
        "publisher_cadence": "at least monthly",
        "source": "Wellington City Council Transport Sensors",
        "model": {
            "id": "movement-seasonal-mad-v1",
            "type": "matched_weekday_hour_median_mad",
            "lookback_weeks": int(lookback_weeks),
            "decision_role": "candidate_generation_only",
            "calibration_status": "not_an_incident_classifier",
        },
        "input_observation_count": input_observation_count,
        "candidate_count": candidate_count,
        "input_role": "canonical_sensor_observations",
        "output_role": "movement_anomaly_candidates",
        "automatic_incident": False,
        "automatic_warning": False,
        "trend_basis": f"prior {int(lookback_weeks)} matched weekday and hour observations",
        "limitations": LIMITATIONS,
        "slots": slots,
    }
