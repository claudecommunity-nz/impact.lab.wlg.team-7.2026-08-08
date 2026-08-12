/**
 * The source registry behind /settings.
 *
 * Everything here runs in the browser. The four committed COP files are the
 * built-in sources; anything an operator adds is stored in `localStorage` only,
 * so this repo never holds someone else's endpoint or token. Probing is a plain
 * `fetch` with a timer around it — status and last sync are measured, never
 * asserted.
 */

export type SourceFormat = "geojson" | "json" | "csv" | "ndjson";
export type SourceKind = "builtin" | "custom";
export type SourceStatus = "unknown" | "checking" | "ok" | "degraded" | "failed";

export type DataSource = {
  id: string;
  label: string;
  publisher: string;
  url: string;
  format: SourceFormat;
  kind: SourceKind;
  cadence: string;
  note: string;
};

/** Measured, never assumed: every field comes from an actual request. */
export type SourceProbe = {
  status: SourceStatus;
  checkedAt: string | null;
  lastSyncAt: string | null;
  latencyMs: number | null;
  recordCount: number | null;
  message: string;
};

export type IntegrationKind = "rest" | "mcp" | "a2a" | "webhook";

export type Integration = {
  id: string;
  kind: IntegrationKind;
  label: string;
  url: string;
  token: string;
  enabled: boolean;
};

export type AgentProvider = "none" | "anthropic" | "openai" | "google" | "deepseek" | "custom";

export type AgentConfig = {
  /** "none" means the chat answers locally from the loaded artifacts. */
  provider: AgentProvider;
  /** Custom provider only: where questions are POSTed. */
  endpoint: string;
  model: string;
  apiKey: string;
};

/**
 * Hosted model providers the chat can link to. The key is typed in /settings,
 * stored in this browser's localStorage only, and sent only to the matching
 * provider host — this public repo and the site itself never receive it.
 */
export const AGENT_PROVIDERS: Record<
  Exclude<AgentProvider, "none" | "custom">,
  {
    label: string;
    host: string;
    keyUrl: string;
    keyHint: string;
    defaultModel: string;
    models: string[];
    note: string;
  }
> = {
  anthropic: {
    label: "Anthropic Claude",
    host: "api.anthropic.com",
    keyUrl: "https://platform.claude.com/settings/keys",
    keyHint: "sk-ant-…",
    defaultModel: "claude-opus-5",
    models: [
      "claude-opus-5",
      "claude-sonnet-5",
      "claude-fable-5",
      "claude-opus-4-8",
      "claude-haiku-4-5",
    ],
    note: "Answers come straight from Anthropic; a safety decline is reported as such.",
  },
  openai: {
    label: "OpenAI",
    host: "api.openai.com",
    keyUrl: "https://platform.openai.com/api-keys",
    keyHint: "sk-…",
    defaultModel: "gpt-5.1",
    models: ["gpt-5.1", "gpt-5.1-mini", "gpt-5", "gpt-4.1", "gpt-4o"],
    note: "Model names change often — type any current one; the list is only a suggestion.",
  },
  google: {
    label: "Google Gemini",
    host: "generativelanguage.googleapis.com",
    keyUrl: "https://aistudio.google.com/apikey",
    keyHint: "AIza…",
    defaultModel: "gemini-3-pro-preview",
    models: [
      "gemini-3-pro-preview",
      "gemini-2.5-pro",
      "gemini-2.5-flash",
      "gemini-2.5-flash-lite",
    ],
    note: "Uses the Gemini API key from AI Studio, not a Cloud service account.",
  },
  deepseek: {
    label: "DeepSeek",
    host: "api.deepseek.com",
    keyUrl: "https://platform.deepseek.com/api_keys",
    keyHint: "sk-…",
    defaultModel: "deepseek-chat",
    models: ["deepseek-chat", "deepseek-reasoner"],
    note: "If the provider blocks browser calls (CORS), the chat falls back to local answers.",
  },
};

export function isAgentProvider(value: unknown): value is AgentProvider {
  return (
    value === "none" ||
    value === "custom" ||
    (typeof value === "string" && value in AGENT_PROVIDERS)
  );
}

export type Settings = {
  version: 1;
  sources: DataSource[];
  integrations: Integration[];
  agent: AgentConfig;
};

