# ====================IMPORTS====================
"""
Wellington movement anomaly detection — Claude Hackathon (Problem 05).

Standalone / local Streamlit app. Follows the WCC Snowflake Streamlit template
structure (section separators, @st.cache_data data layer, render_* methods,
pydeck + CartoDB basemap), but the SESSION block is swapped from
get_active_session() to a local DuckDB connection so it runs with `streamlit run`.

Data: the committed April-2026 anomaly aggregates in
      data/sensors/anomaly/csv/  (street level + vehicle-type level).
The baseline / z-score logic from build_anomaly_features.sql is recreated as
DuckDB views over those CSVs, so the app is fully self-contained from the repo.
Set ANOMALY_DUCKDB to point at a transport_sensors.duckdb instead, if preferred.
"""

import os
from pathlib import Path

import duckdb
import pandas as pd
import plotly.graph_objects as go
import pydeck as pdk
import streamlit as st

st.set_page_config(layout="wide", page_title="Wellington Movement Anomalies", page_icon="🚨")

# ====================SESSION====================
# Local deployment: DuckDB instead of a Snowflake session.
APP_ROOT = Path(__file__).resolve().parent
REPO_ROOT = APP_ROOT.parents[1]
CSV_DIR = Path(os.environ.get("ANOMALY_CSV_DIR", REPO_ROOT / "data" / "sensors" / "anomaly" / "csv"))
ANOMALY_DUCKDB = os.environ.get("ANOMALY_DUCKDB")  # optional: prebuilt DB with schema `anomaly`

WELLINGTON_CBD = {"LAT": -41.2865, "LON": 174.7762}


@st.cache_resource(show_spinner="Loading anomaly layer into DuckDB…")
def get_connection() -> duckdb.DuckDBPyConnection:
    """
    One DuckDB connection for the app. Either attach a prebuilt anomaly DB, or
    build the layer in-memory from the committed CSVs. Baseline/z-score views are
    (re)created so both paths expose the same relation names.
    """
    if ANOMALY_DUCKDB and Path(ANOMALY_DUCKDB).exists():
        con = duckdb.connect(ANOMALY_DUCKDB, read_only=True)
        con.execute("CREATE OR REPLACE TEMP VIEW street_hourly AS SELECT * FROM anomaly.street_hourly")
        con.execute("CREATE OR REPLACE TEMP VIEW vehicle_type_hourly AS SELECT * FROM anomaly.vehicle_type_hourly")
        con.execute("CREATE OR REPLACE TEMP VIEW street_dim AS SELECT * FROM anomaly.street_dim")
    else:
        con = duckdb.connect(":memory:")
        for name in ("street_hourly", "vehicle_type_hourly", "street_dim"):
            path = (CSV_DIR / f"{name}.csv").as_posix()
            con.execute(f"CREATE OR REPLACE VIEW {name} AS SELECT * FROM read_csv_auto('{path}')")

    # (b) baseline/z-score views -- baseline = (entity, hour-of-day, weekday/weekend)
    con.execute(
        """
        CREATE OR REPLACE TEMP VIEW v_street_anom AS
        WITH base AS (
            SELECT street, countline_hour, is_weekend,
                   avg(total_count) AS baseline_mean,
                   stddev_samp(total_count) AS baseline_sd,
                   count(*) AS baseline_n
            FROM street_hourly GROUP BY street, countline_hour, is_weekend)
        SELECT h.*, b.baseline_mean, b.baseline_sd, b.baseline_n,
               h.total_count - b.baseline_mean AS residual,
               CASE WHEN b.baseline_sd > 0
                    THEN round((h.total_count - b.baseline_mean)/b.baseline_sd, 3) END AS z
        FROM street_hourly h JOIN base b USING (street, countline_hour, is_weekend)
        """
    )
    con.execute(
        """
        CREATE OR REPLACE TEMP VIEW v_vehtype_anom AS
        WITH base AS (
            SELECT transport_class, countline_hour, is_weekend,
                   avg(total_count) AS baseline_mean,
                   stddev_samp(total_count) AS baseline_sd,
                   count(*) AS baseline_n
            FROM vehicle_type_hourly GROUP BY transport_class, countline_hour, is_weekend)
        SELECT h.*, b.baseline_mean, b.baseline_sd, b.baseline_n,
               h.total_count - b.baseline_mean AS residual,
               CASE WHEN b.baseline_sd > 0
                    THEN round((h.total_count - b.baseline_mean)/b.baseline_sd, 3) END AS z
        FROM vehicle_type_hourly h JOIN base b USING (transport_class, countline_hour, is_weekend)
        """
    )
    return con


