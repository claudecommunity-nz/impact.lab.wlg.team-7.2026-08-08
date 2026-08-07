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
