import { SiteFooter, SiteHeader } from "../SiteChrome";

export const metadata = {
  title: "City ontology · Murmur",
  description:
    "One typed graph over 87 sources: the WCC emergency-GIS catalogue and the Murmur COP feeds. A concept for Team 7 review.",
};

/* ==================== the city ontology page ====================
 * The WCO concept as a route: the same charts as the shared concept page,
 * re-set in Murmur's own tokens — grey ladder for data, WCC yellow for the
 * one accent, amber/red only where the app already means increase/decrease.
 * Counts are computed from the real catalogue and the 13 COP feeds; the
 * mobile view drops the detail lines (`wco-hide-s`), never the numbers. */

const INK = "var(--wcc-grey-900)";
const G700 = "var(--wcc-grey-700)";
const G500 = "var(--wcc-grey-500)";
const G300 = "var(--wcc-grey-300)";
const G100 = "var(--wcc-grey-100)";
const YELLOW = "var(--wcc-yellow)";

function Spine() {
  return (
    <section className="wco-card dark" aria-labelledby="wco-spine-h">
      <h2 id="wco-spine-h">Seven classes, one loop</h2>
      <p className="wco-sub wco-hide-s">node size = sources in class · arrows read left to right</p>
      <div className="wco-scroll">
        <svg
          viewBox="0 0 960 470"
          style={{ minWidth: 780, width: "100%", height: "auto" }}
          role="img"
          aria-label="Network of the seven Wellington City Ontology classes: observations are detected into signals, signals evidence an event, warnings corroborate and hazard layers frame it; the event affects lifelines and activates response, prioritised by community data; sensors observe the same lifelines back."
        >
          <defs>
            <marker id="wco-arr" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
              <path d="M0 0L8 4L0 8Z" fill={G500} />
            </marker>
          </defs>
          <g stroke={G700} strokeWidth="1.6" fill="none">
            <path d="M118 130 Q160 150 246 152" markerEnd="url(#wco-arr)" />
            <path d="M352 175 Q430 205 496 216" markerEnd="url(#wco-arr)" />
            <path d="M188 262 Q240 262 300 262" markerEnd="url(#wco-arr)" />
            <path d="M368 258 Q430 248 494 236" markerEnd="url(#wco-arr)" />
            <path d="M310 388 Q420 360 502 260" markerEnd="url(#wco-arr)" />
            <path d="M588 202 Q660 165 722 142" markerEnd="url(#wco-arr)" />
            <path d="M586 254 Q670 300 730 330" markerEnd="url(#wco-arr)" />
            <path d="M872 388 Q830 370 800 352" markerEnd="url(#wco-arr)" />
            <path d="M740 152 Q420 90 172 230" strokeDasharray="5 5" markerEnd="url(#wco-arr)" />
          </g>
          <g fontSize="10.5" fontWeight="600" fill={G300}>
            <text x="164" y="132">conditions</text>
            <text x="408" y="192">frames</text>
            <text x="212" y="250">detects</text>
            <text className="wco-hide-s" x="212" y="278" fontSize="9" fill={G500}>median + MAD</text>
            <text x="405" y="238">evidences</text>
            <text x="380" y="342">corroborates</text>
            <text x="650" y="160">affects</text>
            <text x="648" y="298">activates</text>
            <text x="796" y="384">prioritises</text>
            <text className="wco-hide-s" x="400" y="106" fill={G500} fontSize="9.5">
              observes · WCC transport sensors on the network they measure
            </text>
          </g>
          <g textAnchor="middle">
            <g>
              <circle cx="96" cy="122" r="18" fill={G500} />
              <text x="96" y="158" fontSize="11" fontWeight="600" fill={G300}>Ground &amp; Land</text>
              <text x="96" y="126" fontSize="11" fontWeight="800" fill="#000">5</text>
              <title>Ground &amp; Land · 5 · slope, wind zones, soils, tree cover</title>
            </g>
            <g>
              <circle cx="300" cy="152" r="52" fill={G300} />
              <text x="300" y="146" fontSize="13" fontWeight="700" fill="#000">Hazard</text>
              <text x="300" y="163" fontSize="14" fontWeight="800" fill="#000">55</text>
              <title>Hazard · 55 · climate 21, quake 9, coastal 12, flood 8, landslide 5</title>
            </g>
            <g>
              <circle cx="146" cy="262" r="40" fill={G100} />
              <text x="146" y="256" fontSize="11.5" fontWeight="700" fill="#000">Movement &amp;</text>
              <text x="146" y="269" fontSize="11.5" fontWeight="700" fill="#000">Observation</text>
              <text x="146" y="284" fontSize="12.5" fontWeight="800" fill="#000">14</text>
              <circle cx="146" cy="262" r="46" fill="none" stroke={YELLOW} strokeWidth="1.6" strokeDasharray="4 4" />
              <title>Movement &amp; Observation · 14 · 13 arrive through the Murmur COP</title>
            </g>
            <g>
              <circle cx="334" cy="262" r="30" fill="none" stroke={G100} strokeWidth="1.6" strokeDasharray="5 4" />
              <text x="334" y="259" fontSize="11.5" fontWeight="700" fill={G100}>Signal</text>
              <text x="334" y="273" fontSize="9" fontWeight="500" fill={G300}>derived</text>
              <title>Signal · derived, not stored · gated deviation from a matched baseline</title>
            </g>
            <g>
              <circle cx="272" cy="392" r="26" fill={G500} />
              <text x="272" y="388" fontSize="10.5" fontWeight="700" fill="#000">Warnings</text>
              <text x="272" y="401" fontSize="11.5" fontWeight="800" fill="#000">4</text>
              <title>Warnings &amp; Alerts · 4 · MetService CAP, NZTA warnings, shaking layers, alert polygons</title>
            </g>
            <g>
              <circle cx="544" cy="228" r="46" fill={YELLOW} />
              <text x="544" y="222" fontSize="13" fontWeight="800" fill="#000">Event</text>
              <text x="544" y="238" fontSize="9.5" fontWeight="600" fill={G700}>episode</text>
              <title>Event · an investigation episode · e.g. the 18–22 Apr 2026 storm</title>
            </g>
            <g>
              <circle cx="746" cy="130" r="27" fill={G300} />
              <text x="746" y="126" fontSize="10.5" fontWeight="700" fill="#000">Lifelines</text>
              <text x="746" y="140" fontSize="11.5" fontWeight="800" fill="#000">5</text>
              <title>Lifelines &amp; Networks · 5 · roads, footpaths, water faults, power outages</title>
            </g>
            <g>
              <circle cx="762" cy="340" r="24" fill={G100} />
              <text x="762" y="336" fontSize="10" fontWeight="700" fill="#000">Response</text>
              <text x="762" y="350" fontSize="11.5" fontWeight="800" fill="#000">3</text>
              <title>Response Assets · 3 · community hubs, water tanks, post-quake routes</title>
            </g>
            <g>
              <circle cx="886" cy="398" r="15" fill={G500} />
              <text x="886" y="431" fontSize="10.5" fontWeight="600" fill={G300}>People</text>
              <text x="886" y="402" fontSize="10.5" fontWeight="800" fill="#000">1</text>
              <title>People &amp; Community · 1 · NZ Index of Deprivation (SA1)</title>
            </g>
          </g>
        </svg>
      </div>
      <p className="wco-src">87 sources · dashed ring = Murmur · dashed node = derived, not stored</p>
    </section>
  );
}

