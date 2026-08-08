# ====================IMPORTS====================
"""
NZTA state-highway traffic anomaly detection — Claude Hackathon (Problem 05).

Standalone / local Streamlit app. Follows the WCC Snowflake Streamlit template
structure (section separators, @st.cache_data data layer, render_* methods,
pydeck + CartoDB basemap), with the SESSION block swapped from get_active_session()
to a local DuckDB connection so it runs with `streamlit run`.

Data: the committed April-2026 NZTA anomaly extracts in NZTA/anomaly/csv/, read
into in-memory DuckDB. These are REAL NZTA TMS daily counts (de-duplicated) scored
against each site's own robust weekday/weekend baseline. Daily granularity only
(no 2026 sub-daily archive); TMS lags ~2 days, so this is a baseline/backtest
source, not a live detector. Set NZTA_DUCKDB to read a full nzta.duckdb instead.
"""

import os
from pathlib import Path

import duckdb
import pandas as pd
import plotly.express as px
import pydeck as pdk
import streamlit as st

st.set_page_config(layout="wide", page_title="NZTA Traffic Anomalies", page_icon="🛣️")

# ====================SESSION====================
APP_ROOT = Path(__file__).resolve().parent
NZTA_ROOT = APP_ROOT.parent
CSV_DIR = Path(os.environ.get("NZTA_CSV_DIR", NZTA_ROOT / "anomaly" / "csv"))
SEVERITY_ORDER = ["HIGH", "MEDIUM", "LOW"]


@st.cache_resource(show_spinner="Loading NZTA anomaly extracts into DuckDB…")
def get_connection() -> duckdb.DuckDBPyConnection:
    con = duckdb.connect(":memory:")
    for name in ("site_daily_scored", "anomaly_flagged", "site_summary", "coverage_by_date"):
        path = (CSV_DIR / f"{name}.csv").as_posix()
        con.execute(f"CREATE OR REPLACE VIEW {name} AS SELECT * FROM read_csv_auto('{path}')")
    return con


def q(sql: str, params: list | None = None) -> pd.DataFrame:
    return get_connection().execute(sql, params or []).fetch_df()


# ====================DATA====================
@st.cache_data(show_spinner=False)
def get_meta() -> dict:
    row = q("SELECT min(count_date) mn, max(count_date) mx FROM site_daily_scored").iloc[0]
    shs = q("SELECT DISTINCT state_highway FROM site_daily_scored WHERE state_highway IS NOT NULL ORDER BY 1")
    return {"MIN": pd.to_datetime(row["mn"]).date(), "MAX": pd.to_datetime(row["mx"]).date(),
            "SH": shs["state_highway"].astype(str).tolist()}


def _where(f: dict) -> tuple[str, list]:
    clauses, params = ["severity <> 'NONE'"], []
    clauses.append("count_date BETWEEN ? AND ?"); params += [f["d0"], f["d1"]]
    if f["severities"]:
        clauses.append("severity IN (" + ",".join("?" * len(f["severities"])) + ")"); params += f["severities"]
    if f["directions"]:
        clauses.append("direction IN (" + ",".join("?" * len(f["directions"])) + ")"); params += f["directions"]
    if f["shs"]:
        clauses.append("state_highway IN (" + ",".join("?" * len(f["shs"])) + ")"); params += f["shs"]
    return " AND ".join(clauses), params


@st.cache_data(show_spinner=False)
def get_metrics(f: dict) -> dict:
    where, params = _where(f)
    row = q(f"""SELECT count(*) SITE_DAYS,
                       count(*) FILTER (WHERE severity='HIGH') HIGH,
                       count(DISTINCT SiteRef) SITES,
                       min(ratio) LOW_RATIO
                FROM site_daily_scored WHERE {where}""", params).iloc[0]
    return {"SITE_DAYS": int(row.SITE_DAYS), "HIGH": int(row.HIGH),
            "SITES": int(row.SITES), "LOW_RATIO": row.LOW_RATIO}


@st.cache_data(show_spinner=False)
def get_top_anomalies(f: dict, limit: int = 400) -> pd.DataFrame:
    where, params = _where(f)
    return q(f"""SELECT count_date, day_name, site_name, SiteRef, state_highway AS SH,
                        total_count, round(baseline_median) AS BASELINE, ratio, robust_z,
                        severity, direction, no_location
                 FROM site_daily_scored WHERE {where}
                 ORDER BY abs(coalesce(robust_z,0)) DESC LIMIT {int(limit)}""", params)


