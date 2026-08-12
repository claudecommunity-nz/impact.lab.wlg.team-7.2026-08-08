"use client";

import Link from "next/link";
import {
  type CSSProperties,
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
import {
  openReview,
  reviewSnapshot,
  serverReviewSnapshot,
  signalKey,
  subscribeReview,
} from "./review-store";
import health from "../public/cop/v1/movement-health.json";

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
  type MapView,
  type ReplayCollection,
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
type LayerId = "signals" | "coverage" | "cameras" | "transit" | "roads" | "flights";
type Layers = Record<LayerId, boolean>;
type Focus = "signal" | "camera" | "transit" | "road" | "flight";
type Hover = {
  kind: Focus;
  id: string;
  left: number;
  top: number;
  above: boolean;
  /** Beak position in px from the popup's left edge, aimed at the anchor. */
  beakX: number;
};

const POPUP_WIDTH = 248;
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

/* The evidence column slides away rather than disappearing, so the map can grow
 * to the full frame when someone is scanning rather than investigating. */
const evidenceStore = createFlagStore("murmur.evidence.open", true);
/* Same remembered-flag pattern for the floating layer menu. */
const layerMenuStore = createFlagStore("murmur.layers.open", true);
/* Layer visibility is session state, never persisted: every load starts with
 * movement signals only, and every other layer is opt-in for that visit. */
const DEFAULT_LAYERS: Layers = {
  signals: true,
  coverage: false,
  cameras: false,
  transit: false,
  roads: false,
  flights: false,
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
];

type SearchHit = { kind: Focus; id: string; label: string; detail: string; coordinate: Coordinate };

/** Compass tokens from the source data, spelt out for the popup meta line. */
const COMPASS: Record<string, string> = {
  N: "north", NE: "north-east", E: "east", SE: "south-east",
  S: "south", SW: "south-west", W: "west", NW: "north-west",
};
const compass = (direction: string) => COMPASS[direction] ?? direction;

const PLAY_INTERVAL_MS = 900;
/** Multipliers on the base tick: one published slot per tick, faster or slower. */
const PLAY_SPEEDS = [0.5, 1, 2, 4, 5];

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/* Slot timestamps are Wellington wall-clock ISO strings; the label is read off
 * the string itself so a viewer in another timezone sees the published hour. */
function slotDateParts(targetAt: string) {
  const [datePart, timePart = "00:00"] = targetAt.split("T");
  const [year, month, day] = datePart.split("-").map(Number);
  return { year, month, day, time: timePart.slice(0, 5) };
}

function dayLabel(date: string) {
  const { year, month, day } = slotDateParts(date);
  const weekday = WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
  return `${weekday} ${day} ${MONTHS[month - 1]}`;
}

function slotLabel(targetAt: string) {
  return `${dayLabel(targetAt)} · ${slotDateParts(targetAt).time}`;
}

function shortDate(targetAt: string) {
  const { month, day } = slotDateParts(targetAt);
  return `${day} ${MONTHS[month - 1]}`;
}

/** A month of daily values as bars: flagged days highlighted, an optional
 * baseline as a dashed reference line. Reported days only — gaps stay gaps. */
function DailyStrip({
  points,
  reference,
  label,
}: {
  points: { date: string; value: number; flagged: boolean }[];
  reference?: number;
  label: string;
}) {
  if (points.length === 0) return null;
  const width = 232;
  const height = 44;
  const gap = 1.5;
  const max = Math.max(...points.map((point) => point.value), reference ?? 0, 1);
  const barWidth = (width - gap * (points.length - 1)) / points.length;
  const barHeight = (value: number) => Math.max((value / max) * (height - 2), 1);
  return (
    <figure className="trend-spark">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label}>
        {points.map((point, index) => (
          <rect
            key={point.date}
            className={point.flagged ? "bar now decrease" : "bar"}
            x={index * (barWidth + gap)}
            y={height - barHeight(point.value)}
            width={barWidth}
            height={barHeight(point.value)}
          />
        ))}
        {reference !== undefined ? (
          <line
            className="expected-line"
            x1={0}
            y1={height - (reference / max) * (height - 2)}
            x2={width}
            y2={height - (reference / max) * (height - 2)}
          />
        ) : null}
      </svg>
      <figcaption aria-hidden="true">
        <span>{shortDate(points[0].date)}</span>
        {reference !== undefined ? <span>usual {reference.toLocaleString("en-NZ")}</span> : null}
        <span>{shortDate(points[points.length - 1].date)}</span>
      </figcaption>
    </figure>
  );
}

