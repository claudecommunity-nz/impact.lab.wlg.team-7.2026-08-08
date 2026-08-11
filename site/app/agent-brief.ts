/**
 * What the chat agent knows.
 *
 * The brief is the committed COP artifacts, loaded once in the browser.
 * Answers are assembled from those numbers only — nothing is generated, so the
 * agent cannot invent a signal that is not in the feed. When an operator
 * configures an agent endpoint in /settings, the same brief is posted as
 * context and the endpoint answers instead.
 */

import type {
  CameraCollection,
  CameraFeature,
  LineCollection,
  LineFeature,
  RoadCollection,
  RoadFeature,
  TransitCollection,
  TransitFeature,
} from "./map-draw";
import { PEOPLE_CLASSES } from "./map-draw";

export type Health = {
  target_at: string;
  publisher_mode: string;
  observed_groups: number;
  expected_groups: number;
  data_gap_groups: number;
  candidate_count: number;
  insufficient_baseline_count: number;
  data_as_of: string;
  publisher_cadence: string;
  source: string;
  method: string;
  limitations: string[];
};

export type Brief = {
  health: Health | null;
  signals: LineFeature[];
  coverageCount: number;
  cameras: CameraFeature[];
  transit: TransitFeature[];
  transitStopCount: number;
  roads: RoadFeature[];
  roadEvent: string | null;
  errors: string[];
};

export type AgentReply = { text: string; sources: string[] };

export const EMPTY_BRIEF: Brief = {
  health: null,
  signals: [],
  coverageCount: 0,
  cameras: [],
  transit: [],
  transitStopCount: 0,
  roads: [],
  roadEvent: null,
  errors: [],
};

export const SUGGESTED_QUESTIONS = [
  "What changed in this batch?",
  "Which signal dropped the most?",
  "How reliable is this data?",
  "Any camera near the worst signal?",
  "What happened in the April floods?",
];

async function readJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
  return (await response.json()) as T;
}

/** One load per session; a failed feed degrades the brief instead of the chat. */
export async function loadBrief(): Promise<Brief> {
  const errors: string[] = [];
  const settled = await Promise.allSettled([
    readJson<Health>("/cop/v1/movement-health.json"),
    readJson<LineCollection>("/cop/v1/movement-signals.geojson"),
    readJson<LineCollection>("/cop/v1/countline-coverage.geojson"),
    readJson<CameraCollection>("/cop/v1/traffic-cameras.geojson"),
    readJson<TransitCollection>("/cop/v1/transit-anomalies.geojson"),
    readJson<RoadCollection>("/cop/v1/road-anomalies.geojson"),
  ]);
  const [health, signals, coverage, cameras, transit, roads] = settled;
  const note = (label: string, result: PromiseSettledResult<unknown>) => {
    if (result.status === "rejected") errors.push(`${label} did not load`);
  };
  note("Health", health);
  note("Signals", signals);
  note("Coverage", coverage);
  note("Cameras", cameras);
  note("PT anomalies", transit);
  note("State highways", roads);

  return {
    health: health.status === "fulfilled" ? health.value : null,
    signals: signals.status === "fulfilled" ? signals.value.features : [],
    coverageCount: coverage.status === "fulfilled" ? coverage.value.features.length : 0,
    cameras: cameras.status === "fulfilled" ? cameras.value.features : [],
    transit: transit.status === "fulfilled" ? transit.value.features : [],
    transitStopCount: transit.status === "fulfilled" ? transit.value.stop_count : 0,
    roads: roads.status === "fulfilled" ? roads.value.features : [],
    roadEvent: roads.status === "fulfilled" ? roads.value.event : null,
    errors,
  };
}

const text = (feature: LineFeature, key: string) => String(feature.properties[key] ?? "");
const num = (feature: LineFeature, key: string) => Number(feature.properties[key] ?? 0);

function signalLine(feature: LineFeature): string {
  const z = num(feature, "robust_z");
  return `· ${text(feature, "name")} — ${text(feature, "transport_class")} ${text(
    feature,
    "direction",
  )}, ${num(feature, "observed_count").toLocaleString("en-NZ")} observed vs ${num(
    feature,
    "expected_count",
  ).toLocaleString("en-NZ")} expected (${z > 0 ? "+" : ""}${z.toFixed(1)} z)`;
}

