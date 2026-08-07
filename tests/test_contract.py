import pandas as pd

from movement_anomaly.contract import to_feature_collection


def test_geojson_uses_wgs84_order_and_exposes_freshness_confidence_and_limits():
    signals = pd.DataFrame(
        [
            {
                "countline_id": "47847",
                "date": pd.Timestamp("2026-08-06"),
                "hour": 8,
                "count": 20.0,
                "transport_class": "Pedestrian",
                "direction": "SW",
                "expected_count": 100.0,
                "history_samples": 12,
                "robust_z": -7.96,
                "change_direction": "decrease",
                "status": "candidate",
                "data_quality": "complete",
            }
        ]
    )
    metadata = pd.DataFrame(
        [
            {
                "COUNTLINE_ID": "47847",
                "VIEWPOINT_ID": "7475",
                "NAME": "Luxford St road upper",
                "LATITUDE_START_LINE": -41.319916,
                "LONGITUDE_START_LINE": 174.775421,
                "LATITUDE_END_LINE": -41.319893,
                "LONGITUDE_END_LINE": 174.775391,
                "EARLIEST": "2023-10-31",
                "LATEST": "2026-08-06",
            }
        ]
    )

    result = to_feature_collection(
        signals,
        metadata,
        data_as_of="2026-08-06T23:00:00+12:00",
    )

    assert result["type"] == "FeatureCollection"
    feature = result["features"][0]
    assert feature["geometry"] == {
        "type": "LineString",
        "coordinates": [
            [174.775421, -41.319916],
            [174.775391, -41.319893],
        ],
    }
    props = feature["properties"]
    assert props["schema"] == "movement-signal/v1"
    assert props["attention"] == "investigate"
    assert props["publisher_cadence"] == "at least monthly"
    assert props["data_as_of"] == "2026-08-06T23:00:00+12:00"
    assert props["signal_confidence"]["history_samples"] == 12
    assert "Fixed sensors do not represent every city journey." in props["limitations"]
    assert "A counted vehicle is not a passenger count." in props["limitations"]
