import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

async function render(path = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${path}`, { headers: { accept: "text/html" } }),
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
  // The real brand assets, not the starter placeholders.
  assert.ok(html.includes("/murmur-logo.svg"));
  assert.ok(html.includes("/murmur-favicon.svg"));
  assert.doesNotMatch(html, /brand-mark|>M05</);
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
  assert.ok(html.includes("/cop/v1/movement-replay.json"));
  assert.ok(html.includes("/cop/v1/movement-health.json"));
  assert.ok(html.includes("/cop/v1/traffic-cameras.geojson"));
  assert.ok(html.includes("/cop/v1/transit-anomalies.geojson"));
  assert.ok(html.includes("/cop/v1/road-anomalies.geojson"));
  // The replay timebar server-renders on the default published hour.
  assert.match(html, /aria-label="Batch replay timeline"/);
  assert.match(html, /aria-label="Replay hour"/);
  assert.match(html, /Play the replay/);
  assert.match(html, /Thu 6 Aug · 12:00/);
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

test("ships the hourly replay as a consistent, leakage-safe contract", async () => {
  const [replayText, healthText, signalsText, coverageText] = await Promise.all([
    readFile(new URL("../public/cop/v1/movement-replay.json", import.meta.url), "utf8"),
    readFile(new URL("../public/cop/v1/movement-health.json", import.meta.url), "utf8"),
    readFile(new URL("../public/cop/v1/movement-signals.geojson", import.meta.url), "utf8"),
    readFile(new URL("../public/cop/v1/countline-coverage.geojson", import.meta.url), "utf8"),
  ]);
  const replay = JSON.parse(replayText);
  const health = JSON.parse(healthText);
  const signals = JSON.parse(signalsText);
  const coverage = JSON.parse(coverageText);

  assert.equal(replay.schema, "movement-replay/v1");
  assert.equal(replay.publisher_mode, "batch replay");
  assert.equal(replay.slots.length, 144);
  assert.equal(replay.default_target_at, health.target_at);
  assert.ok(replay.limitations.length > 0);
  assert.equal(replay.automatic_incident, false);
  assert.equal(replay.automatic_warning, false);

  // The default slot is the committed snapshot, feature for feature.
  const defaultSlot = replay.slots.find((slot) => slot.target_at === replay.default_target_at);
  assert.ok(defaultSlot, "the default hour must be one of the published slots");
  assert.equal(defaultSlot.candidate_count, health.candidate_count);
  assert.equal(defaultSlot.data_gap_groups, health.data_gap_groups);
  const key = (signal) => `${signal.countline_id}:${signal.transport_class}:${signal.direction}`;
  assert.deepEqual(
    defaultSlot.signals.map(key).sort(),
    signals.features.map((feature) => key(feature.properties)).sort(),
  );

  // Every slot is internally consistent and every signal lands on a countline.
  const countlines = new Set(coverage.features.map((feature) => feature.properties.countline_id));
  let total = 0;
  for (const slot of replay.slots) {
    assert.equal(slot.signals.length, slot.candidate_count);
    total += slot.candidate_count;
    for (const signal of slot.signals) {
      assert.ok(countlines.has(signal.countline_id), `${signal.countline_id} must have geometry`);
      assert.ok(signal.matched_history.length <= 12);
      // Trend history must sit strictly before the observed hour: no future leakage.
      for (const point of signal.matched_history) {
        assert.ok(point.observed_at < signal.observed_at);
      }
      assert.ok(["increase", "decrease"].includes(signal.change_direction));
    }
  }
  assert.equal(replay.candidate_count, total);
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
  assert.match(html, /Public transport/);
  assert.match(html, /State highways/);
  assert.match(html, /Air access/);
  // Investigation presets: the batch snapshot and the real April case.
  assert.match(html, /aria-label="Investigations"/);
  assert.match(html, /Movement snapshot/);
  assert.match(html, /Floods and storm/);
  assert.match(html, /18–22 Apr 2026/);
  // Signals and coverage start on; the corroborating layers start off.
  assert.ok((html.match(/aria-pressed="true"/g) ?? []).length >= 3);
  assert.ok((html.match(/aria-pressed="false"/g) ?? []).length >= 3);
  // The floating layer menu starts open, with local search and truth badges.
  assert.match(html, /aria-controls="layer-menu-body"/);
  assert.match(html, /Find on the map/);
  assert.match(html, /status-badge live/);
  assert.match(html, /status-badge synthetic/);
  assert.match(html, /status-badge real/);
  // One canvas, one projection: no source ships a second map.
  assert.equal(html.match(/<canvas/g)?.length, 1);
});

test("ships the PT anomaly layer as an honestly labelled synthetic artifact", async () => {
  const transitText = await readFile(
    new URL("../public/cop/v1/transit-anomalies.geojson", import.meta.url),
    "utf8",
  );
  const transit = JSON.parse(transitText);

  assert.equal(transit.type, "FeatureCollection");
  assert.equal(transit.schema, "transit-anomaly-collection/v1");
  assert.equal(transit.synthetic, true);
  assert.equal(transit.features.length, transit.hotspot_count);
  assert.ok(transit.hotspot_count > 0 && transit.hotspot_count < transit.stop_count);
  assert.match(transit.attribution, /Metlink/);
  assert.ok(transit.limitations.some((entry) => /[Ss]ynthetic/.test(entry)));

  // Sorted worst-first so the site's top-N list slice is honest.
  const counts = transit.features.map((feature) => feature.properties.anomaly_count);
  assert.deepEqual(counts, [...counts].sort((a, b) => b - a));

  for (const feature of transit.features) {
    assert.equal(feature.geometry.type, "Point");
    const [longitude, latitude] = feature.geometry.coordinates;
    assert.ok(longitude > 170 && latitude < -40);
    assert.equal(feature.properties.synthetic, true);
    assert.ok(feature.properties.limitations.length > 0);
    assert.ok(["high", "elevated"].includes(feature.properties.severity_tier));
  }
});

test("ships the state highway layer as a real, attributed flood backtest", async () => {
  const roadText = await readFile(
    new URL("../public/cop/v1/road-anomalies.geojson", import.meta.url),
    "utf8",
  );
  const roads = JSON.parse(roadText);

  assert.equal(roads.type, "FeatureCollection");
  assert.equal(roads.schema, "road-anomaly-collection/v1");
  assert.equal(roads.real_event, true);
  assert.match(roads.event, /April 2026/);
  assert.deepEqual(roads.event_dates, ["2026-04-20", "2026-04-21"]);
  assert.equal(roads.features.length, roads.site_count);
  assert.match(roads.attribution, /NZ Transport Agency|NZTA/);
  assert.ok(roads.limitations.some((entry) => /[Rr]eal data/.test(entry)));

  // The no-geometry Ngauranga sites are surfaced, never silently dropped.
  assert.ok(roads.sites_without_geometry.length > 0);
  assert.equal(
    roads.flagged_site_count,
    roads.site_count + roads.sites_without_geometry.length,
  );

  // Sorted worst-first so the site's top-N list slice is honest.
  const scores = roads.features.map((feature) => Math.abs(feature.properties.robust_z));
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a));

  for (const feature of roads.features) {
    assert.equal(feature.geometry.type, "Point");
    const [longitude, latitude] = feature.geometry.coordinates;
    assert.ok(longitude > 170 && latitude < -40);
    assert.equal(feature.properties.real_event, true);
    assert.ok(feature.properties.limitations.length > 0);
    assert.ok(["HIGH", "MEDIUM", "LOW"].includes(feature.properties.severity));
    assert.ok(["2026-04-20", "2026-04-21"].includes(feature.properties.date));

    // Each site carries its April daily series: reported days only, in order,
    // and the flagged day the feature publishes must appear in its own history.
    const history = feature.properties.daily_history;
    assert.ok(history.length > 0);
    const dates = history.map((day) => day.date);
    assert.deepEqual(dates, [...dates].sort());
    assert.ok(
      history.some(
        (day) =>
          day.date === feature.properties.date &&
          day.observed === feature.properties.observed_count,
      ),
    );
  }
});

test("ships the air-access layer as a real, attributed OpenSky backtest", async () => {
  const flightText = await readFile(
    new URL("../public/cop/v1/flight-anomalies.geojson", import.meta.url),
    "utf8",
  );
  const flights = JSON.parse(flightText);

  assert.equal(flights.type, "FeatureCollection");
  assert.equal(flights.schema, "flight-anomaly-collection/v1");
  assert.equal(flights.real_data, true);
  assert.match(flights.attribution, /OpenSky/);
  assert.ok(flights.limitations.some((entry) => /[Rr]eal data/.test(entry)));
  assert.ok(flights.limitations.some((entry) => /gaps, never zeros/.test(entry)));

  assert.equal(flights.features.length, 1);
  const feature = flights.features[0];
  assert.equal(feature.geometry.type, "Point");
  const [longitude, latitude] = feature.geometry.coordinates;
  assert.ok(longitude > 174.7 && longitude < 174.9 && latitude < -41.2 && latitude > -41.4);

  const properties = feature.properties;
  assert.equal(properties.iata, "WLG");
  assert.equal(
    flights.flagged_hour_count,
    properties.high_hours + properties.medium_hours,
  );
  assert.equal(properties.flagged_hours.length, flights.flagged_hour_count);
  assert.ok(properties.daily_movements.length >= 28);
  const dates = properties.daily_movements.map((day) => day.date);
  assert.deepEqual(dates, [...dates].sort());
  const flaggedDates = new Set(properties.flagged_hours.map((hour) => hour.date));
  for (const day of properties.daily_movements) {
    assert.equal(day.flagged, flaggedDates.has(day.date));
  }
  // The flood days the roads layer flags are independently visible from the air.
  assert.ok(properties.flagged_hours.some((hour) => hour.date === "2026-04-20"));
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

test("carries a hideable sidebar and the agent on every route", async () => {
  for (const path of ["/", "/settings"]) {
    const response = await render(path);
    assert.equal(response.status, 200, `${path} should render`);
    const html = await response.text();

    assert.match(html, /aria-label="Murmur sections"/, `${path} should ship the navigator`);
    assert.match(html, /Operating picture/);
    assert.match(html, /Data sources/);
    assert.match(html, /Integrations/);
    // The rail can be put away, and says which state it is in.
    assert.match(html, /Hide the navigator|Show the navigator/);
    // The agent is reachable from anywhere, not just the dashboard.
    assert.match(html, /Ask the Murmur agent/);
    assert.match(html, /aria-controls="agent-panel"/);
    // Chrome that must never drop off a route.
    assert.match(html, /Batch replay/);
    assert.match(html, /Not live emergency information/);
  }
});

test("lets the dashboard brief be folded away", async () => {
  const html = await render("/").then((response) => response.text());

  // First visit shows the brief, so the demo and a new operator both get it.
  assert.match(html, /Movement changes worth investigating/);
  assert.match(html, /Hide the brief/);
  assert.match(html, /aria-expanded="true"/);
  // Folded, the strip is what remains: it must not need the hero to make sense.
  assert.doesNotMatch(html, /Show the brief/);
});

test("puts the investigate panel beside the map and lets it slide away", async () => {
  const html = await render("/").then((response) => response.text());

  // The toggle owns the panel, and the panel starts open.
  assert.match(html, /aria-controls="evidence-panel"/);
  assert.match(html, /id="evidence-panel"/);
  assert.match(html, /Hide investigate panel/);
  assert.doesNotMatch(html, /Show investigate panel/);
  // Still one canvas and one projection after the layout swap.
  assert.equal(html.match(/<canvas/g)?.length, 1);
});

test("keeps source settings off the dashboard and on their own route", async () => {
  const [dashboard, settings] = await Promise.all([
    render("/").then((response) => response.text()),
    render("/settings").then((response) => response.text()),
  ]);

  // The operating picture stays an operating picture.
  assert.doesNotMatch(dashboard, /Add a source/);
  assert.doesNotMatch(dashboard, /Agent setup<\/h2>/);
  assert.doesNotMatch(dashboard, /A2A agent card/);

  assert.match(settings, /Data sources and integrations/);
  assert.match(settings, /Last sync/);
  assert.match(settings, /Test all/);
  assert.match(settings, /Add a source/);
  assert.match(settings, /id="integrations"/);
  assert.match(settings, /MCP server config/);
  assert.match(settings, /A2A agent card/);
  // Agent setup: hosted providers linked by a browser-held key, local by default.
  assert.match(settings, /Agent setup/);
  assert.match(settings, /id="agent"/);
  assert.match(settings, /Local answers \(no API\)/);
  assert.match(settings, /Anthropic Claude/);
  assert.match(settings, /stored in this browser/);
  // Every built-in source is listed with a retry control.
  for (const url of [
    "/cop/v1/movement-signals.geojson",
    "/cop/v1/movement-replay.json",
    "/cop/v1/countline-coverage.geojson",
    "/cop/v1/traffic-cameras.geojson",
    "/cop/v1/transit-anomalies.geojson",
    "/cop/v1/road-anomalies.geojson",
    "/cop/v1/flight-anomalies.geojson",
    "/cop/v1/movement-health.json",
  ]) {
    assert.ok(settings.includes(url), `${url} should be listed as a source`);
  }
  assert.ok((settings.match(/Test or retry/g) ?? []).length >= 8);
  // Four export formats are offered per source.
  for (const format of ["GeoJSON", "JSON", "CSV", "NDJSON"]) {
    assert.ok(settings.includes(format), `${format} should be an export option`);
  }
  // Settings never adds a second map.
  assert.equal(settings.match(/<canvas/g), null);
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

test("keeps provider API keys and other secrets out of the repo", async () => {
  // Agent keys live in the visitor's browser localStorage only. This scan is
  // the backstop: if a live-looking key ever lands in the source or artifacts,
  // the suite fails before it can ship. Placeholders like "sk-ant-…" don't
  // match — the patterns require real key-length bodies.
  const KEY_SHAPES = [
    ["Anthropic key", /sk-ant-[A-Za-z0-9_-]{16,}/],
    ["OpenAI/DeepSeek key", /\bsk-[A-Za-z0-9]{32,}/],
    ["Google API key", /\bAIza[0-9A-Za-z_-]{30,}/],
    ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{30,}/],
    ["Webhook signing secret", /\bwhsec_[A-Za-z0-9]{20,}/],
    ["Private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ];
  const TEXT_EXTENSIONS = new Set([
    ".ts", ".tsx", ".mjs", ".js", ".json", ".geojson", ".css", ".md", ".html",
    ".py", ".toml", ".yml", ".yaml", ".txt", ".sql",
  ]);
  const SKIP_DIRS = new Set(["node_modules", "dist", ".venv", ".wrangler", ".vinext", ".next", "data"]);

  const here = path.dirname(fileURLToPath(import.meta.url));
  const roots = [
    path.join(here, "..", "app"),
    path.join(here, "..", "worker"),
    path.join(here, "..", "tests"),
    path.join(here, "..", "public"),
    path.join(here, "..", "..", "scripts"),
    path.join(here, "..", "..", "src"),
  ];

  const offences = [];
  for (const root of roots) {
    let entries;
    try {
      entries = await readdir(root, { recursive: true, withFileTypes: true });
    } catch {
      continue; // a root may not exist in a partial checkout
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const full = path.join(entry.parentPath ?? entry.path, entry.name);
      const relative = path.relative(path.join(here, "..", ".."), full);
      if (relative.split(path.sep).some((part) => SKIP_DIRS.has(part))) continue;
      if (!TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      const text = await readFile(full, "utf8");
      for (const [label, pattern] of KEY_SHAPES) {
        if (pattern.test(text)) offences.push(`${relative}: looks like a ${label}`);
      }
    }
  }
  assert.deepEqual(offences, [], `Secret-shaped strings found:\n${offences.join("\n")}`);
});