/** Prior matched weekday/hour counts as bars, the observed hour highlighted,
 * and the expected median as a dashed reference line. */
function TrendSparkline({
  history,
  observed,
  expected,
  changeDirection,
}: {
  history: SignalTrendPoint[];
  observed: number;
  expected: number;
  changeDirection: string;
}) {
  if (history.length === 0) return null;
  const width = 232;
  const height = 44;
  const gap = 2;
  const counts = [...history.map((point) => point.observed_count), observed];
  const max = Math.max(...counts, expected, 1);
  const barWidth = (width - gap * (counts.length - 1)) / counts.length;
  const barHeight = (count: number) => Math.max((count / max) * (height - 2), 1);
  const expectedY = height - (expected / max) * (height - 2);
  return (
    <figure className="trend-spark">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`Observed ${observed.toLocaleString("en-NZ")} against ${history.length} prior matched hours, expected ${expected.toLocaleString("en-NZ")}`}
      >
        {counts.map((count, index) => {
          const now = index === counts.length - 1;
          return (
            <rect
              key={index}
              className={now ? `bar now ${changeDirection}` : "bar"}
              x={index * (barWidth + gap)}
              y={height - barHeight(count)}
              width={barWidth}
              height={barHeight(count)}
            />
          );
        })}
        <line className="expected-line" x1={0} y1={expectedY} x2={width} y2={expectedY} />
      </svg>
      <figcaption aria-hidden="true">
        <span>{shortDate(history[0].observed_at)}</span>
        <span>expected {expected.toLocaleString("en-NZ")}</span>
        <span>now</span>
      </figcaption>
    </figure>
  );
}

/** Investigation cases: each frames one published window by switching on
 * exactly the layers that hold data for it. Every case loads through the
 * same adapter — a `CaseModel` built from its own artifacts — so the timebar,
 * histogram, readout and signal layer are one code path per case. */
const EVENTS: {
  id: string;
  label: string;
  window: string;
  badge: string;
  tone: "replay" | "real";
  layers: Partial<Record<LayerId, boolean>>;
  focus: Focus;
  /** Readout copy while the case's artifacts are still loading. */
  fallbackLabel: string;
  fallbackNote: string;
}[] = [
  {
    id: "aug-snapshot",
    label: "Movement snapshot",
    window: "1–6 Aug 2026",
    badge: "Batch replay",
    tone: "replay",
    /* The standard view: movement signals only; everything else is opt-in. */
    layers: {
      signals: true,
      coverage: false,
      cameras: false,
      roads: false,
      flights: false,
      transit: false,
    },
    focus: "signal",
    fallbackLabel: slotLabel(health.target_at),
    fallbackNote: `${health.candidate_count} signals`,
  },
  {
    id: "april-floods",
    label: "Floods and storm",
    window: "18–22 Apr 2026",
    badge: "Real",
    tone: "real",
    /* Same standard start as every case: signals only. The April layers
     * (roads, flights, synthetic transit) come in when picked from the
     * drawer or a list, or the moment the April timeline is scrubbed. */
    layers: {
      signals: true,
      coverage: false,
      cameras: false,
      roads: false,
      flights: false,
      transit: false,
    },
    focus: "road",
    fallbackLabel: "18–22 Apr 2026",
    fallbackNote: "real event",
  },
];

/* ==================== the case-load adapter ====================
 * One normalized shape per case: hourly slots carrying the signal features
 * to draw, the up/down split, an optional daily background band, an optional
 * corroboration tick, and how the case filters the road diamonds. Adding a
 * case is one EVENTS entry plus one builder that returns this shape. */

type CaseSlot = {
  key: string;
  date: string;
  label: string;
  up: number;
  down: number;
  /** 0..1 daily background band (e.g. flagged road sites, day resolution). */
  wash: number;
  /** Hourly corroboration tick (e.g. a flagged airport hour). */
  tick: boolean;
  signals: LineFeature[];
};

type CaseModel = {
  slots: CaseSlot[];
  defaultIndex: number;
  /** Slots from the start shaded as the event window; 0 = no shading. */
  eventHours: number;
  /** The signal drawer's Open feed target for this case. */
  feed: string;
  /** Whether scrubbing filters the road diamonds to the slot's day. */
  roadDayFilter: boolean;
};

