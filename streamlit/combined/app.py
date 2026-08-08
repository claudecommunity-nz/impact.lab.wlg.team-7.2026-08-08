# ====================IMPORTS====================
"""
Wellington movement — combined multi-source anomaly view (Problem 05).

One app over all three movement sources (WCC sensors, Metlink PT, NZTA highways).
A multi-layer pydeck map shows each source's anomalies as its own togglable layer;
a conformed reporting tab counts how many sources agree in each ~1 km cell x hour,
with a slider to require corroboration (>1 source).

Standalone / local Streamlit on the WCC template (section separators,
@st.cache_data data layer, render_* methods, pydeck + CartoDB Voyager), with the
SESSION block swapped to a local DuckDB reading the committed combined extracts in
data/combined/csv/. NZTA is daily-only and is expanded to synthetic hourly using a
diurnal profile learned from the real sensor counts — flagged as synthetic.
"""

import os
import time
from pathlib import Path

import duckdb
import pandas as pd
import plotly.express as px
import pydeck as pdk
import streamlit as st

st.set_page_config(layout="wide", page_title="Wellington Movement — Combined", page_icon="🧭")

# ====================SESSION====================
APP_ROOT = Path(__file__).resolve().parent
REPO_ROOT = APP_ROOT.parents[1]
CSV_DIR = Path(os.environ.get("COMBINED_CSV_DIR", REPO_ROOT / "data" / "combined" / "csv"))

SOURCE_COLOR = {"sensors": [39, 174, 96], "metlink": [41, 128, 185], "nzta": [230, 126, 34]}
SOURCE_LABEL = {"sensors": "WCC sensors (real)", "metlink": "Metlink PT (synthetic)",
                "nzta": "NZTA highways (synthetic hourly)"}


@st.cache_resource(show_spinner="Loading combined anomaly layer into DuckDB…")
def get_connection() -> duckdb.DuckDBPyConnection:
    con = duckdb.connect(":memory:")
    for name in ("anomaly_points", "conformed_hourly", "corroboration_summary",
                 "source_totals", "camera_catalogue"):
        path = (CSV_DIR / f"{name}.csv").as_posix()
        con.execute(f"CREATE OR REPLACE VIEW {name} AS SELECT * FROM read_csv_auto('{path}')")
    return con


def q(sql: str, params: list | None = None) -> pd.DataFrame:
    return get_connection().execute(sql, params or []).fetch_df()


# ====================DATA====================
@st.cache_data(show_spinner=False)
def get_meta() -> dict:
    row = q("SELECT min(event_date) mn, max(event_date) mx FROM anomaly_points").iloc[0]
    return {"MIN": pd.to_datetime(row["mn"]).date(), "MAX": pd.to_datetime(row["mx"]).date()}


def _time_clause(f: dict, prefix: str = "") -> tuple[str, list]:
    p = prefix
    clauses = [f"{p}event_date BETWEEN ? AND ?"]
    params = [f["d0"], f["d1"]]
    if f["hour"] != "All":
        clauses.append(f"{p}event_hour = ?"); params.append(int(f["hour"]))
    return " AND ".join(clauses), params


@st.cache_data(show_spinner=False)
def get_points(f: dict, sources: tuple, sev_min: int) -> pd.DataFrame:
    where, params = _time_clause(f)
    if not sources:
        return pd.DataFrame(columns=["source", "location", "lat", "lon", "hits", "sev_rank"])
    src = "(" + ",".join("?" * len(sources)) + ")"
    return q(f"""SELECT source, location, lat, lon, event_date, event_hour, metric,
                        sum(hits) AS hits, max(sev_rank) AS sev_rank
                 FROM anomaly_points
                 WHERE {where} AND source IN {src} AND sev_rank >= ? AND lat IS NOT NULL
                 GROUP BY ALL""",
             params + list(sources) + [sev_min])


@st.cache_data(show_spinner=False)
def get_conformed(f: dict, min_sources: int) -> pd.DataFrame:
    where, params = _time_clause(f)
    return q(f"""SELECT cell_id, cell_lat, cell_lon, event_date, event_hour,
                        sensor_hits, metlink_hits, nzta_hits, total_hits, sources_hit,
                        max_sev_rank, sources
                 FROM conformed_hourly
                 WHERE {where} AND sources_hit >= ?
                 ORDER BY sources_hit DESC, total_hits DESC""", params + [min_sources])


@st.cache_data(show_spinner=False)
def get_source_totals() -> pd.DataFrame:
    return q("SELECT * FROM source_totals ORDER BY anomaly_records DESC")


@st.cache_data(show_spinner=False)
def get_corroboration() -> pd.DataFrame:
    return q("SELECT * FROM corroboration_summary ORDER BY sources_hit")


