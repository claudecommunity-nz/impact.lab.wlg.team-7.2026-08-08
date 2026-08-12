export type Coordinate = [number, number];

/** One prior matched weekday-and-hour observation backing a signal's baseline. */
export type SignalTrendPoint = { observed_at: string; observed_count: number };

export type LineFeature = {
  id: string;
  geometry: { type: "LineString"; coordinates: Coordinate[] };
  properties: Record<
    string,
    string | number | string[] | SignalTrendPoint[] | Record<string, string | number>
  >;
};

export type ReplaySignal = {
  id: string;
  countline_id: string;
  transport_class: string;
  direction: string;
  change_direction: string;
  observed_count: number;
  expected_count: number;
  robust_z: number;
  history_samples: number;
  data_quality: string;
  observed_at: string;
  matched_history: SignalTrendPoint[];
  viewpoint_id: string;
  name: string;
  signal_confidence: { level: string; history_samples: number; basis: string };
};

export type ReplaySlot = {
  target_at: string;
  observed_groups: number;
  expected_groups: number;
  data_gap_groups: number;
  candidate_count: number;
  signals: ReplaySignal[];
};

export type ReplayCollection = {
  schema: string;
  available_from: string;
  available_to: string;
  default_target_at: string;
  display_timezone: string;
  data_as_of: string;
  publisher_mode: string;
  publisher_cadence: string;
  source: string;
  candidate_count: number;
  trend_basis: string;
  limitations: string[];
  slots: ReplaySlot[];
};

export type CameraProperties = {
  camera_id: string;
  name: string;
  direction: string;
  region: string;
  offline: boolean;
  within_countline_frame: boolean;
  image_url: string;
  view_url: string;
  catalogue_retrieved_at: string;
  publisher_cadence: string;
  limitations: string[];
  attribution: string;
};

export type CameraFeature = {
  id: string;
  geometry: { type: "Point"; coordinates: Coordinate };
  properties: CameraProperties;
};

export type LineCollection = { type: "FeatureCollection"; features: LineFeature[] };

export type CameraCollection = {
  type: "FeatureCollection";
  source: string;
  retrieved_at: string;
  camera_count: number;
  within_frame_count: number;
  attribution: string;
  limitations: string[];
  features: CameraFeature[];
};

export type TransitProperties = {
  stop_id: string;
  stop_name: string;
  modes: string[];
  anomaly_count: number;
  high_count: number;
  medium_count: number;
  low_count: number;
  severity_tier: "high" | "elevated";
  top_detector: string;
  top_detector_count: number;
  worst_example: { date: string; hour: number; severity: string; score: number; detail: string };
  daily_counts?: { date: string; count: number; high: number }[];
  /** Hour keys (YYYY-MM-DDTHH) inside the April event window with activity. */
  event_hours?: string[];
  synthetic: boolean;
  attribution: string;
  limitations: string[];
};

export type TransitFeature = {
  id: string;
  geometry: { type: "Point"; coordinates: Coordinate };
  properties: TransitProperties;
};

export type TransitCollection = {
  type: "FeatureCollection";
  stop_count: number;
  hotspot_count: number;
  synthetic: boolean;
  attribution: string;
  limitations: string[];
  /** Quoted figures from the official Metlink April 2026 monthly report —
   * the real anchor beside the synthetic replay. */
  official_context?: {
    source: string;
    source_url: string;
    figures: Record<string, number>;
    storm_notes: string[];
  } | null;
  features: TransitFeature[];
};

export type DailyHistoryPoint = {
  date: string;
  observed: number;
  baseline: number;
  flagged: boolean;
};

export type RoadProperties = {
  site_ref: string;
  site_name: string;
  state_highway: string;
  site_type: string;
  date: string;
  observed_count: number;
  baseline_median: number;
  baseline_days: number;
  ratio: number;
  robust_z: number;
  severity: "HIGH" | "MEDIUM" | "LOW";
  direction: "DROP" | "SURGE";
  april_anomaly_days: number;
  daily_history: DailyHistoryPoint[];
  event: string;
  real_event: boolean;
  attribution: string;
  limitations: string[];
};

export type RoadFeature = {
  id: string;
  geometry: { type: "Point"; coordinates: Coordinate };
  properties: RoadProperties;
};

export type RoadCollection = {
  type: "FeatureCollection";
  event: string;
  event_dates: string[];
  flagged_site_count: number;
  site_count: number;
  real_event: boolean;
  attribution: string;
  limitations: string[];
  sites_without_geometry: RoadProperties[];
  features: RoadFeature[];
};

export type FlightHourRecord = {
  date: string;
  hour: number;
  observed: number;
  expected: number;
  ratio: number;
  robust_z: number;
  severity: "HIGH" | "MEDIUM" | "LOW" | "NONE";
  direction: "DROP" | "SURGE";
};