function Holdings() {
  return (
    <section className="wco-card" aria-labelledby="wco-hold-h">
      <h2 id="wco-hold-h">55 of 87 sources map risk</h2>
      <p className="wco-sub wco-hide-s">class × holding authority</p>
      <div className="wco-scroll">
        <svg
          viewBox="0 0 560 310"
          style={{ minWidth: 470, width: "100%", height: "auto" }}
          role="img"
          aria-label="Stacked bars: Hazard 55, Movement and Observation 14, Ground and Land 5, Lifelines 5, Warnings 4, Response 3, People 1, segmented by authority."
        >
          <g fontSize="9.5" fontWeight="600" fill={G700}>
            <circle cx="8" cy="10" r="5" fill={INK} />
            <text x="18" y="13.5">WCC</text>
            <circle cx="62" cy="10" r="5" fill={G700} />
            <text x="72" y="13.5">GWRC</text>
            <circle cx="124" cy="10" r="5" fill={G500} />
            <text x="134" y="13.5">National</text>
            <circle cx="192" cy="10" r="5" fill={G300} />
            <text x="202" y="13.5">Other</text>
          </g>
          <g fontSize="11" fontWeight="600" fill={INK}>
            <text x="8" y="52">Hazard</text>
            <rect x="8" y="58" width="91.7" height="16" fill={INK}><title>WCC · 14</title></rect>
            <rect x="99.7" y="58" width="216.2" height="16" fill={G700}><title>GWRC · 33</title></rect>
            <path d="M315.9 58h44.4a8 8 0 0 1 0 16h-44.4z" fill={G500}><title>National · 8</title></path>
            <text x="370" y="71" fontWeight="800" fontSize="12.5">55</text>
            <text className="wco-hide-s" x="8" y="88" fontSize="8.5" fontWeight="500" fill={G500} letterSpacing=".04em">
              CLIMATE 21 · QUAKE 9 · COASTAL 12 · FLOOD 8 · LANDSLIDE 5
            </text>

            <text x="8" y="116">Movement &amp; Observation</text>
            <rect x="8" y="122" width="39.3" height="16" fill={INK}><title>WCC · 6</title></rect>
            <rect x="47.3" y="122" width="13.1" height="16" fill={G700}><title>GWRC · 2</title></rect>
            <rect x="60.4" y="122" width="19.7" height="16" fill={G500}><title>National · 3</title></rect>
            <path d="M80.1 122h11.6a8 8 0 0 1 0 16H80.1z" fill={G300}><title>Other · 3</title></path>
            <text x="101" y="135" fontWeight="800" fontSize="12.5">14</text>
            <rect x="8" y="144" width="8" height="8" fill={YELLOW} />
            <text x="21" y="152" fontSize="8.5" fontWeight="600" fill={G700} letterSpacing=".04em">
              13 OF 14 ARRIVE THROUGH THE MURMUR COP
            </text>

            <text x="8" y="182">Ground &amp; Land</text>
            <path d="M8 188h24.8a8 8 0 0 1 0 16H8z" fill={INK}><title>WCC · 5</title></path>
            <text x="42" y="201" fontWeight="800" fontSize="12.5">5</text>

            <text x="150" y="182">Lifelines &amp; Networks</text>
            <rect x="150" y="188" width="19.7" height="16" fill={INK}><title>WCC · 3</title></rect>
            <rect x="169.7" y="188" width="6.5" height="16" fill={G500}><title>National · 1</title></rect>
            <path d="M176.2 188h2.6a8 8 0 0 1 0 16h-2.6z" fill={G300}><title>Wellington Water · 1</title></path>
            <text x="192" y="201" fontWeight="800" fontSize="12.5">5</text>

            <text x="310" y="182">Warnings &amp; Alerts</text>
            <path d="M310 188h18.2a8 8 0 0 1 0 16H310z" fill={G500}><title>National · 4</title></path>
            <text x="336" y="201" fontWeight="800" fontSize="12.5">4</text>

            <text x="8" y="236">Response Assets</text>
            <rect x="8" y="242" width="13.1" height="16" fill={INK}><title>WCC · 2</title></rect>
            <path d="M21.1 242h2.6a8 8 0 0 1 0 16h-2.6z" fill={G300}><title>WREMO · 1</title></path>
            <text x="36" y="255" fontWeight="800" fontSize="12.5">3</text>

            <text x="150" y="236">People &amp; Community</text>
            <path d="M150 242h0.5a8 8 0 0 1 0 16H150z" fill={G300}><title>Otago / Stats NZ · 1</title></path>
            <text x="166" y="255" fontWeight="800" fontSize="12.5">1</text>
          </g>
          <text className="wco-hide-s" x="8" y="298" fontSize="9.5" fontWeight="500" fill={G500} letterSpacing=".08em">
            TOTALS SUM TO 87 · EVERY SOURCE SITS IN EXACTLY ONE CLASS
          </text>
        </svg>
      </div>
      <p className="wco-src">WCC emergency-GIS catalogue + Murmur COP v1</p>
    </section>
  );
}

