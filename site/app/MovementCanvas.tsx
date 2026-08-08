"use client";

import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  type CameraCollection,
  type CameraFeature,
  type Coordinate,
  type LineCollection,
  type LineFeature,
  type MapView,
  DEFAULT_VIEW,
  MAX_ZOOM,
  MIN_ZOOM,
  boundsOfLines,
  boundsOfPoints,
  createProjector,
  drawCameras,
  drawCoverage,
  drawSignals,
  drawTiles,
  fitView,
  panView,
  pickNearest,
  prepareCanvas,
  zoomAround,
} from "./map-draw";

type Filter = "all" | "people" | "vehicles";
type Source = "movement" | "cameras";
type CameraScope = "frame" | "all";

const PEOPLE = new Set(["Pedestrian", "Cyclist", "E-scooter"]);

const SOURCES: { id: Source; label: string; detail: string }[] = [
  { id: "movement", label: "WCC countlines", detail: "Batch replay · movement change" },
  { id: "cameras", label: "NZTA traffic cameras", detail: "Live frames · state highways" },
];

export default function MovementCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const [source, setSource] = useState<Source>("movement");
  const [coverage, setCoverage] = useState<LineFeature[]>([]);
  const [signals, setSignals] = useState<LineFeature[]>([]);
  const [cameras, setCameras] = useState<CameraCollection | null>(null);
  const [selectedSignalId, setSelectedSignalId] = useState<string | null>(null);
  const [selectedCameraId, setSelectedCameraId] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [cameraScope, setCameraScope] = useState<CameraScope>("frame");
  const [error, setError] = useState<string | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [frameNonce, setFrameNonce] = useState(0);
  // Remember which frame URL failed, so selecting another camera or refreshing
  // clears the failure without an effect.
  const [failedFrame, setFailedFrame] = useState<string | null>(null);
  const [view, setView] = useState<MapView>(DEFAULT_VIEW);
  // The canvas is redrawn imperatively, so tile loads and resizes can call the
  // latest draw closure without re-running an effect.
  const drawRef = useRef<() => void>(() => {});
  const dragRef = useRef<{ x: number; y: number; moved: boolean } | null>(null);

  const stageSize = useCallback(() => {
    const rect = canvasRef.current?.getBoundingClientRect();
    return rect && rect.width > 0 ? { width: rect.width, height: rect.height } : null;
  }, []);

  useEffect(() => {
    Promise.all([
      fetch("/cop/v1/countline-coverage.geojson").then((response) => response.json()),
      fetch("/cop/v1/movement-signals.geojson").then((response) => response.json()),
    ])
      .then(([coverageData, signalData]: LineCollection[]) => {
        setCoverage(coverageData.features);
        setSignals(signalData.features);
        setSelectedSignalId(signalData.features[0]?.id ?? null);
      })
      .catch(() => setError("The replay files could not be loaded. Check the COP feed."));
  }, []);

  useEffect(() => {
    fetch("/cop/v1/traffic-cameras.geojson")
      .then((response) => response.json())
      .then((collection: CameraCollection) => {
        setCameras(collection);
        const onFrame = collection.features.find(
          (feature) => feature.properties.within_countline_frame,
        );
        setSelectedCameraId((onFrame ?? collection.features[0])?.id ?? null);
      })
      .catch(() => setCameraError("The camera catalogue could not be loaded."));
  }, []);

  const filteredSignals = useMemo(() => signals.filter((feature) => {
    const mode = String(feature.properties.transport_class);
    if (filter === "people") return PEOPLE.has(mode);
    if (filter === "vehicles") return !PEOPLE.has(mode);
    return true;
  }), [signals, filter]);

  const cameraFeatures = useMemo(() => cameras?.features ?? [], [cameras]);
  const onFrameCameras = useMemo(
    () => cameraFeatures.filter((feature) => feature.properties.within_countline_frame),
    [cameraFeatures],
  );
  const listedCameras = useMemo(
    () => (cameraScope === "frame" ? onFrameCameras : cameraFeatures),
    [cameraScope, onFrameCameras, cameraFeatures],
  );

  const selectedSignal =
    signals.find((feature) => feature.id === selectedSignalId) ?? filteredSignals[0];
  const selectedCamera: CameraFeature | undefined =
    cameraFeatures.find((feature) => feature.id === selectedCameraId) ?? listedCameras[0];

  const showingCameras = source === "cameras";

  // Redraw after every render, and hand the same closure to tile loads and resizes.
  useEffect(() => {
    drawRef.current = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const surface = prepareCanvas(canvas);
      if (!surface) return;
      drawTiles(surface.context, view, surface.width, surface.height, () => drawRef.current());
      const project = createProjector(view, surface.width, surface.height);
      drawCoverage(surface.context, project, coverage);
      if (showingCameras) {
        drawCameras(surface.context, project, listedCameras, selectedCamera?.id ?? null);
      } else {
        drawSignals(surface.context, project, filteredSignals, selectedSignal?.id ?? null);
      }
    };
    drawRef.current();
  });

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const observer = new ResizeObserver(() => drawRef.current());
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  // Wheel zoom needs a non-passive listener so the page does not scroll instead.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const anchor: Coordinate = [event.clientX - rect.left, event.clientY - rect.top];
      setView((current) =>
        zoomAround(current, event.deltaY < 0 ? 1 : -1, anchor, rect.width, rect.height),
      );
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, []);

  const zoomBy = (step: number) => {
    const size = stageSize();
    if (!size) return;
    setView((current) =>
      zoomAround(current, step, [size.width / 2, size.height / 2], size.width, size.height),
    );
  };

  const fitLayer = useCallback(() => {
    const size = stageSize();
    if (!size) return;
    const bounds = showingCameras ? boundsOfPoints(listedCameras) : boundsOfLines(coverage);
    if (bounds) setView(fitView(bounds, size.width, size.height));
  }, [stageSize, showingCameras, listedCameras, coverage]);

  /** Selecting from the list recentres the map only when the feature is off screen. */
  const revealOnMap = (coordinate: Coordinate) => {
    const size = stageSize();
    if (!size) return;
    setView((current) => {
      const [x, y] = createProjector(current, size.width, size.height)(coordinate);
      const margin = 40;
      const visible =
        x >= margin && x <= size.width - margin && y >= margin && y <= size.height - margin;
      return visible ? current : { ...current, centerLon: coordinate[0], centerLat: coordinate[1] };
    });
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { x: event.clientX, y: event.clientY, moved: false };
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 3) return;
    drag.moved = true;
    drag.x = event.clientX;
    drag.y = event.clientY;
    setView((current) => panView(current, -dx, -dy));
  };

  // A press that never moved is a click: select the nearest feature under it.
  const handlePointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    const size = stageSize();
    if (!drag || drag.moved || !size) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const point: Coordinate = [event.clientX - rect.left, event.clientY - rect.top];
    const project = createProjector(view, size.width, size.height);
    if (showingCameras) {
      const hit = pickNearest(listedCameras, (feature) => feature.geometry.coordinates, project, point);
      if (hit) setSelectedCameraId(hit.id);
    } else {
      const hit = pickNearest(filteredSignals, (feature) => feature.geometry.coordinates[0], project, point);
      if (hit) setSelectedSignalId(hit.id);
    }
  };
  const frameSrc = selectedCamera
    ? `${selectedCamera.properties.image_url}?frame=${frameNonce}`
    : null;
  const frameFailed = frameSrc !== null && frameSrc === failedFrame;

  return (
    <div className="investigation-shell">
      <div className="source-tabs" role="tablist" aria-label="Data sources">
        {SOURCES.map((entry) => (
          <button
            type="button"
            key={entry.id}
            id={`source-tab-${entry.id}`}
            role="tab"
            aria-selected={source === entry.id}
            aria-controls="source-panel"
            className={source === entry.id ? "active" : ""}
            onClick={() => setSource(entry.id)}
          >
            <strong>{entry.label}</strong>
            <small>{entry.detail}</small>
          </button>
        ))}
      </div>

      <section
        className="investigation-frame"
        id="source-panel"
        role="tabpanel"
        aria-labelledby={`source-tab-${source}`}
      >
        <div className="map-column">
          <div className="map-toolbar">
            <div>
              <p className="eyebrow">
                {showingCameras
                  ? "Live frames · NZTA Traffic and Travel API"
                  : "12:00 · Thursday 6 August 2026"}
              </p>
              <h2 id="map-heading">
                {showingCameras ? "Camera positions on the same frame" : "Countline change field"}
              </h2>
            </div>
            {showingCameras ? (
              <div className="filter-group" aria-label="Filter cameras">
                {(["frame", "all"] as CameraScope[]).map((value) => (
                  <button
                    type="button"
                    key={value}
                    className={cameraScope === value ? "active" : ""}
                    aria-pressed={cameraScope === value}
                    onClick={() => setCameraScope(value)}
                  >
                    {value === "frame"
                      ? `On frame (${onFrameCameras.length})`
                      : `All Wellington (${cameraFeatures.length})`}
                  </button>
                ))}
              </div>
            ) : (
              <div className="filter-group" aria-label="Filter signals">
                {(["all", "people", "vehicles"] as Filter[]).map((value) => (
                  <button
                    type="button"
                    key={value}
                    className={filter === value ? "active" : ""}
                    aria-pressed={filter === value}
                    onClick={() => setFilter(value)}
                  >
                    {value === "all" ? "All" : value === "people" ? "People" : "Vehicles"}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="map-stage" ref={frameRef}>
            <canvas
              ref={canvasRef}
              className="map-canvas"
              role="img"
              aria-label={
                showingCameras
                  ? `Map of ${listedCameras.length} NZTA traffic cameras over Wellington. Drag to pan, use the zoom buttons to change scale.`
                  : `Map of ${filteredSignals.length} unusual movement changes across 414 WCC countlines. Drag to pan, use the zoom buttons to change scale.`
              }
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={() => { dragRef.current = null; }}
            />
            <div className="map-controls">
              <button
                type="button"
                onClick={() => zoomBy(1)}
                disabled={view.zoom >= MAX_ZOOM}
                aria-label="Zoom in"
                title="Zoom in"
              >
                +
              </button>
              <button
                type="button"
                onClick={() => zoomBy(-1)}
                disabled={view.zoom <= MIN_ZOOM}
                aria-label="Zoom out"
                title="Zoom out"
              >
                −
              </button>
              <button type="button" className="fit" onClick={fitLayer} title="Fit this layer">
                Fit
              </button>
              <span className="zoom-level" aria-hidden="true">z{view.zoom}</span>
            </div>
            <p className="map-attribution">
              ©{" "}
              <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">
                OpenStreetMap
              </a>{" "}
              ·{" "}
              <a href="https://carto.com/attributions" target="_blank" rel="noreferrer">
                CARTO
              </a>
            </p>
            <div className="map-key" aria-hidden="true">
              {showingCameras ? (
                <>
                  <span><i className="camera" />Camera</span>
                  <span><i className="camera-offline" />Offline</span>
                </>
              ) : (
                <>
                  <span><i className="increase" />Increase</span>
                  <span><i className="decrease" />Decrease</span>
                </>
              )}
              <span><i className="coverage" />Sensor coverage</span>
            </div>
            {coverage.length === 0 && !error ? <p className="map-message">Loading countlines…</p> : null}
            {error ? <p className="map-message error" role="alert">{error}</p> : null}
          </div>
          <p className="map-caption">
            {showingCameras
              ? `${onFrameCameras.length} of ${cameraFeatures.length} Wellington cameras sit inside the WCC countline frame; the rest watch state highways further out. Drag to pan, scroll or use + and − to zoom.`
              : "Geometry is the WCC sensor countline itself. It does not imply the whole surrounding street or suburb changed. Drag to pan, scroll or use + and − to zoom."}
          </p>
        </div>

        {showingCameras ? (
          <aside className="evidence-column" aria-label="Camera evidence">
            {selectedCamera ? (
              <div className="selected-evidence">
                <div className="evidence-heading">
                  <span
                    className={`direction-chip ${
                      selectedCamera.properties.within_countline_frame ? "on-frame" : "off-frame"
                    }`}
                  >
                    {selectedCamera.properties.within_countline_frame ? "on frame" : "off frame"}
                  </span>
                  <span>Camera {selectedCamera.properties.camera_id}</span>
                </div>
                <h3>{selectedCamera.properties.name}</h3>
                <p>
                  {selectedCamera.properties.direction || "Direction not published"} ·{" "}
                  {selectedCamera.properties.region}
                </p>
                <figure className="camera-frame">
                  {frameSrc && !frameFailed ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={frameSrc}
                      alt={`Most recent NZTA camera frame: ${selectedCamera.properties.name}`}
                      referrerPolicy="no-referrer"
                      onError={() => setFailedFrame(frameSrc)}
                    />
                  ) : (
                    <p className="frame-missing">
                      No frame returned. The camera may be offline or NZTA unreachable.
                    </p>
                  )}
                  <figcaption>
                    Frame loads live from NZTA in your browser. Nothing is stored or re-published
                    here — the Streamlit capture app records published frame times to build the
                    change-detection series.
                  </figcaption>
                </figure>
                <button
                  type="button"
                  className="frame-refresh"
                  onClick={() => setFrameNonce((nonce) => nonce + 1)}
                >
                  Refresh frame
                </button>
                <dl className="evidence-metrics">
                  <div><dt>Publisher</dt><dd>NZTA</dd></div>
                  <div><dt>Cadence</dt><dd>every few minutes</dd></div>
                  <div>
                    <dt>Position</dt>
                    <dd>
                      {selectedCamera.geometry.coordinates[1].toFixed(4)},{" "}
                      {selectedCamera.geometry.coordinates[0].toFixed(4)}
                    </dd>
                  </div>
                  <div>
                    <dt>Catalogue status</dt>
                    <dd>{selectedCamera.properties.offline ? "offline" : "online"}</dd>
                  </div>
                </dl>
                <a
                  className="camera-link"
                  href={selectedCamera.properties.view_url}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open this camera on NZTA Journeys{" "}
                  <span aria-hidden="true">→</span>
                  <span className="visually-hidden">(opens in new window)</span>
                </a>
                <p className="evidence-note">
                  A frame is a snapshot, not a count. Cameras watch state highways, so they
                  corroborate a countline signal — they do not measure one.
                </p>
              </div>
            ) : (
              <p className="empty-evidence">
                {cameraError ?? "Loading the Wellington camera catalogue…"}
              </p>
            )}

            <div className="signal-list" aria-label={`${listedCameras.length} cameras`}>
              {listedCameras.map((feature) => (
                <button
                  type="button"
                  key={feature.id}
                  className={feature.id === selectedCamera?.id ? "selected" : ""}
                  onClick={() => {
                    setSelectedCameraId(feature.id);
                    revealOnMap(feature.geometry.coordinates);
                  }}
                >
                  <span>
                    <strong>{feature.properties.name}</strong>
                    <small>
                      {feature.properties.direction || "Direction not published"}
                      {feature.properties.within_countline_frame ? "" : " · off frame"}
                    </small>
                  </span>
                  <em className={feature.properties.offline ? "offline" : "online"}>
                    {feature.properties.camera_id}
                  </em>
                </button>
              ))}
            </div>
          </aside>
        ) : (
          <aside className="evidence-column" aria-label="Signal evidence">
            {selectedSignal ? (
              <div className="selected-evidence">
                <div className="evidence-heading">
                  <span className={`direction-chip ${selectedSignal.properties.change_direction}`}>
                    {String(selectedSignal.properties.change_direction)}
                  </span>
                  <span>Investigate</span>
                </div>
                <h3>{String(selectedSignal.properties.name)}</h3>
                <p>{String(selectedSignal.properties.transport_class)} · {String(selectedSignal.properties.direction)}</p>
                <div className="count-comparison">
                  <div><span>Observed</span><strong>{Number(selectedSignal.properties.observed_count).toLocaleString("en-NZ")}</strong></div>
                  <div><span>Expected</span><strong>{Number(selectedSignal.properties.expected_count).toLocaleString("en-NZ")}</strong></div>
                </div>
                <dl className="evidence-metrics">
                  <div><dt>Robust score</dt><dd>{Number(selectedSignal.properties.robust_z).toFixed(1)} z</dd></div>
                  <div><dt>History</dt><dd>{Number((selectedSignal.properties.signal_confidence as Record<string, number>).history_samples)} matched hours</dd></div>
                  <div><dt>Baseline confidence</dt><dd>{String((selectedSignal.properties.signal_confidence as Record<string, string>).level)}</dd></div>
                </dl>
                <p className="evidence-note">No cause inferred. Check operational context before acting.</p>
              </div>
            ) : <p className="empty-evidence">Select a signal to inspect its evidence.</p>}

            <div className="signal-list" aria-label={`${filteredSignals.length} filtered signals`}>
              {filteredSignals.map((feature) => (
                <button
                  type="button"
                  key={feature.id}
                  className={feature.id === selectedSignal?.id ? "selected" : ""}
                  onClick={() => {
                    setSelectedSignalId(feature.id);
                    revealOnMap(feature.geometry.coordinates[0]);
                  }}
                >
                  <span>
                    <strong>{String(feature.properties.name)}</strong>
                    <small>{String(feature.properties.transport_class)} · {String(feature.properties.direction)}</small>
                  </span>
                  <em className={String(feature.properties.change_direction)}>
                    {Number(feature.properties.robust_z) > 0 ? "+" : ""}{Number(feature.properties.robust_z).toFixed(1)}
                  </em>
                </button>
              ))}
            </div>
          </aside>
        )}
      </section>
    </div>
  );
}