@st.cache_data(show_spinner=False)
def get_map_points(f: dict) -> pd.DataFrame:
    where, params = _where(f)
    return q(f"""
        SELECT SiteRef, any_value(site_name) site_name, any_value(state_highway) SH,
               avg(lat) LAT, avg(lon) LON,
               count(*) ANOMALY_DAYS,
               count(*) FILTER (WHERE severity='HIGH') HIGH_DAYS,
               min(ratio) LOWEST_RATIO
        FROM site_daily_scored
        WHERE {where} AND lat IS NOT NULL
        GROUP BY SiteRef""", params)


@st.cache_data(show_spinner=False)
def get_heatmap(f: dict, top_n: int) -> pd.DataFrame:
    where, params = _where(f)
    # Ratio for the top anomalous sites across all their days (not just flagged),
    # so the heatmap shows the anomaly against a full-month backdrop.
    return q(f"""
        WITH top AS (
            SELECT SiteRef FROM site_daily_scored WHERE {where}
            GROUP BY SiteRef ORDER BY count(*) DESC LIMIT {int(top_n)})
        SELECT s.site_name AS LOCATION, s.count_date AS DAY, s.ratio AS RATIO
        FROM site_daily_scored s JOIN top t USING (SiteRef)
        WHERE s.ratio IS NOT NULL""", params)


@st.cache_data(show_spinner=False)
def get_no_location(f: dict) -> pd.DataFrame:
    where, params = _where(f)
    return q(f"""SELECT count_date, site_name, SiteRef, total_count,
                        round(baseline_median) BASELINE, ratio, severity, direction
                 FROM site_daily_scored WHERE {where} AND no_location
                 ORDER BY abs(coalesce(robust_z,0)) DESC""", params)


@st.cache_data(show_spinner=False)
def get_coverage() -> pd.DataFrame:
    return q("SELECT * FROM coverage_by_date ORDER BY count_date")


# ====================SIDEBAR====================
def render_sidebar() -> dict:
    st.sidebar.title("🛣️ NZTA Traffic Anomalies")
    st.sidebar.caption("State highways · Wellington · April 2026 · DuckDB (local)")
    meta = get_meta()

    st.sidebar.header("Filters")
    severities = st.sidebar.multiselect("Severity", SEVERITY_ORDER, default=["HIGH", "MEDIUM"])
    directions = st.sidebar.multiselect("Direction", ["DROP", "SURGE"], default=["DROP", "SURGE"])
    shs = st.sidebar.multiselect("State highway", meta["SH"], default=[])
    date_range = st.sidebar.date_input("Date range", value=(meta["MIN"], meta["MAX"]),
                                       min_value=meta["MIN"], max_value=meta["MAX"])
    d0, d1 = (date_range if isinstance(date_range, tuple) and len(date_range) == 2
              else (meta["MIN"], meta["MAX"]))

    st.sidebar.markdown("---")
    st.sidebar.info("Each site is compared **only to itself** (robust median/MAD by "
                    "weekday vs weekend). A low ratio = far less traffic than usual — a "
                    "possible closure or loss of access.")
    st.sidebar.caption("Real NZTA TMS data, daily, ~2-day lag. Baseline/backtest source, "
                       "not a live feed. Never sum across sites. In an emergency, 111.")
    return {"severities": severities, "directions": directions, "shs": shs, "d0": d0, "d1": d1}


# ====================TABS====================
def render_main_tabs(f: dict) -> None:
    t_over, t_map, t_heat, t_data = st.tabs(
        ["🚨 Overview", "🗺️ Map", "🔥 Daily heatmap", "📋 Data"])
    with t_over:
        render_tab_overview(f)
    with t_map:
        render_tab_map(f)
    with t_heat:
        render_tab_heatmap(f)
    with t_data:
        render_tab_data(f)


def render_tab_overview(f: dict) -> None:
    st.header("Anomaly overview")
    m = get_metrics(f)
    c1, c2, c3, c4 = st.columns(4)
    c1.metric("Anomaly site-days", f"{m['SITE_DAYS']:,}")
    c2.metric("High severity", f"{m['HIGH']:,}")
    c3.metric("Sites affected", m["SITES"])
    c4.metric("Biggest drop (ratio)", "—" if pd.isna(m["LOW_RATIO"]) else f"{m['LOW_RATIO']:.2f}")

    top = get_top_anomalies(f)
    if top.empty:
        st.info("No anomalies match the current filters.")
        return
    st.subheader("Top anomalies (by robust z)")
    plot = top.head(15).copy()
    plot["LABEL"] = plot["site_name"].fillna(plot["SiteRef"]) + " · " + plot["count_date"].astype(str)
    fig = px.bar(plot[::-1], x="robust_z", y="LABEL", color="direction", orientation="h",
                 color_discrete_map={"DROP": "#c0392b", "SURGE": "#2980b9"})
    fig.update_layout(height=430, margin=dict(l=10, r=10, t=10, b=10), yaxis_title=None,
                      xaxis_title="robust z-score")
    st.plotly_chart(fig, width="stretch")
    st.dataframe(top.head(50), width="stretch", hide_index=True)