export const SETTINGS_KEY = "murmur.settings.v1";
export const PROBE_KEY = "murmur.probes.v1";
export const PROBE_TIMEOUT_MS = 8_000;

export const FORMAT_LABELS: Record<SourceFormat, string> = {
  geojson: "GeoJSON",
  json: "JSON",
  csv: "CSV",
  ndjson: "NDJSON",
};

export const STATUS_LABELS: Record<SourceStatus, string> = {
  unknown: "not tested",
  checking: "testing…",
  ok: "reachable",
  degraded: "reachable, odd payload",
  failed: "failed",
};

/** The committed contract. These seven files are what the site actually reads. */
export const BUILTIN_SOURCES: DataSource[] = [
  {
    id: "movement-signals",
    label: "Movement signals",
    publisher: "Wellington City Council Transport Sensors",
    url: "/cop/v1/movement-signals.geojson",
    format: "geojson",
    kind: "builtin",
    cadence: "batch replay · at least monthly",
    note: "Countline signals with observed, expected, robust score and confidence.",
  },
  {
    id: "movement-replay",
    label: "Hourly replay",
    publisher: "Wellington City Council Transport Sensors",
    url: "/cop/v1/movement-replay.json",
    format: "json",
    kind: "builtin",
    cadence: "batch replay · 1–6 Aug 2026, hourly slots",
    note: "144 published hours with per-signal matched history for the timebar.",
  },
  {
    id: "movement-april",
    label: "April movement backtest",
    publisher: "Wellington City Council Transport Sensors",
    url: "/cop/v1/movement-april.json",
    format: "json",
    kind: "builtin",
    cadence: "retrospective backtest · 18–23 Apr 2026, hourly",
    note: "Street-level signals for the floods case. Never event-time evidence.",
  },
  {
    id: "rain-april",
    label: "April rainfall",
    publisher: "Greater Wellington Regional Council (Hilltop)",
    url: "/cop/v1/rain-april.geojson",
    format: "geojson",
    kind: "builtin",
    cadence: "official record · 18–23 Apr 2026, hourly",
    note: "Real gauge record. Intensity classes are WMO definitions.",
  },
  {
    id: "reports-april",
    label: "April public reports",
    publisher: "WCC service desk (synthetic)",
    url: "/cop/v1/reports-april.geojson",
    format: "geojson",
    kind: "builtin",
    cadence: "synthetic demonstration · 18–23 Apr 2026",
    note: "Synthetic ticket flow: clustering, source grades, corroboration rule.",
  },
  {
    id: "countline-coverage",
    label: "Sensor coverage",
    publisher: "Wellington City Council Transport Sensors",
    url: "/cop/v1/countline-coverage.geojson",
    format: "geojson",
    kind: "builtin",
    cadence: "batch replay · at least monthly",
    note: "Every measured countline, so absence reads as a gap and not a zero.",
  },
  {
    id: "traffic-cameras",
    label: "Traffic cameras",
    publisher: "NZTA Traffic and Travel API",
    url: "/cop/v1/traffic-cameras.geojson",
    format: "geojson",
    kind: "builtin",
    cadence: "catalogue rebuilt on demand · frames every few minutes",
    note: "Camera positions only. Frames load straight from NZTA in the browser.",
  },
  {
    id: "transit-anomalies",
    label: "Public transport anomalies",
    publisher: "Metlink GTFS © Greater Wellington Regional Council",
    url: "/cop/v1/transit-anomalies.geojson",
    format: "geojson",
    kind: "builtin",
    cadence: "synthetic April 2026 replay",
    note: "Labelled synthetic running over the real timetable. Not a real event.",
  },
  {
    id: "road-anomalies",
    label: "State highway anomalies",
    publisher: "NZ Transport Agency Waka Kotahi, NZTA Open Data",
    url: "/cop/v1/road-anomalies.geojson",
    format: "geojson",
    kind: "builtin",
    cadence: "April 2026 backtest · daily counts, two-day lag",
    note: "Real 20-21 April 2026 flood event. TMS counts scored per site.",
  },
  {
    id: "flight-anomalies",
    label: "Air access anomalies",
    publisher: "OpenSky Network",
    url: "/cop/v1/flight-anomalies.geojson",
    format: "geojson",
    kind: "builtin",
    cadence: "April 2026 backtest · hourly movements",
    note: "Real WLG flight movements scored per hour. Not an airport feed.",
  },
  {
    id: "movement-health",
    label: "Coverage and health",
    publisher: "Wellington City Council Transport Sensors",
    url: "/cop/v1/movement-health.json",
    format: "json",
    kind: "builtin",
    cadence: "batch replay · at least monthly",
    note: "Candidate count, data gaps, data age and the published limitations.",
  },
];

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  sources: [],
  integrations: [],
  agent: { provider: "none", endpoint: "", model: "", apiKey: "" },
};

