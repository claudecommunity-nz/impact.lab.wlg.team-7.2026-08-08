/**
 * The header and footer shared by every route. Both are server components: the
 * batch-replay chip and the attribution block are contractual copy, so they
 * render in the HTML rather than waiting on the client.
 */

export function SiteHeader() {
  return (
    <header className="watch-header">
      <a className="watch-brand" href="/" aria-label="Murmur home">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="brand-logo" src="/murmur-logo.svg" alt="Murmur" />
        <small>Measuring the city’s heartbeat and detecting irregularities</small>
      </a>
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
