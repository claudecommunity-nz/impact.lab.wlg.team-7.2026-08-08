import MovementCanvas from "./MovementCanvas";
import { SiteFooter, SiteHeader } from "./SiteChrome";
import health from "../public/cop/v1/movement-health.json";

export default function Home() {
  return (
    <div className="watch-shell">
      <a className="skip-link" href="#content">
        Skip to main content
      </a>
      <SiteHeader />

      <main id="content">
      <h1 className="visually-hidden">Movement changes worth investigating</h1>

      <MovementCanvas />

      <section className="handoff-section" aria-labelledby="handoff-heading">
        <div>
          <p className="eyebrow">Shared operating picture</p>
          <h2 id="handoff-heading">The map is a view. The feed is the product.</h2>
          <p>
            WGS84 GeoJSON with counts, robust score, confidence, attribution
            and limitations.
          </p>
          <p>
            <a className="ontology-link" href="/ontology">
              City ontology · 87 sources, one typed graph
            </a>
          </p>
        </div>
        <div className="endpoint-list">
          <a href="/cop/v1/movement-signals.geojson">
            <span>Signal feed</span>
            <code>/cop/v1/movement-signals.geojson</code>
          </a>
          <a href="/cop/v1/movement-replay.json">
            <span>Hourly replay · 1–6 Aug 2026</span>
            <code>/cop/v1/movement-replay.json</code>
          </a>
          <a href="/cop/v1/movement-april.json">
            <span>April movement backtest · 18–23 Apr 2026</span>
            <code>/cop/v1/movement-april.json</code>
          </a>
          <a href="/cop/v1/traffic-cameras.geojson">
            <span>Traffic camera layer</span>
            <code>/cop/v1/traffic-cameras.geojson</code>
          </a>
          <a href="/cop/v1/transit-anomalies.geojson">
            <span>PT anomaly layer (synthetic)</span>
            <code>/cop/v1/transit-anomalies.geojson</code>
          </a>
          <a href="/cop/v1/road-anomalies.geojson">
            <span>State highway layer (real April 2026 floods)</span>
            <code>/cop/v1/road-anomalies.geojson</code>
          </a>
          <a href="/cop/v1/road-events.geojson">
            <span>Road events and closures (NZTA TREIS snapshot)</span>
            <code>/cop/v1/road-events.geojson</code>
          </a>
          <a href="/cop/v1/rain-april.geojson">
            <span>Rainfall layer (real April 2026, GWRC Hilltop)</span>
            <code>/cop/v1/rain-april.geojson</code>
          </a>
          <a href="/cop/v1/reports-april.geojson">
            <span>Public reports layer (synthetic ticket flow)</span>
            <code>/cop/v1/reports-april.geojson</code>
          </a>
          <a href="/cop/v1/live-sim.json">
            <span>Live monitor simulation (synthetic)</span>
            <code>/cop/v1/live-sim.json</code>
          </a>
          <a href="/cop/v1/flight-anomalies.geojson">
            <span>Air access layer (real April 2026, OpenSky)</span>
            <code>/cop/v1/flight-anomalies.geojson</code>
          </a>
          <a href="/cop/v1/movement-health.json">
            <span>Coverage and health</span>
            <code>/cop/v1/movement-health.json</code>
          </a>
        </div>
      </section>

      <section className="limits-section" aria-labelledby="limits-heading">
        <p className="eyebrow">Known limits</p>
        <h2 id="limits-heading">What this signal cannot tell Council</h2>
        <div className="limit-grid">
          {health.limitations.map((limitation) => (
            <p key={limitation}>{limitation}</p>
          ))}
        </div>
      </section>
      </main>

      <SiteFooter />
    </div>
  );
}
