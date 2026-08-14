"use client";

import {
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { createFlagStore } from "./flag-store";
import { matchAnalogue, matchPeriod, slotVectors } from "./analogue";
import {
  openReview,
  reviewSnapshot,
  serverReviewSnapshot,
  signalKey,
  subscribeReview,
} from "./review-store";
import {
  type CaseModel,
  type Filter,
  type Focus,
  type LayerId,
  type Layers,
  type SearchHit,
  EVENTS,
  buildAprilCaseModel,
  buildAugCaseModel,
  buildLiveSimCaseModel,
  compass,
  dayLabel,
  shortDate,
} from "./case-model";
import { DailyStrip, TrendSparkline } from "./EvidenceStrips";
import CaseCharts from "./CaseCharts";

import {
  type AprilMovementCollection,
  type CameraCollection,
  type CameraFeature,
  type Cluster,
  type Coordinate,
  type FlightCollection,
  type FlightFeature,
  type LineCollection,
  type LineFeature,
  type LiveSimCollection,
  type MapView,
  type RainCollection,
  type RainFeature,
  type ReplayCollection,
  type ReportCollection,
  type ReportFeature,
  type RoadCollection,
  type RoadFeature,
  type SignalTrendPoint,
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
  drawFlights,
  drawRain,
  drawReports,
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

type Hover = {
  kind: Focus;
  id: string;
  left: number;
  top: number;
  above: boolean;
  /** Beak position in px from the popup's left edge, aimed at the anchor. */
  beakX: number;
  /** Auto callouts render the narrow variant so they cover fewer records. */
  compact?: boolean;
};

const POPUP_WIDTH = 248;
/** Auto callouts use the narrow popup so they cover fewer records. */
const COMPACT_POPUP_WIDTH = 186;
const HOVER_REFRESH_MS = 15_000;
/* Once a glyph is hovered it stays hovered until the pointer leaves this
 * radius of its anchor — without the slack, overlapping glyphs trade the
 * popup back and forth on every pointer move and it reads as flicker. */
const HOVER_STICKY_PX = 18;
const TRANSIT_LIST_LIMIT = 30;
const ROAD_LIST_LIMIT = 30;
/* Points whose projected positions land within one cell merge into a density
 * bubble; zooming in grows the screen distances and dissolves the bubbles.
 * 16px ≈ one glyph, so only genuinely overlapping marks group — bubbles
 * dissolve a zoom level earlier than the previous 34px cell. */
const CLUSTER_CELL = 16;
const SEARCH_LIMIT = 8;
/* While the timeline moves, the hour's worst issue opens its own callout —
 * a warning/torrential gauge first, else a signal at or beyond this |z|. */
const AUTO_POPUP_Z = 8;

/* The evidence column slides away rather than disappearing, so the map can grow
 * to the full frame when someone is scanning rather than investigating. On a
 * small screen these three default closed: the first paint is the map alone,
 * every panel one icon tap away. */
const evidenceStore = createFlagStore("murmur.evidence.open", true, false);
/* Same remembered-flag pattern for the floating layer menu. */
const layerMenuStore = createFlagStore("murmur.layers.open", true, false);
/* And for the corner situation card, which folds away to an icon. */
const statusStore = createFlagStore("murmur.status.open", true, false);
/* Auto callouts during playback can be switched off from the timebar. */
const autoPopupStore = createFlagStore("murmur.autopopup.on", true);
/* Layer visibility is session state, never persisted: every load starts with
 * movement signals only, and every other layer is opt-in for that visit. */
const DEFAULT_LAYERS: Layers = {
  signals: true,
  coverage: false,
  cameras: false,
  transit: false,
  roads: false,
  flights: false,
  rain: false,
  reports: false,
};

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
  { id: "flights", label: "Air access", publisher: "OpenSky Network", badge: "Real · Apr 2026", tone: "real" },
  { id: "rain", label: "Rainfall", publisher: "GWRC Hilltop", badge: "Real · Apr 2026", tone: "real" },
  { id: "reports", label: "Public reports", publisher: "WCC service desk", badge: "Synthetic", tone: "synthetic" },
];

/* One slot per tick. A slot changes the label, the counts, the glyphs and
 * possibly a callout at once; reading that takes about two and a half
 * seconds. The speed picker still scales both ways. */
const PLAY_INTERVAL_MS = 2400;
/** Multipliers on the base tick: one published slot per tick, faster or slower. */
const PLAY_SPEEDS = [0.5, 1, 2, 4, 5];

export default function MovementCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const timebarRef = useRef<HTMLDivElement>(null);
  const [layers, setLayers] = useState<Layers>(DEFAULT_LAYERS);
  const [coverage, setCoverage] = useState<LineFeature[]>([]);
  const [signals, setSignals] = useState<LineFeature[]>([]);
  const [cameras, setCameras] = useState<CameraCollection | null>(null);
  const [transit, setTransit] = useState<TransitCollection | null>(null);
  const [roads, setRoads] = useState<RoadCollection | null>(null);
  const [flights, setFlights] = useState<FlightCollection | null>(null);
  const [rain, setRain] = useState<RainCollection | null>(null);
  const [reports, setReports] = useState<ReportCollection | null>(null);
  const [aprilMovement, setAprilMovement] = useState<AprilMovementCollection | null>(null);
  const [liveSim, setLiveSim] = useState<LiveSimCollection | null>(null);
  const [selectedSignalId, setSelectedSignalId] = useState<string | null>(null);
  const [selectedCameraId, setSelectedCameraId] = useState<string | null>(null);
  const [selectedTransitId, setSelectedTransitId] = useState<string | null>(null);
  const [selectedRoadId, setSelectedRoadId] = useState<string | null>(null);
  const [selectedFlightId, setSelectedFlightId] = useState<string | null>(null);
  const [selectedRainId, setSelectedRainId] = useState<string | null>(null);
  const [selectedReportId, setSelectedReportId] = useState<string | null>(null);
  const [focus, setFocus] = useState<Focus>("signal");
  const [filter, setFilter] = useState<Filter>("all");
  const [error, setError] = useState<string | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [transitError, setTransitError] = useState<string | null>(null);
  const [roadError, setRoadError] = useState<string | null>(null);
  const [flightError, setFlightError] = useState<string | null>(null);
  const [rainError, setRainError] = useState<string | null>(null);
  const [reportError, setReportError] = useState<string | null>(null);
  const [frameNonce, setFrameNonce] = useState(0);
  // Remember which frame URL failed, so selecting another camera or refreshing
  // clears the failure without an effect.
  const [failedFrame, setFailedFrame] = useState<string | null>(null);
  const [view, setView] = useState<MapView>(DEFAULT_VIEW);
  // The stage's measured size, mirrored into state so render-time consumers
  // (the view-scoped situation card) never touch a ref during render.
  const [stageBox, setStageBox] = useState<{ width: number; height: number } | null>(null);
  // The hourly replay drives the signal layer once it loads; until then the
  // committed snapshot renders, so a failed fetch degrades to today's map.
  const [replay, setReplay] = useState<ReplayCollection | null>(null);
  const [playing, setPlaying] = useState(false);
  // The chosen investigation case is its own state: hand-toggling layers
  // afterwards changes the picture, never which case is open. Each case
  // remembers its own scrub position; -1 or absent means the case default.
  /* The site opens on the flagship: the real April storm investigation. */
  const [caseId, setCaseId] = useState<string>("april-floods");
  const [slotIndices, setSlotIndices] = useState<Record<string, number>>({});
  const [speed, setSpeed] = useState(1);
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
  // Active touches on the canvas; two of them make the gesture a pinch, and
  // pinchRef holds the finger spread the next zoom step is measured against.
  const pointersRef = useRef<Map<number, Coordinate>>(new Map());
  const pinchRef = useRef<number | null>(null);
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
  const statusOpen =
    useSyncExternalStore(
      statusStore.subscribe,
      statusStore.snapshot,
      statusStore.serverSnapshot,
    ) === "1";
  const autoPopupOn =
    useSyncExternalStore(
      autoPopupStore.subscribe,
      autoPopupStore.snapshot,
      autoPopupStore.serverSnapshot,
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
      const fitted = fitView(bounds, size.width, size.height);
      /* A phone-portrait fit lands a level out, where street glyphs crowd;
         the small-screen first frame starts at z12. The Fit button and
         reveals still use the exact fit. */
      const floor = window.matchMedia("(max-width: 900px)").matches ? 12 : MIN_ZOOM;
      setView(fitted.zoom < floor ? { ...fitted, zoom: floor } : fitted);
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
    fetch("/cop/v1/movement-replay.json")
      .then((response) => response.json())
      .then((collection: ReplayCollection) => {
        if (Array.isArray(collection.slots) && collection.slots.length > 0) {
          setReplay(collection);
        }
      })
      .catch(() => {
        // The committed snapshot keeps rendering; the timebar stays disabled.
      });
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

  useEffect(() => {
    fetch("/cop/v1/road-anomalies.geojson")
      .then((response) => response.json())
      .then((collection: RoadCollection) => {
        setRoads(collection);
        setSelectedRoadId(collection.features[0]?.id ?? null);
      })
      .catch(() => setRoadError("The state-highway layer could not be loaded."));
  }, []);

  useEffect(() => {
    fetch("/cop/v1/movement-april.json")
      .then((response) => response.json())
      .then((collection: AprilMovementCollection) => {
        if (Array.isArray(collection.slots)) setAprilMovement(collection);
      })
      .catch(() => {
        // The April case simply shows no movement signals if the file fails.
      });
  }, []);

  useEffect(() => {
    fetch("/cop/v1/live-sim.json")
      .then((response) => response.json())
      .then((collection: LiveSimCollection) => {
        if (Array.isArray(collection.slots) && collection.synthetic === true) {
          setLiveSim(collection);
        }
      })
      .catch(() => {
        // Without the simulation feed the Live monitor case stays empty.
      });
  }, []);

  useEffect(() => {
    fetch("/cop/v1/flight-anomalies.geojson")
      .then((response) => response.json())
      .then((collection: FlightCollection) => {
        setFlights(collection);
        setSelectedFlightId(collection.features[0]?.id ?? null);
      })
      .catch(() => setFlightError("The air-access layer could not be loaded."));
  }, []);

  useEffect(() => {
    fetch("/cop/v1/rain-april.geojson")
      .then((response) => response.json())
      .then((collection: RainCollection) => {
        setRain(collection);
        setSelectedRainId(collection.features[0]?.id ?? null);
      })
      .catch(() => setRainError("The rainfall layer could not be loaded."));
  }, []);

  useEffect(() => {
    fetch("/cop/v1/reports-april.geojson")
      .then((response) => response.json())
      .then((collection: ReportCollection) => {
        setReports(collection);
        setSelectedReportId(collection.features[0]?.id ?? null);
      })
      .catch(() => setReportError("The public-reports layer could not be loaded."));
  }, []);

  /* Replay signals carry no geometry of their own: the countline id keys into
   * the coverage layer's line, so one geometry file serves every hour. */
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

  const flightFeatures = useMemo(() => flights?.features ?? [], [flights]);
  const rainFeatures = useMemo(() => rain?.features ?? [], [rain]);
  const rainHourly = useMemo(() => rain?.hourly ?? [], [rain]);
  const reportFeatures = useMemo(() => reports?.features ?? [], [reports]);

  /* The April case replays by hour, the same unit as August: 144 slots over
   * 18–23 Apr. Flight flags are true hourly events; road counts are daily
   * data, so they draw as full-day plateaus — the shape states the source's
   * resolution. Counts of flagged units, never raw sums. The sites'
   * full-month history stays in the evidence panel strips. */
  const countlineGeometry = useMemo(() => {
    const index = new Map<string, Coordinate[]>();
    for (const feature of coverage) {
      index.set(String(feature.properties.countline_id), feature.geometry.coordinates);
    }
    return index;
  }, [coverage]);

  /* Every case loads through the same adapter: one CaseModel per case, built
   * from that case's own artifacts. Null until the artifacts arrive. */
  const caseModels = useMemo<Record<string, CaseModel | null>>(
    () => ({
      "aug-snapshot": buildAugCaseModel(replay, countlineGeometry),
      "april-floods": buildAprilCaseModel(aprilMovement, roadFeatures, flightFeatures, rainHourly),
      "live-sim": buildLiveSimCaseModel(liveSim),
    }),
    [replay, countlineGeometry, aprilMovement, roadFeatures, flightFeatures, rainHourly, liveSim],
  );
  const activeModel = caseModels[caseId] ?? null;
  const activeEvent = EVENTS.find((entry) => entry.id === caseId) ?? EVENTS[0];
  const storedIndex = slotIndices[caseId] ?? -1;
  const effectiveIndex = activeModel
    ? storedIndex >= 0
      ? Math.min(storedIndex, activeModel.slots.length - 1)
      : activeModel.defaultIndex
    : -1;
  const activeCaseSlot = activeModel?.slots[effectiveIndex] ?? null;
  const activeRoadDate =
    activeModel?.roadDayFilter ? activeCaseSlot?.date ?? null : null;

  /* A case with day filtering narrows the diamonds to sites flagged on the
   * slot's day; the roads list and search keep the full flagged set. */
  const shownRoads = useMemo(() => {
    if (!activeRoadDate) return roadFeatures;
    return roadFeatures.filter((feature) =>
      (feature.properties.daily_history ?? []).some(
        (day) => day.date === activeRoadDate && day.flagged,
      ),
    );
  }, [roadFeatures, activeRoadDate]);

  const shownSignals = useMemo<LineFeature[]>(() => {
    if (activeCaseSlot) return activeCaseSlot.signals;
    // Before the default case's artifacts arrive, the committed snapshot renders.
    return caseId === EVENTS[0].id ? signals : [];
  }, [activeCaseSlot, caseId, signals]);

  /* The April timeline drives every time-bearing layer, not just signals:
   * the slot key filters buses to the hour, accumulates reports by log time,
   * sizes the rain droplets and haloes the plane. The lists and search keep
   * each layer's full set, like the roads day filter. */
  const timeSyncKey =
    caseId === "april-floods" && activeCaseSlot ? activeCaseSlot.key : null;
  const shownTransit = useMemo(() => {
    if (!timeSyncKey) return transitFeatures;
    return transitFeatures.filter((feature) =>
      feature.properties.event_hours?.includes(timeSyncKey),
    );
  }, [transitFeatures, timeSyncKey]);
  const shownReports = useMemo(() => {
    if (!timeSyncKey) return reportFeatures;
    return reportFeatures.filter(
      (feature) => feature.properties.created_at.slice(0, 13) <= timeSyncKey,
    );
  }, [reportFeatures, timeSyncKey]);

  /* The corner situation card: what is happening right now IN THE CURRENT
   * VIEW, in plain numbers. Every figure is scoped to features whose anchors
   * project inside the canvas, so panning and zooming re-frame the story —
   * pan to Wainuiomata and its rain takes the card. */
  const situation = useMemo(() => {
    if (!activeCaseSlot) return null;
    const size = stageBox;
    const project = size ? createProjector(view, size.width, size.height) : null;
    const inView = (coordinate: Coordinate) => {
      if (!project || !size) return true;
      const [x, y] = project(coordinate);
      return x >= 0 && x <= size.width && y >= 0 && y <= size.height;
    };
    let up = 0;
    let down = 0;
    const groups = {
      people: { observed: 0, expected: 0, count: 0 },
      vehicles: { observed: 0, expected: 0, count: 0 },
    };
    for (const feature of activeCaseSlot.signals) {
      if (!inView(feature.geometry.coordinates[0])) continue;
      if (feature.properties.change_direction === "decrease") down += 1;
      else up += 1;
      const group = PEOPLE_CLASSES.has(String(feature.properties.transport_class))
        ? groups.people
        : groups.vehicles;
      group.observed += Number(feature.properties.observed_count);
      group.expected += Number(feature.properties.expected_count);
      group.count += 1;
    }
    const summarise = (group: typeof groups.people) =>
      group.count === 0 || group.expected === 0
        ? null
        : {
            percent: Math.round(((group.observed - group.expected) / group.expected) * 100),
            observed: Math.round(group.observed),
            expected: Math.round(group.expected),
          };
    let rainMm = 0;
    let rainWarning = false;
    if (caseId === "april-floods") {
      for (const feature of rainFeatures) {
        if (!inView(feature.geometry.coordinates)) continue;
        const mm = feature.properties.mm_by_hour?.[activeCaseSlot.key] ?? 0;
        if (mm > rainMm) rainMm = mm;
        if (feature.properties.warning_by_hour?.[activeCaseSlot.key]) rainWarning = true;
      }
    } else if (caseId === "live-sim") {
      // The simulation has no per-gauge geometry: the slot aggregate speaks.
      rainMm = activeCaseSlot.rainMm;
      rainWarning = activeCaseSlot.rainWarning;
    }
    /* Layer-adaptive rows: a layer that is switched on contributes its own
     * in-view figures, so the card grows with the picture. */
    const reports = layers.reports
      ? shownReports.filter((feature) => inView(feature.geometry.coordinates)).length
      : null;
    const transit = layers.transit
      ? (timeSyncKey ? shownTransit : transitFeatures).filter((feature) =>
          inView(feature.geometry.coordinates),
        ).length
      : null;
    const roads = layers.roads
      ? (caseId === "april-floods" ? shownRoads : roadFeatures).filter((feature) =>
          inView(feature.geometry.coordinates),
        ).length
      : null;
    const countlines = layers.coverage
      ? coverage.filter((feature) => inView(feature.geometry.coordinates[0])).length
      : null;
    let camerasInView: { total: number; offline: number } | null = null;
    if (layers.cameras) {
      camerasInView = { total: 0, offline: 0 };
      for (const feature of cameraFeatures) {
        if (!inView(feature.geometry.coordinates)) continue;
        camerasInView.total += 1;
        if (feature.properties.offline) camerasInView.offline += 1;
      }
    }
    const airInView = flightFeatures.some((feature) => inView(feature.geometry.coordinates));
    const air =
      layers.flights && caseId === "april-floods" && airInView
        ? activeCaseSlot.tick
          ? "flagged"
          : "normal"
        : null;
    return {
      signalsOn: layers.signals,
      up,
      down,
      people: summarise(groups.people),
      vehicles: summarise(groups.vehicles),
      rainMm,
      rainWarning,
      reports,
      transit,
      roads,
      countlines,
      cameras: camerasInView,
      air,
    };
  }, [
    activeCaseSlot, view, caseId, rainFeatures, timeSyncKey, shownReports,
    shownTransit, transitFeatures, shownRoads, roadFeatures, coverage,
    cameraFeatures, flightFeatures, layers, stageBox,
  ]);

  const filteredSignals = useMemo(() => shownSignals.filter((feature) => {
    const mode = String(feature.properties.transport_class);
    if (filter === "people") return PEOPLE_CLASSES.has(mode);
    if (filter === "vehicles") return !PEOPLE_CLASSES.has(mode);
    return true;
  }), [shownSignals, filter]);

  const selectedSignal =
    shownSignals.find((feature) => feature.id === selectedSignalId) ?? filteredSignals[0];
  const selectedCamera: CameraFeature | undefined =
    cameraFeatures.find((feature) => feature.id === selectedCameraId) ?? sortedCameras[0];
  const selectedTransit: TransitFeature | undefined =
    transitFeatures.find((feature) => feature.id === selectedTransitId) ?? transitFeatures[0];
  const selectedRoad: RoadFeature | undefined =
    roadFeatures.find((feature) => feature.id === selectedRoadId) ?? roadFeatures[0];
  const selectedFlight: FlightFeature | undefined =
    flightFeatures.find((feature) => feature.id === selectedFlightId) ?? flightFeatures[0];
  const selectedRain: RainFeature | undefined =
    rainFeatures.find((feature) => feature.id === selectedRainId) ?? rainFeatures[0];
  const selectedReport: ReportFeature | undefined =
    reportFeatures.find((feature) => feature.id === selectedReportId) ?? reportFeatures[0];

  const hoveredCamera =
    hover?.kind === "camera"
      ? cameraFeatures.find((feature) => feature.id === hover.id)
      : undefined;
  const hoveredSignal =
    hover?.kind === "signal"
      ? shownSignals.find((feature) => feature.id === hover.id)
      : undefined;
  const hoveredTransit =
    hover?.kind === "transit"
      ? transitFeatures.find((feature) => feature.id === hover.id)
      : undefined;
  const hoveredRoad =
    hover?.kind === "road"
      ? roadFeatures.find((feature) => feature.id === hover.id)
      : undefined;
  const hoveredFlight =
    hover?.kind === "flight"
      ? flightFeatures.find((feature) => feature.id === hover.id)
      : undefined;
  const hoveredRain =
    hover?.kind === "rain"
      ? rainFeatures.find((feature) => feature.id === hover.id)
      : undefined;
  const hoveredReport =
    hover?.kind === "report"
      ? reportFeatures.find((feature) => feature.id === hover.id)
      : undefined;

  /* The investigate panel follows the pointer: hovering any glyph previews its
   * evidence, and the pinned selection returns when the pointer leaves. */
  const panelFocus: Focus = hover?.kind ?? focus;
  const panelSignal = hoveredSignal ?? selectedSignal;
  const panelCamera = hoveredCamera ?? selectedCamera;
  const panelTransit = hoveredTransit ?? selectedTransit;
  const panelRoad = hoveredRoad ?? selectedRoad;
  const panelFlight = hoveredFlight ?? selectedFlight;
  const panelRain = hoveredRain ?? selectedRain;
  const panelReport = hoveredReport ?? selectedReport;
  const previewing = Boolean(
    hoveredSignal || hoveredCamera || hoveredTransit || hoveredRoad || hoveredFlight ||
    hoveredRain || hoveredReport,
  );

  /* Case-adaptive road figures: while a day-filtering case sits on a slot,
   * the panel shows that day's counts for the site; otherwise its worst day. */
  const panelRoadDay =
    panelRoad && activeRoadDate
      ? (panelRoad.properties.daily_history ?? []).find(
          (day) => day.date === activeRoadDate,
        )
      : undefined;
  const panelRoadDate = panelRoadDay ? activeRoadDate! : panelRoad?.properties.date;
  const panelRoadObserved = panelRoadDay?.observed ?? panelRoad?.properties.observed_count ?? 0;
  const panelRoadBaseline = panelRoadDay?.baseline ?? panelRoad?.properties.baseline_median ?? 0;

  /* Review state for the selected signal: browser-local triage, never a
   * Council record. What corroborates depends on the open case — April has
   * the roads and flights backtests in-window; August has no second source. */
  const review = useSyncExternalStore(subscribeReview, reviewSnapshot, serverReviewSnapshot);
  const panelSignalKey = panelSignal ? signalKey(panelSignal.properties) : null;
  const panelSignalReview = panelSignalKey ? review.items[panelSignalKey] : undefined;
  const corroboration =
    caseId === "april-floods"
      ? `rain ${activeCaseSlot?.rainMm ?? 0} mm/h${
          activeCaseSlot?.rainWarning ? " (warning-level)" : ""
        } · ${shownRoads.length} highway sites · air ${
          activeCaseSlot?.tick ? "flagged" : "normal"
        }`
      : caseId === "live-sim"
        ? `rain ${activeCaseSlot?.rainMm ?? 0} mm/h${
            activeCaseSlot?.rainWarning ? " (warning-level)" : ""
          } · synthetic simulation`
        : "none in this window · missing ≠ contradicting";

  /* The analogue advisor: in the Live monitor, the trailing three hours are
   * matched against every hour of the saved April investigation. */
  const aprilModel = caseModels["april-floods"];
  const aprilVectors = useMemo(
    () => (aprilModel ? slotVectors(aprilModel.slots) : []),
    [aprilModel],
  );
  const analogue = useMemo(() => {
    if (caseId !== "live-sim" || !activeModel || aprilVectors.length === 0) return null;
    return matchAnalogue(activeModel.slots, effectiveIndex, aprilVectors);
  }, [caseId, activeModel, effectiveIndex, aprilVectors]);
  /* The stable episode rating beside the flickering per-hour match. */
  const periodMatch = useMemo(() => {
    if (caseId !== "live-sim" || !activeModel || aprilVectors.length === 0) return null;
    return matchPeriod(activeModel.slots, effectiveIndex, aprilVectors);
  }, [caseId, activeModel, effectiveIndex, aprilVectors]);

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
      transit: split(shownTransit, (feature) => feature.geometry.coordinates, layers.transit),
      roads: split(shownRoads, (feature) => feature.geometry.coordinates, layers.roads),
      reports: split(shownReports, (feature) => feature.geometry.coordinates, layers.reports),
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
      if (layers.rain) {
        drawRain(
          surface.context,
          project,
          rainFeatures,
          selectedRain?.id ?? null,
          hover?.kind === "rain" ? hover.id : null,
          scale,
          timeSyncKey,
        );
      }
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
      if (layers.reports) {
        drawReports(
          surface.context,
          project,
          groups.reports.singles,
          selectedReport?.id ?? null,
          hover?.kind === "report" ? hover.id : null,
          scale,
        );
        drawClusters(surface.context, groups.reports.clusters, "#77776F");
      }
      if (layers.flights) {
        drawFlights(
          surface.context,
          project,
          flightFeatures,
          selectedFlight?.id ?? null,
          hover?.kind === "flight" ? hover.id : null,
          scale,
          Boolean(timeSyncKey && activeCaseSlot?.tick),
        );
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
        drawClusters(surface.context, groups.cameras.clusters, "#12934B");
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
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect && rect.width > 0) {
        setStageBox({ width: rect.width, height: rect.height });
      }
      autoFitFnRef.current();
      drawRef.current();
    });
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  // The timebar floats over the map's top edge; its measured height feeds the
  // CSS var that keeps the corner controls and the layer drawer clear of it.
  useEffect(() => {
    const frame = frameRef.current;
    const bar = timebarRef.current;
    if (!frame || !bar) return;
    const observer = new ResizeObserver(() => {
      frame.style.setProperty("--timebar-h", `${bar.offsetHeight}px`);
    });
    observer.observe(bar);
    return () => observer.disconnect();
  }, []);

  // Playback steps one published slot per tick and stops at the last one.
  // The interval reads the live index from a ref, so it needs no re-arming.
  const indexRef = useRef(effectiveIndex);
  useEffect(() => {
    indexRef.current = effectiveIndex;
  });

  /* The auto popup adapter: on every scrub or playback step, the severest
   * issue of the hour opens the same callout a hover would — a gauge at
   * warning or torrential level first, else the biggest gated signal. A real
   * hover, pan or zoom takes over exactly as it always did. */
  const severeFnRef = useRef<(index: number) => void>(() => {});
  useEffect(() => {
    severeFnRef.current = (index: number) => {
      const slot = activeModel?.slots[index];
      const size = stageSize();
      if (!slot || !size || autoPopupStore.snapshot() !== "1") {
        setHover(null);
        return;
      }
      const project = createProjector(view, size.width, size.height);
      const width = COMPACT_POPUP_WIDTH;
      const makeHover = (kind: Focus, id: string, coordinate: Coordinate): Hover | null => {
        const [px, py] = project(coordinate);
        if (px < 0 || px > size.width || py < 0 || py > size.height) return null;
        const left = Math.min(
          Math.max(px - width / 2, 8),
          Math.max(8, size.width - width - 8),
        );
        return {
          kind,
          id,
          left,
          top: py,
          above: py > 120,
          beakX: Math.min(Math.max(px - left, 14), width - 14),
          compact: true,
        };
      };
      let next: Hover | null = null;
      if (layers.rain && caseId === "april-floods") {
        let worst: RainFeature | null = null;
        let worstMm = 0;
        for (const feature of rainFeatures) {
          // Out-of-frame gauges (Hutt Valley, Wainuiomata) are context, not
          // the city's story — they never take the auto popup.
          if (!feature.properties.within_countline_frame) continue;
          const mm = feature.properties.mm_by_hour?.[slot.key] ?? 0;
          const warning = Boolean(feature.properties.warning_by_hour?.[slot.key]);
          if ((warning || mm >= 25) && mm >= worstMm) {
            worst = feature;
            worstMm = mm;
          }
        }
        if (worst) next = makeHover("rain", worst.id, worst.geometry.coordinates);
      }
      if (!next) {
        let worst: LineFeature | null = null;
        let worstZ = AUTO_POPUP_Z;
        for (const feature of slot.signals) {
          const z = Math.abs(Number(feature.properties.robust_z));
          if (z >= worstZ) {
            worst = feature;
            worstZ = z;
          }
        }
        if (worst) next = makeHover("signal", worst.id, worst.geometry.coordinates[0]);
      }
      setHover(next);
    };
  });
  useEffect(() => {
    if (!playing || !activeModel) return;
    const lastIndex = activeModel.slots.length - 1;
    const interval = setInterval(() => {
      if (indexRef.current >= lastIndex) {
        setPlaying(false);
        return;
      }
      const next = indexRef.current + 1;
      setSlotIndices((current) => ({ ...current, [caseId]: next }));
      severeFnRef.current(next);
    }, PLAY_INTERVAL_MS / speed);
    return () => clearInterval(interval);
  }, [playing, activeModel, caseId, speed]);

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
      layers.flights ? boundsOfPoints(flightFeatures) : null,
      layers.rain ? boundsOfPoints(rainFeatures) : null,
      layers.reports ? boundsOfPoints(reportFeatures) : null,
    );
    if (!bounds) return;
    autoFitRef.current = false;
    setHover(null);
    setView(fitView(bounds, size.width, size.height));
  }, [
    stageSize, layers, coverage, cameraFeatures, transitFeatures, roadFeatures,
    flightFeatures, rainFeatures, reportFeatures,
  ]);

  const toggleLayer = (id: LayerId) => {
    setHover(null);
    setLayers((current) => ({ ...current, [id]: !current[id] }));
  };

  /** The drawer's operations row: the target adapts, the verbs stay constant. */
  const evidenceOps = (kind: Focus, coordinate: Coordinate, feed: string, extra?: ReactNode) => (
    <div className="evidence-ops">
      <button
        type="button"
        onClick={() => {
          setFocus(kind);
          ensureLayer(kind);
          revealOnMap(coordinate);
        }}
      >
        Show on map
      </button>
      <a href={feed} target="_blank" rel="noreferrer">
        Open feed
      </a>
      {extra}
    </div>
  );

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
    for (const feature of shownSignals) {
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
    for (const feature of flightFeatures) {
      if (feature.properties.site_name.toLowerCase().includes(query)) {
        hits.push({
          kind: "flight",
          id: feature.id,
          label: feature.properties.site_name,
          detail: "Air access",
          coordinate: feature.geometry.coordinates,
        });
      }
    }
    for (const feature of rainFeatures) {
      if (feature.properties.site_name.toLowerCase().includes(query)) {
        hits.push({
          kind: "rain",
          id: feature.id,
          label: feature.properties.site_name,
          detail: "Rain gauge",
          coordinate: feature.geometry.coordinates,
        });
      }
    }
    for (const feature of reportFeatures) {
      if (feature.properties.street.toLowerCase().includes(query)) {
        hits.push({
          kind: "report",
          id: feature.id,
          label: `${feature.properties.street} report`,
          detail: "Public report · synthetic",
          coordinate: feature.geometry.coordinates,
        });
      }
    }
    return hits.slice(0, SEARCH_LIMIT);
  }, [
    search, shownSignals, cameraFeatures, transitFeatures, roadFeatures,
    flightFeatures, rainFeatures, reportFeatures,
  ]);

  /** Picking a feature switches its layer on, so the pick is always visible. */
  const ensureLayer = (kind: Focus) => {
    const id: LayerId =
      kind === "signal"
        ? "signals"
        : kind === "camera"
          ? "cameras"
          : kind === "transit"
            ? "transit"
            : kind === "road"
              ? "roads"
              : kind === "rain"
                ? "rain"
                : kind === "report"
                  ? "reports"
                  : "flights";
    setLayers((current) => (current[id] ? current : { ...current, [id]: true }));
  };

  /** A case only asserts the layers it names; other choices stay the user's. */
  const applyEvent = (event: (typeof EVENTS)[number]) => {
    setHover(null);
    setPlaying(false);
    setCaseId(event.id);
    setLayers((current) => ({ ...current, ...event.layers }));
    setFocus(event.focus);
    // Opening a case lands on its default slot, whatever was scrubbed before.
    setSlotIndices((current) => ({ ...current, [event.id]: -1 }));
    // Fit to the event's own layers; the toggles land on the next render.
    const size = stageSize();
    const bounds = unionBounds(
      event.layers.signals || event.layers.coverage ? boundsOfLines(coverage) : null,
      event.layers.roads ? boundsOfPoints(roadFeatures) : null,
      event.layers.flights ? boundsOfPoints(flightFeatures) : null,
      event.layers.transit ? boundsOfPoints(transitFeatures) : null,
    );
    if (size && bounds) {
      autoFitRef.current = false;
      setView(fitView(bounds, size.width, size.height));
    }
  };

  /** Scrubbing is a deliberate act: it pauses playback and shows the signal layer. */
  const scrubTo = (index: number) => {
    if (!activeModel) return;
    setPlaying(false);
    ensureLayer("signal");
    const clamped = Math.min(Math.max(index, 0), activeModel.slots.length - 1);
    setSlotIndices((current) => ({ ...current, [caseId]: clamped }));
    severeFnRef.current(clamped);
  };

  const togglePlay = () => {
    if (!activeModel) return;
    setHover(null);
    ensureLayer("signal");
    if (!playing && effectiveIndex >= activeModel.slots.length - 1) {
      setSlotIndices((current) => ({ ...current, [caseId]: 0 }));
    }
    setPlaying((current) => !current);
  };

  const pickSearchHit = (hit: SearchHit) => {
    if (hit.kind === "camera") setSelectedCameraId(hit.id);
    else if (hit.kind === "transit") setSelectedTransitId(hit.id);
    else if (hit.kind === "road") setSelectedRoadId(hit.id);
    else if (hit.kind === "flight") setSelectedFlightId(hit.id);
    else setSelectedSignalId(hit.id);
    setFocus(hit.kind);
    ensureLayer(hit.kind);
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
    const place = (kind: Focus, id: string, [x, y]: Coordinate): Hover => {
      const left = Math.min(
        Math.max(x - POPUP_WIDTH / 2, 8),
        Math.max(8, size.width - POPUP_WIDTH - 8),
      );
      return {
        kind,
        id,
        left,
        top: y,
        above: y > (kind === "camera" ? 264 : 120),
        beakX: Math.min(Math.max(x - left, 14), POPUP_WIDTH - 14),
      };
    };
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
    if (layers.reports) {
      const hit = pickNearest(groups.reports.singles, (feature) => feature.geometry.coordinates, project, point);
      if (hit) return place("report", hit.id, project(hit.geometry.coordinates));
    }
    if (layers.flights) {
      const hit = pickNearest(flightFeatures, (feature) => feature.geometry.coordinates, project, point);
      if (hit) return place("flight", hit.id, project(hit.geometry.coordinates));
    }
    if (layers.rain) {
      const hit = pickNearest(rainFeatures, (feature) => feature.geometry.coordinates, project, point);
      if (hit) return place("rain", hit.id, project(hit.geometry.coordinates));
    }
    return null;
  };

  /** Density bubble under the pointer, if any — clicking it zooms in a level. */
  const clusterAt = (point: Coordinate, size: { width: number; height: number }) => {
    const groups = clusterLayers(size.width, size.height);
    for (const clusters of [
      groups.cameras.clusters,
      groups.transit.clusters,
      groups.roads.clusters,
      groups.reports.clusters,
    ]) {
      for (const cluster of clusters) {
        const distance = Math.hypot(cluster.x - point[0], cluster.y - point[1]);
        if (distance <= clusterRadius(cluster.members.length) + 2) return cluster;
      }
    }
    return null;
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    pointersRef.current.set(event.pointerId, [event.clientX, event.clientY]);
    if (pointersRef.current.size === 2) {
      // A second finger turns the gesture into a pinch, not a drag or a click.
      dragRef.current = null;
      setHover(null);
      const [a, b] = [...pointersRef.current.values()];
      pinchRef.current = Math.hypot(a[0] - b[0], a[1] - b[1]);
      return;
    }
    dragRef.current = { x: event.clientX, y: event.clientY, moved: false };
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (pointersRef.current.has(event.pointerId)) {
      pointersRef.current.set(event.pointerId, [event.clientX, event.clientY]);
    }
    // Pinch: whole zoom levels like the wheel, one step per third of spread,
    // anchored on the midpoint between the fingers.
    if (pinchRef.current !== null && pointersRef.current.size >= 2) {
      const [a, b] = [...pointersRef.current.values()];
      const distance = Math.hypot(a[0] - b[0], a[1] - b[1]);
      const ratio = distance / pinchRef.current;
      if (ratio > 1.3 || ratio < 1 / 1.3) {
        const rect = event.currentTarget.getBoundingClientRect();
        const anchor: Coordinate = [
          (a[0] + b[0]) / 2 - rect.left,
          (a[1] + b[1]) / 2 - rect.top,
        ];
        autoFitRef.current = false;
        pinchRef.current = distance;
        setView((current) =>
          zoomAround(current, ratio > 1 ? 1 : -1, anchor, rect.width, rect.height),
        );
      }
      return;
    }
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
    // Sticky hover: the popup anchor was stored at pick time, so while the
    // pointer stays beside it the current pick wins over a nearer neighbour.
    if (hover) {
      const distance = Math.hypot(
        hover.left + hover.beakX - point[0],
        hover.top - point[1],
      );
      if (distance <= HOVER_STICKY_PX) return;
    }
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
    pointersRef.current.delete(event.pointerId);
    if (pinchRef.current !== null) {
      // The pinch owns this gesture until the last finger lifts.
      if (pointersRef.current.size < 2) pinchRef.current = null;
      return;
    }
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
        return;
      }
      // A tap on empty map puts the callout away; a mouse never lingers here.
      setHover(null);
      return;
    }
    // A tap opens the same callout a hover would, so touch gets feedback too.
    setHover(hit);
    if (hit.kind === "camera") {
      setSelectedCameraId(hit.id);
      setFocus("camera");
    } else if (hit.kind === "transit") {
      setSelectedTransitId(hit.id);
      setFocus("transit");
    } else if (hit.kind === "road") {
      setSelectedRoadId(hit.id);
      setFocus("road");
    } else if (hit.kind === "flight") {
      setSelectedFlightId(hit.id);
      setFocus("flight");
    } else if (hit.kind === "rain") {
      setSelectedRainId(hit.id);
      setFocus("rain");
    } else if (hit.kind === "report") {
      setSelectedReportId(hit.id);
      setFocus("report");
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
      layers.flights ? `${flightFeatures.length} air access site` : null,
      layers.rain ? `${rainFeatures.length} rain gauges` : null,
      layers.reports ? `${reportFeatures.length} synthetic public reports` : null,
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
          <div
            className="replay-bar"
            role="group"
            aria-label="Batch replay timeline"
            ref={timebarRef}
          >
            <select
              className="case-picker"
              aria-label="Investigations"
              value={caseId}
              onChange={(changeEvent) => {
                const picked = EVENTS.find(
                  (entry) => entry.id === changeEvent.currentTarget.value,
                );
                if (picked) applyEvent(picked);
              }}
            >
              {EVENTS.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label} · {entry.window} · {entry.badge}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="replay-play"
              onClick={togglePlay}
              disabled={!activeModel}
              aria-label={playing ? "Pause the replay" : "Play the replay"}
              title={playing ? "Pause the replay" : "Play the replay"}
            >
              {playing ? (
                <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
                  <rect x="3" y="2.5" width="3.4" height="11" fill="currentColor" />
                  <rect x="9.6" y="2.5" width="3.4" height="11" fill="currentColor" />
                </svg>
              ) : (
                <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
                  <path d="M4 2.4v11.2L13.2 8Z" fill="currentColor" />
                </svg>
              )}
            </button>
            <button
              type="button"
              onClick={() => scrubTo(effectiveIndex - 1)}
              disabled={!activeModel || effectiveIndex <= 0}
              aria-label="Previous hour"
              title="Previous hour"
            >
              ‹
            </button>
            <button
              type="button"
              onClick={() => scrubTo(effectiveIndex + 1)}
              disabled={!activeModel || effectiveIndex >= (activeModel?.slots.length ?? 1) - 1}
              aria-label="Next hour"
              title="Next hour"
            >
              ›
            </button>
            <select
              className="speed-picker"
              aria-label="Playback speed"
              value={String(speed)}
              onChange={(event) => setSpeed(Number(event.currentTarget.value))}
            >
              {PLAY_SPEEDS.map((value) => (
                <option key={value} value={String(value)}>
                  {value}×
                </option>
              ))}
            </select>
            <button
              type="button"
              className={autoPopupOn ? "" : "off"}
              onClick={() => {
                autoPopupStore.toggle(autoPopupOn);
                if (autoPopupOn) setHover(null);
              }}
              aria-pressed={autoPopupOn}
              aria-label={autoPopupOn ? "Turn auto callouts off" : "Turn auto callouts on"}
              title={autoPopupOn ? "Turn auto callouts off" : "Turn auto callouts on"}
            >
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                {autoPopupOn ? (
                  <path d="M2 2.6h12v8H8.4L5 13.6v-3H2z" fill="currentColor" />
                ) : (
                  <>
                    <path
                      d="M2 2.6h12v8H8.4L5 13.6v-3H2z"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.4"
                    />
                    <line
                      x1="1.6"
                      y1="14.4"
                      x2="14.4"
                      y2="1.6"
                      stroke="currentColor"
                      strokeWidth="1.6"
                    />
                  </>
                )}
              </svg>
            </button>
            <button
              type="button"
              className={caseId === "live-sim" ? "sim-on" : ""}
              onClick={() => {
                const target =
                  caseId === "live-sim"
                    ? EVENTS[0]
                    : EVENTS.find((entry) => entry.id === "live-sim");
                if (target) applyEvent(target);
              }}
              disabled={!liveSim}
              aria-pressed={caseId === "live-sim"}
              aria-label={
                caseId === "live-sim" ? "Leave simulation mode" : "Enter simulation mode"
              }
              title={caseId === "live-sim" ? "Leave simulation mode" : "Enter simulation mode"}
            >
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                <path
                  d="M6.2 1.6h3.6M7 1.6v4.6L3.7 12a2 2 0 0 0 1.8 2.9h5a2 2 0 0 0 1.8-2.9L9 6.2V1.6"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <path d="M5.2 10.6h5.6" stroke="currentColor" strokeWidth="1.5" />
              </svg>
            </button>
            <p className="replay-readout">
              <strong>{activeCaseSlot?.label ?? activeEvent.fallbackLabel}</strong>
              <span>
                {activeCaseSlot ? (
                  <>
                    <i className="up" aria-hidden="true" />
                    {activeCaseSlot.up.toLocaleString("en-NZ")} up ·{" "}
                    <i className="down" aria-hidden="true" />
                    {activeCaseSlot.down.toLocaleString("en-NZ")} down
                  </>
                ) : (
                  activeEvent.fallbackNote
                )}
              </span>
            </p>
            {caseId === "april-floods" || caseId === "live-sim" ? (
              <p
                className="replay-rain"
                title={
                  caseId === "live-sim"
                    ? "Peak simulated rainfall this hour; orange = MetService warning criteria met"
                    : "Peak gauge rainfall this hour, GWRC record; orange = MetService warning criteria met"
                }
              >
                <i className="drop" aria-hidden="true" />
                <strong>{activeCaseSlot ? `${activeCaseSlot.rainMm} mm/h` : "–"}</strong>
                {activeCaseSlot?.rainWarning ? <em>warning</em> : null}
              </p>
            ) : null}
            {caseId === "live-sim" && analogue && aprilModel ? (
              <button
                type="button"
                className="analogue-chip"
                onClick={() => {
                  const april = EVENTS.find((entry) => entry.id === "april-floods");
                  if (!april) return;
                  applyEvent(april);
                  setSlotIndices((current) => ({
                    ...current,
                    "april-floods": analogue.index,
                  }));
                }}
                title="Analogue advisory: nearest saved investigation hour by situation vector — investigate, not a forecast"
              >
                ≈ Floods and storm · {aprilModel.slots[analogue.index].label} ·{" "}
                {Math.round(analogue.score * 100)}%
              </button>
            ) : null}
            <div className="replay-track">
              {activeModel ? (
                <svg
                  className="replay-histogram"
                  viewBox={`0 0 ${activeModel.slots.length} 36`}
                  preserveAspectRatio="none"
                  aria-hidden="true"
                  onPointerDown={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    scrubTo(
                      Math.floor(
                        ((event.clientX - rect.left) / rect.width) *
                          activeModel.slots.length,
                      ),
                    );
                  }}
                >
                  {(() => {
                    const maxSignal = Math.max(
                      1,
                      ...activeModel.slots.map((slot) => Math.max(slot.up, slot.down)),
                    );
                    const maxRain = Math.max(
                      1,
                      ...activeModel.slots.map((slot) => slot.rainMm),
                    );
                    return (
                      <>
                        {activeModel.eventHours > 0 ? (
                          <rect
                            className="event-window"
                            x={0}
                            y={0}
                            width={activeModel.eventHours}
                            height={36}
                          />
                        ) : null}
                        <rect
                          className="cursor"
                          x={effectiveIndex}
                          y={0}
                          width={1}
                          height={36}
                        />
                        {activeModel.slots.map((slot, index) => (
                          <g key={slot.key}>
                            {slot.rainMm > 0 ? (
                              <rect
                                className={`rain-bar ${slot.rainWarning ? "warning" : ""}`}
                                x={index + 0.05}
                                y={0}
                                width={0.9}
                                height={Math.max(0.6, (slot.rainMm / maxRain) * 6)}
                              />
                            ) : null}
                            {slot.wash > 0 ? (
                              <rect
                                className="roads-bar"
                                x={index}
                                y={17 - slot.wash * 16}
                                width={1}
                                height={slot.wash * 16}
                              />
                            ) : null}
                            {slot.tick ? (
                              <rect
                                className="flights-bar"
                                x={index + 0.06}
                                y={19}
                                width={0.88}
                                height={14}
                              />
                            ) : null}
                            {slot.up > 0 ? (
                              <rect
                                className="up"
                                x={index + 0.08}
                                y={17 - (slot.up / maxSignal) * 16}
                                width={0.84}
                                height={(slot.up / maxSignal) * 16}
                              />
                            ) : null}
                            {slot.down > 0 ? (
                              <rect
                                className="down"
                                x={index + 0.08}
                                y={19}
                                width={0.84}
                                height={(slot.down / maxSignal) * 16}
                              />
                            ) : null}
                          </g>
                        ))}
                        <line
                          className="axis"
                          x1={0}
                          y1={18}
                          x2={activeModel.slots.length}
                          y2={18}
                          vectorEffect="non-scaling-stroke"
                        />
                      </>
                    );
                  })()}
                </svg>
              ) : null}
              <input
                type="range"
                className="replay-slider"
                min={0}
                max={activeModel ? activeModel.slots.length - 1 : 0}
                step={1}
                value={effectiveIndex >= 0 ? effectiveIndex : 0}
                disabled={!activeModel}
                onChange={(event) => scrubTo(Number(event.currentTarget.value))}
                aria-label="Replay hour"
                aria-valuetext={activeCaseSlot?.label ?? activeEvent.fallbackLabel}
              />
            </div>
          </div>
            <canvas
              ref={canvasRef}
              className="map-canvas"
              style={hover || overCluster ? { cursor: "pointer" } : undefined}
              role="img"
              aria-label={`Map of Wellington showing ${layerSummary}. Drag to pan, use the zoom buttons to change scale.`}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={(event) => {
                dragRef.current = null;
                pointersRef.current.delete(event.pointerId);
                pinchRef.current = null;
              }}
              onPointerLeave={(event) => {
                // Touch fires leave right after every tap; the tap callout
                // stays until the next tap or view change puts it away.
                if (event.pointerType !== "touch") setHover(null);
              }}
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
              {layers.flights ? <span><i className="flight" />Air access</span> : null}
              {layers.rain ? (
                <>
                  <span><i className="rain" />Light rain</span>
                  <span><i className="rain rain-heavy" />Heavy rain</span>
                  <span><i className="rain rain-warning" />Warning-level</span>
                </>
              ) : null}
              {layers.reports ? (
                <>
                  <span><i className="report" />Report</span>
                  <span><i className="report-high" />Investigate level</span>
                </>
              ) : null}
            </div>
            {activeCaseSlot && situation ? (
              statusOpen ? (
              <div
                className="map-status"
                id="situation-card"
                title="This hour, grouped over the current view: gated signals aggregated per class (% change and observed/expected counts), worst in-view rain, and in-view record counts per layer"
              >
                <button
                  type="button"
                  className="status-close"
                  onClick={() => statusStore.toggle(statusOpen)}
                  aria-expanded
                  aria-controls="situation-card"
                  aria-label="Hide the situation card"
                  title="Hide the situation card"
                >
                  <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                    <path d="M3 10l5-5 5 5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" transform="rotate(180 8 7.5)" />
                  </svg>
                </button>
                <p>{activeCaseSlot.label} · in view</p>
                {situation.signalsOn ? (
                  <>
                    <div>
                      <span>Abnormal records</span>
                      <strong>{situation.up + situation.down}</strong>
                    </div>
                    <div>
                      <span>People</span>
                      <strong
                        className={
                          situation.people === null
                            ? ""
                            : situation.people.percent < 0
                              ? "down"
                              : "up"
                        }
                      >
                        {situation.people === null
                          ? "–"
                          : `${situation.people.percent > 0 ? "+" : ""}${situation.people.percent}% · ${situation.people.observed.toLocaleString("en-NZ")}/${situation.people.expected.toLocaleString("en-NZ")}`}
                      </strong>
                    </div>
                    <div>
                      <span>Vehicles</span>
                      <strong
                        className={
                          situation.vehicles === null
                            ? ""
                            : situation.vehicles.percent < 0
                              ? "down"
                              : "up"
                        }
                      >
                        {situation.vehicles === null
                          ? "–"
                          : `${situation.vehicles.percent > 0 ? "+" : ""}${situation.vehicles.percent}% · ${situation.vehicles.observed.toLocaleString("en-NZ")}/${situation.vehicles.expected.toLocaleString("en-NZ")}`}
                      </strong>
                    </div>
                  </>
                ) : null}
                {situation.countlines !== null ? (
                  <div>
                    <span>Countlines</span>
                    <strong>{situation.countlines}</strong>
                  </div>
                ) : null}
                {situation.cameras !== null ? (
                  <div>
                    <span>Cameras</span>
                    <strong>
                      {situation.cameras.total}
                      {situation.cameras.offline > 0
                        ? ` · ${situation.cameras.offline} off`
                        : ""}
                    </strong>
                  </div>
                ) : null}
                {caseId === "april-floods" || caseId === "live-sim" ? (
                  <div>
                    <span>Rain</span>
                    <strong className={situation.rainWarning ? "warn" : ""}>
                      {situation.rainMm > 0 ? `${situation.rainMm} mm/h` : "none"}
                      {situation.rainWarning ? " · warning" : ""}
                    </strong>
                  </div>
                ) : null}
                {periodMatch && aprilModel ? (
                  <div
                    title={`Episode rating: the trailing 12 hours against the best-aligned April window (ending ${aprilModel.slots[periodMatch.index].label}) — concatenated situation vectors, cosine; advisory, not a forecast`}
                  >
                    <span>≈ April · 12 h</span>
                    <strong className={periodMatch.score >= 0.85 ? "warn" : ""}>
                      {Math.round(periodMatch.score * 100)}%
                    </strong>
                  </div>
                ) : null}
                {situation.roads !== null ? (
                  <div>
                    <span>Highway sites</span>
                    <strong>{situation.roads}</strong>
                  </div>
                ) : null}
                {situation.transit !== null ? (
                  <div>
                    <span>Buses (synthetic)</span>
                    <strong>{situation.transit}</strong>
                  </div>
                ) : null}
                {situation.air !== null ? (
                  <div>
                    <span>Air access</span>
                    <strong className={situation.air === "flagged" ? "warn" : ""}>
                      {situation.air}
                    </strong>
                  </div>
                ) : null}
                {situation.reports !== null ? (
                  <div>
                    <span>Reports so far</span>
                    <strong>{situation.reports}</strong>
                  </div>
                ) : null}
              </div>
              ) : (
                <button
                  type="button"
                  className="map-status-toggle"
                  onClick={() => statusStore.toggle(statusOpen)}
                  aria-expanded={false}
                  aria-controls="situation-card"
                  aria-label="Show the situation card"
                  title="Show the situation card"
                >
                  <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
                    <path
                      d="M2.5 13.5v-5M8 13.5v-9M13.5 13.5v-3"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      fill="none"
                    />
                  </svg>
                </button>
              )
            ) : null}
            {hover &&
            (hoveredCamera || hoveredSignal || hoveredTransit || hoveredRoad || hoveredFlight ||
              hoveredRain || hoveredReport) ? (
              <div
                className={`map-popup sheet ${hover.compact ? "compact" : ""}`}
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
                    <strong className="popup-title">
                      <span className="popup-name">{String(hoveredSignal.properties.name)}</span>
                      <span
                        className={`popup-chip ${String(hoveredSignal.properties.change_direction)}`}
                      >
                        <span aria-hidden="true">
                          {hoveredSignal.properties.change_direction === "decrease" ? "↓" : "↑"}
                        </span>
                        {String(hoveredSignal.properties.change_direction)}
                      </span>
                    </strong>
                    <span className="popup-meta">
                      {String(hoveredSignal.properties.transport_class)} ·{" "}
                      {compass(String(hoveredSignal.properties.direction))}
                    </span>
                    <span>
                      <b>{Number(hoveredSignal.properties.observed_count).toLocaleString("en-NZ")}</b>{" "}
                      observed vs{" "}
                      <b>{Number(hoveredSignal.properties.expected_count).toLocaleString("en-NZ")}</b>{" "}
                      expected (
                      <b className={String(hoveredSignal.properties.change_direction)}>
                        {(() => {
                          const delta = Math.round(
                            Number(hoveredSignal.properties.observed_count) -
                              Number(hoveredSignal.properties.expected_count),
                          );
                          return `${delta > 0 ? "+" : ""}${delta.toLocaleString("en-NZ")}`;
                        })()}
                      </b>
                      )
                    </span>
                    <span>
                      {Number(hoveredSignal.properties.robust_z) > 0 ? "+" : ""}
                      {Number(hoveredSignal.properties.robust_z).toFixed(1)} deviations from usual
                    </span>
                  </p>
                ) : hoveredTransit ? (
                  <p>
                    <strong>{hoveredTransit.properties.stop_name}</strong>
                    <span>
                      <b>{hoveredTransit.properties.anomaly_count}</b> PT anomalies ·{" "}
                      <b>{hoveredTransit.properties.high_count}</b> high · top:{" "}
                      {hoveredTransit.properties.top_detector} · synthetic April replay
                    </span>
                  </p>
                ) : hoveredRoad ? (
                  <p>
                    <strong>{hoveredRoad.properties.site_name}</strong>
                    <span>
                      SH{hoveredRoad.properties.state_highway} ·{" "}
                      <b>{hoveredRoad.properties.ratio.toFixed(2)}×</b> usual ·{" "}
                      {dayLabel(hoveredRoad.properties.date)} · real event
                    </span>
                  </p>
                ) : hoveredFlight ? (
                  <p>
                    <strong>{hoveredFlight.properties.site_name}</strong>
                    <span>
                      <b>{hoveredFlight.properties.high_hours}</b> high ·{" "}
                      <b>{hoveredFlight.properties.medium_hours}</b> medium flagged hours ·
                      real April 2026 · OpenSky
                    </span>
                  </p>
                ) : hoveredRain ? (
                  <p>
                    <strong>{hoveredRain.properties.site_name}</strong>
                    {timeSyncKey ? (
                      <span>
                        now{" "}
                        <b>
                          {(hoveredRain.properties.mm_by_hour?.[timeSyncKey] ?? 0).toLocaleString(
                            "en-NZ",
                          )}{" "}
                          mm/h
                        </b>
                        {hoveredRain.properties.warning_by_hour?.[timeSyncKey]
                          ? " · warning-level accumulation"
                          : ""}
                      </span>
                    ) : null}
                    <span>
                      peak <b>{hoveredRain.properties.peak.value_mm} mm/h</b> ·{" "}
                      <b>{hoveredRain.properties.heavy_hours}</b> heavy hours ·
                      real April 2026 · GWRC
                    </span>
                  </p>
                ) : hoveredReport ? (
                  <p>
                    <strong>{hoveredReport.properties.street}</strong>
                    <span>
                      {hoveredReport.properties.category.replace("_", " ")} · grade{" "}
                      <b>{hoveredReport.properties.source_grade}</b> · cluster{" "}
                      <b>{hoveredReport.properties.cluster_size}</b> ·{" "}
                      {hoveredReport.properties.level} · synthetic
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
                  : panelFocus === "flight"
                    ? "Air access evidence"
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
                {!previewing ? (
                  <>
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
                    {evidenceOps(
                      "camera",
                      panelCamera.geometry.coordinates,
                      "/cop/v1/traffic-cameras.geojson",
                    )}
                  </>
                ) : null}
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
                {!previewing ? (
                  <>
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
                          {dayLabel(panelTransit.properties.worst_example.date)} ·{" "}
                          {String(panelTransit.properties.worst_example.hour).padStart(2, "0")}
                          :00 · {panelTransit.properties.worst_example.severity.toLowerCase()}
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
                    {transit?.official_context ? (
                      <p className="evidence-note">
                        Official April report (real):{" "}
                        {transit.official_context.storm_notes[0]}
                      </p>
                    ) : null}
                    {evidenceOps(
                      "transit",
                      panelTransit.geometry.coordinates,
                      "/cop/v1/transit-anomalies.geojson",
                    )}
                  </>
                ) : null}
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
                  {dayLabel(panelRoadDate ?? panelRoad.properties.date)} · real April 2026
                  flood event
                </p>
                <div className="count-comparison">
                  <div>
                    <span>Observed</span>
                    <strong>{panelRoadObserved.toLocaleString("en-NZ")}</strong>
                  </div>
                  <div>
                    <span>Usual</span>
                    <strong>{panelRoadBaseline.toLocaleString("en-NZ")}</strong>
                  </div>
                  <div>
                    <span>Change</span>
                    <strong
                      className={`delta ${
                        panelRoadObserved < panelRoadBaseline ? "decrease" : "increase"
                      }`}
                    >
                      {(() => {
                        const delta = panelRoadObserved - panelRoadBaseline;
                        return `${delta > 0 ? "+" : ""}${delta.toLocaleString("en-NZ")}`;
                      })()}
                    </strong>
                  </div>
                </div>
                {!previewing ? (
                  <>
                    {panelRoad.properties.daily_history?.length ? (
                      <DailyStrip
                        points={panelRoad.properties.daily_history.map((day) => ({
                          date: day.date,
                          value: day.observed,
                          flagged: day.flagged,
                        }))}
                        reference={panelRoad.properties.baseline_median}
                        label={`Daily counts at ${panelRoad.properties.site_name}, April 2026, flagged days highlighted`}
                      />
                    ) : null}
                    <dl className="evidence-metrics">
                      {panelRoadDay && panelRoadDate !== panelRoad.properties.date ? (
                        <div>
                          <dt>Worst flagged day</dt>
                          <dd>{dayLabel(panelRoad.properties.date)}</dd>
                        </div>
                      ) : null}
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
                    {evidenceOps(
                      "road",
                      panelRoad.geometry.coordinates,
                      "/cop/v1/road-anomalies.geojson",
                    )}
                  </>
                ) : null}
              </div>
            ) : (
              <p className="empty-evidence">
                {roadError ?? "Loading the state-highway layer…"}
              </p>
            )
          ) : panelFocus === "flight" ? (
            panelFlight ? (
              <div className={`selected-evidence ${previewing ? "preview" : ""}`}>
                <div className="evidence-heading">
                  <span className="direction-chip flight">
                    {panelFlight.properties.high_hours + panelFlight.properties.medium_hours}{" "}
                    flagged hours
                  </span>
                  <span>{panelFlight.properties.iata}</span>
                </div>
                <h3>{panelFlight.properties.site_name}</h3>
                <p>OpenSky · real April 2026 backtest</p>
                <div className="count-comparison">
                  <div>
                    <span>High</span>
                    <strong>{panelFlight.properties.high_hours.toLocaleString("en-NZ")}</strong>
                  </div>
                  <div>
                    <span>Medium</span>
                    <strong>{panelFlight.properties.medium_hours.toLocaleString("en-NZ")}</strong>
                  </div>
                  <div>
                    <span>Scored hours</span>
                    <strong>{panelFlight.properties.scored_hours.toLocaleString("en-NZ")}</strong>
                  </div>
                </div>
                {!previewing ? (
                  <>
                <DailyStrip
                  points={panelFlight.properties.daily_movements.map((day) => ({
                    date: day.date,
                    value: day.movements,
                    flagged: day.flagged,
                  }))}
                  label={`Daily flight movements ${shortDate(panelFlight.properties.window_start)} to ${shortDate(panelFlight.properties.window_end)}, flagged days highlighted`}
                />
                <dl className="evidence-metrics">
                  <div>
                    <dt>Worst hour</dt>
                    <dd>
                      {dayLabel(panelFlight.properties.worst_example.date)} ·{" "}
                      {String(panelFlight.properties.worst_example.hour).padStart(2, "0")}:00 ·{" "}
                      {panelFlight.properties.worst_example.observed} vs{" "}
                      {panelFlight.properties.worst_example.expected.toLocaleString("en-NZ")}{" "}
                      expected
                    </dd>
                  </div>
                  <div title="How many robust standard deviations the worst hour sits from its weekday-matched hourly baseline">
                    <dt>Robust score</dt>
                    <dd>{panelFlight.properties.worst_example.robust_z.toFixed(1)} z</dd>
                  </div>
                  <div><dt>Publisher</dt><dd>OpenSky Network</dd></div>
                  <div>
                    <dt>Position</dt>
                    <dd>
                      {panelFlight.geometry.coordinates[1].toFixed(4)},{" "}
                      {panelFlight.geometry.coordinates[0].toFixed(4)}
                    </dd>
                  </div>
                </dl>
                <p className="evidence-note">
                  Derived third-party tracking, not an airport feed. A flag is a
                  statistical change, not a diagnosed disruption.
                </p>
                {evidenceOps(
                  "flight",
                  panelFlight.geometry.coordinates,
                  "/cop/v1/flight-anomalies.geojson",
                )}
                  </>
                ) : null}
              </div>
            ) : (
              <p className="empty-evidence">
                {flightError ?? "Loading the air-access layer…"}
              </p>
            )
          ) : panelFocus === "rain" ? (
            panelRain ? (
              <div className={`selected-evidence ${previewing ? "preview" : ""}`}>
                <div className="evidence-heading">
                  <span className="direction-chip rain">
                    {panelRain.properties.heavy_hours} heavy hours
                  </span>
                  <span>Rain gauge</span>
                </div>
                <h3>{panelRain.properties.site_name}</h3>
                <p>GWRC Hilltop · real April 2026 record</p>
                <div className="count-comparison">
                  <div>
                    <span>Peak</span>
                    <strong>{panelRain.properties.peak.value_mm.toLocaleString("en-NZ")}</strong>
                  </div>
                  <div>
                    <span>Window total</span>
                    <strong>{panelRain.properties.window_total_mm.toLocaleString("en-NZ")}</strong>
                  </div>
                  <div>
                    <span>Violent hours</span>
                    <strong>{panelRain.properties.violent_hours.toLocaleString("en-NZ")}</strong>
                  </div>
                </div>
                {!previewing ? (
                  <>
                    <DailyStrip
                      points={panelRain.properties.daily_totals.map((day) => ({
                        date: day.date,
                        value: day.mm,
                        flagged: day.flagged,
                      }))}
                      label={`Daily rainfall at ${panelRain.properties.site_name}, 18–23 April 2026, heavy days highlighted`}
                    />
                    <dl className="evidence-metrics">
                      <div>
                        <dt>Peak hour</dt>
                        <dd>
                          {dayLabel(panelRain.properties.peak.observed_at.slice(0, 10))} ·{" "}
                          {panelRain.properties.peak.observed_at.slice(11, 16)} ·{" "}
                          {panelRain.properties.peak.value_mm} mm/h
                        </dd>
                      </div>
                      <div><dt>Cadence</dt><dd>hourly totals</dd></div>
                      <div title="Hours whose rolling 6-hour or 24-hour totals met the general MetService heavy-rain warning criteria (50 mm/6 h · 100 mm/24 h)">
                        <dt>MetService criteria</dt>
                        <dd>{panelRain.properties.warning_hours} h met · 50 mm/6 h or 100 mm/24 h</dd>
                      </div>
                      <div>
                        <dt>Position</dt>
                        <dd>
                          {panelRain.geometry.coordinates[1].toFixed(4)},{" "}
                          {panelRain.geometry.coordinates[0].toFixed(4)}
                        </dd>
                      </div>
                    </dl>
                    <p className="evidence-note">
                      Official gauge record. Intensity classes are WMO, warning
                      states are MetService criteria — a gauge fact, not an
                      issued warning.
                    </p>
                    {evidenceOps(
                      "rain",
                      panelRain.geometry.coordinates,
                      "/cop/v1/rain-april.geojson",
                    )}
                  </>
                ) : null}
              </div>
            ) : (
              <p className="empty-evidence">
                {rainError ?? "Loading the rainfall layer…"}
              </p>
            )
          ) : panelFocus === "report" ? (
            panelReport ? (
              <div className={`selected-evidence ${previewing ? "preview" : ""}`}>
                <div className="evidence-heading">
                  <span className={`direction-chip report-${panelReport.properties.level}`}>
                    {panelReport.properties.level}
                  </span>
                  <span>{panelReport.properties.report_id}</span>
                </div>
                <h3>{panelReport.properties.street}</h3>
                <p>
                  {panelReport.properties.category.replace("_", " ")} ·{" "}
                  {panelReport.properties.channel} · synthetic demonstration
                </p>
                <div className="count-comparison">
                  <div>
                    <span>Cluster</span>
                    <strong>{panelReport.properties.cluster_size.toLocaleString("en-NZ")}</strong>
                  </div>
                  <div>
                    <span>Source grade</span>
                    <strong>{panelReport.properties.source_grade}</strong>
                  </div>
                  <div>
                    <span>Corroborated</span>
                    <strong>{panelReport.properties.corroborated ? "yes" : "no"}</strong>
                  </div>
                </div>
                {!previewing ? (
                  <>
                    <dl className="evidence-metrics">
                      <div>
                        <dt>Logged</dt>
                        <dd>
                          {dayLabel(panelReport.properties.created_at.slice(0, 10))} ·{" "}
                          {panelReport.properties.created_at.slice(11, 16)}
                        </dd>
                      </div>
                      <div title="A report is corroborated when the movement detector holds a decrease signal for the same street within ±2 hours">
                        <dt>Corroboration</dt>
                        <dd>
                          {panelReport.properties.corroborated_by ??
                            "no independent stream in the window"}
                        </dd>
                      </div>
                      <div>
                        <dt>Level rule</dt>
                        <dd>A/B source or 5+ cluster → investigate · 3+ → elevated</dd>
                      </div>
                      <div>
                        <dt>Position</dt>
                        <dd>
                          {panelReport.geometry.coordinates[1].toFixed(4)},{" "}
                          {panelReport.geometry.coordinates[0].toFixed(4)}
                        </dd>
                      </div>
                    </dl>
                    <p className="evidence-note">
                      Synthetic records: enumerated categories, no personal
                      information. A level means investigate, never a confirmed
                      incident.
                    </p>
                    {evidenceOps(
                      "report",
                      panelReport.geometry.coordinates,
                      "/cop/v1/reports-april.geojson",
                    )}
                  </>
                ) : null}
              </div>
            ) : (
              <p className="empty-evidence">
                {reportError ?? "Loading the public-reports layer…"}
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
                {Array.isArray(panelSignal.properties.caveats) &&
                (panelSignal.properties.caveats as string[]).includes("heavy_rain_hour") ? (
                  <span
                    className="caveat-chip"
                    title="Any gauge at or above 10 mm/h (WMO heavy) this hour: the rise may be sensor degradation, not movement"
                  >
                    heavy-rain hour
                  </span>
                ) : null}
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
              {!previewing ? (
                <>
                  {Array.isArray(panelSignal.properties.matched_history) &&
                  panelSignal.properties.matched_history.length > 0 &&
                  typeof panelSignal.properties.matched_history[0] === "object" ? (
                    <TrendSparkline
                      history={panelSignal.properties.matched_history as SignalTrendPoint[]}
                      observed={Number(panelSignal.properties.observed_count)}
                      expected={Number(panelSignal.properties.expected_count)}
                      changeDirection={String(panelSignal.properties.change_direction)}
                    />
                  ) : null}
                  <dl className="evidence-metrics">
                    <div title="How many robust standard deviations the hour sits from its matched weekday-and-hour baseline">
                      <dt>Robust score</dt>
                      <dd>{Number(panelSignal.properties.robust_z).toFixed(1)} z</dd>
                    </div>
                    <div><dt>History</dt><dd>{Number((panelSignal.properties.signal_confidence as Record<string, number>).history_samples)} matched hours</dd></div>
                    <div><dt>Baseline confidence</dt><dd>{String((panelSignal.properties.signal_confidence as Record<string, string>).level)}</dd></div>
                    <div title="Other loaded sources in this case window; a missing source adds uncertainty, it does not clear the signal">
                      <dt>Corroboration</dt>
                      <dd>{corroboration}</dd>
                    </div>
                  </dl>
                  <p className="evidence-note">No cause inferred. Check operational context before acting.</p>
                  {evidenceOps(
                    "signal",
                    panelSignal.geometry.coordinates[0],
                    activeModel?.feed ?? "/cop/v1/movement-signals.geojson",
                    panelSignalReview ? (
                      <a href="/review">
                        {panelSignalReview.status === "closed" ? "Closed in review" : "In review"}
                      </a>
                    ) : (
                      <button
                        type="button"
                        onClick={() =>
                          openReview(
                            panelSignalKey!,
                            String(panelSignal.properties.name),
                            `${String(panelSignal.properties.transport_class)} · ${String(panelSignal.properties.direction)}`,
                          )
                        }
                      >
                        Send to review
                      </button>
                    ),
                  )}
                </>
              ) : null}
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
                  <small>
                    {String(feature.properties.transport_class)} · {String(feature.properties.direction)}
                    {(() => {
                      const item = review.items[signalKey(feature.properties)];
                      if (!item) return "";
                      return item.status === "closed" ? " · closed" : " · in review";
                    })()}
                    {Array.isArray(feature.properties.caveats) &&
                    (feature.properties.caveats as string[]).includes("heavy_rain_hour")
                      ? " · heavy-rain hour"
                      : ""}
                  </small>
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
                  ensureLayer("camera");
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
                  ensureLayer("transit");
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
                  ensureLayer("road");
                  revealOnMap(feature.geometry.coordinates);
                }}
              >
                <span>
                  <strong>{feature.properties.site_name}</strong>
                  <small>
                    SH{feature.properties.state_highway} · {dayLabel(feature.properties.date)}
                  </small>
                </span>
                <em className={feature.properties.severity === "HIGH" ? "road-high" : "road"}>
                  {feature.properties.ratio.toFixed(2)}×
                </em>
              </button>
            ))}
            <p className="list-group">Rain gauges ({rainFeatures.length} · real)</p>
            {rainFeatures.map((feature) => (
              <button
                type="button"
                key={feature.id}
                className={focus === "rain" && feature.id === selectedRain?.id ? "selected" : ""}
                onClick={() => {
                  setSelectedRainId(feature.id);
                  setFocus("rain");
                  ensureLayer("rain");
                  revealOnMap(feature.geometry.coordinates);
                }}
              >
                <span>
                  <strong>{feature.properties.site_name}</strong>
                  <small>
                    peak {feature.properties.peak.value_mm} mm/h ·{" "}
                    {feature.properties.heavy_hours} heavy h
                  </small>
                </span>
                <em className="rain">{feature.properties.window_total_mm}mm</em>
              </button>
            ))}
            <p className="list-group">Public reports ({reportFeatures.length} · synthetic)</p>
            {reportFeatures.map((feature) => (
              <button
                type="button"
                key={feature.id}
                className={focus === "report" && feature.id === selectedReport?.id ? "selected" : ""}
                onClick={() => {
                  setSelectedReportId(feature.id);
                  setFocus("report");
                  ensureLayer("report");
                  revealOnMap(feature.geometry.coordinates);
                }}
              >
                <span>
                  <strong>{feature.properties.street}</strong>
                  <small>
                    {feature.properties.category.replace("_", " ")} · grade{" "}
                    {feature.properties.source_grade} · cluster {feature.properties.cluster_size}
                  </small>
                </span>
                <em className={`report-${feature.properties.level}`}>
                  {feature.properties.level}
                </em>
              </button>
            ))}
            <p className="list-group">Air access ({flightFeatures.length} · real)</p>
            {flightFeatures.map((feature) => (
              <button
                type="button"
                key={feature.id}
                className={focus === "flight" && feature.id === selectedFlight?.id ? "selected" : ""}
                onClick={() => {
                  setSelectedFlightId(feature.id);
                  setFocus("flight");
                  ensureLayer("flight");
                  revealOnMap(feature.geometry.coordinates);
                }}
              >
                <span>
                  <strong>{feature.properties.site_name}</strong>
                  <small>
                    {feature.properties.iata} · {shortDate(feature.properties.window_start)} –{" "}
                    {shortDate(feature.properties.window_end)}
                  </small>
                </span>
                <em className="flight">
                  {feature.properties.high_hours + feature.properties.medium_hours}
                </em>
              </button>
            ))}
          </div>
          </div>
        </aside>
      </section>
      <CaseCharts
        event={activeEvent}
        model={activeModel}
        index={effectiveIndex}
        onScrub={scrubTo}
      />
    </div>
  );
}