def q(sql: str, params: list | None = None) -> pd.DataFrame:
    return get_connection().execute(sql, params or []).fetch_df()


# ====================DATA====================
@st.cache_data(show_spinner=False)
def get_bounds() -> dict:
    row = q("SELECT min(countline_date) mn, max(countline_date) mx FROM street_hourly").iloc[0]
    return {"MIN": pd.to_datetime(row["mn"]).date(), "MAX": pd.to_datetime(row["mx"]).date()}


@st.cache_data(show_spinner=False)
def get_transport_classes() -> list[str]:
    return q("SELECT DISTINCT transport_class FROM vehicle_type_hourly ORDER BY 1")["transport_class"].tolist()


@st.cache_data(show_spinner=False)
def get_street_anomalies(z_min: float, day_filter: str, d0, d1) -> pd.DataFrame:
    where = _day_clause(day_filter)
    return q(
        f"""
        SELECT street AS STREET, countline_date AS DATE, countline_hour AS HOUR,
               total_count AS TOTAL, round(baseline_mean,0) AS BASELINE,
               round(residual,0) AS RESIDUAL, z AS Z, is_weekend AS IS_WEEKEND
        FROM v_street_anom
        WHERE z >= ? AND countline_date BETWEEN ? AND ? {where}
        ORDER BY z DESC
        """,
        [z_min, d0, d1],
    )


@st.cache_data(show_spinner=False)
def get_vehtype_anomalies(z_min: float, day_filter: str, d0, d1) -> pd.DataFrame:
    where = _day_clause(day_filter)
    return q(
        f"""
        SELECT transport_class AS TRANSPORT_CLASS, countline_date AS DATE, countline_hour AS HOUR,
               total_count AS TOTAL, round(baseline_mean,0) AS BASELINE,
               round(residual,0) AS RESIDUAL, z AS Z
        FROM v_vehtype_anom
        WHERE z >= ? AND countline_date BETWEEN ? AND ? {where}
        ORDER BY z DESC
        """,
        [z_min, d0, d1],
    )


@st.cache_data(show_spinner=False)
def get_street_map(z_min: float, day_filter: str, d0, d1) -> pd.DataFrame:
    where = _day_clause(day_filter)
    return q(
        f"""
        WITH a AS (
            SELECT street,
                   count_if(z >= ?) AS anomaly_hours,
                   max(z) AS peak_z,
                   max(CASE WHEN z >= ? THEN total_count END) AS peak_total
            FROM v_street_anom
            WHERE countline_date BETWEEN ? AND ? {where}
            GROUP BY street)
        SELECT d.street AS STREET, d.n_countlines AS N_COUNTLINES,
               d.centroid_lat AS LAT, d.centroid_lon AS LON,
               coalesce(a.anomaly_hours,0) AS ANOMALY_HOURS,
               round(a.peak_z,2) AS PEAK_Z, a.peak_total AS PEAK_TOTAL
        FROM street_dim d LEFT JOIN a USING (street)
        WHERE d.centroid_lat IS NOT NULL
        """,
        [z_min, z_min, d0, d1],
    )


@st.cache_data(show_spinner=False)
def get_vehtype_series(transport_class: str) -> pd.DataFrame:
    df = q(
        """
        SELECT countline_date AS DATE, countline_hour AS HOUR,
               total_count AS TOTAL, baseline_mean AS BASELINE, z AS Z
        FROM v_vehtype_anom WHERE transport_class = ?
        ORDER BY countline_date, countline_hour
        """,
        [transport_class],
    )
    if not df.empty:
        df["TS"] = pd.to_datetime(df["DATE"]) + pd.to_timedelta(df["HOUR"], unit="h")
    return df


def _day_clause(day_filter: str) -> str:
    if day_filter == "Weekdays":
        return "AND is_weekend = FALSE"
    if day_filter == "Weekends":
        return "AND is_weekend = TRUE"
    return ""