function byAbsoluteScore(features: LineFeature[]): LineFeature[] {
  return [...features].sort((a, b) => Math.abs(num(b, "robust_z")) - Math.abs(num(a, "robust_z")));
}

/** Metres between two WGS84 points, good enough for "which camera is nearest". */
function distanceMetres(a: [number, number], b: [number, number]): number {
  const latitudeScale = 111_320;
  const longitudeScale = latitudeScale * Math.cos(((a[1] + b[1]) / 2) * (Math.PI / 180));
  return Math.hypot((a[0] - b[0]) * longitudeScale, (a[1] - b[1]) * latitudeScale);
}

const STOP_WORDS = new Set([
  "the", "and", "any", "are", "for", "was", "with", "what", "which", "where", "how",
  "many", "much", "near", "show", "tell", "give", "about", "there", "this", "that",
  "signal", "signals", "camera", "cameras", "data", "from", "does", "did", "has",
]);

/** Crude singular: "quays" has to find "Thorndon Quay road". */
const stem = (word: string) => (word.length > 4 && word.endsWith("s") ? word.slice(0, -1) : word);

/** Name matching: any substantial word in the question that hits a feature name. */
function nameMatches(question: string, brief: Brief) {
  const words = question
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 3 && !STOP_WORDS.has(word))
    .map(stem);
  if (words.length === 0) return null;

  const hits = (name: string) => words.some((word) => name.toLowerCase().includes(word));
  const signals = brief.signals.filter((feature) => hits(text(feature, "name")));
  const cameras = brief.cameras.filter((feature) => hits(feature.properties.name));
  const transit = brief.transit.filter((feature) => hits(feature.properties.stop_name));
  const roads = brief.roads.filter((feature) => hits(feature.properties.site_name));
  if (signals.length + cameras.length + transit.length + roads.length === 0) return null;
  return { signals, cameras, transit, roads };
}

const DISCLAIMER =
  "Signals mean investigate, not diagnose. Not live emergency information — in an emergency, call 111.";

/**
 * Route a question to the numbers that answer it. Deliberately keyword-driven:
 * a wrong route says "I do not hold that", which is safer than a fluent guess.
 */
