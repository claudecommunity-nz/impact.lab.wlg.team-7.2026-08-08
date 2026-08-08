# ====================IMPORTS====================
"""
Metlink (Wellington PT) movement anomaly detection — Claude Hackathon (Problem 05).

Standalone / local Streamlit app. Follows the WCC Snowflake Streamlit template
structure (section separators, @st.cache_data data layer, render_* methods,
pydeck + CartoDB basemap), with the SESSION block swapped from get_active_session()
to a local DuckDB connection so it runs with `streamlit run`.

Data: the committed April-2026 Metlink anomaly extracts in
      data/buses_trains/anomaly/csv/  (read into in-memory DuckDB).
These come from a SYNTHETIC replay of the real Metlink timetable — real routes,
stops and scheduled times, simulated running with injected, labelled anomalies.
Every figure here is simulated; label it as such. Set METLINK_DUCKDB to read a
full metlink.duckdb instead.
"""

import os
from pathlib import Path

import duckdb
import pandas as pd
import plotly.express as px
import pydeck as pdk
import streamlit as st

st.set_page_config(layout="wide", page_title="Metlink Movement Anomalies", page_icon="🚌")

# ====================SESSION====================
APP_ROOT = Path(__file__).resolve().parent
REPO_ROOT = APP_ROOT.parents[1]
CSV_DIR = Path(os.environ.get("METLINK_CSV_DIR", REPO_ROOT / "data" / "buses_trains" / "anomaly" / "csv"))
WELLINGTON_CBD = {"LAT": -41.2865, "LON": 174.7762}
SEVERITY_ORDER = ["HIGH", "MEDIUM", "LOW"]


@st.cache_resource(show_spinner="Loading Metlink anomaly extracts into DuckDB…")
def get_connection() -> duckdb.DuckDBPyConnection:
    con = duckdb.connect(":memory:")
    for name in ("anomaly_events", "anomaly_summary", "anomaly_worst_days",
                 "anomaly_hotspots", "detector_scorecard", "dim_stop"):
        path = (CSV_DIR / f"{name}.csv").as_posix()
        con.execute(f"CREATE OR REPLACE VIEW {name} AS SELECT * FROM read_csv_auto('{path}')")
    return con


def q(sql: str, params: list | None = None) -> pd.DataFrame:
    return get_connection().execute(sql, params or []).fetch_df()


# ====================DATA====================
@st.cache_data(show_spinner=False)
def get_filters_meta() -> dict:
    row = q("SELECT min(SERVICE_DATE) mn, max(SERVICE_DATE) mx FROM anomaly_events").iloc[0]
    detectors = q("SELECT DISTINCT DETECTOR, DETECTOR_NAME FROM anomaly_events ORDER BY 1")
    modes = q('SELECT DISTINCT "MODE" FROM anomaly_events WHERE "MODE" IS NOT NULL ORDER BY 1')["MODE"].tolist()
    return {
        "MIN": pd.to_datetime(row["mn"]).date(),
        "MAX": pd.to_datetime(row["mx"]).date(),
        "DETECTORS": list(detectors.itertuples(index=False, name=None)),
        "MODES": modes,
    }


def _where(f: dict) -> tuple[str, list]:
    clauses, params = ["SEVERITY <> 'NONE'"], []
    clauses.append("SERVICE_DATE BETWEEN ? AND ?"); params += [f["d0"], f["d1"]]
    if f["severities"]:
        clauses.append("SEVERITY IN (" + ",".join("?" * len(f["severities"])) + ")"); params += f["severities"]
    if f["detectors"]:
        clauses.append("DETECTOR IN (" + ",".join("?" * len(f["detectors"])) + ")"); params += f["detectors"]
    if f["modes"]:
        clauses.append('"MODE" IN (' + ",".join("?" * len(f["modes"])) + ")"); params += f["modes"]
    return " AND ".join(clauses), params


@st.cache_data(show_spinner=False)
def get_metrics(f: dict) -> dict:
    where, params = _where(f)
    row = q(f"""SELECT count(*) TOTAL,
                       count(*) FILTER (WHERE SEVERITY='HIGH') HIGH,
                       count(DISTINCT SERVICE_DATE) DATES,
                       count(DISTINCT ROUTE_ID) ROUTES
                FROM anomaly_events WHERE {where}""", params).iloc[0]
    return {"TOTAL": int(row.TOTAL), "HIGH": int(row.HIGH),
            "DATES": int(row.DATES), "ROUTES": int(row.ROUTES)}


@st.cache_data(show_spinner=False)
def get_by_detector(f: dict) -> pd.DataFrame:
    where, params = _where(f)
    return q(f"""SELECT DETECTOR_NAME, SEVERITY, count(*) AS ANOMALIES
                 FROM anomaly_events WHERE {where}
                 GROUP BY ALL ORDER BY ANOMALIES DESC""", params)