export type FlightProperties = {
  site_name: string;
  iata: string;
  window_start: string;
  window_end: string;
  scored_hours: number;
  high_hours: number;
  medium_hours: number;
  low_hours: number;
  worst_example: FlightHourRecord;
  flagged_hours: FlightHourRecord[];
  daily_movements: { date: string; movements: number; observed_hours: number; flagged: boolean }[];
  real_data: boolean;
  attribution: string;
  limitations: string[];
};

export type FlightFeature = {
  id: string;
  geometry: { type: "Point"; coordinates: Coordinate };
  properties: FlightProperties;
};

export type FlightCollection = {
  type: "FeatureCollection";
  window_start: string;
  window_end: string;
  flagged_hour_count: number;
  real_data: boolean;
  attribution: string;
  limitations: string[];
  features: FlightFeature[];
};

export type RainProperties = {
  series_id: string;
  site_name: string;
  unit: string;
  cadence_minutes: number;
  window_total_mm: number;
  peak: { observed_at: string; value_mm: number };
  heavy_hours: number;
  violent_hours: number;
  /** Inside the WCC countline frame — out-of-frame gauges are context and
   * never speak through the auto popup. */
  within_countline_frame: boolean;
  /** Sparse map of hour key (YYYY-MM-DDTHH) to mm for hours with rain. */
  mm_by_hour: Record<string, number>;
  /** Hours whose rolling 6 h/24 h totals met the MetService warning criteria,
   * mapped to the worst accumulation in mm. */
  warning_by_hour?: Record<string, number>;
  warning_hours: number;
  daily_totals: { date: string; mm: number; flagged: boolean }[];
  attribution: string;
  limitations: string[];
};

export type RainFeature = {
  id: string;
  geometry: { type: "Point"; coordinates: Coordinate };
  properties: RainProperties;
};

export type RainHourly = {
  hour: string;
  max_mm: number;
  max_site: string;
  heavy_stations: number;
  warning_stations: number;
  class: string;
};

export type RainCollection = {
  type: "FeatureCollection";
  window_start: string;
  window_end: string;
  station_count: number;
  thresholds: Record<string, number | string>;
  hourly: RainHourly[];
  limitations: string[];
  features: RainFeature[];
};

export type ReportProperties = {
  report_id: string;
  street: string;
  category: string;
  channel: string;
  source_grade: string;
  created_at: string;
  status: string;
  cluster_id: string;
  cluster_size: number;
  level: string;
  corroborated: boolean;
  corroborated_by: string | null;
  synthetic: boolean;
  limitations: string[];
};

export type ReportFeature = {
  id: string;
  geometry: { type: "Point"; coordinates: Coordinate };
  properties: ReportProperties;
};

export type ReportCollection = {
  type: "FeatureCollection";
  synthetic: boolean;
  window_start: string;
  window_end: string;
  report_count: number;
  cluster_count: number;
  escalation_rules: Record<string, string>;
  corroboration_rule: { method: string; window_hours: number; reference: string };
  limitations: string[];
  features: ReportFeature[];
};

export type AprilSignal = {
  id: string;
  street: string;
  name: string;
  transport_class: string;
  direction: string;
  change_direction: string;
  observed_count: number;
  expected_count: number;
  robust_z: number;
  history_samples: number;
  data_quality: string;
  observed_at: string;
  matched_history: SignalTrendPoint[];
  countlines: number;
  coordinates: Coordinate;
  signal_confidence: { level: string; history_samples: number; basis: string };
};

export type AprilMovementCollection = {
  schema: string;
  window_start: string;
  window_end: string;
  candidate_count: number;
  attribution: string;
  limitations: string[];
  slots: { target_at: string; candidate_count: number; signals: AprilSignal[] }[];
};

/** Transport classes drawn with the person glyph; everything else gets the car. */
export const PEOPLE_CLASSES = new Set(["Pedestrian", "Cyclist", "E-scooter"]);

export type Projector = (coordinate: Coordinate) => Coordinate;
export type Bounds = { west: number; east: number; south: number; north: number };
export type MapView = { centerLon: number; centerLat: number; zoom: number };

export const MIN_ZOOM = 9;
export const MAX_ZOOM = 18;

/** Wellington CBD, matching the council's own map framing. */
export const DEFAULT_VIEW: MapView = {
  centerLon: 174.7812352,
  centerLat: -41.2909568,
  zoom: 12,
};

const TILE_SIZE = 256;
const FIT_PADDING = 36;

/*
 * Basemap: CARTO Voyager raster tiles (OpenStreetMap data). Voyager carries
 * real terrain and street colour where Positron was near-monochrome; the draw
 * filter still mutes it a step so the layer glyphs keep visual priority. No
 * API key or map library is involved — the tiles are drawn onto the same
 * canvas as the layers. Attribution is required and is rendered over the map
 * by MovementCanvas.
 */
const RETINA = typeof window !== "undefined" && (window.devicePixelRatio || 1) > 1.5;
const TILE_CACHE_LIMIT = 512;
const tileCache = new Map<string, HTMLImageElement>();

