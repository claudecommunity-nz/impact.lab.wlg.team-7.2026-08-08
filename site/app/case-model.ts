/* ==================== the case-load adapter ====================
 * One normalized shape per case: hourly slots carrying the signal features
 * to draw, the up/down split, an optional daily background band, an optional
 * corroboration tick, and how the case filters the road diamonds. Adding a
 * case is one EVENTS entry plus one builder that returns this shape. */

import health from "../public/cop/v1/movement-health.json";
import type {
  AprilMovementCollection,
  Coordinate,
  FlightFeature,
  LineFeature,
  LiveSimCollection,
  RainHourly,
  ReplayCollection,
  RoadFeature,
} from "./map-draw";

export type Filter = "all" | "people" | "vehicles";
export type LayerId = "signals" | "coverage" | "cameras" | "transit" | "roads" | "flights" | "rain" | "reports";
export type Layers = Record<LayerId, boolean>;
export type Focus = "signal" | "camera" | "transit" | "road" | "flight" | "rain" | "report";
export type SearchHit = { kind: Focus; id: string; label: string; detail: string; coordinate: Coordinate };

/** Compass tokens from the source data, spelt out for the popup meta line. */
const COMPASS: Record<string, string> = {
  N: "north", NE: "north-east", E: "east", SE: "south-east",
  S: "south", SW: "south-west", W: "west", NW: "north-west",
};
export const compass = (direction: string) => COMPASS[direction] ?? direction;

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/* Slot timestamps are Wellington wall-clock ISO strings; the label is read off
 * the string itself so a viewer in another timezone sees the published hour. */
function slotDateParts(targetAt: string) {
  const [datePart, timePart = "00:00"] = targetAt.split("T");
  const [year, month, day] = datePart.split("-").map(Number);
  return { year, month, day, time: timePart.slice(0, 5) };
}

export function dayLabel(date: string) {
  const { year, month, day } = slotDateParts(date);
  const weekday = WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
  return `${weekday} ${day} ${MONTHS[month - 1]}`;
}

export function slotLabel(targetAt: string) {
  return `${dayLabel(targetAt)} · ${slotDateParts(targetAt).time}`;
}

export function shortDate(targetAt: string) {
  const { month, day } = slotDateParts(targetAt);
  return `${day} ${MONTHS[month - 1]}`;
}

/** Investigation cases: each frames one published window by switching on
 * exactly the layers that hold data for it. Every case loads through the
 * same adapter — a `CaseModel` built from its own artifacts — so the timebar,
 * histogram, readout and signal layer are one code path per case. */
export const EVENTS: {
  id: string;
  label: string;
  window: string;
  badge: string;
  tone: "replay" | "real" | "synthetic";
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
  {
    id: "live-sim",
    label: "Live monitor",
    window: "simulated now",
    badge: "Synthetic",
    tone: "synthetic",
    /* The monitor mode: a simulated live feed, signals only like every case. */
    layers: {
      signals: true,
      coverage: false,
      cameras: false,
      roads: false,
      flights: false,
      transit: false,
    },
    focus: "signal",
    fallbackLabel: "simulated now",
    fallbackNote: "synthetic feed",
  },
];

export type CaseSlot = {
  key: string;
  date: string;
  label: string;
  up: number;
  down: number;
  /** 0..1 daily background band (e.g. flagged road sites, day resolution). */
  wash: number;
  /** Hourly corroboration tick (e.g. a flagged airport hour). */
  tick: boolean;
  /** Peak gauge rainfall for the hour, mm/h; 0 when no rain layer exists. */
  rainMm: number;
  /** True when any gauge hit the WMO heavy class (>= 10 mm/h) this hour. */
  rainFlag: boolean;
  /** True when any gauge's rolling totals met the MetService warning criteria. */
  rainWarning: boolean;
  signals: LineFeature[];
};

export type CaseModel = {
  slots: CaseSlot[];
  defaultIndex: number;
  /** Slots from the start shaded as the event window; 0 = no shading. */
  eventHours: number;
  /** The signal drawer's Open feed target for this case. */
  feed: string;
  /** Whether scrubbing filters the road diamonds to the slot's day. */
  roadDayFilter: boolean;
};

export function buildAugCaseModel(
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
    rainMm: 0,
    rainFlag: false,
    rainWarning: false,
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

export function buildAprilCaseModel(
  aprilMovement: AprilMovementCollection | null,
  roadFeatures: RoadFeature[],
  flightFeatures: FlightFeature[],
  rainHourly: RainHourly[],
): CaseModel | null {
  if (!aprilMovement && roadFeatures.length === 0 && flightFeatures.length === 0) return null;
  const rainByHour = new Map(rainHourly.map((entry) => [entry.hour.slice(0, 13), entry]));
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
        rainMm: rainByHour.get(key)?.max_mm ?? 0,
        rainFlag: ["heavy", "violent"].includes(rainByHour.get(key)?.class ?? ""),
        rainWarning: (rainByHour.get(key)?.warning_stations ?? 0) > 0,
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

export function buildLiveSimCaseModel(liveSim: LiveSimCollection | null): CaseModel | null {
  if (!liveSim) return null;
  const slots = liveSim.slots.map((slot) => ({
    key: slot.target_at.slice(0, 13),
    date: slot.target_at.slice(0, 10),
    label: slotLabel(slot.target_at),
    up: slot.signals.filter((signal) => signal.change_direction === "increase").length,
    down: slot.signals.filter((signal) => signal.change_direction === "decrease").length,
    wash: 0,
    tick: false,
    rainMm: slot.rain_max_mm,
    rainFlag: slot.rain_max_mm >= 10,
    rainWarning: slot.rain_warning_stations > 0,
    signals: slot.signals.map((signal) => {
      const { coordinates, ...properties } = signal;
      return {
        id: signal.id,
        geometry: { type: "LineString" as const, coordinates: [coordinates, coordinates] },
        properties,
      };
    }),
  }));
  return {
    slots,
    // The monitor opens on "now": the last simulated hour.
    defaultIndex: Math.max(slots.length - 1, 0),
    eventHours: 0,
    feed: "/cop/v1/live-sim.json",
    roadDayFilter: false,
  };
}
