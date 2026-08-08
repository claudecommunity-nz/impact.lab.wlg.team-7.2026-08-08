"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import {
  type CameraCollection,
  type CameraFeature,
  type LineCollection,
  type LineFeature,
  createProjector,
  drawCameras,
  drawCoverage,
  drawSignals,
  prepareCanvas,
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
  const listedCameras = cameraScope === "frame" ? onFrameCameras : cameraFeatures;

  const selectedSignal =
    signals.find((feature) => feature.id === selectedSignalId) ?? filteredSignals[0];
  const selectedCamera: CameraFeature | undefined =
    cameraFeatures.find((feature) => feature.id === selectedCameraId) ?? listedCameras[0];

  useEffect(() => {
    const canvas = canvasRef.current;
    const frame = frameRef.current;
    if (!canvas || !frame) return;

    const render = () => {
      const surface = prepareCanvas(canvas);
      if (!surface) return;
      const project = createProjector(coverage, surface.width, surface.height);
      if (!project) return;
      drawCoverage(surface.context, project, coverage);
      if (source === "cameras") {
        drawCameras(surface.context, project, cameraFeatures, selectedCamera?.id ?? null);
      } else {
        drawSignals(surface.context, project, filteredSignals, selectedSignal?.id ?? null);
      }
    };

    const observer = new ResizeObserver(render);
    observer.observe(frame);
    render();
    return () => observer.disconnect();
  }, [coverage, source, filteredSignals, selectedSignal, cameraFeatures, selectedCamera]);

  const showingCameras = source === "cameras";
  const frameSrc = selectedCamera
    ? `${selectedCamera.properties.image_url}?frame=${frameNonce}`
    : null;
  const frameFailed = frameSrc !== null && frameSrc === failedFrame;
  const offFrameCount = cameraFeatures.length - onFrameCameras.length;

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
              role="img"
              aria-label={
                showingCameras
                  ? `${onFrameCameras.length} NZTA traffic cameras inside the WCC countline frame`
                  : `${filteredSignals.length} unusual movement changes across 414 WCC countlines`
              }
            />
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
              ? `Same projection as the countline layer. ${offFrameCount} Wellington-region cameras sit outside it and are published in the feed but not drawn.`
              : "Geometry is the WCC sensor countline itself. It does not imply the whole surrounding street or suburb changed."}
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
                  Open this camera on NZTA Journeys
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
                  onClick={() => setSelectedCameraId(feature.id)}
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
                  onClick={() => setSelectedSignalId(feature.id)}
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