export function loadSettings(): Settings {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    return normaliseSettings(JSON.parse(raw));
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(settings: Settings) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* Private-mode browsers refuse writes; the session still works in memory. */
  }
}

/*
 * Both stores are read through `useSyncExternalStore`, so a component never has
 * to set state in an effect to pick up what the browser already knows.
 */
const settingsListeners = new Set<() => void>();
let settingsCache: Settings | null = null;

export function subscribeSettings(listener: () => void) {
  settingsListeners.add(listener);
  return () => {
    settingsListeners.delete(listener);
  };
}

export function settingsSnapshot(): Settings {
  settingsCache ??= loadSettings();
  return settingsCache;
}

/** SSR and hydration see the defaults; the real values arrive on first paint. */
export function serverSettingsSnapshot(): Settings {
  return DEFAULT_SETTINGS;
}

export function writeSettings(next: Settings) {
  settingsCache = next;
  saveSettings(next);
  settingsListeners.forEach((listener) => listener());
}

const EMPTY_PROBES: Record<string, SourceProbe> = {};
const probeListeners = new Set<() => void>();
let probeCache: Record<string, SourceProbe> | null = null;

export function subscribeProbes(listener: () => void) {
  probeListeners.add(listener);
  return () => {
    probeListeners.delete(listener);
  };
}

export function probesSnapshot(): Record<string, SourceProbe> {
  probeCache ??= loadProbes();
  return probeCache;
}

export function serverProbesSnapshot(): Record<string, SourceProbe> {
  return EMPTY_PROBES;
}

export function writeProbe(id: string, probe: SourceProbe) {
  probeCache = { ...probesSnapshot(), [id]: probe };
  saveProbes(probeCache);
  probeListeners.forEach((listener) => listener());
}

/**
 * The key as it exists in `localStorage` right now, masked. Read straight from
 * storage rather than from React state, so the panel can prove the save landed
 * instead of echoing back what was typed.
 */
export function storedAgentKey(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (!raw) return null;
    const stored = (JSON.parse(raw) as Partial<Settings>).agent?.apiKey ?? "";
    return stored ? String(stored) : null;
  } catch {
    return null;
  }
}

export function maskSecret(secret: string): string {
  if (secret.length <= 10) return "•".repeat(Math.max(secret.length, 4));
  return `${secret.slice(0, 6)}…${secret.slice(-4)}`;
}

/** For values that never change after load, such as the page origin. */
export const noopSubscribe = () => () => {};

export function originSnapshot(): string {
  return typeof window === "undefined" ? "" : window.location.origin;
}

export function loadProbes(): Record<string, SourceProbe> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(PROBE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, SourceProbe>) : {};
  } catch {
    return {};
  }
}

export function saveProbes(probes: Record<string, SourceProbe>) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PROBE_KEY, JSON.stringify(probes));
  } catch {
    /* ignored — probe history is a convenience, not state we depend on */
  }
}