# ====================SIDEBAR====================
def render_sidebar() -> dict:
    st.sidebar.title("🚨 Movement Anomalies")
    st.sidebar.caption("WCC transport sensors · April 2026 · DuckDB (local)")

    bounds = get_bounds()
    st.sidebar.header("Detection")
    z_min = st.sidebar.slider("Anomaly threshold (z-score)", 1.5, 4.5, 3.0, 0.1,
                              help="Flag hours whose count is this many SDs above the "
                                   "matched hour-of-day / weekday-weekend baseline.")
    day_filter = st.sidebar.radio("Days", ["All", "Weekdays", "Weekends"], horizontal=True)

    date_range = st.sidebar.date_input(
        "Date range", value=(bounds["MIN"], bounds["MAX"]),
        min_value=bounds["MIN"], max_value=bounds["MAX"],
    )
    d0, d1 = (date_range if isinstance(date_range, tuple) and len(date_range) == 2
              else (bounds["MIN"], bounds["MAX"]))

    st.sidebar.markdown("---")
    src = "prebuilt DuckDB" if (ANOMALY_DUCKDB and Path(ANOMALY_DUCKDB).exists()) else "committed CSVs (in-memory DuckDB)"
    st.sidebar.info(
        f"Source: {src}.\n\nBaseline = mean±sd of each entity at the same "
        "hour-of-day, split weekday/weekend. A high z = an unusual surge.\n\n"
        "**Signals mean investigate — they don't confirm an event.**"
    )
    return {"z_min": z_min, "day_filter": day_filter, "d0": d0, "d1": d1}


# ====================TABS====================
def render_main_tabs(f: dict) -> None:
    tab_over, tab_map, tab_veh, tab_data = st.tabs(
        ["🚨 Overview", "🗺️ Street map", "🚗 Vehicle types", "📋 Data"]
    )
    with tab_over:
        render_tab_overview(f)
    with tab_map:
        render_tab_map(f)
    with tab_veh:
        render_tab_vehicle_types(f)
    with tab_data:
        render_tab_data(f)


def render_tab_overview(f: dict) -> None:
    st.header("Anomaly overview")
    st.caption(f"z ≥ {f['z_min']} · {f['day_filter']} · {f['d0']} → {f['d1']}")

    streets = get_street_anomalies(f["z_min"], f["day_filter"], f["d0"], f["d1"])
    veh = get_vehtype_anomalies(f["z_min"], f["day_filter"], f["d0"], f["d1"])

    c1, c2, c3, c4 = st.columns(4)
    c1.metric("Street anomaly-hours", f"{len(streets):,}")
    c2.metric("Streets affected", f"{streets['STREET'].nunique() if not streets.empty else 0}")
    c3.metric("Vehicle-type anomaly-hours", f"{len(veh):,}")
    c4.metric("Peak street z", f"{streets['Z'].max():.2f}" if not streets.empty else "—")

    st.subheader("Top street anomalies")
    if streets.empty:
        st.info("No street-hours exceed the threshold in this window.")
    else:
        render_anomaly_bar(streets.head(15), "STREET")
        st.dataframe(streets.head(50), width="stretch", hide_index=True)

    st.subheader("Top vehicle-type anomalies")
    if veh.empty:
        st.info("No vehicle-type-hours exceed the threshold in this window.")
    else:
        st.dataframe(veh.head(20), width="stretch", hide_index=True)


def render_tab_map(f: dict) -> None:
    st.header("Street map")
    st.caption("Bubble size = anomaly-hours in window · colour = peak z. Grey = no anomalies.")
    render_street_map(get_street_map(f["z_min"], f["day_filter"], f["d0"], f["d1"]))


def render_tab_vehicle_types(f: dict) -> None:
    st.header("Vehicle-type series")
    classes = get_transport_classes()
    selected = st.selectbox("Transport class", classes,
                            index=classes.index("Car") if "Car" in classes else 0)
    df = get_vehtype_series(selected)
    if df.empty:
        st.info("No data for this class.")
        return
    render_series_chart(df, selected, f["z_min"])
    flagged = df[df["Z"] >= f["z_min"]].sort_values("Z", ascending=False)
    st.caption(f"{len(flagged)} anomaly-hours for {selected} at z ≥ {f['z_min']}")
    st.dataframe(flagged[["DATE", "HOUR", "TOTAL", "BASELINE", "Z"]].head(30),
                 width="stretch", hide_index=True)


