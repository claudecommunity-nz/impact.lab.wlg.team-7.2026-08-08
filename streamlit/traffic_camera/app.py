# ====================IMPORTS====================
"""
Wellington Traffic Camera Capture — Claude Hackathon (traffic change detection)

Standalone / local Streamlit app. Follows the WCC Snowflake Streamlit template
structure (section separators, @st.cache_data data layer, render_* methods,
pydeck + CartoDB basemap), but with the SESSION block swapped from
get_active_session() to a local filesystem store so it runs with `streamlit run`.

Images are captured to disk on demand only — one download per press of Refresh.
Nothing is fetched on rerun, tab switch, or widget interaction.
"""

import base64
import io
from datetime import datetime, timezone, timedelta
from pathlib import Path

import pandas as pd
import pydeck as pdk
import streamlit as st
from PIL import Image

import nzta_client as nzta

# Set page to wide mode
st.set_page_config(layout="wide", page_title="Wellington Traffic Cameras", page_icon="📷")

# ====================SESSION====================
# Local deployment: no Snowflake session. The "schema" is a folder on disk.
APP_ROOT = Path(__file__).resolve().parent
DATA_ROOT = Path(st.session_state.get("DATA_ROOT", APP_ROOT / "data"))

CATALOGUE_PATH = DATA_ROOT / "cameras_wellington.json"
IMAGES_ROOT = DATA_ROOT / "captures"
MANIFEST_PATH = DATA_ROOT / "manifest.csv"

NZ_TZ = timezone(timedelta(hours=12))  # NZST; NZDT handled cosmetically only
WELLINGTON_CBD = {"LAT": -41.2865, "LON": 174.7762}

for key, default in {
    "catalogue": None,
    "capture_rows": None,
    "last_capture_at": None,
    "catalogue_source": None,
}.items():
    if key not in st.session_state:
        st.session_state[key] = default


# ====================DATA====================
@st.cache_data(show_spinner=False)
def get_catalogue_from_disk(catalogue_path_str: str, cache_buster: float) -> list[dict]:
    """Wellington camera catalogue previously saved to disk."""
    return nzta.load_catalogue(Path(catalogue_path_str))


@st.cache_data(show_spinner=False)
def get_manifest(manifest_path_str: str, cache_buster: float) -> pd.DataFrame:
    """Full capture manifest as a DataFrame with UPPERCASE columns."""
    rows = nzta.read_manifest(Path(manifest_path_str))
    if not rows:
        return pd.DataFrame(columns=nzta.MANIFEST_COLUMNS)

    df = pd.DataFrame(rows)
    for column in ["LAT", "LON", "BYTES", "IMAGE_AGE_SECONDS"]:
        if column in df.columns:
            df[column] = pd.to_numeric(df[column], errors="coerce")
    for column in ["CAPTURED_AT_UTC", "LAST_MODIFIED_UTC"]:
        if column in df.columns:
            df[column] = pd.to_datetime(df[column], errors="coerce", utc=True)
    return df


@st.cache_data(show_spinner=False)
def get_thumbnail_data_uri(file_path_str: str, mtime: float, width: int = 240) -> str:
    """Small base64 JPEG so pydeck tooltips can show the photo without a web server."""
    try:
        with Image.open(file_path_str) as image:
            image = image.convert("RGB")
            ratio = width / float(image.width)
            image = image.resize((width, max(1, int(image.height * ratio))))
            buffer = io.BytesIO()
            image.save(buffer, format="JPEG", quality=70)
        encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
        return f"data:image/jpeg;base64,{encoded}"
    except Exception:  # noqa: BLE001 - a missing/corrupt frame must not break the map
        return ""


def file_mtime(file_path_str: str) -> float:
    path = Path(file_path_str) if file_path_str else None
    return path.stat().st_mtime if path and path.exists() else 0.0


def data_version() -> float:
    """Cache buster driven by the on-disk manifest, so caches clear after a capture."""
    return MANIFEST_PATH.stat().st_mtime if MANIFEST_PATH.exists() else 0.0