def render_tab_map(f: dict) -> None:
    st.header("Where the anomalies are")
    st.caption("State-highway sites with anomalies. Bubble size = anomaly-days · red = has HIGH.")
    render_site_map(get_map_points(f))
    nol = get_no_location(f)
    if not nol.empty:
        st.warning(f"⚠️ {nol['SiteRef'].nunique()} anomalous site(s) have no geometry and can't be "
                   "mapped (Ngauranga WTOC) — shown here so they aren't lost:")
        st.dataframe(nol, width="stretch", hide_index=True)


def render_tab_heatmap(f: dict) -> None:
    st.header("Daily traffic ratio by site")
    st.caption("Each cell = a site's daily total ÷ its usual level. "
               "Red = well below normal (possible disruption); blue = above.")
    top_n = st.slider("Top sites (by anomaly-days)", 5, 40, 20)
    df = get_heatmap(f, top_n)
    if df.empty:
        st.info("No anomalies match the current filters.")
        return
    render_ratio_heatmap(df)


def render_tab_data(f: dict) -> None:
    st.header("Anomaly site-days")
    top = get_top_anomalies(f, limit=5000)
    st.caption(f"{len(top):,} flagged site-days for the current filters.")
    st.dataframe(top, width="stretch", hide_index=True)
    render_download_csv_dataframe(top, "NZTA anomalies", "nzta_anomalies.csv")
    st.subheader("Reporting coverage per date")
    st.caption("How many sites reported each day — the honest denominator. Do not trend totals across sites.")
    st.dataframe(get_coverage(), width="stretch", hide_index=True)


# ====================VISUALISATION====================
def render_site_map(df: pd.DataFrame) -> None:
    if df.empty:
        st.warning("No mappable anomalies for these filters.")
        return
    df = df.copy()
    df["RADIUS"] = 300 + df["ANOMALY_DAYS"] * 220
    df["COLOR"] = df["HIGH_DAYS"].apply(lambda h: [192, 57, 43, 220] if h > 0 else [230, 126, 34, 200])
    layer = pdk.Layer(
        "ScatterplotLayer", df, get_position=["LON", "LAT"], get_fill_color="COLOR",
        get_line_color=[255, 255, 255, 180], get_radius="RADIUS",
        radius_min_pixels=4, radius_max_pixels=45, line_width_min_pixels=1,
        stroked=True, filled=True, pickable=True, auto_highlight=True)
    view = pdk.ViewState(latitude=float(df["LAT"].mean()), longitude=float(df["LON"].mean()),
                         zoom=8.5, pitch=0)
    tooltip = {"html": "<b>{site_name}</b> (SH{SH})<br/>Anomaly-days: {ANOMALY_DAYS}<br/>"
                       "High: {HIGH_DAYS}<br/>Lowest ratio: {LOWEST_RATIO}",
               "style": {"backgroundColor": "#1b2631", "color": "white", "fontSize": "12px"}}
    st.pydeck_chart(pdk.Deck(layers=[layer], initial_view_state=view, tooltip=tooltip,
                             map_style="https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json"))


def render_ratio_heatmap(df: pd.DataFrame) -> None:
    df = df.copy()
    df["DAY"] = pd.to_datetime(df["DAY"]).dt.strftime("%m-%d")
    pivot = df.pivot_table(index="LOCATION", columns="DAY", values="RATIO", aggfunc="min")
    pivot = pivot.loc[pivot.min(axis=1).sort_values().index]  # most-suppressed sites on top
    fig = px.imshow(pivot, labels=dict(x="Date", y="Site", color="Ratio"),
                    color_continuous_scale="RdBu", color_continuous_midpoint=1.0,
                    zmin=0, zmax=2, aspect="auto")
    fig.update_layout(height=max(360, 24 * len(pivot)), margin=dict(l=10, r=10, t=10, b=10))
    st.plotly_chart(fig, width="stretch")


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