@st.cache_data(show_spinner=False)
def get_cameras() -> pd.DataFrame:
    return q("SELECT * FROM camera_catalogue ORDER BY CAMERA_ID")


@st.cache_data(show_spinner=False)
def get_points_range(d0, d1, sev_min: int) -> pd.DataFrame:
    return q("""SELECT source, location, lat, lon,
                       strftime(event_date, '%Y-%m-%d') AS DAY, event_hour AS HOUR,
                       any_value(metric) AS metric, sum(hits) AS hits
                FROM anomaly_points
                WHERE event_date BETWEEN ? AND ? AND sev_rank >= ? AND lat IS NOT NULL
                GROUP BY ALL""", [d0, d1, sev_min])


# ====================SIDEBAR====================
def render_sidebar() -> dict:
    st.sidebar.title("🧭 Combined movement anomalies")
    st.sidebar.caption("WCC sensors · Metlink · NZTA · April 2026 · DuckDB (local)")
    meta = get_meta()
    st.sidebar.header("Window")
    date_range = st.sidebar.date_input("Date range", value=(meta["MIN"], meta["MAX"]),
                                       min_value=meta["MIN"], max_value=meta["MAX"])
    d0, d1 = (date_range if isinstance(date_range, tuple) and len(date_range) == 2
              else (meta["MIN"], meta["MAX"]))
    hour = st.sidebar.selectbox("Hour of day", ["All"] + list(range(24)), index=0)
    sev = st.sidebar.radio("Minimum severity", ["MEDIUM+", "HIGH only"], index=0)
    st.sidebar.markdown("---")
    st.sidebar.info("Anomalies are MEDIUM+ per source. NZTA is daily, expanded to "
                    "**synthetic hourly** via a diurnal profile from the real sensor "
                    "counts. Signals mean *investigate*, not confirmed events.")
    return {"d0": d0, "d1": d1, "hour": hour, "sev_min": 3 if sev == "HIGH only" else 2}


# ====================TABS====================
def render_main_tabs(f: dict) -> None:
    t_map, t_conf, t_live, t_play, t_data = st.tabs(
        ["🗺️ Multi-layer map", "🔀 Conformed report", "📷 Live Photos", "▶️ Playback", "📋 Data"])
    with t_map:
        render_tab_map(f)
    with t_conf:
        render_tab_conformed(f)
    with t_live:
        render_tab_live_photos(f)
    with t_play:
        render_tab_playback(f)
    with t_data:
        render_tab_data(f)


def render_tab_map(f: dict) -> None:
    st.header("Anomalies by source")
    st.caption("Toggle each source's layer. Bubble size = anomaly hits at that place/hour.")
    cols = st.columns(3)
    chosen = []
    for i, s in enumerate(("sensors", "metlink", "nzta")):
        rgb = SOURCE_COLOR[s]
        dot = f"<span style='color:rgb({rgb[0]},{rgb[1]},{rgb[2]})'>●</span>"
        with cols[i]:
            if st.checkbox(f"{SOURCE_LABEL[s]}", value=True, key=f"lyr_{s}"):
                chosen.append(s)
            st.markdown(dot, unsafe_allow_html=True)
    pts = get_points(f, tuple(chosen), f["sev_min"])
    render_multilayer_map(pts, chosen)
    if not pts.empty:
        st.caption(f"{len(pts):,} anomaly points shown "
                   f"({', '.join(f'{s}: {int((pts.source==s).sum())}' for s in chosen)}).")


def render_tab_conformed(f: dict) -> None:
    st.header("Conformed anomalies — where sources agree")
    st.caption("Each ~1 km cell × hour, counting anomaly hits per source. Raise the slider "
               "to require corroboration across sources.")
    min_sources = st.slider("Minimum sources agreeing", 1, 3, 1,
                            help="1 = any anomaly · 2+ = more than one source flags the same "
                                 "cell and hour (stronger signal).")
    conf = get_conformed(f, min_sources)

    c1, c2, c3, c4 = st.columns(4)
    c1.metric("Cell-hours", f"{len(conf):,}")
    c2.metric("≥2 sources", int((conf["sources_hit"] >= 2).sum()) if not conf.empty else 0)
    c3.metric("All 3 sources", int((conf["sources_hit"] >= 3).sum()) if not conf.empty else 0)
    c4.metric("Distinct cells", conf["cell_id"].nunique() if not conf.empty else 0)

    if conf.empty:
        st.info("No cell-hours meet the current filter.")
        return

    render_conformed_map(conf)

    st.subheader("Corroboration breakdown")
    corr = get_corroboration()
    fig = px.bar(corr, x="sources_hit", y="cell_hours", text="cell_hours")
    fig.update_layout(height=260, margin=dict(l=10, r=10, t=10, b=10),
                      xaxis_title="sources agreeing", yaxis_title="cell-hours")
    st.plotly_chart(fig, width="stretch")

    st.subheader("Most-corroborated cell-hours")
    show = conf.head(60).rename(columns={"event_date": "DATE", "event_hour": "HOUR",
                                         "sources_hit": "SOURCES", "total_hits": "HITS"})
    st.dataframe(show[["DATE", "HOUR", "cell_lat", "cell_lon", "SOURCES", "HITS",
                       "sensor_hits", "metlink_hits", "nzta_hits", "sources"]],
                 width="stretch", hide_index=True)


