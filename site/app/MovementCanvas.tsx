"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type Coordinate = [number, number];
type LineFeature = {
  id: string;
  geometry: { type: "LineString"; coordinates: Coordinate[] };
  properties: Record<string, string | number | Record<string, string | number>>;
};
type FeatureCollection = { type: "FeatureCollection"; features: LineFeature[] };
type Filter = "all" | "people" | "vehicles";

const PEOPLE = new Set(["Pedestrian", "Cyclist", "E-scooter"]);

function drawMap(
  canvas: HTMLCanvasElement,
  coverage: LineFeature[],
  signals: LineFeature[],
  selectedId: string | null,
) {
  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(rect.width * ratio));
  canvas.height = Math.max(1, Math.floor(rect.height * ratio));
  const context = canvas.getContext("2d");
  if (!context || coverage.length === 0) return;
  context.scale(ratio, ratio);
  const width = rect.width;
  const height = rect.height;
  context.clearRect(0, 0, width, height);

  const coordinates = coverage.flatMap((feature) => feature.geometry.coordinates);
  const longitudes = coordinates.map(([longitude]) => longitude);
  const latitudes = coordinates.map(([, latitude]) => latitude);
  const bounds = {
    west: Math.min(...longitudes),
    east: Math.max(...longitudes),
    south: Math.min(...latitudes),
    north: Math.max(...latitudes),
  };
  const padding = 28;
  const project = ([longitude, latitude]: Coordinate): Coordinate => [
    padding + ((longitude - bounds.west) / (bounds.east - bounds.west)) * (width - padding * 2),
    height - padding - ((latitude - bounds.south) / (bounds.north - bounds.south)) * (height - padding * 2),
  ];

  context.strokeStyle = "rgba(70, 111, 124, 0.22)";
  context.lineWidth = 1;
  for (const feature of coverage) {
    const [start, end] = feature.geometry.coordinates.map(project);
    context.beginPath();
    context.moveTo(...start);
    context.lineTo(...end);
    context.stroke();
  }

  for (const feature of signals) {
    const [start, rawEnd] = feature.geometry.coordinates.map(project);
    const dx = rawEnd[0] - start[0];
    const dy = rawEnd[1] - start[1];
    const length = Math.hypot(dx, dy) || 1;
    const end: Coordinate = length < 9
      ? [start[0] + (dx / length) * 9, start[1] + (dy / length) * 9]
      : rawEnd;
    const isSelected = feature.id === selectedId;
    const decreasing = feature.properties.change_direction === "decrease";
    context.strokeStyle = decreasing ? "#C75845" : "#D78916";
    context.lineWidth = isSelected ? 6 : 3.5;
    context.lineCap = "round";
    context.beginPath();
    context.moveTo(...start);
    context.lineTo(...end);
    context.stroke();
    context.fillStyle = isSelected ? "#102A33" : context.strokeStyle;
    context.beginPath();
    context.arc(start[0], start[1], isSelected ? 5 : 3.5, 0, Math.PI * 2);
    context.fill();
  }
}

export default function MovementCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const [coverage, setCoverage] = useState<LineFeature[]>([]);
  const [signals, setSignals] = useState<LineFeature[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      fetch("/cop/v1/countline-coverage.geojson").then((response) => response.json()),
      fetch("/cop/v1/movement-signals.geojson").then((response) => response.json()),
    ])
      .then(([coverageData, signalData]: FeatureCollection[]) => {
        setCoverage(coverageData.features);
        setSignals(signalData.features);
        setSelectedId(signalData.features[0]?.id ?? null);
      })
      .catch(() => setError("The replay files could not be loaded. Check the COP feed."));
  }, []);

  const filteredSignals = useMemo(() => signals.filter((feature) => {
    const mode = String(feature.properties.transport_class);
    if (filter === "people") return PEOPLE.has(mode);
    if (filter === "vehicles") return !PEOPLE.has(mode);
    return true;
  }), [signals, filter]);

  const selected = signals.find((feature) => feature.id === selectedId) ?? filteredSignals[0];

  useEffect(() => {
    const canvas = canvasRef.current;
    const frame = frameRef.current;
    if (!canvas || !frame) return;
    const render = () => drawMap(canvas, coverage, filteredSignals, selected?.id ?? null);
    const observer = new ResizeObserver(render);
    observer.observe(frame);
    render();
    return () => observer.disconnect();
  }, [coverage, filteredSignals, selected]);

  return (
    <section className="investigation-frame" aria-labelledby="map-heading">
      <div className="map-column">
        <div className="map-toolbar">
          <div>
            <p className="eyebrow">12:00 · Thursday 6 August 2026</p>
            <h2 id="map-heading">Countline change field</h2>
          </div>
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
        </div>
        <div className="map-stage" ref={frameRef}>
          <canvas
            ref={canvasRef}
            role="img"
            aria-label={`${filteredSignals.length} unusual movement changes across 414 WCC countlines`}
          />
          <div className="map-key" aria-hidden="true">
            <span><i className="increase" />Increase</span>
            <span><i className="decrease" />Decrease</span>
            <span><i className="coverage" />Sensor coverage</span>
          </div>
          {coverage.length === 0 && !error ? <p className="map-message">Loading countlines…</p> : null}
          {error ? <p className="map-message error" role="alert">{error}</p> : null}
        </div>
        <p className="map-caption">
          Geometry is the WCC sensor countline itself. It does not imply the whole
          surrounding street or suburb changed.
        </p>
      </div>

      <aside className="evidence-column" aria-label="Signal evidence">
        {selected ? (
          <div className="selected-evidence">
            <div className="evidence-heading">
              <span className={`direction-chip ${selected.properties.change_direction}`}>
                {String(selected.properties.change_direction)}
              </span>
              <span>Investigate</span>
            </div>
            <h3>{String(selected.properties.name)}</h3>
            <p>{String(selected.properties.transport_class)} · {String(selected.properties.direction)}</p>
            <div className="count-comparison">
              <div><span>Observed</span><strong>{Number(selected.properties.observed_count).toLocaleString("en-NZ")}</strong></div>
              <div><span>Expected</span><strong>{Number(selected.properties.expected_count).toLocaleString("en-NZ")}</strong></div>
            </div>
            <dl className="evidence-metrics">
              <div><dt>Robust score</dt><dd>{Number(selected.properties.robust_z).toFixed(1)} z</dd></div>
              <div><dt>History</dt><dd>{Number((selected.properties.signal_confidence as Record<string, number>).history_samples)} matched hours</dd></div>
              <div><dt>Baseline confidence</dt><dd>{String((selected.properties.signal_confidence as Record<string, string>).level)}</dd></div>
            </dl>
            <p className="evidence-note">No cause inferred. Check operational context before acting.</p>
          </div>
        ) : <p className="empty-evidence">Select a signal to inspect its evidence.</p>}

        <div className="signal-list" aria-label={`${filteredSignals.length} filtered signals`}>
          {filteredSignals.map((feature) => (
            <button
              type="button"
              key={feature.id}
              className={feature.id === selected?.id ? "selected" : ""}
              onClick={() => setSelectedId(feature.id)}
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
    </section>
  );
}
