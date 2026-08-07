import pandas as pd


RAW_COLUMNS = {
    "_COL_0": "countline_id",
    "_COL_1": "date",
    "_COL_2": "hour",
    "_COL_3": "count",
    "_COL_4": "transport_class",
    "_COL_5": "direction",
}
OBSERVATION_KEY = [
    "countline_id",
    "date",
    "hour",
    "transport_class",
    "direction",
]


def normalize_mobility_frame(frame: pd.DataFrame) -> pd.DataFrame:
    normalized = frame.rename(columns=RAW_COLUMNS).copy()
    missing = [column for column in RAW_COLUMNS.values() if column not in normalized]
    if missing:
        raise ValueError(f"missing mobility columns: {', '.join(missing)}")

    normalized = normalized[list(RAW_COLUMNS.values())]
    normalized["countline_id"] = normalized["countline_id"].astype(str)
    normalized["date"] = pd.to_datetime(normalized["date"]).dt.normalize()
    normalized["hour"] = pd.to_numeric(normalized["hour"]).astype(int)
    normalized["count"] = pd.to_numeric(normalized["count"]).astype(float)

    if normalized.duplicated(OBSERVATION_KEY).any():
        raise ValueError("duplicate observation key")
    return normalized.reset_index(drop=True)