def render_tab_data(f: dict) -> None:
    st.header("Data")
    st.caption("Full anomaly-scored tables for the current window.")
    streets = get_street_anomalies(f["z_min"], f["day_filter"], f["d0"], f["d1"])
    veh = get_vehtype_anomalies(f["z_min"], f["day_filter"], f["d0"], f["d1"])
    st.subheader("Street level")
    st.dataframe(streets, width="stretch", hide_index=True)
    render_download_csv_dataframe(streets, "street anomalies", "street_anomalies.csv")
    st.subheader("Vehicle-type level")
    st.dataframe(veh, width="stretch", hide_index=True)
    render_download_csv_dataframe(veh, "vehicle-type anomalies", "vehicle_type_anomalies.csv")


# ====================VISUALISATION====================
def render_anomaly_bar(df: pd.DataFrame, label_col: str) -> None:
    plot = df.assign(LABEL=df[label_col] + " · " + df["DATE"].astype(str) + " " + df["HOUR"].astype(str) + ":00")
    fig = go.Figure(go.Bar(x=plot["Z"][::-1], y=plot["LABEL"][::-1], orientation="h",
                           marker_color="#c0392b"))
    fig.update_layout(height=420, margin=dict(l=10, r=10, t=10, b=10),
                      xaxis_title="z-score", yaxis_title=None)
    st.plotly_chart(fig, width="stretch")


def render_street_map(df: pd.DataFrame) -> None:
    if df.empty:
        st.warning("No street coordinates available.")
        return
    df = df.copy()
    df["PEAK_Z"] = df["PEAK_Z"].fillna(0)
    df["RADIUS"] = 80 + df["ANOMALY_HOURS"].fillna(0) * 12
    df["COLOR"] = df["ANOMALY_HOURS"].apply(
        lambda h: [192, 57, 43, 220] if h and h > 0 else [149, 165, 166, 120])

    layer = pdk.Layer(
        "ScatterplotLayer", df, get_position=["LON", "LAT"], get_fill_color="COLOR",
        get_line_color=[255, 255, 255, 200], get_radius="RADIUS",
        radius_min_pixels=5, radius_max_pixels=40, line_width_min_pixels=1,
        stroked=True, filled=True, pickable=True, auto_highlight=True,
    )
    view = pdk.ViewState(latitude=float(df["LAT"].mean()), longitude=float(df["LON"].mean()),
                         zoom=11, pitch=0)
    tooltip = {
        "html": "<b>{STREET}</b><br/>Anomaly-hours: {ANOMALY_HOURS}<br/>"
                "Peak z: {PEAK_Z}<br/>Countlines: {N_COUNTLINES}",
        "style": {"backgroundColor": "#1b2631", "color": "white", "fontSize": "12px"},
    }
    st.pydeck_chart(pdk.Deck(layers=[layer], initial_view_state=view, tooltip=tooltip,
                             map_style="https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json"))


def render_series_chart(df: pd.DataFrame, title: str, z_min: float) -> None:
    flagged = df[df["Z"] >= z_min]
    fig = go.Figure()
    fig.add_trace(go.Scatter(x=df["TS"], y=df["TOTAL"], mode="lines",
                             name="hourly count", line=dict(color="#2980b9", width=1)))
    fig.add_trace(go.Scatter(x=df["TS"], y=df["BASELINE"], mode="lines",
                             name="baseline", line=dict(color="#7f8c8d", width=1, dash="dot")))
    if not flagged.empty:
        fig.add_trace(go.Scatter(x=flagged["TS"], y=flagged["TOTAL"], mode="markers",
                                 name=f"anomaly (z≥{z_min})", marker=dict(color="#c0392b", size=8)))
    fig.update_layout(height=430, margin=dict(l=10, r=10, t=30, b=10),
                      title=f"{title} — hourly count vs baseline",
                      xaxis_title=None, yaxis_title="count")
    st.plotly_chart(fig, width="stretch")


# ====================STATIC_METHODS====================
def render_download_csv_dataframe(download_dataframe, download_label, download_file_name) -> None:
    """Download CSV button for dataframes."""
    st.markdown("---")
    if not download_dataframe.empty:
        st.download_button(
            label="📥 Download " + download_label,
            data=download_dataframe.to_csv(index=False),
            file_name=download_file_name, mime="text/csv",
            key=f"download_{download_file_name}",
        )
    else:
        st.info("No data available to download")


# ====================MAIN====================
if __name__ == "__main__":
    filters = render_sidebar()
    render_main_tabs(filters)