const STATIC_ROWS = [22, 22, 22, 3];

function Truth() {
  return (
    <section className="wco-card" aria-labelledby="wco-truth-h">
      <h2 id="wco-truth-h">7 of 87 speak in real time</h2>
      <p className="wco-sub wco-hide-s">darker = fresher · hollow = declared synthetic</p>
      <div className="wco-scroll">
        <svg
          viewBox="0 0 560 310"
          style={{ minWidth: 470, width: "100%", height: "auto" }}
          role="img"
          aria-label="Dot chart of 87 sources by truth class: 7 live, 4 batch replay, 4 real archived April 2026, 3 declared synthetic, 69 static planning layers."
        >
          <g fontSize="11" fontWeight="600" fill={INK}>
            <text x="8" y="26">Live</text>
            <rect x="6" y="31" width="22" height="15" fill={YELLOW} />
            <text x="10" y="43" fontSize="12.5" fontWeight="800">7</text>
            <text x="8" y="76">Batch replay</text>
            <text x="8" y="91" fontSize="12.5" fontWeight="800">4</text>
            <text x="8" y="126">Real · archived</text>
            <text x="8" y="141" fontSize="12.5" fontWeight="800">4</text>
            <text x="8" y="176">Synthetic · declared</text>
            <text x="8" y="191" fontSize="12.5" fontWeight="800">3</text>
            <text x="8" y="226">Static · planning</text>
            <text x="8" y="241" fontSize="12.5" fontWeight="800">69</text>
          </g>
          <g fill={INK}>
            {["NZTA traffic cameras", "Waka Kotahi TREIS road events", "MetService weather CAP", "Eagle / NZTA warnings", "GeoNet shaking layers", "Wellington Water faults", "National electricity outages"].map(
              (name, i) => (
                <circle key={name} cx={120 + i * 20} cy={30} r={7}>
                  <title>{name}</title>
                </circle>
              ),
            )}
          </g>
          <g fill={G700}>
            {["movement-signals", "movement-replay", "movement-health", "countline-coverage"].map((name, i) => (
              <circle key={name} cx={120 + i * 20} cy={80} r={7}>
                <title>{`${name} · WCC transport sensors`}</title>
              </circle>
            ))}
          </g>
          <g fill={G500}>
            {["movement-april", "road-anomalies", "flight-anomalies", "rain-april"].map((name, i) => (
              <circle key={name} cx={120 + i * 20} cy={130} r={7}>
                <title>{`${name} · real, archived Apr 2026`}</title>
              </circle>
            ))}
          </g>
          <g fill="none" stroke={G500} strokeWidth="2">
            {["transit-anomalies", "reports-april", "live-sim"].map((name, i) => (
              <circle key={name} cx={120 + i * 20} cy={180} r={6}>
                <title>{`${name} · declared synthetic`}</title>
              </circle>
            ))}
          </g>
          <g fill={G300}>
            {STATIC_ROWS.flatMap((count, row) =>
              Array.from({ length: count }, (_, i) => (
                <circle key={`${row}-${i}`} cx={120 + i * 20} cy={230 + row * 20} r={7}>
                  <title>69 planning layers · updated on plan cycles, not clocks</title>
                </circle>
              )),
            )}
          </g>
        </svg>
      </div>
      <p className="wco-src">one dot = one source · truth classes after Murmur&apos;s layer badges</p>
    </section>
  );
}