/** Imported config is untrusted input: keep the shape, drop everything else. */
export function normaliseSettings(input: unknown): Settings {
  const raw = (input ?? {}) as Partial<Settings>;
  const sources = Array.isArray(raw.sources) ? raw.sources : [];
  const integrations = Array.isArray(raw.integrations) ? raw.integrations : [];
  const agent = (raw.agent ?? {}) as Partial<AgentConfig>;
  return {
    version: 1,
    sources: sources
      .filter((source) => source && typeof source.url === "string")
      .map((source, index) => ({
        id: String(source.id ?? `custom-${index + 1}`),
        label: String(source.label ?? "Untitled source"),
        publisher: String(source.publisher ?? "Publisher not stated"),
        url: String(source.url),
        format: isFormat(source.format) ? source.format : "json",
        kind: "custom" as const,
        cadence: String(source.cadence ?? "cadence not stated"),
        note: String(source.note ?? ""),
      })),
    integrations: integrations
      .filter((entry) => entry && typeof entry.url === "string")
      .map((entry, index) => ({
        id: String(entry.id ?? `integration-${index + 1}`),
        kind: isIntegrationKind(entry.kind) ? entry.kind : "rest",
        label: String(entry.label ?? "Untitled integration"),
        url: String(entry.url),
        token: String(entry.token ?? ""),
        enabled: entry.enabled !== false,
      })),
    agent: {
      // Settings saved before providers existed carry only an endpoint.
      provider: isAgentProvider(agent.provider)
        ? agent.provider
        : agent.endpoint
          ? "custom"
          : "none",
      endpoint: String(agent.endpoint ?? ""),
      model: String(agent.model ?? ""),
      apiKey: String(agent.apiKey ?? ""),
    },
  };
}

function isFormat(value: unknown): value is SourceFormat {
  return typeof value === "string" && value in FORMAT_LABELS;
}

function isIntegrationKind(value: unknown): value is IntegrationKind {
  return value === "rest" || value === "mcp" || value === "a2a" || value === "webhook";
}

export function allSources(settings: Settings): DataSource[] {
  return [...BUILTIN_SOURCES, ...settings.sources];
}

/**
 * A file dropped into the panel never leaves the tab: it is held in memory for
 * this session and addressed by a `local:` pseudo-URL rather than uploaded.
 */
export const LOCAL_PREFIX = "local:";

export function isLocal(source: DataSource): boolean {
  return source.url.startsWith(LOCAL_PREFIX);
}

export function probeLocal(text: string, format: SourceFormat): SourceProbe {
  const counted = countRecords(text, format);
  const checkedAt = new Date().toISOString();
  return {
    status: counted.count === null ? "degraded" : "ok",
    checkedAt,
    lastSyncAt: checkedAt,
    latencyMs: 0,
    recordCount: counted.count,
    message: `In this browser session only · ${counted.message}`,
  };
}

/**
 * Fetch the source and report what actually came back. A reachable URL that
 * parses to something unrecognisable is `degraded`, not `ok` — the point of the
 * panel is to distinguish those.
 */
export async function probeSource(
  source: DataSource,
  previous?: SourceProbe,
): Promise<SourceProbe> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  const checkedAt = new Date().toISOString();
  const lastSyncAt = previous?.lastSyncAt ?? null;

  try {
    const response = await fetch(source.url, {
      signal: controller.signal,
      headers: { accept: "application/json, text/plain;q=0.8, */*;q=0.5" },
    });
    const latencyMs = Date.now() - startedAt;
    if (!response.ok) {
      return {
        status: "failed",
        checkedAt,
        lastSyncAt,
        latencyMs,
        recordCount: null,
        message: `HTTP ${response.status} ${response.statusText}`.trim(),
      };
    }
    const text = await response.text();
    const counted = countRecords(text, source.format);
    return {
      status: counted.count === null ? "degraded" : "ok",
      checkedAt,
      lastSyncAt: checkedAt,
      latencyMs,
      recordCount: counted.count,
      message: counted.message,
    };
  } catch (error) {
    const aborted = error instanceof DOMException && error.name === "AbortError";
    return {
      status: "failed",
      checkedAt,
      lastSyncAt,
      latencyMs: Date.now() - startedAt,
      recordCount: null,
      message: aborted
        ? `No response within ${PROBE_TIMEOUT_MS / 1000}s`
        : "Request blocked or the host is unreachable (CORS, DNS or offline)",
    };
  } finally {
    // A resolved request must not leave an abort armed for the next one.
    clearTimeout(timer);
  }
}

/** Same idea for an integration: report what the endpoint actually did. */
export async function probeIntegration(integration: Integration): Promise<string> {
  const startedAt = Date.now();
  try {
    const response = await fetch(integration.url, {
      headers: integration.token ? { authorization: `Bearer ${integration.token}` } : undefined,
    });
    return `${integration.label}: HTTP ${response.status} in ${Date.now() - startedAt} ms.`;
  } catch {
    return `${integration.label}: no response. The host may be down, or the browser blocked it (CORS).`;
  }
}

