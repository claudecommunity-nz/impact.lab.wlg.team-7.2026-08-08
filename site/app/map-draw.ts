export type Coordinate = [number, number];

export type LineFeature = {
  id: string;
  geometry: { type: "LineString"; coordinates: Coordinate[] };
  properties: Record<string, string | number | Record<string, string | number>>;
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
 * Basemap: CARTO Positron raster tiles (OpenStreetMap data). Neutral grey so the
 * signal amber/red and camera green stay legible, and no API key or map library
 * is involved — the tiles are drawn onto the same canvas as the layers.
 * Attribution is required and is rendered over the map by MovementCanvas.
 */
const RETINA = typeof window !== "undefined" && (window.devicePixelRatio || 1) > 1.5;
const TILE_CACHE_LIMIT = 512;
const tileCache = new Map<string, HTMLImageElement>();

function tileUrl(zoom: number, x: number, y: number) {
  return `https://basemaps.cartocdn.com/light_all/${zoom}/${x}/${y}${RETINA ? "@2x" : ""}.png`;
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

export function boundsOfPoints(features: CameraFeature[]) {
  return boundsOf(features.map((feature) => feature.geometry.coordinates));
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

export function drawSignals(
  context: CanvasRenderingContext2D,
  project: Projector,
  signals: LineFeature[],
  selectedId: string | null,
) {
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
    context.strokeStyle = decreasing ? "#B3261E" : "#8A5A00";
    context.lineWidth = isSelected ? 6 : 3.5;
    context.lineCap = "round";
    context.beginPath();
    context.moveTo(...start);
    context.lineTo(...end);
    context.stroke();
    context.fillStyle = isSelected ? "#000000" : context.strokeStyle;
    context.beginPath();
    context.arc(start[0], start[1], isSelected ? 6 : 4, 0, Math.PI * 2);
    context.fill();
    context.strokeStyle = "#FFFFFF";
    context.lineWidth = 1.5;
    context.stroke();
  }
}

export function drawCameras(
  context: CanvasRenderingContext2D,
  project: Projector,
  cameras: CameraFeature[],
  selectedId: string | null,
) {
  for (const feature of cameras) {
    const [x, y] = project(feature.geometry.coordinates);
    const isSelected = feature.id === selectedId;
    const radius = isSelected ? 8 : 5;

    context.fillStyle = feature.properties.offline ? "#6F6F69" : "#0B6B3A";
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.fill();

    context.strokeStyle = "#FFFFFF";
    context.lineWidth = 2;
    context.stroke();

    if (isSelected) {
      context.strokeStyle = "#000000";
      context.lineWidth = 2;
      context.beginPath();
      context.arc(x, y, radius + 5, 0, Math.PI * 2);
      context.stroke();
    }
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