function tileUrl(zoom: number, x: number, y: number) {
  return `https://basemaps.cartocdn.com/rastertiles/voyager/${zoom}/${x}/${y}${RETINA ? "@2x" : ""}.png`;
}

// ==================== web mercator ====================
export function lonToWorldX(longitude: number, zoom: number) {
  return ((longitude + 180) / 360) * TILE_SIZE * 2 ** zoom;
}

export function latToWorldY(latitude: number, zoom: number) {
  const sine = Math.sin((Math.min(Math.max(latitude, -85.05), 85.05) * Math.PI) / 180);
  return (0.5 - Math.log((1 + sine) / (1 - sine)) / (4 * Math.PI)) * TILE_SIZE * 2 ** zoom;
}

export function worldXToLon(x: number, zoom: number) {
  return (x / (TILE_SIZE * 2 ** zoom)) * 360 - 180;
}

export function worldYToLat(y: number, zoom: number) {
  const n = Math.PI - (2 * Math.PI * y) / (TILE_SIZE * 2 ** zoom);
  return (180 / Math.PI) * Math.atan(Math.sinh(n));
}

export function clampZoom(zoom: number) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(zoom)));
}

/** Screen pixels for the current view. Both layers share this one projection. */
export function createProjector(view: MapView, width: number, height: number): Projector {
  const originX = lonToWorldX(view.centerLon, view.zoom) - width / 2;
  const originY = latToWorldY(view.centerLat, view.zoom) - height / 2;
  return ([longitude, latitude]) => [
    lonToWorldX(longitude, view.zoom) - originX,
    latToWorldY(latitude, view.zoom) - originY,
  ];
}

export function unproject(
  [x, y]: Coordinate,
  view: MapView,
  width: number,
  height: number,
): Coordinate {
  const originX = lonToWorldX(view.centerLon, view.zoom) - width / 2;
  const originY = latToWorldY(view.centerLat, view.zoom) - height / 2;
  return [worldXToLon(originX + x, view.zoom), worldYToLat(originY + y, view.zoom)];
}

/** Move the view by a screen-pixel delta (drag moves the map with the pointer). */
export function panView(view: MapView, dx: number, dy: number): MapView {
  const x = lonToWorldX(view.centerLon, view.zoom) + dx;
  const y = latToWorldY(view.centerLat, view.zoom) + dy;
  const span = TILE_SIZE * 2 ** view.zoom;
  return {
    centerLon: worldXToLon(x, view.zoom),
    centerLat: worldYToLat(Math.min(Math.max(y, 0), span), view.zoom),
    zoom: view.zoom,
  };
}

/** Step the zoom while keeping the point under the cursor fixed. */
export function zoomAround(
  view: MapView,
  step: number,
  anchor: Coordinate,
  width: number,
  height: number,
): MapView {
  const zoom = clampZoom(view.zoom + step);
  if (zoom === view.zoom) return view;
  const geographic = unproject(anchor, view, width, height);
  const zoomed: MapView = { ...view, zoom };
  const [x, y] = createProjector(zoomed, width, height)(geographic);
  return panView(zoomed, x - anchor[0], y - anchor[1]);
}

// ==================== bounds and fitting ====================
export function boundsOf(coordinates: Coordinate[]): Bounds | null {
  if (coordinates.length === 0) return null;
  const longitudes = coordinates.map(([longitude]) => longitude);
  const latitudes = coordinates.map(([, latitude]) => latitude);
  return {
    west: Math.min(...longitudes),
    east: Math.max(...longitudes),
    south: Math.min(...latitudes),
    north: Math.max(...latitudes),
  };
}

export function boundsOfLines(features: LineFeature[]) {
  return boundsOf(features.flatMap((feature) => feature.geometry.coordinates));
}

export function boundsOfPoints(features: { geometry: { coordinates: Coordinate } }[]) {
  return boundsOf(features.map((feature) => feature.geometry.coordinates));
}

/** Combined extent of several layers, ignoring the ones that are empty or off. */
export function unionBounds(...list: (Bounds | null)[]): Bounds | null {
  const bounds = list.filter((entry): entry is Bounds => entry !== null);
  if (bounds.length === 0) return null;
  return {
    west: Math.min(...bounds.map((entry) => entry.west)),
    east: Math.max(...bounds.map((entry) => entry.east)),
    south: Math.min(...bounds.map((entry) => entry.south)),
    north: Math.max(...bounds.map((entry) => entry.north)),
  };
}

