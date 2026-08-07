# Wellington Traffic Camera Capture

Standalone Streamlit app for the Claude hackathon traffic-change-detection problem
statement. Captures the latest still from every NZTA traffic camera in the Wellington
region, on demand, and stores each frame on disk so a change-detection model has a
time series to work with.

Built on the WCC `snowflake-streamlit-development` template (section separators,
`@st.cache_data` data layer, `render_*` methods, pydeck with a CartoDB basemap), with
the `SESSION` block swapped from `get_active_session()` to a local filesystem store so
it runs under plain `streamlit run`.

## Run it

```bash
cd nzta_traffic_cameras
python3.12 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
streamlit run app.py
```

First run only: press **🔄 Refresh camera catalogue** in the sidebar. That pulls the
national camera list once and writes `data/cameras_wellington.json`. After that the
catalogue is read from disk.

Then press **⬇️ Refresh latest photos** on the *Latest photos* tab. That is the only
thing that downloads. Reruns, tab switches, search boxes and selectboxes never trigger
a fetch.

## Tabs

**📷 Latest photos**
- **📋 List** — every Wellington camera as a photo card with name, ID, frame time and
  status. Search by name or ID, hide unavailable cameras, 2/3/4 column layout, and a
  CSV export of the underlying index.
- **🗺️ Map** — pydeck scatter plot over the CartoDB Voyager basemap. Hovering a pin
  shows the captured photo inline (thumbnails are inlined as base64 data URIs, so no
  static file server is needed). Below the map, a selectbox shows the full-size frame
  plus metadata. 🟢 new frame · 🔵 unchanged · 🔴 unavailable.

**📈 Capture history** — every frame ever captured, grouped by run and by camera. This
is the change-detection substrate.

## Data sources

| Thing | Endpoint |
|---|---|
| Camera catalogue | `https://trafficnz.info/service/traffic/rest/4/cameras/all` (NZTA open Traffic & Travel API, no auth) |
| Camera image | `https://www.trafficnz.info/camera/{camera_id}.jpg` |
| Human-readable page | `https://www.journeys.nzta.govt.nz/traffic-cameras/wellington/{camera_id}` |

The `journeys.nzta.govt.nz` page you linked is a JavaScript SPA — there is no HTML to
scrape. It reads from the same open API the app uses, so we go straight to the source
rather than driving a headless browser.

The catalogue parser is deliberately schema-tolerant: it walks the XML (or JSON, if the
endpoint honours the `Accept` header) and keeps any record carrying an id plus a valid
lat/lon, matching field names case-insensitively across a set of likely aliases. If the
API's `region` field is blank or renamed, it falls back to a Greater Wellington bounding
box (Ōtaki to the south coast, Kāpiti to the Wairarapa).

## Storage layout

```
data/
├── cameras_wellington.json      # catalogue snapshot
├── manifest.csv                 # one row per camera per capture run
└── captures/
    ├── 1180/
    │   ├── 20260808T091500Z_7f0c68ab.jpg
    │   └── 20260808T093000Z_a13be901.jpg
    └── 1181/…
```

Filenames are `{last_modified}_{md5_prefix}.jpg`. **`Last-Modified` is the important
bit** — it is the camera's actual frame time, not the download time, which is what lets
you tell "the camera published a new frame" apart from "we polled again". If the MD5
already exists on disk the file is not rewritten and the row is logged as `UNCHANGED`.

### Placeholder handling

NZTA serves an identical "image unavailable" placeholder for offline cameras. Rather
than ship a reference copy, the client detects it statistically: if the exact same MD5
comes back for three or more different cameras in a single run, that content is the
placeholder. Those frames are flagged `UNAVAILABLE` and deleted so they never enter the
change-detection series.

## Manifest schema

`CAMERA_ID, CAMERA_NAME, REGION, LAT, LON, CAPTURED_AT_UTC, LAST_MODIFIED_UTC,
IMAGE_AGE_SECONDS, FILE_PATH, MD5, BYTES, STATUS, MESSAGE`

`STATUS` ∈ `OK` (new frame) · `UNCHANGED` · `UNAVAILABLE` · `EMPTY` · `ERROR`.

## Path back to Snowflake

`nzta_client.py` has no Streamlit dependency, so the same code lifts into a Python
stored procedure behind an external access integration:

- network rule allowing `trafficnz.info` and `www.trafficnz.info`
- procedure writes frames to an internal stage and the manifest to a table
- a task on a schedule replaces the Refresh button
- Cortex `AI_COMPLETE` with `PROMPT()` + `TO_FILE()` over consecutive staged frames for
  the actual change classification — the same cascade pattern as SWARM_PARKING_VISION

The manifest columns are already UPPERCASE and stage-friendly for that reason.

## Notes

- Camera IDs and coordinates are never hardcoded — everything comes from the live
  catalogue, cached to disk.
- Capture is threaded (sidebar slider, default 8 workers). Be considerate of a public
  government endpoint; 8 is plenty for ~20–40 cameras.
- Images are © NZTA and covered by the Traffic and Travel API terms of use.