export function answer(question: string, brief: Brief): AgentReply {
  const query = question.toLowerCase().trim();
  const has = (...terms: string[]) => terms.some((term) => query.includes(term));
  const health = brief.health;

  if (query.length === 0) {
    return { text: "Ask me about the signals, the data quality, the cameras or PT.", sources: [] };
  }

  if (brief.signals.length === 0 && brief.errors.length > 0) {
    return {
      text: `I could not load the operating picture: ${brief.errors.join(", ")}. Test the sources in Data sources and try again.`,
      sources: [],
    };
  }

  if (/^(hello|hi|hey|kia ora|morena)\b/.test(query) && query.length < 20) {
    return {
      text: `Kia ora. I read the published Murmur artifacts: ${brief.signals.length} movement signals, ${brief.coverageCount} countlines, ${brief.cameras.length} NZTA cameras and ${brief.transit.length} PT anomaly hotspots. Ask what changed, how reliable it is, or about a specific street.`,
      sources: [],
    };
  }

  if (has("what can you", "help", "who are you", "what do you know")) {
    return {
      text: [
        "I answer from the committed COP artifacts only — no cause is inferred and nothing is generated.",
        "I can tell you: what changed in this batch, the biggest increase or decrease, people vs vehicles,",
        "data gaps and confidence, cameras near a place, PT anomaly hotspots, the published limitations,",
        "and where the feeds live. Ask about a street name and I will look it up.",
      ].join(" "),
      sources: [],
    };
  }

  if (has("limitation", "cannot tell", "caveat", "what can't", "what cant", "trust")) {
    const limits = health?.limitations ?? [];
    return {
      text: [`Published limitations (${limits.length}):`, ...limits.map((line) => `· ${line}`), DISCLAIMER].join(
        "\n",
      ),
      sources: ["/cop/v1/movement-health.json"],
    };
  }

  if (has("gap", "missing", "quality", "reliab", "confiden", "baseline", "how old", "age")) {
    if (!health) return { text: "The health file did not load, so I cannot speak to data quality.", sources: [] };
    const lowConfidence = brief.signals.filter(
      (feature) =>
        String((feature.properties.signal_confidence as Record<string, string>)?.level) === "low",
    ).length;
    return {
      text: [
        `${health.data_gap_groups} baseline groups expected at this weekday and hour are absent from the batch. They are recorded as data gaps, never filled as zero.`,
        `${health.insufficient_baseline_count} groups have too little history to score at all, and ${lowConfidence} of the ${brief.signals.length} signals carry low baseline confidence.`,
        `Method: ${health.method}. Publisher cadence: ${health.publisher_cadence}. Data as of ${health.data_as_of}.`,
        DISCLAIMER,
      ].join("\n"),
      sources: ["/cop/v1/movement-health.json", "/cop/v1/movement-signals.geojson"],
    };
  }

  if (has("api", "feed", "endpoint", "geojson", "export", "download", "mcp", "a2a", "integrat")) {
    return {
      text: [
        "Every layer ships as a file on the same WGS84 frame:",
        "· /cop/v1/movement-signals.geojson — signals with observed, expected, robust score, confidence",
        "· /cop/v1/movement-replay.json — 144 published hours, 1–6 Aug 2026, with matched history",
        "· /cop/v1/movement-april.json — street-level April backtest signals, 18–23 Apr 2026",
        "· /cop/v1/countline-coverage.geojson — every measured countline",
        "· /cop/v1/traffic-cameras.geojson — NZTA camera positions",
        "· /cop/v1/transit-anomalies.geojson — Metlink hotspots (labelled synthetic)",
        "· /cop/v1/road-anomalies.geojson — NZTA state-highway sites, real April 2026 floods",
        "· /cop/v1/flight-anomalies.geojson — WLG air access, real April 2026, OpenSky",
        "· /cop/v1/movement-health.json — counts, gaps, data age, limitations",
        "Data sources in the sidebar exports any of them as GeoJSON, JSON, CSV or NDJSON, and builds the MCP and A2A config.",
      ].join("\n"),
      sources: [],
    };
  }

  if (has("flood", "storm", "highway", "sh1", "sh2", "sh58", "sh59", "april", "remutaka", "waka kotahi", "closure")) {
    const top = brief.roads.slice(0, 3);
    if (top.length === 0) return { text: "The state-highway layer did not load.", sources: [] };
    return {
      text: [
        `Real event: ${brief.roadEvent}. ${brief.roads.length} state-highway sites flagged, worst first:`,
        ...top.map(
          (feature) =>
            `· ${feature.properties.site_name} (SH${feature.properties.state_highway}) — ${feature.properties.observed_count.toLocaleString(
              "en-NZ",
            )} vs ${feature.properties.baseline_median.toLocaleString("en-NZ")} usual, ${feature.properties.ratio.toFixed(2)}× (${feature.properties.robust_z.toFixed(1)} z)`,
        ),
        "Real NZTA daily counts with a two-day lag: a backtest, not a live detector.",
        DISCLAIMER,
      ].join("\n"),
      sources: ["/cop/v1/road-anomalies.geojson"],
    };
  }

  if (has("bus", "transit", "metlink", "public transport", "train", "hotspot", " pt ")) {
    const top = brief.transit.slice(0, 3);
    if (top.length === 0) return { text: "The PT anomaly layer did not load.", sources: [] };
    return {
      text: [
        `${brief.transit.length} anomaly hotspots across ${brief.transitStopCount} Metlink stops. Worst three:`,
        ...top.map(
          (feature) =>
            `· ${feature.properties.stop_name} — ${feature.properties.anomaly_count} anomalies, ${feature.properties.high_count} high, mostly ${feature.properties.top_detector}`,
        ),
        `Worst single example: ${top[0].properties.worst_example.detail}`,
        "This layer is a labelled synthetic replay over the real April 2026 timetable. It does not describe an actual event.",
      ].join("\n"),
      sources: ["/cop/v1/transit-anomalies.geojson"],
    };
  }

  if (has("camera", "cctv", "frame", "corrobor")) {
    const offline = brief.cameras.filter((feature) => feature.properties.offline).length;
    const onFrame = brief.cameras.filter(
      (feature) => feature.properties.within_countline_frame,
    ).length;
    const worst = byAbsoluteScore(brief.signals)[0];
    const nearest =
      worst && brief.cameras.length > 0
        ? [...brief.cameras].sort(
            (a, b) =>
              distanceMetres(a.geometry.coordinates, worst.geometry.coordinates[0]) -
              distanceMetres(b.geometry.coordinates, worst.geometry.coordinates[0]),
          )[0]
        : null;
    return {
      text: [
        `${brief.cameras.length} NZTA cameras are catalogued, ${onFrame} of them inside the countline frame and ${offline} flagged offline.`,
        nearest && worst
          ? `Nearest camera to the strongest signal (${text(worst, "name")}) is ${nearest.properties.name}, about ${Math.round(
              distanceMetres(nearest.geometry.coordinates, worst.geometry.coordinates[0]),
            ).toLocaleString("en-NZ")} m away.`
          : "",
        "A frame is a snapshot, not a count. Cameras watch state highways, so they corroborate a countline signal — they do not measure one.",
      ]
        .filter(Boolean)
        .join("\n"),
      sources: ["/cop/v1/traffic-cameras.geojson"],
    };
  }

  if (has("pedestrian", "people", "foot", "walking", "cyclist", "scooter")) {
    const people = brief.signals.filter((feature) =>
      PEOPLE_CLASSES.has(text(feature, "transport_class")),
    );
    return {
      text: people.length
        ? [`${people.length} of ${brief.signals.length} signals are people movement:`, ...byAbsoluteScore(people).map(signalLine), DISCLAIMER].join("\n")
        : "No pedestrian, cyclist or scooter signals cleared the gates in this batch.",
      sources: ["/cop/v1/movement-signals.geojson"],
    };
  }

  if (has("vehicle", "car", "traffic", "truck", "bus lane")) {
    const vehicles = brief.signals.filter(
      (feature) => !PEOPLE_CLASSES.has(text(feature, "transport_class")),
    );
    return {
      text: vehicles.length
        ? [`${vehicles.length} of ${brief.signals.length} signals are vehicle movement:`, ...byAbsoluteScore(vehicles).map(signalLine), DISCLAIMER].join("\n")
        : "No vehicle signals cleared the gates in this batch.",
      sources: ["/cop/v1/movement-signals.geojson"],
    };
  }

  if (has("drop", "decrease", "fell", "down", "quiet", "fewer")) {
    const drops = byAbsoluteScore(
      brief.signals.filter((feature) => text(feature, "change_direction") === "decrease"),
    );
    return {
      text: drops.length
        ? [`${drops.length} signals are decreases. Largest first:`, ...drops.slice(0, 5).map(signalLine), DISCLAIMER].join("\n")
        : "No decreases cleared the gates in this batch.",
      sources: ["/cop/v1/movement-signals.geojson"],
    };
  }

  if (has("increase", "rose", "spike", "busier", "more than expected", "up ")) {
    const rises = byAbsoluteScore(
      brief.signals.filter((feature) => text(feature, "change_direction") === "increase"),
    );
    return {
      text: rises.length
        ? [`${rises.length} signals are increases. Largest first:`, ...rises.slice(0, 5).map(signalLine), DISCLAIMER].join("\n")
        : "No increases cleared the gates in this batch.",
      sources: ["/cop/v1/movement-signals.geojson"],
    };
  }

  if (has("biggest", "largest", "worst", "top", "strongest", "most")) {
    const ranked = byAbsoluteScore(brief.signals).slice(0, 5);
    return {
      text: ranked.length
        ? ["Strongest signals by robust score:", ...ranked.map(signalLine), DISCLAIMER].join("\n")
        : "No signals cleared the gates in this batch.",
      sources: ["/cop/v1/movement-signals.geojson"],
    };
  }

  const matches = nameMatches(question, brief);
  if (matches) {
    const lines: string[] = [];
    if (matches.signals.length) {
      lines.push(`${matches.signals.length} matching signal(s):`, ...matches.signals.map(signalLine));
    }
    if (matches.cameras.length) {
      lines.push(
        `${matches.cameras.length} matching camera(s):`,
        ...matches.cameras
          .slice(0, 5)
          .map(
            (feature) =>
              `· ${feature.properties.name} — ${feature.properties.direction || "direction not published"}, ${
                feature.properties.offline ? "offline" : "online"
              }`,
          ),
      );
    }
    if (matches.transit.length) {
      lines.push(
        `${matches.transit.length} matching PT hotspot(s):`,
        ...matches.transit
          .slice(0, 5)
          .map(
            (feature) =>
              `· ${feature.properties.stop_name} — ${feature.properties.anomaly_count} anomalies, ${feature.properties.high_count} high (synthetic replay)`,
          ),
      );
    }
    if (matches.roads.length) {
      lines.push(
        `${matches.roads.length} matching state-highway site(s):`,
        ...matches.roads
          .slice(0, 5)
          .map(
            (feature) =>
              `· ${feature.properties.site_name} (SH${feature.properties.state_highway}) — ${feature.properties.ratio.toFixed(2)}× usual on ${feature.properties.date} (real April 2026 floods)`,
          ),
      );
    }
    lines.push(DISCLAIMER);
    return { text: lines.join("\n"), sources: ["/cop/v1/movement-signals.geojson"] };
  }

  if (has("what changed", "summary", "overview", "status", "brief", "batch", "how many")) {
    if (!health) return { text: "The health file did not load, so I cannot summarise the batch.", sources: [] };
    const ranked = byAbsoluteScore(brief.signals).slice(0, 3);
    return {
      text: [
        `${health.candidate_count} signals worth investigating at ${health.target_at}, out of ${health.observed_groups.toLocaleString("en-NZ")} observed groups across ${brief.coverageCount} countlines.`,
        `${health.data_gap_groups} data gaps and ${health.insufficient_baseline_count} groups without enough baseline.`,
        ...ranked.map(signalLine),
        `Publisher mode: ${health.publisher_mode}, ${health.publisher_cadence}. ${DISCLAIMER}`,
      ].join("\n"),
      sources: ["/cop/v1/movement-health.json", "/cop/v1/movement-signals.geojson"],
    };
  }

  return {
    text: [
      "I do not hold an answer to that in the published artifacts, so I will not guess.",
      `What I do hold: ${brief.signals.length} signals, ${brief.coverageCount} countlines, ${brief.cameras.length} cameras, ${brief.transit.length} PT hotspots, ${brief.roads.length} state-highway flood sites and the batch health file.`,
      "Try a street name, \"biggest drop\", \"data gaps\", \"cameras\", \"PT hotspots\" or \"April floods\".",
    ].join("\n"),
    sources: [],
  };
}

