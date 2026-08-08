"use client";

import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { createFlagStore } from "./flag-store";

import {
  type CameraCollection,
  type CameraFeature,
  type Coordinate,
  type LineCollection,
  type LineFeature,
  type MapView,
  type TransitCollection,
  type TransitFeature,
  DEFAULT_VIEW,
  MAX_ZOOM,
  MIN_ZOOM,
  PEOPLE_CLASSES,
  boundsOfLines,
  boundsOfPoints,
  createProjector,
  drawCameras,
  drawCoverage,
  drawSignals,
  drawTiles,
  drawTransit,
  fitView,
  panView,
  pickNearest,
  prepareCanvas,
  unionBounds,
  zoomAround,
} from "./map-draw";

type Filter = "all" | "people" | "vehicles";
type LayerId = "signals" | "coverage" | "cameras" | "transit";
type Layers = Record<LayerId, boolean>;
type Focus = "signal" | "camera" | "transit";
type Hover = { kind: Focus; id: string; left: number; top: number; above: boolean };

const POPUP_WIDTH = 248;
const HOVER_REFRESH_MS = 15_000;
const TRANSIT_LIST_LIMIT = 30;

/* The evidence column slides away rather than disappearing, so the map can grow
 * to the full frame when someone is scanning rather than investigating. */
const evidenceStore = createFlagStore("murmur.evidence.open", true);

const LAYERS: { id: LayerId; label: string; detail: string }[] = [
  { id: "signals", label: "Movement signals", detail: "WCC countlines · batch replay" },
  { id: "coverage", label: "Sensor coverage", detail: "Every measured countline" },
  { id: "cameras", label: "Traffic cameras", detail: "NZTA · live frames" },
  { id: "transit", label: "Public transport", detail: "Metlink · synthetic replay" },
];