function buildAugCaseModel(
  replay: ReplayCollection | null,
  countlineGeometry: Map<string, Coordinate[]>,
): CaseModel | null {
  if (!replay || countlineGeometry.size === 0) return null;
  const slots = replay.slots.map((slot) => ({
    key: slot.target_at.slice(0, 13),
    date: slot.target_at.slice(0, 10),
    label: slotLabel(slot.target_at),
    up: slot.signals.filter((signal) => signal.change_direction === "increase").length,
    down: slot.signals.filter((signal) => signal.change_direction === "decrease").length,
    wash: 0,
    tick: false,
    signals: slot.signals.flatMap((signal) => {
      const coordinates = countlineGeometry.get(signal.countline_id);
      if (!coordinates) return [];
      return [
        {
          id: signal.id,
          geometry: { type: "LineString" as const, coordinates },
          properties: { ...signal },
        },
      ];
    }),
  }));
  return {
    slots,
    defaultIndex: Math.max(
      replay.slots.findIndex((slot) => slot.target_at === replay.default_target_at),
      0,
    ),
    eventHours: 0,
    feed: "/cop/v1/movement-signals.geojson",
    roadDayFilter: false,
  };
}

function buildAprilCaseModel(
  aprilMovement: AprilMovementCollection | null,
  roadFeatures: RoadFeature[],
  flightFeatures: FlightFeature[],
): CaseModel | null {
  if (!aprilMovement && roadFeatures.length === 0 && flightFeatures.length === 0) return null;
  const dates = ["2026-04-18", "2026-04-19", "2026-04-20", "2026-04-21", "2026-04-22", "2026-04-23"];
  const roadsByDate = new Map<string, number>();
  for (const feature of roadFeatures) {
    for (const day of feature.properties.daily_history ?? []) {
      if (day.flagged) roadsByDate.set(day.date, (roadsByDate.get(day.date) ?? 0) + 1);
    }
  }
  const maxRoads = Math.max(1, ...roadsByDate.values());
  const flightByHour = new Set<string>();
  for (const feature of flightFeatures) {
    for (const hour of feature.properties.flagged_hours) {
      flightByHour.add(`${hour.date}T${String(hour.hour).padStart(2, "0")}`);
    }
  }
  const signalsByHour = new Map<string, LineFeature[]>();
  for (const slot of aprilMovement?.slots ?? []) {
    signalsByHour.set(
      slot.target_at.slice(0, 13),
      slot.signals.map((signal) => {
        const { coordinates, ...properties } = signal;
        return {
          id: signal.id,
          geometry: { type: "LineString" as const, coordinates: [coordinates, coordinates] },
          properties,
        };
      }),
    );
  }
  const slots = dates.flatMap((date) =>
    Array.from({ length: 24 }, (_, hour) => {
      const key = `${date}T${String(hour).padStart(2, "0")}`;
      const signals = signalsByHour.get(key) ?? [];
      return {
        key,
        date,
        label: `${dayLabel(date)} · ${String(hour).padStart(2, "0")}:00`,
        up: signals.filter(
          (signal) => signal.properties.change_direction === "increase",
        ).length,
        down: signals.filter(
          (signal) => signal.properties.change_direction === "decrease",
        ).length,
        wash: (roadsByDate.get(date) ?? 0) / maxRoads,
        tick: flightByHour.has(key),
        signals,
      };
    }),
  );
  return {
    slots,
    defaultIndex: Math.max(
      slots.findIndex((slot) => slot.key === "2026-04-20T14"),
      0,
    ),
    eventHours: slots.filter((slot) => slot.date <= "2026-04-22").length,
    feed: "/cop/v1/movement-april.json",
    roadDayFilter: true,
  };
}

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
  const [aprilMovement, setAprilMovement] = useState<AprilMovementCollection | null>(null);
  const [selectedSignalId, setSelectedSignalId] = useState<string | null>(null);
  const [selectedCameraId, setSelectedCameraId] = useState<string | null>(null);
  const [selectedTransitId, setSelectedTransitId] = useState<string | null>(null);
  const [selectedRoadId, setSelectedRoadId] = useState<string | null>(null);
  const [selectedFlightId, setSelectedFlightId] = useState<string | null>(null);
  const [focus, setFocus] = useState<Focus>("signal");
  const [filter, setFilter] = useState<Filter>("all");
  const [error, setError] = useState<string | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [transitError, setTransitError] = useState<string | null>(null);
  const [roadError, setRoadError] = useState<string | null>(null);
  const [flightError, setFlightError] = useState<string | null>(null);
  const [frameNonce, setFrameNonce] = useState(0);
  // Remember which frame URL failed, so selecting another camera or refreshing
  // clears the failure without an effect.
  const [failedFrame, setFailedFrame] = useState<string | null>(null);
  const [view, setView] = useState<MapView>(DEFAULT_VIEW);
  // The hourly replay drives the signal layer once it loads; until then the
  // committed snapshot renders, so a failed fetch degrades to today's map.
  const [replay, setReplay] = useState<ReplayCollection | null>(null);
  const [playing, setPlaying] = useState(false);
  // The chosen investigation case is its own state: hand-toggling layers
  // afterwards changes the picture, never which case is open. Each case
  // remembers its own scrub position; -1 or absent means the case default.
  const [caseId, setCaseId] = useState<string>(EVENTS[0].id);
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
    fetch("/cop/v1/flight-anomalies.geojson")
      .then((response) => response.json())
      .then((collection: FlightCollection) => {
        setFlights(collection);
        setSelectedFlightId(collection.features[0]?.id ?? null);
      })
      .catch(() => setFlightError("The air-access layer could not be loaded."));
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
      "april-floods": buildAprilCaseModel(aprilMovement, roadFeatures, flightFeatures),
    }),
    [replay, countlineGeometry, aprilMovement, roadFeatures, flightFeatures],
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

  /* The investigate panel follows the pointer: hovering any glyph previews its
   * evidence, and the pinned selection returns when the pointer leaves. */
  const panelFocus: Focus = hover?.kind ?? focus;
  const panelSignal = hoveredSignal ?? selectedSignal;
  const panelCamera = hoveredCamera ?? selectedCamera;
  const panelTransit = hoveredTransit ?? selectedTransit;
  const panelRoad = hoveredRoad ?? selectedRoad;
  const panelFlight = hoveredFlight ?? selectedFlight;
  const previewing = Boolean(
    hoveredSignal || hoveredCamera || hoveredTransit || hoveredRoad || hoveredFlight,
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
      ? `${shownRoads.length} highway sites this day · air access ${
          activeCaseSlot?.tick ? "flagged" : "normal"
        }`
      : "none in this window · missing ≠ contradicting";

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
      roads: split(shownRoads, (feature) => feature.geometry.coordinates, layers.roads),
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
      if (layers.flights) {
        drawFlights(
          surface.context,
          project,
          flightFeatures,
          selectedFlight?.id ?? null,
          hover?.kind === "flight" ? hover.id : null,
          scale,
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
  useEffect(() => {
    if (!playing || !activeModel) return;
    const lastIndex = activeModel.slots.length - 1;
    const interval = setInterval(() => {
      if (indexRef.current >= lastIndex) {
        setPlaying(false);
        return;
      }
      setHover(null);
      const next = indexRef.current + 1;
      setSlotIndices((current) => ({ ...current, [caseId]: next }));
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
    );
    if (!bounds) return;
    autoFitRef.current = false;
    setHover(null);
    setView(fitView(bounds, size.width, size.height));
  }, [stageSize, layers, coverage, cameraFeatures, transitFeatures, roadFeatures, flightFeatures]);

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
    return hits.slice(0, SEARCH_LIMIT);
  }, [search, shownSignals, cameraFeatures, transitFeatures, roadFeatures, flightFeatures]);

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
    setHover(null);
    ensureLayer("signal");
    const clamped = Math.min(Math.max(index, 0), activeModel.slots.length - 1);
    setSlotIndices((current) => ({ ...current, [caseId]: clamped }));
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
    if (layers.flights) {
      const hit = pickNearest(flightFeatures, (feature) => feature.geometry.coordinates, project, point);
      if (hit) return place("flight", hit.id, project(hit.geometry.coordinates));
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
    } else if (hit.kind === "flight") {
      setSelectedFlightId(hit.id);
      setFocus("flight");
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
              {layers.flights ? <span><i className="flight" />Air access</span> : null}
            </div>
            {hover &&
            (hoveredCamera || hoveredSignal || hoveredTransit || hoveredRoad || hoveredFlight) ? (
              <div
                className={`map-popup ${hover.above ? "above" : "below"}`}
                style={
                  {
                    left: hover.left,
                    top: hover.top,
                    "--beak-x": `${hover.beakX}px`,
                  } as CSSProperties
                }
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
                      <Link href="/review">
                        {panelSignalReview.status === "closed" ? "Closed in review" : "In review"}
                      </Link>
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
    </div>
  );
}