def render_tab_live_photos(f: dict) -> None:
    st.header("Live traffic camera photos")
    st.caption("Current stills from NZTA Wellington traffic cameras (trafficnz.info), fetched "
               "live by your browser each refresh. © NZ Transport Agency Waka Kotahi.")
    cams = get_cameras()
    top = st.columns([3, 1, 1])
    search = top[0].text_input("Search camera", placeholder="name or id", key="live_search")
    ncols = top[1].selectbox("Columns", [2, 3, 4], index=1, key="live_cols")
    if top[2].button("🔄 Refresh", use_container_width=True):
        st.session_state["photo_nonce"] = st.session_state.get("photo_nonce", 0) + 1
        st.rerun()
    nonce = st.session_state.get("photo_nonce", 0)

    df = cams
    if search:
        s = search.strip().lower()
        df = df[df["CAMERA_NAME"].str.lower().str.contains(s, na=False)
                | df["CAMERA_ID"].astype(str).str.contains(s, na=False)]
    if df.empty:
        st.info("No cameras match.")
        return
    st.caption(f"{len(df)} cameras · refresh #{nonce}")

    records = df.to_dict("records")
    for start in range(0, len(records), ncols):
        row = records[start:start + ncols]
        cols = st.columns(ncols)
        for col, rec in zip(cols, row):
            with col:
                st.image(f"{rec['IMAGE_URL']}?nonce={nonce}", use_container_width=True)
                st.caption(f"#{rec['CAMERA_ID']} · {rec['CAMERA_NAME']}")


def render_tab_playback(f: dict) -> None:
    st.header("Playback — anomalies over a 24-hour period")
    st.caption("Pick a start and end (day + hour) and play through the window; the map animates "
               "each hour. (Interaction modelled on the Melbourne traffic demo; the data here is "
               "Wellington, April 2026.)")
    meta = get_meta()
    c1, c2, c3, c4 = st.columns(4)
    sd = c1.date_input("Start day", value=meta["MIN"], min_value=meta["MIN"],
                       max_value=meta["MAX"], key="pb_sd")
    sh = c2.selectbox("Start hour", list(range(24)), index=0, key="pb_sh")
    ed = c3.date_input("End day", value=meta["MIN"], min_value=meta["MIN"],
                       max_value=meta["MAX"], key="pb_ed")
    eh = c4.selectbox("End hour", list(range(24)), index=23, key="pb_eh")

    start = pd.Timestamp(sd) + pd.Timedelta(hours=int(sh))
    end = pd.Timestamp(ed) + pd.Timedelta(hours=int(eh))
    if end < start:
        st.warning("End is before start — adjust the range.")
        return
    frames = pd.date_range(start, end, freq="h")
    if len(frames) > 240:
        st.warning(f"{len(frames)} hours is a lot — showing the first 240.")
        frames = frames[:240]

    pts = get_points_range(sd, ed, f["sev_min"])
    speed = st.slider("Seconds per hour", 0.1, 2.0, 0.5, 0.1, key="pb_speed")
    idx = st.slider("Frame (hour)", 0, len(frames) - 1, 0, key="pb_frame")
    play = st.button("▶️ Play", type="primary")

    area = st.empty()

    def show(i: int) -> None:
        ts = frames[i]
        fr = pts[(pts["DAY"] == ts.strftime("%Y-%m-%d")) & (pts["HOUR"] == ts.hour)]
        with area.container():
            st.markdown(f"### {ts:%a %d %b} · {ts.hour:02d}:00 — {len(fr)} points, "
                        f"{int(fr['hits'].sum()) if not fr.empty else 0} hits")
            st.pydeck_chart(_points_deck(fr))

    if play:
        for i in range(idx, len(frames)):
            show(i)
            time.sleep(speed)
    else:
        show(idx)