/** Largest whole zoom level at which the bounds still fit inside the canvas. */
export function fitView(bounds: Bounds, width: number, height: number): MapView {
  const usableWidth = Math.max(32, width - FIT_PADDING * 2);
  const usableHeight = Math.max(32, height - FIT_PADDING * 2);

  let zoom = MIN_ZOOM;
  for (let candidate = MAX_ZOOM; candidate >= MIN_ZOOM; candidate -= 1) {
    const spanX = lonToWorldX(bounds.east, candidate) - lonToWorldX(bounds.west, candidate);
    const spanY = latToWorldY(bounds.south, candidate) - latToWorldY(bounds.north, candidate);
    if (spanX <= usableWidth && spanY <= usableHeight) {
      zoom = candidate;
      break;
    }
  }

  const midY = (latToWorldY(bounds.south, zoom) + latToWorldY(bounds.north, zoom)) / 2;
  return {
    centerLon: (bounds.west + bounds.east) / 2,
    centerLat: worldYToLat(midY, zoom),
    zoom,
  };
}

// ==================== drawing ====================
export function prepareCanvas(canvas: HTMLCanvasElement) {
  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(rect.width * ratio));
  canvas.height = Math.max(1, Math.floor(rect.height * ratio));
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.scale(ratio, ratio);
  context.clearRect(0, 0, rect.width, rect.height);
  return { context, width: rect.width, height: rect.height };
}

/**
 * Paint the basemap. Tiles that are already cached draw immediately; the rest
 * call `onTileLoad` when they arrive so the caller can redraw.
 */
export function drawTiles(
  context: CanvasRenderingContext2D,
  view: MapView,
  width: number,
  height: number,
  onTileLoad: () => void,
) {
  const originX = lonToWorldX(view.centerLon, view.zoom) - width / 2;
  const originY = latToWorldY(view.centerLat, view.zoom) - height / 2;
  const tilesPerAxis = 2 ** view.zoom;

  // Mute the basemap one step so terrain greens never outcompete the glyphs.
  context.filter = "saturate(0.85)";

  for (let tileY = Math.floor(originY / TILE_SIZE); tileY <= Math.floor((originY + height) / TILE_SIZE); tileY += 1) {
    if (tileY < 0 || tileY >= tilesPerAxis) continue;
    for (let tileX = Math.floor(originX / TILE_SIZE); tileX <= Math.floor((originX + width) / TILE_SIZE); tileX += 1) {
      const wrappedX = ((tileX % tilesPerAxis) + tilesPerAxis) % tilesPerAxis;
      const key = `${view.zoom}/${wrappedX}/${tileY}`;
      let image = tileCache.get(key);

      if (!image) {
        image = new Image();
        image.decoding = "async";
        image.addEventListener("load", onTileLoad, { once: true });
        image.src = tileUrl(view.zoom, wrappedX, tileY);
        if (tileCache.size >= TILE_CACHE_LIMIT) {
          const oldest = tileCache.keys().next();
          if (!oldest.done) tileCache.delete(oldest.value);
        }
        tileCache.set(key, image);
      }

      if (image.complete && image.naturalWidth > 0) {
        context.drawImage(
          image,
          tileX * TILE_SIZE - originX,
          tileY * TILE_SIZE - originY,
          TILE_SIZE,
          TILE_SIZE,
        );
      }
    }
  }

  context.filter = "none";
}

/**
 * Glyph size multiplier for a zoom level: icons recede at the city-wide zooms
 * so street labels stay legible, and grow back once streets fill the frame.
 */
export function glyphScale(zoom: number) {
  return Math.min(1.2, Math.max(0.7, 0.7 + (zoom - 11) * 0.125));
}

export type Cluster<T> = { x: number; y: number; members: T[] };

/**
 * Screen-space grid clustering. Points whose projected positions share a
 * `radius`-sized cell merge into one cluster anchored at their centroid, so
 * zooming in naturally dissolves clusters into individual glyphs.
 */
export function clusterPoints<T>(
  features: T[],
  anchorOf: (feature: T) => Coordinate,
  project: Projector,
  radius: number,
): Cluster<T>[] {
  const cells = new Map<string, Cluster<T>>();
  for (const feature of features) {
    const [x, y] = project(anchorOf(feature));
    const key = `${Math.round(x / radius)}:${Math.round(y / radius)}`;
    const cell = cells.get(key);
    if (cell) {
      cell.members.push(feature);
      cell.x += x;
      cell.y += y;
    } else {
      cells.set(key, { x, y, members: [feature] });
    }
  }
  for (const cell of cells.values()) {
    cell.x /= cell.members.length;
    cell.y /= cell.members.length;
  }
  return [...cells.values()];
}

export function clusterRadius(count: number) {
  return Math.min(17, 9 + Math.sqrt(count) * 1.6);
}

/** Density bubbles for clustered points: tinted disc, white ring, count. */
export function drawClusters<T>(
  context: CanvasRenderingContext2D,
  clusters: Cluster<T>[],
  colour: string,
) {
  for (const cluster of clusters) {
    if (cluster.members.length < 2) continue;
    const radius = clusterRadius(cluster.members.length);
    context.beginPath();
    context.arc(cluster.x, cluster.y, radius, 0, Math.PI * 2);
    context.globalAlpha = 0.85;
    context.fillStyle = colour;
    context.fill();
    context.globalAlpha = 1;
    context.strokeStyle = "#FFFFFF";
    context.lineWidth = 1.6;
    context.stroke();
    context.fillStyle = "#FFFFFF";
    context.font = "700 10px system-ui, sans-serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(String(cluster.members.length), cluster.x, cluster.y);
  }
}