/** An upload that is no longer in memory, reported rather than silently skipped. */
export function missingUploadProbe(): SourceProbe {
  return {
    status: "failed",
    checkedAt: new Date().toISOString(),
    lastSyncAt: null,
    latencyMs: null,
    recordCount: null,
    message: "The upload is no longer in memory. Re-import the file.",
  };
}

/** Ids stay stable and collision-free without reaching for a clock. */
export function uniqueId(prefix: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  let index = 1;
  while (used.has(`${prefix}-${index}`)) index += 1;
  return `${prefix}-${index}`;
}

function countRecords(
  text: string,
  format: SourceFormat,
): { count: number | null; message: string } {
  try {
    if (format === "csv") {
      const rows = text.trim().split(/\r?\n/).filter(Boolean);
      return rows.length > 1
        ? { count: rows.length - 1, message: `${rows.length - 1} CSV rows` }
        : { count: null, message: "CSV had no data rows" };
    }
    if (format === "ndjson") {
      const lines = text.trim().split(/\r?\n/).filter(Boolean);
      lines.forEach((line) => JSON.parse(line));
      return { count: lines.length, message: `${lines.length} NDJSON records` };
    }
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (Array.isArray((parsed as { features?: unknown[] }).features)) {
      const features = (parsed as { features: unknown[] }).features;
      return { count: features.length, message: `${features.length} GeoJSON features` };
    }
    if (Array.isArray(parsed)) {
      return { count: parsed.length, message: `${parsed.length} JSON records` };
    }
    return { count: 1, message: "1 JSON document" };
  } catch {
    return { count: null, message: "Reachable, but the body did not parse as expected" };
  }
}

/* ---------------------------------------------------------------- export -- */

type GeoFeature = {
  id?: string;
  geometry?: { type?: string; coordinates?: unknown } | null;
  properties?: Record<string, unknown> | null;
};

/** Convert a fetched payload into one of the offered formats. */
export function convert(text: string, format: SourceFormat): string {
  if (format === "geojson" || format === "json") return prettyJson(text);
  const rows = toRows(text);
  if (format === "ndjson") return rows.map((row) => JSON.stringify(row)).join("\n");
  return toCsv(rows);
}

function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/** Flatten to one record per feature, keeping geometry as lon/lat columns. */
function toRows(text: string): Record<string, unknown>[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Already flat text (CSV or NDJSON): pass the lines through untouched.
    return text
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line, index) => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return { line: index + 1, value: line };
        }
      });
  }

  const features = (parsed as { features?: GeoFeature[] }).features;
  if (Array.isArray(features)) {
    return features.map((feature) => {
      const [longitude, latitude] = firstCoordinate(feature.geometry?.coordinates);
      return {
        id: feature.id ?? "",
        geometry_type: feature.geometry?.type ?? "",
        longitude,
        latitude,
        ...flatten(feature.properties ?? {}),
      };
    });
  }
  if (Array.isArray(parsed)) return parsed.map((entry) => flatten(entry as object));
  return [flatten(parsed as object)];
}

/** GeoJSON coordinates nest by geometry type; take the first position found. */
function firstCoordinate(value: unknown): [number | "", number | ""] {
  let cursor: unknown = value;
  while (Array.isArray(cursor) && Array.isArray(cursor[0])) cursor = cursor[0];
  if (Array.isArray(cursor) && typeof cursor[0] === "number" && typeof cursor[1] === "number") {
    return [cursor[0], cursor[1]];
  }
  return ["", ""];
}

function flatten(input: object): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const [innerKey, innerValue] of Object.entries(value)) {
        output[`${key}_${innerKey}`] = scalar(innerValue);
      }
    } else {
      output[key] = scalar(value);
    }
  }
  return output;
}

function scalar(value: unknown): unknown {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map((entry) => String(entry)).join(" | ");
  if (typeof value === "object") return JSON.stringify(value);
  return value;
}

function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const escape = (value: unknown) => {
    const text = value === null || value === undefined ? "" : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [
    columns.join(","),
    ...rows.map((row) => columns.map((column) => escape(row[column])).join(",")),
  ].join("\n");
}