def get_latest_frame_df() -> pd.DataFrame:
    """One row per camera: the most recent successful capture."""
    manifest_df = get_manifest(str(MANIFEST_PATH), data_version())
    if manifest_df.empty:
        return manifest_df

    manifest_df = manifest_df.sort_values("CAPTURED_AT_UTC")
    latest_df = manifest_df.groupby("CAMERA_ID", as_index=False).last()
    latest_df["CAMERA_ID_NUM"] = pd.to_numeric(latest_df["CAMERA_ID"], errors="coerce")
    return latest_df.sort_values("CAMERA_ID_NUM").drop(columns=["CAMERA_ID_NUM"])


# ====================ACTIONS====================
def refresh_catalogue() -> None:
    """Pull the national camera list from NZTA and keep the Wellington region."""
    with st.spinner("Retrieving the NZTA camera catalogue…"):
        try:
            all_cameras, source_url = nzta.fetch_camera_catalogue()
        except Exception as exc:  # noqa: BLE001
            st.error(f"Catalogue refresh failed: {exc}")
            return

    wellington = nzta.filter_wellington(all_cameras)
    if not wellington:
        st.warning("The catalogue was retrieved but no Wellington cameras matched.")
        return

    nzta.save_catalogue(CATALOGUE_PATH, wellington)
    st.session_state.catalogue = wellington
    st.session_state.catalogue_source = source_url
    get_catalogue_from_disk.clear()
    st.success(f"Catalogue refreshed — {len(wellington)} Wellington cameras from {len(all_cameras)} nationally.")


def refresh_photos(max_workers: int, timeout: int) -> None:
    """The one and only download step. Runs on button press, never on rerun."""
    cameras = st.session_state.catalogue or get_catalogue_from_disk(str(CATALOGUE_PATH), 0.0)
    if not cameras:
        st.error("No camera catalogue loaded. Press **Refresh camera catalogue** in the sidebar first.")
        return

    progress = st.progress(0.0, text=f"Capturing {len(cameras)} cameras…")
    rows = nzta.capture_images(cameras, IMAGES_ROOT, max_workers=max_workers, timeout=timeout)
    progress.progress(1.0, text="Writing manifest…")

    nzta.append_manifest(MANIFEST_PATH, rows)
    st.session_state.capture_rows = rows
    st.session_state.last_capture_at = datetime.now(timezone.utc)

    get_manifest.clear()
    progress.empty()

    ok = sum(1 for r in rows if r["STATUS"] == "OK")
    unchanged = sum(1 for r in rows if r["STATUS"] == "UNCHANGED")
    failed = len(rows) - ok - unchanged
    st.success(f"Captured {ok} new frames · {unchanged} unchanged · {failed} unavailable/error.")


# ====================SIDEBAR====================
def render_sidebar() -> tuple[int, int]:
    st.sidebar.title("📷 Wellington Traffic Cameras")
    st.sidebar.caption("Source: NZTA Traffic & Travel open API · trafficnz.info")

    catalogue = st.session_state.catalogue or get_catalogue_from_disk(str(CATALOGUE_PATH), 0.0)
    st.session_state.catalogue = catalogue

    st.sidebar.header("Capture")
    max_workers = st.sidebar.slider("Parallel downloads", 1, 16, 8)
    timeout = st.sidebar.slider("Request timeout (seconds)", 5, 60, 20)

    if st.sidebar.button("🔄 Refresh camera catalogue", use_container_width=True):
        refresh_catalogue()
        st.rerun()

    st.sidebar.markdown("---")
    st.sidebar.metric("Cameras in catalogue", len(catalogue))

    manifest_df = get_manifest(str(MANIFEST_PATH), data_version())
    st.sidebar.metric("Frames captured to date", len(manifest_df))

    if not manifest_df.empty:
        last_run = manifest_df["CAPTURED_AT_UTC"].max()
        st.sidebar.caption(f"Last capture: {format_nz(last_run)}")

    st.sidebar.markdown("---")
    st.sidebar.info(
        f"Images are written to:\n\n`{IMAGES_ROOT}`\n\n"
        "One folder per camera, one file per distinct frame. "
        "Nothing downloads until you press **Refresh latest photos**."
    )

    return max_workers, timeout