export function drawCoverage(
  context: CanvasRenderingContext2D,
  project: Projector,
  coverage: LineFeature[],
) {
  context.strokeStyle = "rgba(28, 28, 26, 0.45)";
  context.lineWidth = 1.5;
  for (const feature of coverage) {
    const [start, end] = feature.geometry.coordinates.map(project);
    context.beginPath();
    context.moveTo(...start);
    context.lineTo(...end);
    context.stroke();
  }
}

/** Mini person: head over a rounded torso, anchored at (x, y). */
function drawPersonGlyph(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  scale: number,
  fill: string,
) {
  context.fillStyle = fill;
  context.strokeStyle = "#FFFFFF";
  context.lineWidth = 1.4;
  context.beginPath();
  context.arc(x, y - 3.4 * scale, 2 * scale, 0, Math.PI * 2);
  context.fill();
  context.stroke();
  traceRoundedRect(context, x - 2.7 * scale, y - 0.9 * scale, 5.4 * scale, 5.8 * scale, 2.6 * scale);
  context.fill();
  context.stroke();
}

/** Mini car: cabin over body with two wheels, anchored at (x, y). */
function drawCarGlyph(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  scale: number,
  fill: string,
) {
  context.fillStyle = fill;
  context.strokeStyle = "#FFFFFF";
  context.lineWidth = 1.4;
  traceRoundedRect(context, x - 3.8 * scale, y - 4.4 * scale, 7.6 * scale, 4 * scale, 1.8 * scale);
  context.fill();
  context.stroke();
  traceRoundedRect(context, x - 6.4 * scale, y - 1.6 * scale, 12.8 * scale, 5 * scale, 2 * scale);
  context.fill();
  context.stroke();
  context.fillStyle = "#FFFFFF";
  for (const side of [-1, 1]) {
    context.beginPath();
    context.arc(x + side * 3.6 * scale, y + 3.2 * scale, 1.3 * scale, 0, Math.PI * 2);
    context.fill();
  }
}

export function drawSignals(
  context: CanvasRenderingContext2D,
  project: Projector,
  signals: LineFeature[],
  selectedId: string | null,
  hoveredId: string | null = null,
  baseScale = 1,
) {
  for (const feature of signals) {
    const [start, rawEnd] = feature.geometry.coordinates.map(project);
    const dx = rawEnd[0] - start[0];
    const dy = rawEnd[1] - start[1];
    const length = Math.hypot(dx, dy) || 1;
    const end: Coordinate = length < 16
      ? [start[0] + (dx / length) * 16, start[1] + (dy / length) * 16]
      : rawEnd;
    const isSelected = feature.id === selectedId;
    const isHovered = feature.id === hoveredId;
    const decreasing = feature.properties.change_direction === "decrease";
    const colour = decreasing ? "#B3261E" : "#8A5A00";
    // One clean element: the whole arrow is a single filled silhouette (the
    // same shape as the map-key swatch) with one white outline, so it stays
    // crisp at small sizes instead of dissolving into strokes.
    const lineWidth = isSelected ? 4.5 : isHovered ? 3.5 : 2.5;
    const angle = Math.atan2(end[1] - start[1], end[0] - start[0]);
    const shaftHalf = lineWidth / 2;
    const headLength = 6 + lineWidth * 2;
    const headHalf = (5 + lineWidth * 1.6) / 2;
    const arrowLength = Math.hypot(end[0] - start[0], end[1] - start[1]);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const outline: Coordinate[] = [
      [0, -shaftHalf],
      [arrowLength - headLength, -shaftHalf],
      [arrowLength - headLength, -headHalf],
      [arrowLength, 0],
      [arrowLength - headLength, headHalf],
      [arrowLength - headLength, shaftHalf],
      [0, shaftHalf],
    ];
    context.beginPath();
    outline.forEach(([localX, localY], index) => {
      const x = start[0] + cos * localX - sin * localY;
      const y = start[1] + sin * localX + cos * localY;
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    });
    context.closePath();
    context.lineJoin = "round";
    context.fillStyle = colour;
    context.strokeStyle = "#FFFFFF";
    context.lineWidth = 1.5;
    context.fill();
    context.stroke();

    // Signals carry the story, so their glyphs run a step larger than the
    // corroborating camera and bus icons.
    const scale = (isSelected ? 1.4 : isHovered ? 1.2 : 1) * baseScale * 1.15;
    const fill = isSelected ? "#000000" : colour;
    if (isSelected) {
      // Selection ring ties the map mark to the open evidence panel.
      context.beginPath();
      context.arc(start[0], start[1], 8.5 * scale, 0, Math.PI * 2);
      context.strokeStyle = "#000000";
      context.lineWidth = 2;
      context.stroke();
    }
    if (PEOPLE_CLASSES.has(String(feature.properties.transport_class))) {
      drawPersonGlyph(context, start[0], start[1], scale, fill);
    } else {
      drawCarGlyph(context, start[0], start[1], scale, fill);
    }
  }
}

