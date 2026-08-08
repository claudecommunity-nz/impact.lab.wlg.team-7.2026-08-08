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

const PADDING = 28;

/**
 * Both source layers share one projection: the countline coverage defines the
 * frame, and everything else is drawn onto it. A camera outside these bounds is
 * never drawn at a clamped position — it is left off the map and counted instead.
 */
export function createProjector(
  coverage: LineFeature[],
  width: number,
  height: number,
): Projector | null {
  const coordinates = coverage.flatMap((feature) => feature.geometry.coordinates);
  if (coordinates.length === 0) return null;

  const longitudes = coordinates.map(([longitude]) => longitude);
  const latitudes = coordinates.map(([, latitude]) => latitude);
  const west = Math.min(...longitudes);
  const east = Math.max(...longitudes);
  const south = Math.min(...latitudes);
  const north = Math.max(...latitudes);
  const spanX = east - west || 1;
  const spanY = north - south || 1;

  return ([longitude, latitude]) => [
    PADDING + ((longitude - west) / spanX) * (width - PADDING * 2),
    height - PADDING - ((latitude - south) / spanY) * (height - PADDING * 2),
  ];
}

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

export function drawCoverage(
  context: CanvasRenderingContext2D,
  project: Projector,
  coverage: LineFeature[],
) {
  context.strokeStyle = "rgba(70, 111, 124, 0.22)";
  context.lineWidth = 1;
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

export function drawCameras(
  context: CanvasRenderingContext2D,
  project: Projector,
  cameras: CameraFeature[],
  selectedId: string | null,
) {
  for (const feature of cameras) {
    if (!feature.properties.within_countline_frame) continue;
    const [x, y] = project(feature.geometry.coordinates);
    const isSelected = feature.id === selectedId;
    const radius = isSelected ? 8 : 5;

    context.fillStyle = feature.properties.offline ? "#8AA0A6" : "#2D7A68";
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.fill();

    context.strokeStyle = "#F8FBFB";
    context.lineWidth = 2;
    context.stroke();

    if (isSelected) {
      context.strokeStyle = "#102A33";
      context.lineWidth = 2;
      context.beginPath();
      context.arc(x, y, radius + 5, 0, Math.PI * 2);
      context.stroke();
    }
  }
}
