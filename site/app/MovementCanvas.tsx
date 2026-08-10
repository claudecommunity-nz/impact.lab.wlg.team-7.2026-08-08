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
  type Cluster,
  type Coordinate,
  type LineCollection,
  type LineFeature,
  type MapView,
  type RoadCollection,
  type RoadFeature,
  type TransitCollection,
  type TransitFeature,
  DEFAULT_VIEW,
  MAX_ZOOM,
  MIN_ZOOM,
  PEOPLE_CLASSES,
  boundsOfLines,
  boundsOfPoints,
  clusterPoints,
  clusterRadius,
  createProjector,
  drawCameras,
  drawClusters,
  drawCoverage,
  drawRoads,
  drawSignals,
  drawTiles,
  drawTransit,
  fitView,
  glyphScale,
  panView,
  pickNearest,
  prepareCanvas,
  unionBounds,
  zoomAround,
} from "./map-draw";

type Filter = "all" | "people" | "vehicles";
type LayerId = "signals" | "coverage" | "cameras" | "transit" | "roads";
type Layers = Record<LayerId, boolean>;
type Focus = "signal" | "camera" | "transit" | "road";
type Hover = { kind: Focus; id: string; left: number; top: number; above: boolean };

const POPUP_WIDTH = 248;
const HOVER_REFRESH_MS = 15_000;
const TRANSIT_LIST_LIMIT = 30;
const ROAD_LIST_LIMIT = 30;
/* Points whose projected positions land within one cell merge into a density
 * bubble; zooming in grows the screen distances and dissolves the bubbles. */
const CLUSTER_CELL = 34;
const SEARCH_LIMIT = 8;

/* The evidence column slides away rather than disappearing, so the map can grow
 * to the full frame when someone is scanning rather than investigating. */
const evidenceStore = createFlagStore("murmur.evidence.open", true);
/* Same remembered-flag pattern for the floating layer menu. */
const layerMenuStore = createFlagStore("murmur.layers.open", true);

/** Every layer states its temporal truth as a badge: live, replay, synthetic or real. */
const LAYERS: {
  id: LayerId;
  label: string;
  publisher: string;
  badge: string;
  tone: "live" | "replay" | "synthetic" | "real";
}[] = [
  { id: "signals", label: "Movement signals", publisher: "WCC countlines", badge: "Batch replay", tone: "replay" },
  { id: "coverage", label: "Sensor coverage", publisher: "WCC countlines", badge: "Batch replay", tone: "replay" },
  { id: "cameras", label: "Traffic cameras", publisher: "NZTA", badge: "Live", tone: "live" },
  { id: "transit", label: "Public transport", publisher: "Metlink", badge: "Synthetic", tone: "synthetic" },
  { id: "roads", label: "State highways", publisher: "NZTA", badge: "Real · Apr 2026", tone: "real" },
];

type SearchHit = { kind: Focus; id: string; label: string; detail: string; coordinate: Coordinate };