/** Mini bus at each Metlink anomaly hotspot; red tier means dense high severity. */
export function drawTransit(
  context: CanvasRenderingContext2D,
  project: Projector,
  hotspots: TransitFeature[],
  selectedId: string | null,
  hoveredId: string | null = null,
  baseScale = 1,
) {
  for (const feature of hotspots) {
    const [x, y] = project(feature.geometry.coordinates);
    const isSelected = feature.id === selectedId;
    const isHovered = feature.id === hoveredId;
    // Corroborating layer: runs smaller than the signal glyphs on purpose.
    const scale = (isSelected ? 1.35 : isHovered ? 1.2 : 1) * baseScale * 0.85;
    const width = 11 * scale;
    const height = 8 * scale;
    const left = x - width / 2;
    const top = y - height / 2;
    // Softer red than the signal glyphs' #B3261E so hotspots sit behind signals visually.
    const body = feature.properties.severity_tier === "high" ? "#C4675E" : "#2B5CAD";

    if (isSelected) {
      traceRoundedRect(context, left - 3, top - 3, width + 6, height + 6, 4 * scale);
      context.strokeStyle = "#000000";
      context.lineWidth = 2;
      context.stroke();
    }

    traceRoundedRect(context, left, top, width, height, 2 * scale);
    context.fillStyle = body;
    context.fill();
    context.strokeStyle = "#FFFFFF";
    context.lineWidth = 1.4;
    context.stroke();

    context.fillStyle = "#FFFFFF";
    traceRoundedRect(context, left + 1.8 * scale, top + 1.6 * scale, width - 3.6 * scale, 2.4 * scale, scale);
    context.fill();
    for (const side of [-1, 1]) {
      context.beginPath();
      context.arc(x + side * 3 * scale, top + height, 1.2 * scale, 0, Math.PI * 2);
      context.fill();
    }
  }
}

/**
 * Diamond road-sign at each flagged NZTA state-highway site (real April 2026
 * flood backtest); darker fill for HIGH severity. Purple, so the layer reads
 * apart from the signal red/amber and the transit blue.
 */
export function drawRoads(
  context: CanvasRenderingContext2D,
  project: Projector,
  sites: RoadFeature[],
  selectedId: string | null,
  hoveredId: string | null = null,
  baseScale = 1,
) {
  for (const feature of sites) {
    const [x, y] = project(feature.geometry.coordinates);
    const isSelected = feature.id === selectedId;
    const isHovered = feature.id === hoveredId;
    const scale = (isSelected ? 1.35 : isHovered ? 1.2 : 1) * baseScale;
    const radius = 5 * scale;
    const body = feature.properties.severity === "HIGH" ? "#5B4A8A" : "#907FBE";

    if (isSelected) {
      traceDiamond(context, x, y, radius + 3);
      context.strokeStyle = "#000000";
      context.lineWidth = 2;
      context.stroke();
    }

    traceDiamond(context, x, y, radius);
    context.fillStyle = body;
    context.fill();
    context.strokeStyle = "#FFFFFF";
    context.lineWidth = 1.4;
    context.stroke();
  }
}

function traceDiamond(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
) {
  context.beginPath();
  context.moveTo(x, y - radius);
  context.lineTo(x + radius, y);
  context.lineTo(x, y + radius);
  context.lineTo(x - radius, y);
  context.closePath();
}

function traceRoundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  context.beginPath();
  context.moveTo(x + radius, y);
  context.lineTo(x + width - radius, y);
  context.arcTo(x + width, y, x + width, y + radius, radius);
  context.lineTo(x + width, y + height - radius);
  context.arcTo(x + width, y + height, x + width - radius, y + height, radius);
  context.lineTo(x + radius, y + height);
  context.arcTo(x, y + height, x, y + height - radius, radius);
  context.lineTo(x, y + radius);
  context.arcTo(x, y, x + radius, y, radius);
  context.closePath();
}

/**
 * Mini plane at the airport air-access site (real April 2026 OpenSky
 * backtest). Teal, so the layer reads apart from every other glyph colour.
 */
