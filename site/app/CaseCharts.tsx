import { useMemo, useState } from "react";
import type { PointerEvent as ReactPointerEvent, MouseEvent as ReactMouseEvent } from "react";
import health from "../public/cop/v1/movement-health.json";
import { PEOPLE_CLASSES } from "./map-draw";
import { EVENTS, shortDate, type CaseModel } from "./case-model";

/* ==================== the case charts band ====================
 * Sits after the map. One band per active case, built from the same CaseModel
 * the timebar drives, so the charts scrub-sync for free: KPI tiles, a
 * diverging deviations column chart over the whole window, corroboration
 * lanes (rain, highway sites, air access — small multiples on one shared
 * time axis, never a second y-axis), and a people-vs-vehicles day split.
 * All SVG/HTML — the map keeps the page's only canvas. With no case model
 * loaded the band falls back to the committed snapshot facts. */

type DayGroup = {
  date: string;
  hours: number;
  start: number;
  up: number;
  down: number;
  people: number;
  vehicles: number;
  roadSites: number;
};

const H = 64;
const MID = H / 2;
const LANE_H = 40;

const nz = (value: number, digits = 0) =>
  value.toLocaleString("en-NZ", { maximumFractionDigits: digits });

function Tile({
  label,
  value,
  sub,
  onJump,
}: {
  label: string;
  value: string;
  sub?: string;
  onJump?: () => void;
}) {
  const body = (
    <>
      <span className="tile-label">{label}</span>
      <strong className="tile-value">{value}</strong>
      {sub ? <span className="tile-sub">{sub}</span> : null}
    </>
  );
  return onJump ? (
    <button type="button" className="chart-tile jump" onClick={onJump}>
      {body}
    </button>
  ) : (
    <div className="chart-tile">{body}</div>
  );
}

function DayRow({ days }: { days: DayGroup[] }) {
  return (
    <div className="chart-days" aria-hidden="true">
      {days.map((day) => (
        <span key={day.date} style={{ flexGrow: day.hours }}>
          {shortDate(day.date)}
        </span>
      ))}
    </div>
  );
}