@st.cache_data(show_spinner=False)
def get_heatmap(f: dict, dimension: str, top_n: int) -> pd.DataFrame:
    where, params = _where(f)
    col = {"Route": '"ROUTE_SHORT_NAME"', "Mode": '"MODE"', "Stop": '"STOP_NAME"'}[dimension]
    return q(f"""
        WITH filt AS (SELECT * FROM anomaly_events WHERE {where} AND {col} IS NOT NULL),
        top AS (SELECT {col} AS LOC FROM filt GROUP BY 1 ORDER BY count(*) DESC LIMIT {int(top_n)})
        SELECT f.{col} AS LOCATION, f.EVENT_HOUR AS HOUR, count(*) AS ANOMALIES
        FROM filt f JOIN top t ON t.LOC = f.{col}
        GROUP BY ALL""", params)


@st.cache_data(show_spinner=False)
def get_map_points(f: dict) -> pd.DataFrame:
    where, params = _where(f)
    return q(f"""
        SELECT STOP_ID, any_value(STOP_NAME) STOP_NAME,
               avg(STOP_LAT) LAT, avg(STOP_LON) LON,
               count(*) ANOMALIES,
               count(*) FILTER (WHERE SEVERITY='HIGH') HIGH,
               any_value("MODE") AS "MODE"
        FROM anomaly_events
        WHERE {where} AND STOP_LAT IS NOT NULL
        GROUP BY STOP_ID HAVING count(*) > 0""", params)


@st.cache_data(show_spinner=False)
def get_events(f: dict, limit: int = 2000) -> pd.DataFrame:
    where, params = _where(f)
    return q(f"""SELECT SERVICE_DATE, EVENT_HOUR, DETECTOR_NAME, SEVERITY, "MODE",
                        ROUTE_SHORT_NAME, STOP_NAME, round(SCORE,2) SCORE, DETAIL
                 FROM anomaly_events WHERE {where}
                 ORDER BY abs(SCORE) DESC LIMIT {int(limit)}""", params)


@st.cache_data(show_spinner=False)
def get_scorecard() -> pd.DataFrame:
    return q("SELECT * FROM detector_scorecard")


@st.cache_data(show_spinner=False)
def get_worst_days() -> pd.DataFrame:
    return q("SELECT * FROM anomaly_worst_days")


# ====================SIDEBAR====================
def render_sidebar() -> dict:
    st.sidebar.title("🚌 Metlink Anomalies")
    st.sidebar.caption("Wellington PT · April 2026 · DuckDB (local)")
    meta = get_filters_meta()

    st.sidebar.header("Filters")
    severities = st.sidebar.multiselect("Severity", SEVERITY_ORDER, default=["HIGH", "MEDIUM"])
    det_labels = {f"{d} · {n}": d for d, n in meta["DETECTORS"]}
    chosen_det = st.sidebar.multiselect("Detectors", list(det_labels), default=[])
    detectors = [det_labels[c] for c in chosen_det]
    modes = st.sidebar.multiselect("Mode", meta["MODES"], default=[])

    date_range = st.sidebar.date_input("Date range", value=(meta["MIN"], meta["MAX"]),
                                       min_value=meta["MIN"], max_value=meta["MAX"])
    d0, d1 = (date_range if isinstance(date_range, tuple) and len(date_range) == 2
              else (meta["MIN"], meta["MAX"]))

    st.sidebar.markdown("---")
    st.sidebar.warning("⚠️ **Synthetic data.** Real Metlink timetable, simulated running with "
                       "injected anomalies. Figures are illustrative, not actual April 2026 events.")
    return {"severities": severities, "detectors": detectors, "modes": modes, "d0": d0, "d1": d1}


# ====================TABS====================
def render_main_tabs(f: dict) -> None:
    tab_over, tab_map, tab_heat, tab_data = st.tabs(
        ["🚨 Overview", "🗺️ Map", "🔥 Hourly heatmap", "📋 Data"])
    with tab_over:
        render_tab_overview(f)
    with tab_map:
        render_tab_map(f)
    with tab_heat:
        render_tab_heatmap(f)
    with tab_data:
        render_tab_data(f)