# ====================TABS====================
def render_main_tabs(max_workers: int, timeout: int) -> None:
    tab_latest, tab_history = st.tabs(["📷 Latest photos", "📈 Capture history"])

    with tab_latest:
        render_tab_latest_photos(max_workers, timeout)

    with tab_history:
        render_tab_history()


def render_tab_latest_photos(max_workers: int, timeout: int) -> None:
    header_col, button_col = st.columns([4, 1])
    with header_col:
        st.header("Latest photos")
        if st.session_state.last_capture_at:
            st.caption(f"Captured this session at {format_nz(st.session_state.last_capture_at)}")
        else:
            st.caption("Showing the most recent frame held on disk for each camera.")
    with button_col:
        st.write("")
        if st.button("⬇️ Refresh latest photos", type="primary", use_container_width=True):
            refresh_photos(max_workers, timeout)

    latest_df = get_latest_frame_df()

    if latest_df.empty:
        st.info(
            "No photos captured yet. Press **Refresh camera catalogue** in the sidebar "
            "(first run only), then **Refresh latest photos**."
        )
        return

    render_capture_metrics(latest_df)

    sub_list, sub_map = st.tabs(["📋 List", "🗺️ Map"])

    with sub_list:
        render_subtab_list(latest_df)

    with sub_map:
        render_subtab_map(latest_df)


def render_tab_history() -> None:
    st.header("Capture history")
    st.caption("Every frame ever captured — the time series that change detection runs over.")

    manifest_df = get_manifest(str(MANIFEST_PATH), data_version())
    if manifest_df.empty:
        st.info("No captures recorded yet.")
        return

    runs_df = (
        manifest_df.assign(CAPTURE_RUN=manifest_df["CAPTURED_AT_UTC"].dt.floor("min"))
        .groupby("CAPTURE_RUN")
        .agg(
            CAMERAS=("CAMERA_ID", "nunique"),
            NEW_FRAMES=("STATUS", lambda s: int((s == "OK").sum())),
            UNCHANGED=("STATUS", lambda s: int((s == "UNCHANGED").sum())),
            UNAVAILABLE=("STATUS", lambda s: int((s.isin(["UNAVAILABLE", "ERROR", "EMPTY"])).sum())),
        )
        .reset_index()
        .sort_values("CAPTURE_RUN", ascending=False)
    )

    col1, col2, col3 = st.columns(3)
    with col1:
        st.metric("Capture runs", len(runs_df))
    with col2:
        st.metric("Distinct cameras", manifest_df["CAMERA_ID"].nunique())
    with col3:
        st.metric("Distinct frames", manifest_df["MD5"].nunique())

    st.subheader("Runs")
    st.dataframe(runs_df, use_container_width=True, hide_index=True)

    st.subheader("Frames per camera")
    per_camera_df = (
        manifest_df[manifest_df["STATUS"] == "OK"]
        .groupby(["CAMERA_ID", "CAMERA_NAME"], as_index=False)
        .agg(FRAMES=("MD5", "nunique"), FIRST_SEEN=("CAPTURED_AT_UTC", "min"), LAST_SEEN=("CAPTURED_AT_UTC", "max"))
        .sort_values("FRAMES", ascending=False)
    )
    st.dataframe(per_camera_df, use_container_width=True, hide_index=True)

    render_download_csv_dataframe(manifest_df, "Full manifest", "nzta_camera_manifest.csv")


# ====================VISUALISATION====================
def render_capture_metrics(latest_df: pd.DataFrame) -> None:
    live_df = latest_df[latest_df["STATUS"].isin(["OK", "UNCHANGED"])]
    col1, col2, col3, col4 = st.columns(4)
    with col1:
        st.metric("Cameras", len(latest_df))
    with col2:
        st.metric("With a usable frame", len(live_df))
    with col3:
        st.metric("Unavailable", len(latest_df) - len(live_df))
    with col4:
        median_age = live_df["IMAGE_AGE_SECONDS"].median()
        st.metric("Median frame age", "—" if pd.isna(median_age) else f"{median_age / 60:.0f} min")