export default function CaseCharts({
  event,
  model,
  index,
  onScrub,
}: {
  event: (typeof EVENTS)[number];
  model: CaseModel | null;
  index: number;
  onScrub: (index: number) => void;
}) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const brief = useMemo(() => {
    if (!model || model.slots.length === 0) return null;
    const slots = model.slots;
    const days: DayGroup[] = [];
    let totalUp = 0;
    let totalDown = 0;
    let worstIndex = 0;
    let peakRainIndex = 0;
    let warningHours = 0;
    let flightHours = 0;
    slots.forEach((slot, slotIndex) => {
      let day = days[days.length - 1];
      if (!day || day.date !== slot.date) {
        day = {
          date: slot.date,
          hours: 0,
          start: slotIndex,
          up: 0,
          down: 0,
          people: 0,
          vehicles: 0,
          roadSites: 0,
        };
        days.push(day);
      }
      day.hours += 1;
      day.up += slot.up;
      day.down += slot.down;
      day.roadSites = Math.max(day.roadSites, slot.roadSites);
      for (const signal of slot.signals) {
        if (PEOPLE_CLASSES.has(String(signal.properties.transport_class))) day.people += 1;
        else day.vehicles += 1;
      }
      totalUp += slot.up;
      totalDown += slot.down;
      if (slot.up + slot.down > slots[worstIndex].up + slots[worstIndex].down)
        worstIndex = slotIndex;
      if (slot.rainMm > slots[peakRainIndex].rainMm) peakRainIndex = slotIndex;
      if (slot.rainWarning) warningHours += 1;
      if (slot.tick) flightHours += 1;
    });
    return {
      slots,
      days,
      totalUp,
      totalDown,
      worstIndex,
      peakRainIndex,
      peakRain: slots[peakRainIndex].rainMm,
      warningHours,
      flightHours,
      maxHourly: Math.max(...slots.map((slot) => Math.max(slot.up, slot.down)), 1),
      maxRoadSites: Math.max(...days.map((day) => day.roadSites), 0),
      maxClass: Math.max(...days.map((day) => Math.max(day.people, day.vehicles)), 1),
    };
  }, [model]);

  const activeIndex = brief
    ? Math.min(hoverIndex ?? index, brief.slots.length - 1)
    : 0;
  const active = brief?.slots[activeIndex] ?? null;
  const activeDay = brief?.days.find((day) => day.date === active?.date) ?? null;

  const slotFromPointer = (
    pointer: ReactPointerEvent<SVGSVGElement> | ReactMouseEvent<SVGSVGElement>,
  ) => {
    if (!brief) return null;
    const rect = pointer.currentTarget.getBoundingClientRect();
    const ratio = (pointer.clientX - rect.left) / Math.max(rect.width, 1);
    return Math.min(brief.slots.length - 1, Math.max(0, Math.floor(ratio * brief.slots.length)));
  };
  const hoverProps = {
    onPointerMove: (pointer: ReactPointerEvent<SVGSVGElement>) => {
      const slotIndex = slotFromPointer(pointer);
      if (slotIndex !== null) setHoverIndex(slotIndex);
    },
    onPointerLeave: () => setHoverIndex(null),
    onClick: (pointer: ReactMouseEvent<SVGSVGElement>) => {
      const slotIndex = slotFromPointer(pointer);
      if (slotIndex !== null) onScrub(slotIndex);
    },
  };

  const barHeight = (value: number) =>
    value > 0 ? Math.max((value / (brief?.maxHourly ?? 1)) * (MID - 4), 1.5) : 0;
  const laneTone = event.tone === "synthetic" ? "synthetic" : "real";
  const augWindow = EVENTS.find((entry) => entry.id === "aug-snapshot")?.window ?? "";

  const hasRain = (brief?.peakRain ?? 0) > 0;
  const hasRoads = (brief?.maxRoadSites ?? 0) > 0;
  const hasFlights = (brief?.flightHours ?? 0) > 0;
  const n = brief?.slots.length ?? 0;

  const cursorMarks = (height: number) => (
    <>
      {hoverIndex !== null ? (
        <rect className="hover-cursor" x={hoverIndex} y={0} width={1} height={height} />
      ) : null}
      <rect className="cursor" x={index} y={0} width={1} height={height} />
    </>
  );

  return (
    <section className="case-charts" aria-labelledby="case-charts-heading">
      <header className="case-charts-head">
        <div>
          <p className="eyebrow">Case charts</p>
          <h2 id="case-charts-heading">
            {event.label} · {event.window}
          </h2>
        </div>
        <span className={`chart-badge ${event.tone}`}>{event.badge}</span>
      </header>

      <div className="chart-tiles">
        {brief && active ? (
          <>
            <Tile
              label="This hour"
              value={nz(active.up + active.down)}
              sub={`↑ ${nz(active.up)} · ↓ ${nz(active.down)}`}
            />
            <Tile
              label="Window"
              value={nz(brief.totalUp + brief.totalDown)}
              sub={`↑ ${nz(brief.totalUp)} · ↓ ${nz(brief.totalDown)}`}
            />
            <Tile
              label="Worst hour"
              value={nz(brief.slots[brief.worstIndex].up + brief.slots[brief.worstIndex].down)}
              sub={brief.slots[brief.worstIndex].label}
              onJump={() => onScrub(brief.worstIndex)}
            />
            {hasRain ? (
              <Tile
                label="Peak rain"
                value={`${nz(brief.peakRain, 1)} mm/h`}
                sub={
                  brief.warningHours > 0
                    ? `${nz(brief.warningHours)} warning h`
                    : brief.slots[brief.peakRainIndex].label
                }
                onJump={() => onScrub(brief.peakRainIndex)}
              />
            ) : null}
            {hasRoads ? (
              <Tile label="Highway sites" value={nz(brief.maxRoadSites)} sub="worst day" />
            ) : null}
            {hasFlights ? (
              <Tile label="Air access" value={nz(brief.flightHours)} sub="flagged h" />
            ) : null}
          </>
        ) : (
          <>
            <Tile label={`Signals · ${augWindow}`} value={nz(health.candidate_count)} />
            <Tile label={`Data gaps · ${augWindow}`} value={nz(health.data_gap_groups)} />
            <Tile label="As of" value={shortDate(health.data_as_of)} />
          </>
        )}
      </div>

      {brief && active ? (
        <>
          <figure className="case-chart">
            <figcaption className="chart-head">
              <strong>Deviations by hour</strong>
              <span className="chart-legend">
                <i className="swatch up" aria-hidden="true" />
                increases
                <i className="swatch down" aria-hidden="true" />
                decreases
              </span>
              <span className="chart-readout">
                {active.label} · ↑ {nz(active.up)} ↓ {nz(active.down)}
              </span>
            </figcaption>
            <svg
              className="chart-svg deviations"
              viewBox={`0 0 ${n} ${H}`}
              preserveAspectRatio="none"
              role="img"
              aria-label={`${nz(brief.totalUp + brief.totalDown)} gated deviations across ${nz(n)} hours`}
              {...hoverProps}
            >
              {model && model.eventHours > 0 ? (
                <rect className="event-window" x={0} y={0} width={model.eventHours} height={H} />
              ) : null}
              {brief.days.slice(1).map((day) => (
                <line
                  key={day.date}
                  className="day-line"
                  vectorEffect="non-scaling-stroke"
                  x1={day.start}
                  y1={0}
                  x2={day.start}
                  y2={H}
                />
              ))}
              {cursorMarks(H)}
              {brief.slots.map((slot, slotIndex) =>
                slot.up + slot.down > 0 ? (
                  <g key={slot.key}>
                    {slot.up > 0 ? (
                      <rect
                        className="up"
                        x={slotIndex + 0.1}
                        width={0.8}
                        y={MID - barHeight(slot.up)}
                        height={barHeight(slot.up)}
                      />
                    ) : null}
                    {slot.down > 0 ? (
                      <rect
                        className="down"
                        x={slotIndex + 0.1}
                        width={0.8}
                        y={MID}
                        height={barHeight(slot.down)}
                      />
                    ) : null}
                  </g>
                ) : null,
              )}
              <line
                className="axis"
                vectorEffect="non-scaling-stroke"
                x1={0}
                y1={MID}
                x2={n}
                y2={MID}
              />
            </svg>
            <DayRow days={brief.days} />
          </figure>

          {hasRain || hasRoads || hasFlights ? (
            <figure className="case-chart lanes">
              <figcaption className="chart-head">
                <strong>Corroboration</strong>
              </figcaption>
              {hasRain ? (
                <div className="lane">
                  <div className="lane-head">
                    <strong>Rain mm/h</strong>
                    <span className={`chart-badge ${laneTone}`}>{laneTone}</span>
                    <span className="lane-readout">
                      {nz(active.rainMm, 1)} mm/h
                      {active.rainWarning ? <em className="lane-warning"> warning</em> : null}
                    </span>
                  </div>
                  <svg
                    className="chart-svg lane-svg"
                    viewBox={`0 0 ${n} ${LANE_H}`}
                    preserveAspectRatio="none"
                    role="img"
                    aria-label={`Peak rain ${nz(brief.peakRain, 1)} mm/h, ${nz(brief.warningHours)} warning hours`}
                    {...hoverProps}
                  >
                    {cursorMarks(LANE_H)}
                    {brief.slots.map((slot, slotIndex) =>
                      slot.rainMm > 0 ? (
                        <rect
                          key={slot.key}
                          className={slot.rainWarning ? "rain-bar warning" : "rain-bar"}
                          x={slotIndex + 0.1}
                          width={0.8}
                          y={LANE_H - Math.max((slot.rainMm / brief.peakRain) * (LANE_H - 2), 1)}
                          height={Math.max((slot.rainMm / brief.peakRain) * (LANE_H - 2), 1)}
                        />
                      ) : null,
                    )}
                  </svg>
                </div>
              ) : null}
              {hasRoads ? (
                <div className="lane">
                  <div className="lane-head">
                    <strong>Highway sites/day</strong>
                    <span className={`chart-badge ${laneTone}`}>{laneTone}</span>
                    <span className="lane-readout">{nz(activeDay?.roadSites ?? 0)} sites</span>
                  </div>
                  <svg
                    className="chart-svg lane-svg"
                    viewBox={`0 0 ${n} ${LANE_H}`}
                    preserveAspectRatio="none"
                    role="img"
                    aria-label={`Worst day ${nz(brief.maxRoadSites)} flagged state-highway sites`}
                    {...hoverProps}
                  >
                    {cursorMarks(LANE_H)}
                    {brief.days.map((day) =>
                      day.roadSites > 0 ? (
                        <rect
                          key={day.date}
                          className="roads-bar"
                          x={day.start + 0.2}
                          width={day.hours - 0.4}
                          y={LANE_H - (day.roadSites / brief.maxRoadSites) * (LANE_H - 2)}
                          height={(day.roadSites / brief.maxRoadSites) * (LANE_H - 2)}
                        />
                      ) : null,
                    )}
                  </svg>
                </div>
              ) : null}
              {hasFlights ? (
                <div className="lane">
                  <div className="lane-head">
                    <strong>Air access</strong>
                    <span className={`chart-badge ${laneTone}`}>{laneTone}</span>
                    <span className="lane-readout">{active.tick ? "flagged" : "normal"}</span>
                  </div>
                  <svg
                    className="chart-svg lane-svg"
                    viewBox={`0 0 ${n} ${LANE_H}`}
                    preserveAspectRatio="none"
                    role="img"
                    aria-label={`${nz(brief.flightHours)} flagged airport hours`}
                    {...hoverProps}
                  >
                    {cursorMarks(LANE_H)}
                    {brief.slots.map((slot, slotIndex) =>
                      slot.tick ? (
                        <rect
                          key={slot.key}
                          className="flights-bar"
                          x={slotIndex + 0.2}
                          width={0.6}
                          y={4}
                          height={LANE_H - 8}
                        />
                      ) : null,
                    )}
                  </svg>
                </div>
              ) : null}
              <DayRow days={brief.days} />
            </figure>
          ) : null}

          <figure
            className="case-chart class-chart"
            aria-label={`People ${nz(brief.days.reduce((sum, day) => sum + day.people, 0))}, vehicles ${nz(brief.days.reduce((sum, day) => sum + day.vehicles, 0))} gated deviations`}
          >
            <figcaption className="chart-head">
              <strong>People vs vehicles by day</strong>
              <span className="chart-legend">
                <i className="swatch people" aria-hidden="true" />
                people
                <i className="swatch vehicles" aria-hidden="true" />
                vehicles
              </span>
            </figcaption>
            <div className="class-bars" aria-hidden="true">
              {brief.days.map((day) => (
                <div className="class-day" key={day.date}>
                  <div className="class-pair">
                    <span
                      className="class-bar people"
                      style={{ height: `${Math.max((day.people / brief.maxClass) * 100, 1)}%` }}
                      data-value={nz(day.people)}
                    />
                    <span
                      className="class-bar vehicles"
                      style={{ height: `${Math.max((day.vehicles / brief.maxClass) * 100, 1)}%` }}
                      data-value={nz(day.vehicles)}
                    />
                  </div>
                  <span className="class-day-label">{shortDate(day.date)}</span>
                </div>
              ))}
            </div>
          </figure>
        </>
      ) : null}
    </section>
  );
}