def render_tab_overview(f: dict) -> None:
    st.header("Anomaly overview")
    m = get_metrics(f)
    c1, c2, c3, c4 = st.columns(4)
    c1.metric("Anomalies", f"{m['TOTAL']:,}")
    c2.metric("High severity", f"{m['HIGH']:,}")
    c3.metric("Dates affected", m["DATES"])
    c4.metric("Routes affected", m["ROUTES"])

    by_det = get_by_detector(f)
    if by_det.empty:
        st.info("No anomalies match the current filters.")
    else:
        fig = px.bar(by_det, x="ANOMALIES", y="DETECTOR_NAME", color="SEVERITY", orientation="h",
                     category_orders={"SEVERITY": SEVERITY_ORDER},
                     color_discrete_map={"HIGH": "#c0392b", "MEDIUM": "#e67e22", "LOW": "#f1c40f"})
        fig.update_layout(height=380, margin=dict(l=10, r=10, t=10, b=10), yaxis_title=None)
        st.plotly_chart(fig, width="stretch")

    col1, col2 = st.columns(2)
    with col1:
        st.subheader("Worst days")
        st.dataframe(get_worst_days(), width="stretch", hide_index=True)
    with col2:
        st.subheader("Detector scorecard (vs injected truth)")
        st.caption("Precision/recall against the labelled ground-truth episodes.")
        st.dataframe(get_scorecard(), width="stretch", hide_index=True)


def render_tab_map(f: dict) -> None:
    st.header("Where the anomalies are")
    st.caption("Stops with detected anomalies. Bubble size = count · red = has HIGH severity.")
    render_anomaly_map(get_map_points(f))


def render_tab_heatmap(f: dict) -> None:
    st.header("Hourly anomaly heatmap by location")
    c1, c2 = st.columns([1, 1])
    dimension = c1.selectbox("Location dimension", ["Route", "Mode", "Stop"], index=0)
    top_n = c2.slider("Top locations", 5, 40, 20)
    df = get_heatmap(f, dimension, top_n)
    if df.empty:
        st.info("No anomalies match the current filters.")
        return
    render_heatmap(df, dimension)


def render_tab_data(f: dict) -> None:
    st.header("Anomaly events")
    events = get_events(f)
    st.caption(f"Top {len(events):,} by |score| for the current filters.")
    st.dataframe(events, width="stretch", hide_index=True)
    render_download_csv_dataframe(events, "anomaly events", "metlink_anomaly_events.csv")


# ====================VISUALISATION====================
def render_anomaly_map(df: pd.DataFrame) -> None:
    if df.empty:
        st.warning("No mappable anomalies (no stop coordinates) for these filters.")
        return
    df = df.copy()
    df["RADIUS"] = 40 + df["ANOMALIES"] * 6
    df["COLOR"] = df["HIGH"].apply(lambda h: [192, 57, 43, 220] if h > 0 else [41, 128, 185, 200])
    layer = pdk.Layer(
        "ScatterplotLayer", df, get_position=["LON", "LAT"], get_fill_color="COLOR",
        get_line_color=[255, 255, 255, 180], get_radius="RADIUS",
        radius_min_pixels=3, radius_max_pixels=40, line_width_min_pixels=1,
        stroked=True, filled=True, pickable=True, auto_highlight=True)
    view = pdk.ViewState(latitude=float(df["LAT"].mean()), longitude=float(df["LON"].mean()),
                         zoom=10.5, pitch=0)
    tooltip = {"html": "<b>{STOP_NAME}</b><br/>Anomalies: {ANOMALIES}<br/>"
                       "High: {HIGH}<br/>Mode: {MODE}",
               "style": {"backgroundColor": "#1b2631", "color": "white", "fontSize": "12px"}}
    st.pydeck_chart(pdk.Deck(layers=[layer], initial_view_state=view, tooltip=tooltip,
                             map_style="https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json"))


def render_heatmap(df: pd.DataFrame, dimension: str) -> None:
    hours = list(range(24))
    pivot = (df.pivot_table(index="LOCATION", columns="HOUR", values="ANOMALIES",
                            aggfunc="sum", fill_value=0)
               .reindex(columns=hours, fill_value=0))
    pivot = pivot.loc[pivot.sum(axis=1).sort_values(ascending=False).index]
    fig = px.imshow(pivot, labels=dict(x="Hour of day", y=dimension, color="Anomalies"),
                    color_continuous_scale="YlOrRd", aspect="auto")
    fig.update_layout(height=max(360, 22 * len(pivot)), margin=dict(l=10, r=10, t=10, b=10))
    st.plotly_chart(fig, width="stretch")
    st.caption("Darker = more anomalies in that hour. Peaks in the AM/PM commute bands are expected; "
               "off-peak concentrations are the more interesting signal.")


# ====================STATIC_METHODS====================
def render_download_csv_dataframe(download_dataframe, download_label, download_file_name) -> None:
    """Download CSV button for dataframes."""
    st.markdown("---")
    if not download_dataframe.empty:
        st.download_button(label="📥 Download " + download_label,
                           data=download_dataframe.to_csv(index=False),
                           file_name=download_file_name, mime="text/csv",
                           key=f"download_{download_file_name}")
    else:
        st.info("No data available to download")


# ====================MAIN====================
if __name__ == "__main__":
    filters = render_sidebar()
    render_main_tabs(filters)
