import MovementCanvas from "./MovementCanvas";
import health from "../public/cop/v1/movement-health.json";

const formattedDate = new Intl.DateTimeFormat("en-NZ", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "Pacific/Auckland",
}).format(new Date(health.data_as_of));

export default function Home() {
  return (
    <div className="watch-shell">
      <a className="skip-link" href="#content">
        Skip to main content
      </a>
      <header className="watch-header">
        <a className="watch-brand" href="#top" aria-label="Murmur home">
          <span className="brand-mark" aria-hidden="true">M05</span>
          <span>
            <strong>Murmur</strong>
            <small>Measuring the city’s heartbeat and detecting irregularities</small>
          </span>
        </a>
        <div className="batch-status" aria-label="Publisher mode: batch replay">
          <span className="status-beacon" aria-hidden="true" />
          Batch replay
        </div>
      </header>

      <main id="content">
      <section className="brand-band" id="top">
      <div className="watch-intro">
        <div>
          <p className="eyebrow">Problem 05 · anonymous fixed sensors</p>
          <h1>Movement changes worth investigating</h1>
          <p className="intro-copy">
            Hourly pedestrian and vehicle counts compared with the same weekday and
            hour over the prior 12 weeks. Signals invite investigation; they do not
            diagnose an incident, evacuation, or loss of access. Every source lands
            on one map: WCC countlines and NZTA traffic cameras are layers you
            switch on and off over the same frame.
          </p>
        </div>
        <dl className="snapshot-facts" aria-label="Snapshot summary">
          <div>
            <dt>Signals</dt>
            <dd>{health.candidate_count}</dd>
            <span>12 signals to investigate</span>
          </div>
          <div>
            <dt>Data quality</dt>
            <dd>{health.data_gap_groups}</dd>
            <span>207 data gaps, never filled as zero</span>
          </div>
          <div>
            <dt>Publisher data</dt>
            <dd>06 Aug</dd>
            <span>Data through {formattedDate}</span>
          </div>
        </dl>
      </div>
      </section>

      <MovementCanvas />

      <section className="handoff-section" aria-labelledby="handoff-heading">
        <div>
          <p className="eyebrow">Shared operating picture</p>
          <h2 id="handoff-heading">The map is a view. The feed is the product.</h2>
          <p>
            Each signal is WGS84 GeoJSON with observed and expected counts, robust
            score, sample size, data age, confidence, attribution, and limitations.
            Every added source ships the same way: the NZTA camera layer is another
            GeoJSON file on the same projection, with its own attribution and limits.
          </p>
        </div>
        <div className="endpoint-list">
          <a href="/cop/v1/movement-signals.geojson">
            <span>Signal feed</span>
            <code>/cop/v1/movement-signals.geojson</code>
          </a>
          <a href="/cop/v1/traffic-cameras.geojson">
            <span>Traffic camera layer</span>
            <code>/cop/v1/traffic-cameras.geojson</code>
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

      <footer>
        <strong>Not live emergency information.</strong> In an emergency, call 111.
        Data: Wellington City Council Transport Sensors; camera positions and frames
        from the NZTA Traffic and Travel API, images © NZTA. Prototype for
        investigation only.
      </footer>
    </div>
  );
}