export function drawFlights(
  context: CanvasRenderingContext2D,
  project: Projector,
  sites: FlightFeature[],
  selectedId: string | null,
  hoveredId: string | null = null,
  baseScale = 1,
  flaggedHour = false,
) {
  for (const feature of sites) {
    const [x, y] = project(feature.geometry.coordinates);
    const isSelected = feature.id === selectedId;
    const isHovered = feature.id === hoveredId;
    const scale = (isSelected ? 1.35 : isHovered ? 1.2 : 1) * baseScale;

    if (flaggedHour) {
      // The timeline sits on an hour this site flagged: a red halo says so.
      context.beginPath();
      context.arc(x, y, 10 * scale, 0, Math.PI * 2);
      context.strokeStyle = "#B3261E";
      context.lineWidth = 2.5;
      context.stroke();
    }

    if (isSelected) {
      context.beginPath();
      context.arc(x, y, 9 * scale, 0, Math.PI * 2);
      context.strokeStyle = "#000000";
      context.lineWidth = 2;
      context.stroke();
    }

    tracePlane(context, x, y, scale);
    context.fillStyle = "#0E6B72";
    context.fill();
    context.strokeStyle = "#FFFFFF";
    context.lineWidth = 1.3;
    context.stroke();
  }
}

/** Plane silhouette pointing up: nose, swept wings, tailplane. */
function tracePlane(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  scale: number,
) {
  const s = scale;
  context.beginPath();
  context.moveTo(x, y - 6 * s);
  context.quadraticCurveTo(x + 1.4 * s, y - 4.4 * s, x + 1.2 * s, y - 2 * s);
  context.lineTo(x + 6 * s, y + 1.2 * s);
  context.lineTo(x + 6 * s, y + 2.6 * s);
  context.lineTo(x + 1.2 * s, y + 1.2 * s);
  context.lineTo(x + 1 * s, y + 3.6 * s);
  context.lineTo(x + 2.6 * s, y + 5 * s);
  context.lineTo(x + 2.6 * s, y + 6 * s);
  context.lineTo(x, y + 5.2 * s);
  context.lineTo(x - 2.6 * s, y + 6 * s);
  context.lineTo(x - 2.6 * s, y + 5 * s);
  context.lineTo(x - 1 * s, y + 3.6 * s);
  context.lineTo(x - 1.2 * s, y + 1.2 * s);
  context.lineTo(x - 6 * s, y + 2.6 * s);
  context.lineTo(x - 6 * s, y + 1.2 * s);
  context.lineTo(x - 1.2 * s, y - 2 * s);
  context.quadraticCurveTo(x - 1.4 * s, y - 4.4 * s, x, y - 6 * s);
  context.closePath();
}

/** One droplet silhouette anchored at (x, y). */
function traceDrop(context: CanvasRenderingContext2D, x: number, y: number, s: number) {
  context.beginPath();
  context.moveTo(x, y - 5.6 * s);
  context.bezierCurveTo(x + 4.6 * s, y - 0.6 * s, x + 3.6 * s, y + 4.6 * s, x, y + 4.6 * s);
  context.bezierCurveTo(x - 3.6 * s, y + 4.6 * s, x - 4.6 * s, y - 0.6 * s, x, y - 5.6 * s);
  context.closePath();
}

/* Weather-icon grammar: the number of droplets is the intensity class and the
 * group's size grows with the hour's millimetres. */
const DROP_LAYOUT: [number, number, number][][] = [
  [[0, 0, 1]],
  [[-2.6, 0.6, 0.94], [3.4, -3.2, 0.6]],
  [[-2.8, 0.8, 0.94], [3.6, -3, 0.62], [-4.6, -4.4, 0.48]],
];

/** Rain gauge: droplets. With an hour key the glyph follows the timeline —
 * dry gauges fade to one small pale drop; one drop is light rain, two
 * moderate, three heavy, orange at the MetService torrential rate, ringed
 * orange when rolling totals meet the warning criteria. Without a key it
 * summarises the whole record. */
export function drawRain(
  context: CanvasRenderingContext2D,
  project: Projector,
  stations: RainFeature[],
  selectedId: string | null,
  hoveredId: string | null = null,
  baseScale = 1,
  hourKey: string | null = null,
) {
  for (const feature of stations) {
    const [x, y] = project(feature.geometry.coordinates);
    const isSelected = feature.id === selectedId;
    const isHovered = feature.id === hoveredId;
    const mmNow = hourKey ? feature.properties.mm_by_hour?.[hourKey] ?? 0 : null;
    const warningNow = Boolean(hourKey && feature.properties.warning_by_hour?.[hourKey]);
    const wet = mmNow === null ? 1 : Math.min(1, mmNow / 25);
    const size = mmNow === null ? 1 : mmNow > 0 ? 0.8 + wet * 0.6 : 0.7;
    const scale = (isSelected ? 1.35 : isHovered ? 1.2 : 1) * baseScale * 0.95 * size;
    const drops =
      mmNow === null
        ? feature.properties.violent_hours > 0 ? 3 : feature.properties.heavy_hours > 0 ? 2 : 1
        : mmNow >= 10
          ? 3
          : mmNow >= 2.5
            ? 2
            : 1;
    const fill =
      mmNow === null
        ? feature.properties.violent_hours > 0 ? "#0D5C8C" : "#1E90CF"
        : mmNow >= 25
          ? "#D9640A"
          : mmNow >= 10
            ? "#0D5C8C"
            : mmNow > 0
              ? "#1E90CF"
              : "#B9CFDE";

    if (warningNow) {
      // Rolling totals meet the MetService warning criteria this hour.
      context.beginPath();
      context.arc(x, y - scale, 9 * scale, 0, Math.PI * 2);
      context.strokeStyle = "#D9640A";
      context.lineWidth = 2.2;
      context.stroke();
    }

    if (isSelected) {
      context.beginPath();
      context.arc(x, y - scale, 9.5 * scale, 0, Math.PI * 2);
      context.strokeStyle = "#000000";
      context.lineWidth = 2;
      context.stroke();
    }

    context.fillStyle = fill;
    context.strokeStyle = "#FFFFFF";
    context.lineWidth = 1.3;
    for (const [dx, dy, ds] of DROP_LAYOUT[drops - 1]) {
      traceDrop(context, x + dx * scale, y + dy * scale, scale * ds);
      context.fill();
      context.stroke();
    }
  }
}