export default function MovementCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const [layers, setLayers] = useState<Layers>({
    signals: true,
    coverage: true,
    cameras: true,
    transit: true,
  });
  const [coverage, setCoverage] = useState<LineFeature[]>([]);
  const [signals, setSignals] = useState<LineFeature[]>([]);
  const [cameras, setCameras] = useState<CameraCollection | null>(null);
  const [transit, setTransit] = useState<TransitCollection | null>(null);
  const [selectedSignalId, setSelectedSignalId] = useState<string | null>(null);
  const [selectedCameraId, setSelectedCameraId] = useState<string | null>(null);
  const [selectedTransitId, setSelectedTransitId] = useState<string | null>(null);
  const [focus, setFocus] = useState<Focus>("signal");
  const [filter, setFilter] = useState<Filter>("all");
  const [error, setError] = useState<string | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [transitError, setTransitError] = useState<string | null>(null);
  const [frameNonce, setFrameNonce] = useState(0);
  // Remember which frame URL failed, so selecting another camera or refreshing
  // clears the failure without an effect.
  const [failedFrame, setFailedFrame] = useState<string | null>(null);
  const [view, setView] = useState<MapView>(DEFAULT_VIEW);
  // Hover stores the popup position at pick time; every view change clears it,
  // so the stored screen coordinates never go stale.
  const [hover, setHover] = useState<Hover | null>(null);
  const [hoverTick, setHoverTick] = useState(0);
  // The canvas is redrawn imperatively, so tile loads and resizes can call the
  // latest draw closure without re-running an effect.
  const drawRef = useRef<() => void>(() => {});
  const dragRef = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const evidenceOpen =
    useSyncExternalStore(
      evidenceStore.subscribe,
      evidenceStore.snapshot,
      evidenceStore.serverSnapshot,
    ) === "1";

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

  useEffect(() => {
    fetch("/cop/v1/transit-anomalies.geojson")
      .then((response) => response.json())
      .then((collection: TransitCollection) => {
        setTransit(collection);
        setSelectedTransitId(collection.features[0]?.id ?? null);
      })
      .catch(() => setTransitError("The PT anomaly layer could not be loaded."));
  }, []);

  const filteredSignals = useMemo(() => signals.filter((feature) => {
    const mode = String(feature.properties.transport_class);
    if (filter === "people") return PEOPLE_CLASSES.has(mode);
    if (filter === "vehicles") return !PEOPLE_CLASSES.has(mode);
    return true;
  }), [signals, filter]);

  const cameraFeatures = useMemo(() => cameras?.features ?? [], [cameras]);
  // On-frame cameras first, so the list mirrors what the initial viewport shows.
  const sortedCameras = useMemo(
    () => [
      ...cameraFeatures.filter((feature) => feature.properties.within_countline_frame),
      ...cameraFeatures.filter((feature) => !feature.properties.within_countline_frame),
    ],
    [cameraFeatures],
  );

  // The artifact is sorted by anomaly count, so the top slice is the worst stops.
  const transitFeatures = useMemo(() => transit?.features ?? [], [transit]);
  const listedTransit = useMemo(
    () => transitFeatures.slice(0, TRANSIT_LIST_LIMIT),
    [transitFeatures],
  );

  const selectedSignal =
    signals.find((feature) => feature.id === selectedSignalId) ?? filteredSignals[0];
  const selectedCamera: CameraFeature | undefined =
    cameraFeatures.find((feature) => feature.id === selectedCameraId) ?? sortedCameras[0];
  const selectedTransit: TransitFeature | undefined =
    transitFeatures.find((feature) => feature.id === selectedTransitId) ?? transitFeatures[0];

  const hoveredCamera =
    hover?.kind === "camera"
      ? cameraFeatures.find((feature) => feature.id === hover.id)
      : undefined;
  const hoveredSignal =
    hover?.kind === "signal" ? signals.find((feature) => feature.id === hover.id) : undefined;
  const hoveredTransit =
    hover?.kind === "transit"
      ? transitFeatures.find((feature) => feature.id === hover.id)
      : undefined;

  // Redraw after every render, and hand the same closure to tile loads and resizes.
  useEffect(() => {
    drawRef.current = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const surface = prepareCanvas(canvas);
      if (!surface) return;
      drawTiles(surface.context, view, surface.width, surface.height, () => drawRef.current());
      const project = createProjector(view, surface.width, surface.height);
      if (layers.coverage) drawCoverage(surface.context, project, coverage);
      if (layers.transit) {
        drawTransit(
          surface.context,
          project,
          transitFeatures,
          selectedTransit?.id ?? null,
          hover?.kind === "transit" ? hover.id : null,
        );
      }
      if (layers.signals) {
        drawSignals(
          surface.context,
          project,
          filteredSignals,
          selectedSignal?.id ?? null,
          hover?.kind === "signal" ? hover.id : null,
        );
      }
      if (layers.cameras) {
        drawCameras(
          surface.context,
          project,
          cameraFeatures,
          selectedCamera?.id ?? null,
          hover?.kind === "camera" ? hover.id : null,
        );
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

  // While a camera popup is open, re-request its frame so the preview stays a
  // stream of pictures rather than one stale snapshot.
  const hoverKind = hover?.kind ?? null;
  useEffect(() => {
    if (hoverKind !== "camera") return;
    const interval = setInterval(
      () => setHoverTick((tick) => tick + 1),
      HOVER_REFRESH_MS,
    );
    return () => clearInterval(interval);
  }, [hoverKind]);

  // Wheel zoom needs a non-passive listener so the page does not scroll instead.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const anchor: Coordinate = [event.clientX - rect.left, event.clientY - rect.top];
      setHover(null);
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
    setHover(null);
    setView((current) =>
      zoomAround(current, step, [size.width / 2, size.height / 2], size.width, size.height),
    );
  };

  const fitLayers = useCallback(() => {
    const size = stageSize();
    if (!size) return;
    const bounds = unionBounds(
      layers.signals || layers.coverage ? boundsOfLines(coverage) : null,
      layers.cameras ? boundsOfPoints(cameraFeatures) : null,
      layers.transit ? boundsOfPoints(transitFeatures) : null,
    );
    if (!bounds) return;
    setHover(null);
    setView(fitView(bounds, size.width, size.height));
  }, [stageSize, layers, coverage, cameraFeatures, transitFeatures]);

  const toggleLayer = (id: LayerId) => {
    setHover(null);
    setLayers((current) => ({ ...current, [id]: !current[id] }));
  };

  /** Selecting from the list recentres the map only when the feature is off screen. */
  const revealOnMap = (coordinate: Coordinate) => {
    const size = stageSize();
    if (!size) return;
    setHover(null);
    setView((current) => {
      const [x, y] = createProjector(current, size.width, size.height)(coordinate);
      const margin = 40;
      const visible =
        x >= margin && x <= size.width - margin && y >= margin && y <= size.height - margin;
      return visible ? current : { ...current, centerLon: coordinate[0], centerLat: coordinate[1] };
    });
  };

  /** Cameras sit on top of the line layers, so they win the hit test. */
  const featureAt = (point: Coordinate, size: { width: number; height: number }): Hover | null => {
    const project = createProjector(view, size.width, size.height);
    const place = (kind: Focus, id: string, [x, y]: Coordinate): Hover => ({
      kind,
      id,
      left: Math.min(Math.max(x - POPUP_WIDTH / 2, 8), Math.max(8, size.width - POPUP_WIDTH - 8)),
      top: y,
      above: y > (kind === "camera" ? 264 : 120),
    });
    if (layers.cameras) {
      const hit = pickNearest(cameraFeatures, (feature) => feature.geometry.coordinates, project, point);
      if (hit) return place("camera", hit.id, project(hit.geometry.coordinates));
    }
    if (layers.signals) {
      const hit = pickNearest(filteredSignals, (feature) => feature.geometry.coordinates[0], project, point);
      if (hit) return place("signal", hit.id, project(hit.geometry.coordinates[0]));
    }
    if (layers.transit) {
      const hit = pickNearest(transitFeatures, (feature) => feature.geometry.coordinates, project, point);
      if (hit) return place("transit", hit.id, project(hit.geometry.coordinates));
    }
    return null;
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { x: event.clientX, y: event.clientY, moved: false };
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (drag) {
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 3) return;
      if (!drag.moved) setHover(null);
      drag.moved = true;
      drag.x = event.clientX;
      drag.y = event.clientY;
      setView((current) => panView(current, -dx, -dy));
      return;
    }
    const size = stageSize();
    if (!size) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const next = featureAt([event.clientX - rect.left, event.clientY - rect.top], size);
    setHover((current) =>
      current?.kind === next?.kind && current?.id === next?.id ? current : next,
    );
  };

  // A press that never moved is a click: select the nearest feature under it.
  const handlePointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    const size = stageSize();
    if (!drag || drag.moved || !size) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const hit = featureAt([event.clientX - rect.left, event.clientY - rect.top], size);
    if (!hit) return;
    if (hit.kind === "camera") {
      setSelectedCameraId(hit.id);
      setFocus("camera");
    } else if (hit.kind === "transit") {
      setSelectedTransitId(hit.id);
      setFocus("transit");
    } else {
      setSelectedSignalId(hit.id);
      setFocus("signal");
    }
  };

  const frameSrc = selectedCamera
    ? `${selectedCamera.properties.image_url}?frame=${frameNonce}`
    : null;
  const frameFailed = frameSrc !== null && frameSrc === failedFrame;

  const layerSummary =
    [
      layers.signals ? `${filteredSignals.length} movement signals` : null,
      layers.coverage ? "414 countlines of sensor coverage" : null,
      layers.cameras ? `${cameraFeatures.length} NZTA traffic cameras` : null,
      layers.transit ? `${transitFeatures.length} Metlink anomaly hotspots` : null,
    ]
      .filter(Boolean)
      .join(", ") || "no layers switched on";

  return (
    <div className="investigation-shell">
      <section
        className={`investigation-frame ${evidenceOpen ? "" : "evidence-closed"}`}
        aria-labelledby="map-heading"
      >
        <div className="map-column">
          <div className="map-toolbar">
            <div>
              <p className="eyebrow">12:00 · Thursday 6 August 2026 · batch replay + live frames</p>
              <h2 id="map-heading">One map, every source</h2>
            </div>
            <div className="toolbar-controls">
              <button
                type="button"
                className="evidence-toggle"
                onClick={() => evidenceStore.toggle(evidenceOpen)}
                aria-expanded={evidenceOpen}
                aria-controls="evidence-panel"
                aria-label={evidenceOpen ? "Hide investigate panel" : "Show investigate panel"}
                title={evidenceOpen ? "Hide investigate panel" : "Show investigate panel"}
              >
                <span aria-hidden="true">{evidenceOpen ? "«" : "»"}</span>
              </button>
              <div className="layer-toggles" role="group" aria-label="Map layers">
                {LAYERS.map((entry) => (
                  <button
                    type="button"
                    key={entry.id}
                    className={layers[entry.id] ? "active" : ""}
                    aria-pressed={layers[entry.id]}
                    onClick={() => toggleLayer(entry.id)}
                  >
                    <i className={`swatch ${entry.id}`} aria-hidden="true" />
                    <span>
                      <strong>{entry.label}</strong>
                      <small>{entry.detail}</small>
                    </span>
                  </button>
                ))}
              </div>
              {layers.signals ? (
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
              ) : null}
            </div>
          </div>
          <div className="map-stage" ref={frameRef}>
            <canvas
              ref={canvasRef}
              className="map-canvas"
              style={hover ? { cursor: "pointer" } : undefined}
              role="img"
              aria-label={`Map of Wellington showing ${layerSummary}. Drag to pan, use the zoom buttons to change scale.`}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={() => { dragRef.current = null; }}
              onPointerLeave={() => setHover(null)}
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
              <button type="button" className="fit" onClick={fitLayers} title="Fit the active layers">
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
              {layers.signals ? (
                <>
                  <span><i className="increase" />Increase</span>
                  <span><i className="decrease" />Decrease</span>
                </>
              ) : null}
              {layers.coverage ? <span><i className="coverage" />Sensor coverage</span> : null}
              {layers.cameras ? (
                <>
                  <span><i className="camera" />Camera</span>
                  <span><i className="camera-offline" />Offline</span>
                </>
              ) : null}
              {layers.transit ? (
                <>
                  <span><i className="transit" />PT hotspot</span>
                  <span><i className="transit-high" />Dense high severity</span>
                </>
              ) : null}
            </div>
            {hover && (hoveredCamera || hoveredSignal || hoveredTransit) ? (
              <div
                className={`map-popup ${hover.above ? "above" : "below"}`}
                style={{ left: hover.left, top: hover.top }}
                role="status"
              >
                {hoveredCamera ? (
                  <>
                    <div className="popup-media">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={`${hoveredCamera.properties.image_url}?live=${hoverTick}`}
                        alt={`Live NZTA camera frame: ${hoveredCamera.properties.name}`}
                        referrerPolicy="no-referrer"
                      />
                      <span className="live-chip">Live frame · NZTA</span>
                    </div>
                    <p>
                      <strong>{hoveredCamera.properties.name}</strong>
                      <span>
                        {hoveredCamera.properties.direction || "Direction not published"} ·
                        republished every few minutes · click for detail
                      </span>
                    </p>
                  </>
                ) : hoveredSignal ? (
                  <p>
                    <strong>{String(hoveredSignal.properties.name)}</strong>
                    <span>
                      {String(hoveredSignal.properties.transport_class)} ·{" "}
                      {String(hoveredSignal.properties.direction)} ·{" "}
                      {Number(hoveredSignal.properties.robust_z) > 0 ? "+" : ""}
                      {Number(hoveredSignal.properties.robust_z).toFixed(1)} z · click for evidence
                    </span>
                  </p>
                ) : hoveredTransit ? (
                  <p>
                    <strong>{hoveredTransit.properties.stop_name}</strong>
                    <span>
                      {hoveredTransit.properties.anomaly_count} PT anomalies ·{" "}
                      {hoveredTransit.properties.high_count} high · top:{" "}
                      {hoveredTransit.properties.top_detector} · synthetic April replay
                    </span>
                  </p>
                ) : null}
              </div>
            ) : null}
            {coverage.length === 0 && !error ? <p className="map-message">Loading countlines…</p> : null}
            {error ? <p className="map-message error" role="alert">{error}</p> : null}
          </div>
          <p className="map-caption">
            Countline geometry is the WCC sensor line itself — it does not imply the whole
            street or suburb changed. Person and car icons split the signals by mode. Camera
            icons are NZTA state-highway cameras: hover one for its live frame. Bus icons are
            Metlink anomaly hotspots from a labelled synthetic April 2026 replay. Drag to
            pan, scroll or use + and − to zoom.
          </p>
        </div>

        {/* Sits left of the map via CSS `order`; the DOM keeps the map first so
            the primary content is still what a screen reader reaches first. */}
        <aside
          className="evidence-column"
          id="evidence-panel"
          aria-label={
            focus === "camera"
              ? "Camera evidence"
              : focus === "transit"
                ? "Public transport evidence"
                : "Signal evidence"
          }
        >
          <div className="evidence-inner">
          {focus === "camera" ? (
            selectedCamera ? (
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
            )
          ) : focus === "transit" ? (
            selectedTransit ? (
              <div className="selected-evidence">
                <div className="evidence-heading">
                  <span
                    className={`direction-chip ${
                      selectedTransit.properties.severity_tier === "high"
                        ? "transit-high"
                        : "transit"
                    }`}
                  >
                    {selectedTransit.properties.severity_tier === "high"
                      ? "dense high severity"
                      : "elevated"}
                  </span>
                  <span>Stop {selectedTransit.properties.stop_id}</span>
                </div>
                <h3>{selectedTransit.properties.stop_name}</h3>
                <p>
                  {selectedTransit.properties.modes
                    .map((mode) => mode.replace("_", " ").toLowerCase())
                    .join(" · ")}{" "}
                  · synthetic April 2026 replay
                </p>
                <div className="count-comparison">
                  <div>
                    <span>Anomalies</span>
                    <strong>{selectedTransit.properties.anomaly_count.toLocaleString("en-NZ")}</strong>
                  </div>
                  <div>
                    <span>High severity</span>
                    <strong>{selectedTransit.properties.high_count.toLocaleString("en-NZ")}</strong>
                  </div>
                </div>
                <dl className="evidence-metrics">
                  <div>
                    <dt>Top detector</dt>
                    <dd>
                      {selectedTransit.properties.top_detector} (
                      {selectedTransit.properties.top_detector_count})
                    </dd>
                  </div>
                  <div>
                    <dt>Worst example</dt>
                    <dd>
                      {selectedTransit.properties.worst_example.date} ·{" "}
                      {selectedTransit.properties.worst_example.severity.toLowerCase()}
                    </dd>
                  </div>
                  <div>
                    <dt>Position</dt>
                    <dd>
                      {selectedTransit.geometry.coordinates[1].toFixed(4)},{" "}
                      {selectedTransit.geometry.coordinates[0].toFixed(4)}
                    </dd>
                  </div>
                </dl>
                <p className="worst-detail">{selectedTransit.properties.worst_example.detail}</p>
                <p className="evidence-note">
                  Synthetic data: the real Metlink timetable with simulated running and
                  injected anomalies. Nothing here describes an actual April 2026 event.
                </p>
              </div>
            ) : (
              <p className="empty-evidence">
                {transitError ?? "Loading the Metlink anomaly layer…"}
              </p>
            )
          ) : selectedSignal ? (
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
          ) : (
            <p className="empty-evidence">Select a signal to inspect its evidence.</p>
          )}

          <div className="signal-list" aria-label="Signals and cameras">
            <p className="list-group">Movement signals ({filteredSignals.length})</p>
            {filteredSignals.map((feature) => (
              <button
                type="button"
                key={feature.id}
                className={focus === "signal" && feature.id === selectedSignal?.id ? "selected" : ""}
                onClick={() => {
                  setSelectedSignalId(feature.id);
                  setFocus("signal");
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
            <p className="list-group">Traffic cameras ({sortedCameras.length})</p>
            {sortedCameras.map((feature) => (
              <button
                type="button"
                key={feature.id}
                className={focus === "camera" && feature.id === selectedCamera?.id ? "selected" : ""}
                onClick={() => {
                  setSelectedCameraId(feature.id);
                  setFocus("camera");
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
            <p className="list-group">
              PT anomaly hotspots (top {listedTransit.length} of {transitFeatures.length})
            </p>
            {listedTransit.map((feature) => (
              <button
                type="button"
                key={feature.id}
                className={focus === "transit" && feature.id === selectedTransit?.id ? "selected" : ""}
                onClick={() => {
                  setSelectedTransitId(feature.id);
                  setFocus("transit");
                  revealOnMap(feature.geometry.coordinates);
                }}
              >
                <span>
                  <strong>{feature.properties.stop_name}</strong>
                  <small>
                    {feature.properties.modes
                      .map((mode) => mode.replace("_", " ").toLowerCase())
                      .join(" · ")}{" "}
                    · {feature.properties.high_count} high
                  </small>
                </span>
                <em className={feature.properties.severity_tier === "high" ? "transit-high" : "transit"}>
                  {feature.properties.anomaly_count}
                </em>
              </button>
            ))}
          </div>
          </div>
        </aside>
      </section>
    </div>
  );
}