def render_tab_data(f: dict) -> None:
    st.header("Data")
    st.subheader("Anomaly records per source")
    st.dataframe(get_source_totals(), width="stretch", hide_index=True)
    st.subheader("Conformed cell-hours (current window, any corroboration)")
    conf = get_conformed(f, 1)
    st.dataframe(conf, width="stretch", hide_index=True)
    render_download_csv_dataframe(conf, "conformed cell-hours", "conformed_cell_hours.csv")


# ====================VISUALISATION====================
def render_multilayer_map(pts: pd.DataFrame, chosen: list) -> None:
    if pts.empty or not chosen:
        st.warning("No anomaly points for the current filter / no layers selected.")
        return
    layers = []
    for s in chosen:
        sub = pts[pts["source"] == s].copy()
        if sub.empty:
            continue
        sub["RADIUS"] = 120 + sub["hits"] * 40
        rgb = SOURCE_COLOR[s]
        layers.append(pdk.Layer(
            "ScatterplotLayer", sub, get_position=["lon", "lat"],
            get_fill_color=[rgb[0], rgb[1], rgb[2], 200], get_line_color=[255, 255, 255, 160],
            get_radius="RADIUS", radius_min_pixels=3, radius_max_pixels=30,
            line_width_min_pixels=1, stroked=True, filled=True, pickable=True, auto_highlight=True))
    view = pdk.ViewState(latitude=float(pts["lat"].mean()), longitude=float(pts["lon"].mean()),
                         zoom=9.5, pitch=0)
    tooltip = {"html": "<b>{location}</b><br/>{source} · {event_date} {event_hour}:00<br/>"
                       "hits: {hits}<br/>{metric}",
               "style": {"backgroundColor": "#1b2631", "color": "white", "fontSize": "12px"}}
    st.pydeck_chart(pdk.Deck(layers=layers, initial_view_state=view, tooltip=tooltip,
                             map_style="https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json"))


def render_conformed_map(conf: pd.DataFrame) -> None:
    agg = (conf.groupby(["cell_id", "cell_lat", "cell_lon"], as_index=False)
               .agg(cell_hours=("sources_hit", "size"),
                    max_sources=("sources_hit", "max"),
                    total_hits=("total_hits", "sum")))
    agg["COLOR"] = agg["max_sources"].apply(
        lambda s: [192, 57, 43, 230] if s >= 3 else ([230, 126, 34, 210] if s == 2 else [127, 140, 141, 150]))
    agg["RADIUS"] = 150 + agg["cell_hours"] * 30
    layer = pdk.Layer("ScatterplotLayer", agg, get_position=["cell_lon", "cell_lat"],
                      get_fill_color="COLOR", get_line_color=[255, 255, 255, 180],
                      get_radius="RADIUS", radius_min_pixels=5, radius_max_pixels=45,
                      line_width_min_pixels=1, stroked=True, filled=True, pickable=True, auto_highlight=True)
    view = pdk.ViewState(latitude=float(agg["cell_lat"].mean()), longitude=float(agg["cell_lon"].mean()),
                         zoom=9.5, pitch=0)
    tooltip = {"html": "Cell {cell_lat}, {cell_lon}<br/>max sources: {max_sources}<br/>"
                       "cell-hours: {cell_hours} · total hits: {total_hits}",
               "style": {"backgroundColor": "#1b2631", "color": "white", "fontSize": "12px"}}
    st.pydeck_chart(pdk.Deck(layers=[layer], initial_view_state=view, tooltip=tooltip,
                             map_style="https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json"))
    st.caption("🔴 all 3 sources · 🟠 2 sources · ⚪ 1 source (in this window).")


def _points_deck(df: pd.DataFrame) -> pdk.Deck:
    """Multi-source anomaly map with a FIXED Wellington view (stable across frames)."""
    layers = []
    for s, rgb in SOURCE_COLOR.items():
        sub = df[df["source"] == s]
        if sub.empty:
            continue
        sub = sub.copy()
        sub["RADIUS"] = 140 + sub["hits"] * 40
        layers.append(pdk.Layer(
            "ScatterplotLayer", sub, get_position=["lon", "lat"],
            get_fill_color=[rgb[0], rgb[1], rgb[2], 210], get_line_color=[255, 255, 255, 160],
            get_radius="RADIUS", radius_min_pixels=3, radius_max_pixels=30,
            line_width_min_pixels=1, stroked=True, filled=True, pickable=True))
    view = pdk.ViewState(latitude=-41.2200, longitude=174.9000, zoom=8.6, pitch=0)
    tooltip = {"html": "<b>{location}</b><br/>{source} · hits {hits}<br/>{metric}",
               "style": {"backgroundColor": "#1b2631", "color": "white", "fontSize": "12px"}}
    return pdk.Deck(layers=layers, initial_view_state=view, tooltip=tooltip,
                    map_style="https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json")


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