export default function MovementCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const [layers, setLayers] = useState<Layers>({
    signals: true,
    coverage: true,
    cameras: true,
    transit: true,
    roads: true,
  });
  const [coverage, setCoverage] = useState<LineFeature[]>([]);
  const [signals, setSignals] = useState<LineFeature[]>([]);
  const [cameras, setCameras] = useState<CameraCollection | null>(null);
  const [transit, setTransit] = useState<TransitCollection | null>(null);
  const [roads, setRoads] = useState<RoadCollection | null>(null);
  const [selectedSignalId, setSelectedSignalId] = useState<string | null>(null);
  const [selectedCameraId, setSelectedCameraId] = useState<string | null>(null);
  const [selectedTransitId, setSelectedTransitId] = useState<string | null>(null);
  const [selectedRoadId, setSelectedRoadId] = useState<string | null>(null);
  const [focus, setFocus] = useState<Focus>("signal");
  const [filter, setFilter] = useState<Filter>("all");
  const [error, setError] = useState<string | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [transitError, setTransitError] = useState<string | null>(null);
  const [roadError, setRoadError] = useState<string | null>(null);
  const [frameNonce, setFrameNonce] = useState(0);
  // Remember which frame URL failed, so selecting another camera or refreshing
  // clears the failure without an effect.
  const [failedFrame, setFailedFrame] = useState<string | null>(null);
  const [view, setView] = useState<MapView>(DEFAULT_VIEW);
  // Hover stores the popup position at pick time; every view change clears it,
  // so the stored screen coordinates never go stale.
  const [hover, setHover] = useState<Hover | null>(null);
  const [hoverTick, setHoverTick] = useState(0);
  const [overCluster, setOverCluster] = useState(false);
  const [search, setSearch] = useState("");
  const [locateNote, setLocateNote] = useState<string | null>(null);
  // The canvas is redrawn imperatively, so tile loads and resizes can call the
  // latest draw closure without re-running an effect.
  const drawRef = useRef<() => void>(() => {});
  const dragRef = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  // The view auto-fits the coverage frame to the canvas until the user takes
  // over (pan, zoom, locate, reveal) — then their framing wins, resize included.
  const autoFitRef = useRef(true);
  const autoFitFnRef = useRef<() => void>(() => {});
  const evidenceOpen =
    useSyncExternalStore(
      evidenceStore.subscribe,
      evidenceStore.snapshot,
      evidenceStore.serverSnapshot,
    ) === "1";
  const menuOpen =
    useSyncExternalStore(
      layerMenuStore.subscribe,
      layerMenuStore.snapshot,
      layerMenuStore.serverSnapshot,
    ) === "1";

  const stageSize = useCallback(() => {
    const rect = canvasRef.current?.getBoundingClientRect();
    return rect && rect.width > 0 ? { width: rect.width, height: rect.height } : null;
  }, []);

  // Auto-fit: the largest whole zoom that frames the countline coverage in
  // this canvas. Runs when the coverage arrives and again on every resize.
  const autoFit = useCallback(
    (features: LineFeature[]) => {
      if (!autoFitRef.current) return;
      const size = stageSize();
      if (!size) return;
      const bounds = boundsOfLines(features);
      if (!bounds) return;
      setView(fitView(bounds, size.width, size.height));
    },
    [stageSize],
  );

  useEffect(() => {
    Promise.all([
      fetch("/cop/v1/countline-coverage.geojson").then((response) => response.json()),
      fetch("/cop/v1/movement-signals.geojson").then((response) => response.json()),
    ])
      .then(([coverageData, signalData]: LineCollection[]) => {
        setCoverage(coverageData.features);
        setSignals(signalData.features);
        setSelectedSignalId(signalData.features[0]?.id ?? null);
        autoFit(coverageData.features);
      })
      .catch(() => setError("The replay files could not be loaded. Check the COP feed."));
  }, [autoFit]);

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

  useEffect(() => {
    fetch("/cop/v1/road-anomalies.geojson")
      .then((response) => response.json())
      .then((collection: RoadCollection) => {
        setRoads(collection);
        setSelectedRoadId(collection.features[0]?.id ?? null);
      })
      .catch(() => setRoadError("The state-highway layer could not be loaded."));
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

  // Sorted by |robust_z| in the artifact, so the top slice is the worst sites.
  const roadFeatures = useMemo(() => roads?.features ?? [], [roads]);
  const listedRoads = useMemo(
    () => roadFeatures.slice(0, ROAD_LIST_LIMIT),
    [roadFeatures],
  );

  const selectedSignal =
    signals.find((feature) => feature.id === selectedSignalId) ?? filteredSignals[0];
  const selectedCamera: CameraFeature | undefined =
    cameraFeatures.find((feature) => feature.id === selectedCameraId) ?? sortedCameras[0];
  const selectedTransit: TransitFeature | undefined =
    transitFeatures.find((feature) => feature.id === selectedTransitId) ?? transitFeatures[0];
  const selectedRoad: RoadFeature | undefined =
    roadFeatures.find((feature) => feature.id === selectedRoadId) ?? roadFeatures[0];

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
  const hoveredRoad =
    hover?.kind === "road"
      ? roadFeatures.find((feature) => feature.id === hover.id)
      : undefined;

  /* The investigate panel follows the pointer: hovering any glyph previews its
   * evidence, and the pinned selection returns when the pointer leaves. */
  const panelFocus: Focus = hover?.kind ?? focus;
  const panelSignal = hoveredSignal ?? selectedSignal;
  const panelCamera = hoveredCamera ?? selectedCamera;
  const panelTransit = hoveredTransit ?? selectedTransit;
  const panelRoad = hoveredRoad ?? selectedRoad;
  const previewing = Boolean(hoveredSignal || hoveredCamera || hoveredTransit || hoveredRoad);

  /** Per-frame screen-space clustering of the three point layers. */
  const clusterLayers = (width: number, height: number) => {
    const project = createProjector(view, width, height);
    const split = <T,>(features: T[], anchor: (feature: T) => Coordinate, on: boolean) => {
      if (!on) return { singles: [] as T[], clusters: [] as Cluster<T>[] };
      const cells = clusterPoints(features, anchor, project, CLUSTER_CELL);
      return {
        singles: cells.filter((cell) => cell.members.length === 1).map((cell) => cell.members[0]),
        clusters: cells.filter((cell) => cell.members.length > 1),
      };
    };
    return {
      cameras: split(cameraFeatures, (feature) => feature.geometry.coordinates, layers.cameras),
      transit: split(transitFeatures, (feature) => feature.geometry.coordinates, layers.transit),
      roads: split(roadFeatures, (feature) => feature.geometry.coordinates, layers.roads),
    };
  };

  // Redraw after every render, and hand the same closure to tile loads and resizes.
  useEffect(() => {
    drawRef.current = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const surface = prepareCanvas(canvas);
      if (!surface) return;
      drawTiles(surface.context, view, surface.width, surface.height, () => drawRef.current());
      const project = createProjector(view, surface.width, surface.height);
      const scale = glyphScale(view.zoom);
      const groups = clusterLayers(surface.width, surface.height);
      if (layers.coverage) drawCoverage(surface.context, project, coverage);
      if (layers.roads) {
        drawRoads(
          surface.context,
          project,
          groups.roads.singles,
          selectedRoad?.id ?? null,
          hover?.kind === "road" ? hover.id : null,
          scale,
        );
        drawClusters(surface.context, groups.roads.clusters, "#5B4A8A");
      }
      if (layers.transit) {
        drawTransit(
          surface.context,
          project,
          groups.transit.singles,
          selectedTransit?.id ?? null,
          hover?.kind === "transit" ? hover.id : null,
          scale,
        );
        drawClusters(surface.context, groups.transit.clusters, "#2B5CAD");
      }
      if (layers.signals) {
        drawSignals(
          surface.context,
          project,
          filteredSignals,
          selectedSignal?.id ?? null,
          hover?.kind === "signal" ? hover.id : null,
          scale,
        );
      }
      if (layers.cameras) {
        drawCameras(
          surface.context,
          project,
          groups.cameras.singles,
          selectedCamera?.id ?? null,
          hover?.kind === "camera" ? hover.id : null,
          scale,
        );
        drawClusters(surface.context, groups.cameras.clusters, "#0B6B3A");
      }
    };
    drawRef.current();
  });

  useEffect(() => {
    autoFitFnRef.current = () => autoFit(coverage);
  });

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const observer = new ResizeObserver(() => {
      autoFitFnRef.current();
      drawRef.current();
    });
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
      autoFitRef.current = false;
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
    autoFitRef.current = false;
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
      layers.roads ? boundsOfPoints(roadFeatures) : null,
    );
    if (!bounds) return;
    autoFitRef.current = false;
    setHover(null);
    setView(fitView(bounds, size.width, size.height));
  }, [stageSize, layers, coverage, cameraFeatures, transitFeatures, roadFeatures]);

  const toggleLayer = (id: LayerId) => {
    setHover(null);
    setLayers((current) => ({ ...current, [id]: !current[id] }));
  };

  /** Selecting from the list recentres the map only when the feature is off screen. */
  const revealOnMap = (coordinate: Coordinate) => {
    const size = stageSize();
    if (!size) return;
    autoFitRef.current = false;
    setHover(null);
    setView((current) => {
      const [x, y] = createProjector(current, size.width, size.height)(coordinate);
      const margin = 40;
      const visible =
        x >= margin && x <= size.width - margin && y >= margin && y <= size.height - margin;
      return visible ? current : { ...current, centerLon: coordinate[0], centerLat: coordinate[1] };
    });
  };

  // Search covers what the map holds: signal, camera, stop and highway names.
  const searchHits = useMemo<SearchHit[]>(() => {
    const query = search.trim().toLowerCase();
    if (query.length < 2) return [];
    const hits: SearchHit[] = [];
    for (const feature of signals) {
      if (String(feature.properties.name).toLowerCase().includes(query)) {
        hits.push({
          kind: "signal",
          id: feature.id,
          label: String(feature.properties.name),
          detail: `Signal · ${String(feature.properties.transport_class)}`,
          coordinate: feature.geometry.coordinates[0],
        });
      }
    }
    for (const feature of cameraFeatures) {
      if (feature.properties.name.toLowerCase().includes(query)) {
        hits.push({
          kind: "camera",
          id: feature.id,
          label: feature.properties.name,
          detail: "NZTA camera",
          coordinate: feature.geometry.coordinates,
        });
      }
    }
    for (const feature of transitFeatures) {
      if (feature.properties.stop_name.toLowerCase().includes(query)) {
        hits.push({
          kind: "transit",
          id: feature.id,
          label: feature.properties.stop_name,
          detail: "PT hotspot",
          coordinate: feature.geometry.coordinates,
        });
      }
    }
    for (const feature of roadFeatures) {
      if (feature.properties.site_name.toLowerCase().includes(query)) {
        hits.push({
          kind: "road",
          id: feature.id,
          label: feature.properties.site_name,
          detail: `SH${feature.properties.state_highway}`,
          coordinate: feature.geometry.coordinates,
        });
      }
    }
    return hits.slice(0, SEARCH_LIMIT);
  }, [search, signals, cameraFeatures, transitFeatures, roadFeatures]);

  const pickSearchHit = (hit: SearchHit) => {
    if (hit.kind === "camera") setSelectedCameraId(hit.id);
    else if (hit.kind === "transit") setSelectedTransitId(hit.id);
    else if (hit.kind === "road") setSelectedRoadId(hit.id);
    else setSelectedSignalId(hit.id);
    setFocus(hit.kind);
    setSearch("");
    revealOnMap(hit.coordinate);
  };

  const locateMe = () => {
    if (!("geolocation" in navigator)) {
      setLocateNote("No location support in this browser.");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLocateNote(null);
        autoFitRef.current = false;
        setHover(null);
        setView((current) => ({
          centerLon: position.coords.longitude,
          centerLat: position.coords.latitude,
          zoom: Math.max(current.zoom, 14),
        }));
      },
      () => setLocateNote("Location blocked or unavailable."),
    );
  };

  /** Cameras sit on top of the line layers, so they win the hit test. Only
   * individually drawn glyphs are pickable — clustered points are reached by
   * zooming their bubble. */
  const featureAt = (point: Coordinate, size: { width: number; height: number }): Hover | null => {
    const project = createProjector(view, size.width, size.height);
    const groups = clusterLayers(size.width, size.height);
    const place = (kind: Focus, id: string, [x, y]: Coordinate): Hover => ({
      kind,
      id,
      left: Math.min(Math.max(x - POPUP_WIDTH / 2, 8), Math.max(8, size.width - POPUP_WIDTH - 8)),
      top: y,
      above: y > (kind === "camera" ? 264 : 120),
    });
    if (layers.cameras) {
      const hit = pickNearest(groups.cameras.singles, (feature) => feature.geometry.coordinates, project, point);
      if (hit) return place("camera", hit.id, project(hit.geometry.coordinates));
    }
    if (layers.signals) {
      const hit = pickNearest(filteredSignals, (feature) => feature.geometry.coordinates[0], project, point);
      if (hit) return place("signal", hit.id, project(hit.geometry.coordinates[0]));
    }
    if (layers.transit) {
      const hit = pickNearest(groups.transit.singles, (feature) => feature.geometry.coordinates, project, point);
      if (hit) return place("transit", hit.id, project(hit.geometry.coordinates));
    }
    if (layers.roads) {
      const hit = pickNearest(groups.roads.singles, (feature) => feature.geometry.coordinates, project, point);
      if (hit) return place("road", hit.id, project(hit.geometry.coordinates));
    }
    return null;
  };

  /** Density bubble under the pointer, if any — clicking it zooms in a level. */
  const clusterAt = (point: Coordinate, size: { width: number; height: number }) => {
    const groups = clusterLayers(size.width, size.height);
    for (const clusters of [groups.cameras.clusters, groups.transit.clusters, groups.roads.clusters]) {
      for (const cluster of clusters) {
        const distance = Math.hypot(cluster.x - point[0], cluster.y - point[1]);
        if (distance <= clusterRadius(cluster.members.length) + 2) return cluster;
      }
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
      autoFitRef.current = false;
      drag.x = event.clientX;
      drag.y = event.clientY;
      setView((current) => panView(current, -dx, -dy));
      return;
    }
    const size = stageSize();
    if (!size) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const point: Coordinate = [event.clientX - rect.left, event.clientY - rect.top];
    const next = featureAt(point, size);
    setHover((current) =>
      current?.kind === next?.kind && current?.id === next?.id ? current : next,
    );
    const cluster = next ? null : clusterAt(point, size);
    setOverCluster((current) => (current === Boolean(cluster) ? current : Boolean(cluster)));
  };

  // A press that never moved is a click: select the nearest feature under it,
  // or zoom into the density bubble under it.
  const handlePointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    const size = stageSize();
    if (!drag || drag.moved || !size) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const point: Coordinate = [event.clientX - rect.left, event.clientY - rect.top];
    const hit = featureAt(point, size);
    if (!hit) {
      const cluster = clusterAt(point, size);
      if (cluster) {
        autoFitRef.current = false;
        setHover(null);
        setView((current) => zoomAround(current, 1, [cluster.x, cluster.y], size.width, size.height));
      }
      return;
    }
    if (hit.kind === "camera") {
      setSelectedCameraId(hit.id);
      setFocus("camera");
    } else if (hit.kind === "transit") {
      setSelectedTransitId(hit.id);
      setFocus("transit");
    } else if (hit.kind === "road") {
      setSelectedRoadId(hit.id);
      setFocus("road");
    } else {
      setSelectedSignalId(hit.id);
      setFocus("signal");
    }
  };

  const frameSrc = panelCamera
    ? `${panelCamera.properties.image_url}?frame=${frameNonce}`
    : null;
  const frameFailed = frameSrc !== null && frameSrc === failedFrame;

  const layerSummary =
    [
      layers.signals ? `${filteredSignals.length} movement signals` : null,
      layers.coverage ? "414 countlines of sensor coverage" : null,
      layers.cameras ? `${cameraFeatures.length} NZTA traffic cameras` : null,
      layers.transit ? `${transitFeatures.length} Metlink anomaly hotspots` : null,
      layers.roads ? `${roadFeatures.length} state highway anomaly sites` : null,
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
          <h2 id="map-heading" className="visually-hidden">
            One map, every source
          </h2>
          <div className="map-stage" ref={frameRef}>
            <canvas
              ref={canvasRef}
              className="map-canvas"
              style={hover || overCluster ? { cursor: "pointer" } : undefined}
              role="img"
              aria-label={`Map of Wellington showing ${layerSummary}. Drag to pan, use the zoom buttons to change scale.`}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={() => { dragRef.current = null; }}
              onPointerLeave={() => setHover(null)}
            />
            <button
              type="button"
              className="evidence-toggle"
              onClick={() => evidenceStore.toggle(evidenceOpen)}
              aria-expanded={evidenceOpen}
              aria-controls="evidence-panel"
              aria-label={evidenceOpen ? "Hide investigate panel" : "Show investigate panel"}
              title={evidenceOpen ? "Hide investigate panel" : "Show investigate panel"}
            >
              <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
                <rect x="1.2" y="2.2" width="13.6" height="11.6" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.5" />
                <line x1="6.2" y1="2.2" x2="6.2" y2="13.8" stroke="currentColor" strokeWidth="1.5" />
                {evidenceOpen ? <rect x="1.2" y="2.2" width="5" height="11.6" rx="1.4" fill="currentColor" /> : null}
              </svg>
            </button>
            <section className={`layer-drawer ${menuOpen ? "" : "closed"}`} aria-label="Layers and filters">
              {menuOpen ? (
                <>
                  <div className="drawer-head">
                    <p className="drawer-title">Layers</p>
                    <button
                      type="button"
                      className="drawer-toggle"
                      onClick={() => layerMenuStore.toggle(menuOpen)}
                      aria-expanded
                      aria-controls="layer-menu-body"
                      aria-label="Hide the layer menu"
                      title="Hide the layer menu"
                    >
                      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                        <path d="M3 10l5-5 5 5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </button>
                  </div>
                  <div id="layer-menu-body" className="drawer-body">
                    <form className="map-search" role="search" onSubmit={(event) => event.preventDefault()}>
                      <label className="visually-hidden" htmlFor="map-search-input">
                        Find on the map
                      </label>
                      <input
                        id="map-search-input"
                        value={search}
                        onChange={(event) => setSearch(event.target.value)}
                        placeholder="Find a street, stop or site"
                        autoComplete="off"
                      />
                      <button
                        type="button"
                        className="locate"
                        onClick={locateMe}
                        aria-label="Centre on my location"
                        title="Centre on my location"
                      >
                        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                          <circle cx="8" cy="8" r="2.4" fill="currentColor" />
                          <circle cx="8" cy="8" r="5.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
                          <path d="M8 0.4v2.2M8 13.4v2.2M0.4 8h2.2M13.4 8h2.2" stroke="currentColor" strokeWidth="1.4" />
                        </svg>
                      </button>
                    </form>
                    {searchHits.length > 0 ? (
                      <ul className="search-results">
                        {searchHits.map((hit) => (
                          <li key={`${hit.kind}:${hit.id}`}>
                            <button type="button" onClick={() => pickSearchHit(hit)}>
                              <strong>{hit.label}</strong>
                              <small>{hit.detail}</small>
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : search.trim().length >= 2 ? (
                      <p className="search-note">No match in the loaded layers.</p>
                    ) : null}
                    {locateNote ? <p className="search-note">{locateNote}</p> : null}
                    <div className="layer-toggles" role="group" aria-label="Map layers">
                      {LAYERS.map((entry) => (
                        <button
                          type="button"
                          key={entry.id}
                          className={`layer-chip ${layers[entry.id] ? "on" : "off"}`}
                          aria-pressed={layers[entry.id]}
                          onClick={() => toggleLayer(entry.id)}
                        >
                          <i className={`swatch ${entry.id}`} aria-hidden="true" />
                          <span className="chip-text">
                            <strong>{entry.label}</strong>
                            <small>{entry.publisher}</small>
                          </span>
                          <em className={`status-badge ${entry.tone}`}>{entry.badge}</em>
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
                </>
              ) : (
                <button
                  type="button"
                  className="drawer-toggle closed"
                  onClick={() => layerMenuStore.toggle(menuOpen)}
                  aria-expanded={false}
                  aria-label="Show the layer menu"
                  title="Show the layer menu"
                >
                  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
                    <path d="M8 1.6 14.4 5 8 8.4 1.6 5Z" fill="currentColor" />
                    <path d="M2.2 8 8 11l5.8-3M2.2 11 8 14l5.8-3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              )}
            </section>
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
              <button
                type="button"
                className="fit"
                onClick={fitLayers}
                aria-label="Fit the active layers"
                title="Fit the active layers"
              >
                <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
                  <circle cx="8" cy="8" r="3" fill="none" stroke="currentColor" strokeWidth="1.5" />
                  <path d="M8 0.6v2.6M8 12.8v2.6M0.6 8h2.6M12.8 8h2.6" stroke="currentColor" strokeWidth="1.5" />
                </svg>
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
              {layers.roads ? (
                <>
                  <span><i className="road" />Highway drop</span>
                  <span><i className="road-high" />High severity</span>
                </>
              ) : null}
            </div>
            {hover && (hoveredCamera || hoveredSignal || hoveredTransit || hoveredRoad) ? (
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
                        refreshed every few minutes
                      </span>
                    </p>
                  </>
                ) : hoveredSignal ? (
                  <p>
                    <strong>{String(hoveredSignal.properties.name)}</strong>
                    <span>
                      {String(hoveredSignal.properties.transport_class)} ·{" "}
                      {String(hoveredSignal.properties.direction)} ·{" "}
                      {String(hoveredSignal.properties.change_direction)}{" "}
                      {hoveredSignal.properties.change_direction === "decrease" ? "↓" : "↑"}
                    </span>
                    <span>
                      {Number(hoveredSignal.properties.observed_count).toLocaleString("en-NZ")}{" "}
                      observed vs{" "}
                      {Number(hoveredSignal.properties.expected_count).toLocaleString("en-NZ")}{" "}
                      expected (
                      {(() => {
                        const delta = Math.round(
                          Number(hoveredSignal.properties.observed_count) -
                            Number(hoveredSignal.properties.expected_count),
                        );
                        return `${delta > 0 ? "+" : ""}${delta.toLocaleString("en-NZ")}`;
                      })()}
                      )
                    </span>
                    <span>
                      {Number(hoveredSignal.properties.robust_z) > 0 ? "+" : ""}
                      {Number(hoveredSignal.properties.robust_z).toFixed(1)} robust deviations ·
                      investigate
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
                ) : hoveredRoad ? (
                  <p>
                    <strong>{hoveredRoad.properties.site_name}</strong>
                    <span>
                      SH{hoveredRoad.properties.state_highway} ·{" "}
                      {hoveredRoad.properties.ratio.toFixed(2)}× usual ·{" "}
                      {hoveredRoad.properties.date} · real event
                    </span>
                  </p>
                ) : null}
              </div>
            ) : null}
            {coverage.length === 0 && !error ? <p className="map-message">Loading countlines…</p> : null}
            {error ? <p className="map-message error" role="alert">{error}</p> : null}
          </div>
          <p className="map-caption">
            Signals mark the sensor line, not the street. Transit: synthetic
            Metlink replay. Highways: real April 2026 flood backtest.
          </p>
        </div>

        {/* Sits left of the map via CSS `order`; the DOM keeps the map first so
            the primary content is still what a screen reader reaches first. */}
        <aside
          className="evidence-column"
          id="evidence-panel"
          aria-label={
            panelFocus === "camera"
              ? "Camera evidence"
              : panelFocus === "transit"
                ? "Public transport evidence"
                : panelFocus === "road"
                  ? "State highway evidence"
                  : "Signal evidence"
          }
        >
          <div className="evidence-inner">
          {panelFocus === "camera" ? (
            panelCamera ? (
              <div className={`selected-evidence ${previewing ? "preview" : ""}`}>
                <div className="evidence-heading">
                  <span
                    className={`direction-chip ${
                      panelCamera.properties.within_countline_frame ? "on-frame" : "off-frame"
                    }`}
                  >
                    {panelCamera.properties.within_countline_frame ? "on frame" : "off frame"}
                  </span>
                  <span>Camera {panelCamera.properties.camera_id}</span>
                </div>
                <h3>{panelCamera.properties.name}</h3>
                <p>
                  {panelCamera.properties.direction || "Direction not published"} ·{" "}
                  {panelCamera.properties.region}
                </p>
                <figure className="camera-frame">
                  {frameSrc && !frameFailed ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={frameSrc}
                      alt={`Most recent NZTA camera frame: ${panelCamera.properties.name}`}
                      referrerPolicy="no-referrer"
                      onError={() => setFailedFrame(frameSrc)}
                    />
                  ) : (
                    <p className="frame-missing">
                      No frame returned. The camera may be offline or NZTA unreachable.
                    </p>
                  )}
                  <figcaption>
                    Live from NZTA in your browser. Not stored or re-published here.
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
                      {panelCamera.geometry.coordinates[1].toFixed(4)},{" "}
                      {panelCamera.geometry.coordinates[0].toFixed(4)}
                    </dd>
                  </div>
                  <div>
                    <dt>Catalogue status</dt>
                    <dd>{panelCamera.properties.offline ? "offline" : "online"}</dd>
                  </div>
                </dl>
                <a
                  className="camera-link"
                  href={panelCamera.properties.view_url}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open this camera on NZTA Journeys{" "}
                  <span aria-hidden="true">→</span>
                  <span className="visually-hidden">(opens in new window)</span>
                </a>
                <p className="evidence-note">
                  Snapshot, not a count. Corroborates a countline signal.
                </p>
              </div>
            ) : (
              <p className="empty-evidence">
                {cameraError ?? "Loading the Wellington camera catalogue…"}
              </p>
            )
          ) : panelFocus === "transit" ? (
            panelTransit ? (
              <div className={`selected-evidence ${previewing ? "preview" : ""}`}>
                <div className="evidence-heading">
                  <span
                    className={`direction-chip ${
                      panelTransit.properties.severity_tier === "high"
                        ? "transit-high"
                        : "transit"
                    }`}
                  >
                    {panelTransit.properties.severity_tier === "high"
                      ? "dense high severity"
                      : "elevated"}
                  </span>
                  <span>Stop {panelTransit.properties.stop_id}</span>
                </div>
                <h3>{panelTransit.properties.stop_name}</h3>
                <p>
                  {panelTransit.properties.modes
                    .map((mode) => mode.replace("_", " ").toLowerCase())
                    .join(" · ")}{" "}
                  · synthetic April 2026 replay
                </p>
                <div className="count-comparison">
                  <div>
                    <span>Anomalies</span>
                    <strong>{panelTransit.properties.anomaly_count.toLocaleString("en-NZ")}</strong>
                  </div>
                  <div>
                    <span>High severity</span>
                    <strong>{panelTransit.properties.high_count.toLocaleString("en-NZ")}</strong>
                  </div>
                </div>
                <dl className="evidence-metrics">
                  <div>
                    <dt>Top detector</dt>
                    <dd>
                      {panelTransit.properties.top_detector} (
                      {panelTransit.properties.top_detector_count})
                    </dd>
                  </div>
                  <div>
                    <dt>Worst example</dt>
                    <dd>
                      {panelTransit.properties.worst_example.date} ·{" "}
                      {panelTransit.properties.worst_example.severity.toLowerCase()}
                    </dd>
                  </div>
                  <div>
                    <dt>Position</dt>
                    <dd>
                      {panelTransit.geometry.coordinates[1].toFixed(4)},{" "}
                      {panelTransit.geometry.coordinates[0].toFixed(4)}
                    </dd>
                  </div>
                </dl>
                <p className="worst-detail">{panelTransit.properties.worst_example.detail}</p>
                <p className="evidence-note">
                  Synthetic data: real timetable, simulated running, injected
                  anomalies. Not an actual event.
                </p>
              </div>
            ) : (
              <p className="empty-evidence">
                {transitError ?? "Loading the Metlink anomaly layer…"}
              </p>
            )
          ) : panelFocus === "road" ? (
            panelRoad ? (
              <div className={`selected-evidence ${previewing ? "preview" : ""}`}>
                <div className="evidence-heading">
                  <span
                    className={`direction-chip ${
                      panelRoad.properties.severity === "HIGH" ? "road-high" : "road"
                    }`}
                  >
                    {panelRoad.properties.severity.toLowerCase()}{" "}
                    {panelRoad.properties.direction.toLowerCase()}{" "}
                    <span aria-hidden="true">
                      {panelRoad.properties.direction === "DROP" ? "↓" : "↑"}
                    </span>
                  </span>
                  <span>Site {panelRoad.properties.site_ref}</span>
                </div>
                <h3>{panelRoad.properties.site_name}</h3>
                <p>
                  SH{panelRoad.properties.state_highway} ·{" "}
                  {panelRoad.properties.date} · real April 2026 flood event
                </p>
                <div className="count-comparison">
                  <div>
                    <span>Observed</span>
                    <strong>{panelRoad.properties.observed_count.toLocaleString("en-NZ")}</strong>
                  </div>
                  <div>
                    <span>Usual</span>
                    <strong>{panelRoad.properties.baseline_median.toLocaleString("en-NZ")}</strong>
                  </div>
                  <div>
                    <span>Change</span>
                    <strong
                      className={`delta ${
                        panelRoad.properties.direction === "DROP" ? "decrease" : "increase"
                      }`}
                    >
                      {(() => {
                        const delta =
                          panelRoad.properties.observed_count -
                          panelRoad.properties.baseline_median;
                        return `${delta > 0 ? "+" : ""}${delta.toLocaleString("en-NZ")}`;
                      })()}
                    </strong>
                  </div>
                </div>
                <dl className="evidence-metrics">
                  <div>
                    <dt>Ratio</dt>
                    <dd>{panelRoad.properties.ratio.toFixed(2)}× usual</dd>
                  </div>
                  <div title="How many robust standard deviations the day sits from the site's own weekday or weekend baseline">
                    <dt>Robust score</dt>
                    <dd>{panelRoad.properties.robust_z.toFixed(1)} z</dd>
                  </div>
                  <div>
                    <dt>Baseline</dt>
                    <dd>{panelRoad.properties.baseline_days} days</dd>
                  </div>
                  <div>
                    <dt>Position</dt>
                    <dd>
                      {panelRoad.geometry.coordinates[1].toFixed(4)},{" "}
                      {panelRoad.geometry.coordinates[0].toFixed(4)}
                    </dd>
                  </div>
                </dl>
                <p className="evidence-note">
                  Real NZTA daily counts, two-day lag. A flag is a statistical
                  change, not a diagnosed closure.
                </p>
              </div>
            ) : (
              <p className="empty-evidence">
                {roadError ?? "Loading the state-highway layer…"}
              </p>
            )
          ) : panelSignal ? (
            <div className={`selected-evidence ${previewing ? "preview" : ""}`}>
              <div className="evidence-heading">
                <span className={`direction-chip ${panelSignal.properties.change_direction}`}>
                  {String(panelSignal.properties.change_direction)}{" "}
                  <span aria-hidden="true">
                    {panelSignal.properties.change_direction === "decrease" ? "↓" : "↑"}
                  </span>
                </span>
                <span>Investigate</span>
              </div>
              <h3>{String(panelSignal.properties.name)}</h3>
              <p>{String(panelSignal.properties.transport_class)} · {String(panelSignal.properties.direction)}</p>
              <div className="count-comparison">
                <div><span>Observed</span><strong>{Number(panelSignal.properties.observed_count).toLocaleString("en-NZ")}</strong></div>
                <div><span>Expected</span><strong>{Number(panelSignal.properties.expected_count).toLocaleString("en-NZ")}</strong></div>
                <div>
                  <span>Change</span>
                  <strong className={`delta ${panelSignal.properties.change_direction}`}>
                    {(() => {
                      const delta = Math.round(
                        Number(panelSignal.properties.observed_count) -
                          Number(panelSignal.properties.expected_count),
                      );
                      return `${delta > 0 ? "+" : ""}${delta.toLocaleString("en-NZ")}`;
                    })()}
                  </strong>
                </div>
              </div>
              <dl className="evidence-metrics">
                <div title="How many robust standard deviations the hour sits from its matched weekday-and-hour baseline">
                  <dt>Robust score</dt>
                  <dd>{Number(panelSignal.properties.robust_z).toFixed(1)} z</dd>
                </div>
                <div><dt>History</dt><dd>{Number((panelSignal.properties.signal_confidence as Record<string, number>).history_samples)} matched hours</dd></div>
                <div><dt>Baseline confidence</dt><dd>{String((panelSignal.properties.signal_confidence as Record<string, string>).level)}</dd></div>
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
            <p className="list-group">
              State highway anomalies (worst {listedRoads.length} of {roadFeatures.length} · real)
            </p>
            {listedRoads.map((feature) => (
              <button
                type="button"
                key={feature.id}
                className={focus === "road" && feature.id === selectedRoad?.id ? "selected" : ""}
                onClick={() => {
                  setSelectedRoadId(feature.id);
                  setFocus("road");
                  revealOnMap(feature.geometry.coordinates);
                }}
              >
                <span>
                  <strong>{feature.properties.site_name}</strong>
                  <small>SH{feature.properties.state_highway} · {feature.properties.date}</small>
                </span>
                <em className={feature.properties.severity === "HIGH" ? "road-high" : "road"}>
                  {feature.properties.ratio.toFixed(2)}×
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