function Storm() {
  return (
    <section className="wco-card" aria-labelledby="wco-storm-h">
      <h2 id="wco-storm-h">One storm through the graph</h2>
      <p className="wco-sub">18–22 Apr 2026 · every number is from the published artifacts</p>
      <div className="wco-scroll">
        <svg
          viewBox="0 0 960 380"
          style={{ minWidth: 800, width: "100%", height: "auto" }}
          role="img"
          aria-label="Instance diagram: four independent real observations and one declared-synthetic report stream evidence the April 2026 storm event; rain corroborates the movement drop within two hours; the event affects the state-highway lifeline and lands in the review queue."
        >
          <defs>
            <marker id="wco-arr2" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
              <path d="M0 0L8 4L0 8Z" fill={G700} />
            </marker>
          </defs>
          <g fontSize="11">
            <g>
              <rect x="8" y="16" width="252" height="58" rx="6" fill="var(--surface-alt)" stroke={G300} />
              <text x="24" y="38" fontWeight="700" fill={INK}>wco:MovementSignal · set</text>
              <text x="24" y="54" fill={G700}>
                <tspan fill="var(--wcc-error)" fontWeight="700">↓ 601</tspan>
                <tspan> · </tspan>
                <tspan fill="var(--wcc-warning)" fontWeight="700">↑ 175</tspan>
                <tspan> gated deviations</tspan>
              </text>
              <text x="24" y="67" fontSize="8.5" letterSpacing=".08em" fill={G500}>WCC TRANSPORT SENSORS · REAL · BACKTEST</text>
            </g>
            <g>
              <rect x="8" y="96" width="252" height="58" rx="6" fill="var(--surface-alt)" stroke={G300} />
              <text x="24" y="118" fontWeight="700" fill={INK}>wco:RainObservation</text>
              <text x="24" y="134" fill={G700}>peak 77.1 mm/h · 54 warning-criteria h</text>
              <text x="24" y="147" fontSize="8.5" letterSpacing=".08em" fill={G500}>GWRC HILLTOP · REAL · HOURLY</text>
            </g>
            <g>
              <rect x="8" y="176" width="252" height="58" rx="6" fill="var(--surface-alt)" stroke={G300} />
              <text x="24" y="198" fontWeight="700" fill={INK}>wco:RoadImpact</text>
              <text x="24" y="214" fill={G700}>94 state-highway sites flagged</text>
              <text x="24" y="227" fontSize="8.5" letterSpacing=".08em" fill={G500}>NZTA TMS · REAL · 2-DAY LAG</text>
            </g>
            <g>
              <rect x="8" y="256" width="252" height="58" rx="6" fill="var(--surface-alt)" stroke={G300} />
              <text x="24" y="278" fontWeight="700" fill={INK}>wco:AirAccess</text>
              <text x="24" y="294" fill={G700}>9 flagged hours at WLG</text>
              <text x="24" y="307" fontSize="8.5" letterSpacing=".08em" fill={G500}>OPENSKY · REAL · INDEPENDENT OF ROADS</text>
            </g>
            <g>
              <rect x="8" y="336" width="252" height="40" rx="6" fill="none" stroke={G500} strokeDasharray="5 4" />
              <text x="24" y="353" fontWeight="700" fill={INK}>wco:PublicReport · stream</text>
              <text x="24" y="368" fontSize="8.5" letterSpacing=".08em" fill={G500}>DECLARED SYNTHETIC · CORROBORATION ±2 H</text>
            </g>
          </g>
          <g stroke={G700} strokeWidth="1.6" fill="none">
            <path d="M262 45 Q380 60 480 142" markerEnd="url(#wco-arr2)" />
            <path d="M262 125 Q380 130 476 164" markerEnd="url(#wco-arr2)" />
            <path d="M262 205 Q380 200 476 186" markerEnd="url(#wco-arr2)" />
            <path d="M262 285 Q390 275 482 204" markerEnd="url(#wco-arr2)" />
            <path d="M262 352 Q400 340 492 220" strokeDasharray="5 4" markerEnd="url(#wco-arr2)" />
            <path d="M132 82 Q126 88 132 94" markerEnd="url(#wco-arr2)" />
          </g>
          <g fontSize="10" fontWeight="600" fill={G700}>
            <text className="wco-hide-s" x="356" y="98">evidences ×4 · independent sources</text>
            <text x="146" y="92">corroborates ±2 h</text>
          </g>
          <g>
            <rect x="492" y="118" width="216" height="112" rx="6" fill="var(--wcc-black)" />
            <text x="512" y="148" fontSize="13.5" fontWeight="800" fill={YELLOW}>wco:Event</text>
            <text x="512" y="168" fontSize="12" fontWeight="700" fill="var(--surface-page)">Storm &amp; floods</text>
            <text x="512" y="184" fontSize="11" fill={G300}>18–22 Apr 2026 · Wellington</text>
            <text x="512" y="204" fontSize="9" letterSpacing=".08em" fill={G500}>MURMUR CASE APRIL-FLOODS</text>
          </g>
          <g stroke={G700} strokeWidth="1.6" fill="none">
            <path d="M710 152 Q760 140 800 128" markerEnd="url(#wco-arr2)" />
            <path d="M710 204 Q760 220 798 240" markerEnd="url(#wco-arr2)" />
          </g>
          <g fontSize="10" fontWeight="600" fill={G700}>
            <text x="724" y="132">affects</text>
            <text x="722" y="236">lands in</text>
          </g>
          <g fontSize="11">
            <g>
              <rect x="802" y="96" width="150" height="58" rx="6" fill={G100} stroke={G300} />
              <text x="816" y="118" fontWeight="700" fill={INK}>wco:Lifeline</text>
              <text x="816" y="134" fill={G700}>SH network · WLG</text>
              <text x="816" y="147" fontSize="8.5" letterSpacing=".08em" fill={G500}>ROADS · AIRPORT</text>
            </g>
            <g>
              <rect x="802" y="212" width="150" height="58" rx="6" fill={G100} stroke={G300} />
              <text x="816" y="234" fontWeight="700" fill={INK}>wco:Review</text>
              <text x="816" y="250" fill={G700}>triage queue · /review</text>
              <text x="816" y="263" fontSize="8.5" letterSpacing=".08em" fill={G500}>INVESTIGATE · NEVER DIAGNOSE</text>
            </g>
          </g>
        </svg>
      </div>
      <p className="wco-src">signals mean investigate · not live emergency information — in an emergency call 111</p>
    </section>
  );
}

