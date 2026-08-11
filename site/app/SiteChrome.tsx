/**
 * The header and footer shared by every route. Both are server components: the
 * batch-replay chip, the snapshot facts and the attribution block are
 * contractual copy, so they render in the HTML rather than waiting on the
 * client.
 */

import Link from "next/link";
import health from "../public/cop/v1/movement-health.json";

const dataThrough = new Intl.DateTimeFormat("en-NZ", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "Pacific/Auckland",
}).format(new Date(health.data_as_of));

export function SiteHeader() {
  return (
    <header className="watch-header">
      <Link className="watch-brand" href="/" aria-label="Murmur home">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="brand-logo" src="/murmur-logo.svg" alt="Murmur" />
        <small>Measuring the city’s heartbeat and detecting irregularities</small>
      </Link>
      <p className="watch-facts" aria-label="Snapshot summary">
        <strong>{`${health.candidate_count} signals`}</strong>
        <strong>{`${health.data_gap_groups} data gaps`}</strong>
        <span>{`Data through ${dataThrough}`}</span>
      </p>
      <div className="batch-status" aria-label="Publisher mode: batch replay">
        <span className="status-beacon" aria-hidden="true" />
        Batch replay
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer>
      <strong>Not live emergency information.</strong> In an emergency, call 111.
      Data: Wellington City Council Transport Sensors; camera positions and frames
      from the NZTA Traffic and Travel API, images © NZTA; Metlink GTFS timetable
      © Greater Wellington Regional Council, with public-transport running a
      labelled synthetic replay. Prototype for investigation only.
    </footer>
  );
}
