import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the movement investigation surface with truthful batch status", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  const html = await response.text();

  assert.ok(html.includes("<title>Murmur</title>"));
  assert.match(html, /heartbeat and detecting irregularities/);
  assert.ok(
    html.includes(
      '<meta property="og:image" content="http://localhost:3000/og-card.png"',
    ),
  );
  assert.match(html, /Movement changes worth investigating/);
  assert.match(html, /Batch replay/);
  assert.match(html, /12 signals/);
  assert.match(html, /207 data gaps/);
  assert.match(html, /Data through/);
  assert.match(html, /6 Aug 2026/);
  assert.ok(html.includes("/cop/v1/movement-signals.geojson"));
  assert.ok(html.includes("/cop/v1/movement-health.json"));
  assert.ok(html.includes("/cop/v1/traffic-cameras.geojson"));
  assert.match(html, /Not live emergency information/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton|taking shape/i);
});

test("ships internally consistent COP artifacts with WGS84 line geometry", async () => {
  const [healthText, signalsText, coverageText] = await Promise.all([
    readFile(new URL("../public/cop/v1/movement-health.json", import.meta.url), "utf8"),
    readFile(new URL("../public/cop/v1/movement-signals.geojson", import.meta.url), "utf8"),
    readFile(new URL("../public/cop/v1/countline-coverage.geojson", import.meta.url), "utf8"),
  ]);
  const health = JSON.parse(healthText);
  const signals = JSON.parse(signalsText);
  const coverage = JSON.parse(coverageText);

  assert.equal(signals.type, "FeatureCollection");
  assert.equal(signals.features.length, health.candidate_count);
  assert.equal(health.publisher_mode, "batch replay");
  assert.equal(health.publisher_cadence, "at least monthly");
  assert.equal(health.data_gap_groups, 207);
  assert.equal(coverage.features.length, 414);
  assert.ok(
    signals.features.every(
      (feature) =>
        feature.geometry.type === "LineString" &&
        feature.geometry.coordinates.every(
          ([longitude, latitude]) => longitude > 170 && latitude < -40,
        ),
    ),
  );
  assert.deepEqual(
    [...new Set(signals.features.map((feature) => feature.properties.attribution))],
    ["Wellington City Council Transport Sensors"],
  );
});

test("merges every source into one map with switchable layers", async () => {
  const response = await render();
  const html = await response.text();

  // No tabs: sources are layers toggled over the single shared projection.
  assert.doesNotMatch(html, /role="tablist"/);
  assert.match(html, /aria-label="Map layers"/);
  assert.match(html, /Movement signals/);
  assert.match(html, /Sensor coverage/);
  assert.match(html, /Traffic cameras/);
  // All three layers start switched on.
  assert.ok((html.match(/aria-pressed="true"/g) ?? []).length >= 3);
  // One canvas, one projection: the camera layer must not ship a second map.
  assert.equal(html.match(/<canvas/g)?.length, 1);
});

test("ships a camera layer on the same frame with its own attribution and limits", async () => {
  const [cameraText, coverageText] = await Promise.all([
    readFile(new URL("../public/cop/v1/traffic-cameras.geojson", import.meta.url), "utf8"),
    readFile(new URL("../public/cop/v1/countline-coverage.geojson", import.meta.url), "utf8"),
  ]);
  const cameras = JSON.parse(cameraText);
  const coverage = JSON.parse(coverageText);

  assert.equal(cameras.type, "FeatureCollection");
  assert.equal(cameras.schema, "camera-source-collection/v1");
  assert.equal(cameras.features.length, cameras.camera_count);
  assert.ok(cameras.camera_count > 0);
  assert.ok(cameras.within_frame_count > 0);
  assert.match(cameras.attribution, /NZTA/);
  assert.ok(cameras.limitations.length > 0);

  const points = coverage.features.flatMap((feature) => feature.geometry.coordinates);
  const frame = {
    west: Math.min(...points.map(([longitude]) => longitude)),
    east: Math.max(...points.map(([longitude]) => longitude)),
    south: Math.min(...points.map(([, latitude]) => latitude)),
    north: Math.max(...points.map(([, latitude]) => latitude)),
  };

  assert.equal(
    cameras.features.filter((feature) => feature.properties.within_countline_frame).length,
    cameras.within_frame_count,
  );
  for (const feature of cameras.features) {
    assert.equal(feature.geometry.type, "Point");
    const [longitude, latitude] = feature.geometry.coordinates;
    assert.ok(longitude > 170 && latitude < -40);
    // within_countline_frame must agree with the coverage bounds the canvas projects onto.
    assert.equal(
      feature.properties.within_countline_frame,
      longitude >= frame.west &&
        longitude <= frame.east &&
        latitude >= frame.south &&
        latitude <= frame.north,
    );
    assert.match(feature.properties.image_url, /^https:\/\/www\.trafficnz\.info\/camera\//);
    assert.ok(feature.properties.limitations.length > 0);
  }
});

test("removes the disposable starter preview and its dependency", async () => {
  const [page, layout, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(page, /SkeletonPreview|codex-preview/);
  assert.doesNotMatch(layout, /Starter Project|Geist/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  await assert.rejects(access(new URL("../app/_sites-preview", import.meta.url)));
});