/** Public report: a speech-bubble pin coloured by escalation level. */
export function drawReports(
  context: CanvasRenderingContext2D,
  project: Projector,
  reports: ReportFeature[],
  selectedId: string | null,
  hoveredId: string | null = null,
  baseScale = 1,
) {
  for (const feature of reports) {
    const [x, y] = project(feature.geometry.coordinates);
    const isSelected = feature.id === selectedId;
    const isHovered = feature.id === hoveredId;
    const scale = (isSelected ? 1.35 : isHovered ? 1.2 : 1) * baseScale * 0.9;
    const level = feature.properties.level;
    const colour =
      level === "investigate" ? "#D6482B" : level === "elevated" ? "#E08A00" : "#77776F";

    if (isSelected) {
      context.beginPath();
      context.arc(x, y, 8.5 * scale, 0, Math.PI * 2);
      context.strokeStyle = "#000000";
      context.lineWidth = 2;
      context.stroke();
    }

    traceRoundedRect(context, x - 4.4 * scale, y - 5.2 * scale, 8.8 * scale, 6.4 * scale, 2 * scale);
    context.fillStyle = colour;
    context.fill();
    context.strokeStyle = "#FFFFFF";
    context.lineWidth = 1.3;
    context.stroke();
    context.beginPath();
    context.moveTo(x - 1.4 * scale, y + 1.1 * scale);
    context.lineTo(x, y + 4.2 * scale);
    context.lineTo(x + 2 * scale, y + 1.1 * scale);
    context.closePath();
    context.fillStyle = colour;
    context.fill();
    context.strokeStyle = "#FFFFFF";
    context.lineWidth = 1;
    context.stroke();
  }
}

/** Tiny camera glyph: rounded body, lens, and a status-light dot. */
export function drawCameras(
  context: CanvasRenderingContext2D,
  project: Projector,
  cameras: CameraFeature[],
  selectedId: string | null,
  hoveredId: string | null = null,
  baseScale = 1,
) {
  for (const feature of cameras) {
    const [x, y] = project(feature.geometry.coordinates);
    const isSelected = feature.id === selectedId;
    const isHovered = feature.id === hoveredId;
    // Corroborating layer: runs smaller than the signal glyphs on purpose.
    const scale = (isSelected ? 1.35 : isHovered ? 1.2 : 1) * baseScale * 0.8;
    const width = 13 * scale;
    const height = 9 * scale;
    const left = x - width / 2;
    const top = y - height / 2;
    const body = feature.properties.offline ? "#6F6F69" : "#12934B";

    if (isSelected) {
      traceRoundedRect(context, left - 3, top - 3, width + 6, height + 6, 4 * scale);
      context.strokeStyle = "#000000";
      context.lineWidth = 2;
      context.stroke();
    }

    traceRoundedRect(context, left, top, width, height, 2.5 * scale);
    context.fillStyle = body;
    context.fill();
    context.strokeStyle = "#FFFFFF";
    context.lineWidth = 1.5;
    context.stroke();

    context.fillStyle = "#FFFFFF";
    context.beginPath();
    context.arc(x, y, 3.2 * scale, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = body;
    context.beginPath();
    context.arc(x, y, 1.7 * scale, 0, Math.PI * 2);
    context.fill();

    context.fillStyle = "#FFFFFF";
    context.beginPath();
    context.arc(left + width - 3 * scale, top + 2.6 * scale, 0.9 * scale, 0, Math.PI * 2);
    context.fill();
  }
}

/** Nearest feature to a screen point, within `tolerance` pixels. */
export function pickNearest<T extends { id: string }>(
  features: T[],
  anchorOf: (feature: T) => Coordinate,
  project: Projector,
  point: Coordinate,
  tolerance = 14,
): T | null {
  let best: T | null = null;
  let bestDistance = tolerance;
  for (const feature of features) {
    const [x, y] = project(anchorOf(feature));
    const distance = Math.hypot(x - point[0], y - point[1]);
    if (distance <= bestDistance) {
      best = feature;
      bestDistance = distance;
    }
  }
  return best;
}