def render_subtab_list(latest_df: pd.DataFrame) -> None:
    search_col, hide_col, cols_col = st.columns([3, 1, 1])
    with search_col:
        search = st.text_input("Search camera name or ID", placeholder="e.g. Ngauranga, Terrace, 1180")
    with hide_col:
        hide_unavailable = st.checkbox("Hide unavailable", value=True)
    with cols_col:
        columns_per_row = st.selectbox("Columns", [2, 3, 4], index=1)

    filtered_df = latest_df.copy()
    if hide_unavailable:
        filtered_df = filtered_df[filtered_df["STATUS"].isin(["OK", "UNCHANGED"])]
    if search:
        needle = search.strip().lower()
        mask = filtered_df["CAMERA_NAME"].str.lower().str.contains(needle, na=False) | filtered_df[
            "CAMERA_ID"
        ].astype(str).str.contains(needle, na=False)
        filtered_df = filtered_df[mask]

    if filtered_df.empty:
        st.info("No cameras match the current filters.")
        return

    st.caption(f"Showing {len(filtered_df)} cameras")

    records = filtered_df.to_dict("records")
    for start in range(0, len(records), columns_per_row):
        chunk = records[start : start + columns_per_row]
        columns = st.columns(columns_per_row)
        for column, record in zip(columns, chunk):
            with column:
                render_camera_card(record)

    with st.expander("📄 Underlying data"):
        display_df = filtered_df[
            ["CAMERA_ID", "CAMERA_NAME", "STATUS", "LAST_MODIFIED_UTC", "IMAGE_AGE_SECONDS", "BYTES", "FILE_PATH"]
        ]
        st.dataframe(display_df, use_container_width=True, hide_index=True)
        render_download_csv_dataframe(display_df, "Latest photo index", "latest_photos.csv")


def render_camera_card(record: dict) -> None:
    file_path = str(record.get("FILE_PATH") or "")
    caption = f"#{record['CAMERA_ID']} · {record.get('CAMERA_NAME', '')}"

    if file_path and Path(file_path).exists():
        st.image(file_path, use_container_width=True)
    else:
        st.warning("No frame on disk")

    st.markdown(f"**{caption}**")
    st.caption(f"{status_badge(record.get('STATUS'))} · {format_nz(record.get('LAST_MODIFIED_UTC'))}")