function Contract() {
  return (
    <section className="wco-card" aria-labelledby="wco-contract-h">
      <h2 id="wco-contract-h">Six properties per node</h2>
      <p className="wco-sub wco-hide-s">shown for one real feed · rain-april.geojson</p>
      <dl className="wco-contract">
        <dt>wco:class</dt>
        <dd>Observation / Rain</dd>
        <dt>authority</dt>
        <dd>
          Greater Wellington Regional Council<small className="wco-hide-s">Hilltop gauge network</small>
        </dd>
        <dt>truth</dt>
        <dd>
          real · archived Apr 2026<small className="wco-hide-s">live / batch / real / synthetic — always declared</small>
        </dd>
        <dt>cadence</dt>
        <dd>hourly</dd>
        <dt>geometry</dt>
        <dd>
          Point · WGS84<small className="wco-hide-s">every node is mappable or names a place</small>
        </dd>
        <dt>licence</dt>
        <dd>
          publisher&apos;s terms<small className="wco-hide-s">check before republishing anything derived</small>
        </dd>
      </dl>
      <p className="wco-src">Murmur artifacts already carry attribution + limitations</p>
    </section>
  );
}

function Moves() {
  return (
    <section className="wco-card" aria-labelledby="wco-moves-h">
      <h2 id="wco-moves-h">Three moves make it real</h2>
      <p className="wco-sub wco-hide-s">no new infrastructure</p>
      <ul className="wco-next">
        <li>
          Tag the 13 COP artifacts with wco:class + relations
          <small className="wco-hide-s">one JSON property per feed</small>
        </li>
        <li>
          Fold the catalogue&apos;s 12 themes into the 7 classes
          <small className="wco-hide-s">a lookup table, not a migration</small>
        </li>
        <li>
          Drive the layer badges and the agent&apos;s routing off the same properties
          <small className="wco-hide-s">the badges on screen and the ontology stop being two systems</small>
        </li>
      </ul>
      <p className="wco-src">Concept for Team 7 review · not a Council standard</p>
    </section>
  );
}

export default function OntologyRoute() {
  return (
    <div className="watch-shell">
      <a className="skip-link" href="#content">
        Skip to main content
      </a>
      <SiteHeader />

      <main id="content">
        <section className="brand-band">
          <div className="settings-intro">
            <p className="eyebrow">Concept · Team 7 · Problem 05</p>
            <h1>Wellington City Ontology</h1>
            <p className="intro-copy">
              One typed graph over 87 sources: 74 catalogue layers + 13 Murmur feeds.
            </p>
          </div>
        </section>

        <div className="investigation-shell wco">
          <Spine />
          <div className="wco-grid">
            <Holdings />
            <Truth />
          </div>
          <Storm />
          <div className="wco-grid">
            <Contract />
            <Moves />
          </div>
          <p className="wco-src">
            WCC emergency-GIS catalogue · 74 layers — Murmur COP v1 · 13 feeds — chart language after
            lieflat-charts
          </p>
        </div>
      </main>

      <SiteFooter />
    </div>
  );
}