export const MIME_TYPES: Record<SourceFormat, string> = {
  geojson: "application/geo+json",
  json: "application/json",
  csv: "text/csv",
  ndjson: "application/x-ndjson",
};

export function download(filename: string, text: string, mime: string) {
  const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/** Fetch a source and hand the browser a file in the requested format. */
export async function exportSource(
  source: DataSource,
  format: SourceFormat,
  localText?: string,
) {
  let raw: string;
  if (isLocal(source)) {
    if (localText === undefined) throw new Error("This upload is no longer in memory. Re-import the file.");
    raw = localText;
  } else {
    const response = await fetch(source.url);
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${source.url}`);
    raw = await response.text();
  }
  const body = convert(raw, format);
  const extension = format === "geojson" ? "geojson" : format;
  download(`${source.id}.${extension}`, body, MIME_TYPES[format]);
}

export function formatTimestamp(iso: string | null): string {
  if (!iso) return "never";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "unknown";
  return new Intl.DateTimeFormat("en-NZ", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Pacific/Auckland",
  }).format(date);
}

export function relativeTime(iso: string | null): string {
  if (!iso) return "never synced";
  const elapsed = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(elapsed)) return "unknown";
  const minutes = Math.round(elapsed / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

/* --------------------------------------------------------- integrations -- */

/**
 * An A2A agent card for whatever endpoint the operator configures. Generated
 * here rather than committed, because this repo does not host an agent — a card
 * checked into `public/` would advertise a URL that answers nothing.
 */
export function agentCard(origin: string, endpoint: string) {
  return {
    protocolVersion: "0.3.0",
    name: "Murmur movement watch",
    description:
      "Answers questions about Wellington movement-change signals, sensor coverage, NZTA cameras and Metlink PT anomalies from published batch artifacts.",
    url: endpoint || `${origin}/agent`,
    preferredTransport: "JSONRPC",
    provider: {
      organization: "Impact Lab Wellington Team 7 · problem 05",
      url: origin,
    },
    version: "1.0.0",
    capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain", "application/json"],
    skills: [
      {
        id: "movement-signals",
        name: "Movement change signals",
        description:
          "Report countline signals with observed vs expected counts, robust score, sample size and confidence. Signals mean investigate; no cause is inferred.",
        tags: ["movement", "anomaly", "wellington"],
        examples: ["Which signals dropped the most?", "Any pedestrian changes on the quays?"],
      },
      {
        id: "data-quality",
        name: "Coverage and data quality",
        description:
          "Report sensor coverage, data gaps that are never filled as zero, data age and publisher cadence.",
        tags: ["quality", "coverage"],
        examples: ["How many data gaps are in this batch?", "How old is this data?"],
      },
      {
        id: "corroboration",
        name: "Camera and PT corroboration",
        description:
          "Point at NZTA cameras near a signal and Metlink PT anomaly hotspots from the labelled synthetic replay.",
        tags: ["cameras", "transit"],
        examples: ["Any camera near Featherston Street?", "Worst PT hotspots?"],
      },
    ],
    securitySchemes: {},
    supportsAuthenticatedExtendedCard: false,
    disclaimer:
      "Not live emergency information. Hazard-planning and batch-published data. In an emergency, call 111.",
  };
}

/** A config template for any HTTP-capable MCP server: the feeds are static files. */
export function mcpTemplate(origin: string) {
  return {
    mcpServers: {
      murmur: {
        command: "npx",
        args: ["-y", "mcp-server-fetch"],
        env: {
          MURMUR_SIGNALS: `${origin}/cop/v1/movement-signals.geojson`,
          MURMUR_REPLAY: `${origin}/cop/v1/movement-replay.json`,
          MURMUR_COVERAGE: `${origin}/cop/v1/countline-coverage.geojson`,
          MURMUR_CAMERAS: `${origin}/cop/v1/traffic-cameras.geojson`,
          MURMUR_TRANSIT: `${origin}/cop/v1/transit-anomalies.geojson`,
          MURMUR_ROADS: `${origin}/cop/v1/road-anomalies.geojson`,
          MURMUR_HEALTH: `${origin}/cop/v1/movement-health.json`,
        },
      },
    },
  };
}