def render_subtab_map(latest_df: pd.DataFrame) -> None:
    map_df = latest_df.dropna(subset=["LAT", "LON"]).copy()
    if map_df.empty:
        st.warning("No camera coordinates available — refresh the camera catalogue in the sidebar.")
        return

    include_unavailable = st.checkbox("Show unavailable cameras", value=False, key="map_show_unavailable")
    if not include_unavailable:
        map_df = map_df[map_df["STATUS"].isin(["OK", "UNCHANGED"])]

    if map_df.empty:
        st.info("No cameras to plot.")
        return

    map_df["THUMB"] = [
        get_thumbnail_data_uri(str(p), file_mtime(str(p))) if p and Path(str(p)).exists() else ""
        for p in map_df["FILE_PATH"]
    ]
    map_df["LAST_SEEN_NZ"] = map_df["LAST_MODIFIED_UTC"].apply(format_nz)
    map_df["COLOR"] = map_df["STATUS"].apply(
        lambda s: [39, 174, 96, 220] if s == "OK" else ([41, 128, 185, 220] if s == "UNCHANGED" else [192, 57, 43, 200])
    )

    layer = pdk.Layer(
        "ScatterplotLayer",
        map_df,
        get_position=["LON", "LAT"],
        get_fill_color="COLOR",
        get_line_color=[255, 255, 255, 200],
        get_radius=120,
        radius_min_pixels=7,
        radius_max_pixels=18,
        line_width_min_pixels=1,
        stroked=True,
        filled=True,
        pickable=True,
        auto_highlight=True,
    )

    view_state = pdk.ViewState(
        latitude=float(map_df["LAT"].mean()) if len(map_df) > 1 else WELLINGTON_CBD["LAT"],
        longitude=float(map_df["LON"].mean()) if len(map_df) > 1 else WELLINGTON_CBD["LON"],
        zoom=10,
        pitch=0,
        bearing=0,
    )

    tooltip = {
        "html": (
            "<div style='max-width:260px'>"
            "<b>#{CAMERA_ID} {CAMERA_NAME}</b><br/>"
            "<span style='font-size:11px'>{LAST_SEEN_NZ}</span><br/>"
            "<img src='{THUMB}' style='width:240px;margin-top:6px;border-radius:4px'/>"
            "</div>"
        ),
        "style": {"backgroundColor": "#1b2631", "color": "white", "fontSize": "12px"},
    }

    st.pydeck_chart(
        pdk.Deck(
            layers=[layer],
            initial_view_state=view_state,
            tooltip=tooltip,
            map_style="https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json",
        )
    )
    st.caption("🟢 new frame this capture · 🔵 unchanged since last capture · 🔴 unavailable. Hover a pin for the photo.")

    st.markdown("---")
    st.subheader("Inspect a camera")

    options = map_df["CAMERA_ID"].tolist()
    labels = {
        row["CAMERA_ID"]: f"#{row['CAMERA_ID']} · {row['CAMERA_NAME']}" for _, row in map_df.iterrows()
    }
    selected_id = st.selectbox("Camera", options=options, format_func=lambda cid: labels.get(cid, cid))

    record = map_df[map_df["CAMERA_ID"] == selected_id].iloc[0].to_dict()
    image_col, detail_col = st.columns([3, 2])

    with image_col:
        file_path = str(record.get("FILE_PATH") or "")
        if file_path and Path(file_path).exists():
            st.image(file_path, use_container_width=True)
        else:
            st.warning("No frame on disk for this camera.")

    with detail_col:
        st.markdown(f"### #{record['CAMERA_ID']}")
        st.markdown(f"**{record.get('CAMERA_NAME', '')}**")
        st.write(f"Status: {status_badge(record.get('STATUS'))}")
        st.write(f"Frame time: {format_nz(record.get('LAST_MODIFIED_UTC'))}")
        st.write(f"Captured: {format_nz(record.get('CAPTURED_AT_UTC'))}")
        st.write(f"Location: {record.get('LAT'):.5f}, {record.get('LON'):.5f}")
        st.caption(f"`{file_path}`")


# ====================STATIC_METHODS====================
def format_nz(value) -> str:
    """Render a UTC timestamp in New Zealand local time."""
    if value in (None, "") or (isinstance(value, float) and pd.isna(value)):
        return "—"
    try:
        timestamp = pd.to_datetime(value, utc=True)
    except (ValueError, TypeError):
        return str(value)
    if pd.isna(timestamp):
        return "—"
    return timestamp.tz_convert(NZ_TZ).strftime("%d %b %Y %H:%M")


def status_badge(status: str | None) -> str:
    return {
        "OK": "🟢 New frame",
        "UNCHANGED": "🔵 Unchanged",
        "UNAVAILABLE": "🔴 Unavailable",
        "ERROR": "⚠️ Error",
        "EMPTY": "⚠️ Empty response",
    }.get(str(status), str(status))


def render_download_csv_dataframe(download_dataframe, download_label, download_file_name) -> None:
    """Download CSV button for dataframes"""
    st.markdown("---")
    if not download_dataframe.empty:
        csv = download_dataframe.to_csv(index=False)
        st.download_button(
            label="📥 Download " + download_label,
            data=csv,
            file_name=download_file_name,
            mime="text/csv",
            key=f"download_{download_file_name}",
        )
    else:
        st.info("No data available to download")


# ====================MAIN====================
if __name__ == "__main__":
    DATA_ROOT.mkdir(parents=True, exist_ok=True)
    max_workers, timeout = render_sidebar()
    render_main_tabs(max_workers, timeout)