/** The compact context posted to a configured agent endpoint. */
export function briefContext(brief: Brief) {
  return {
    schema: "murmur-agent-context/v1",
    health: brief.health,
    coverage_countlines: brief.coverageCount,
    signals: brief.signals.map((feature) => ({
      id: feature.id,
      ...feature.properties,
    })),
    cameras: brief.cameras.slice(0, 40).map((feature) => ({
      id: feature.id,
      name: feature.properties.name,
      offline: feature.properties.offline,
      within_countline_frame: feature.properties.within_countline_frame,
      coordinates: feature.geometry.coordinates,
    })),
    transit_hotspots: brief.transit.slice(0, 40).map((feature) => ({
      id: feature.id,
      stop_name: feature.properties.stop_name,
      anomaly_count: feature.properties.anomaly_count,
      high_count: feature.properties.high_count,
      top_detector: feature.properties.top_detector,
      synthetic: true,
    })),
    road_anomalies: brief.roads.slice(0, 40).map((feature) => ({
      id: feature.id,
      site_name: feature.properties.site_name,
      state_highway: feature.properties.state_highway,
      date: feature.properties.date,
      ratio: feature.properties.ratio,
      robust_z: feature.properties.robust_z,
      severity: feature.properties.severity,
      real_event: true,
    })),
    road_event: brief.roadEvent,
    guardrails: [
      "Signals mean investigate. Do not diagnose disruption, evacuation or loss of access.",
      "Missing records are data gaps, never zero movement.",
      "Public transport anomalies are a labelled synthetic replay.",
      "State-highway anomalies are a real April 2026 flood backtest: daily NZTA counts, two-day lag.",
      "Not live emergency information. In an emergency, call 111.",
    ],
  };
}
