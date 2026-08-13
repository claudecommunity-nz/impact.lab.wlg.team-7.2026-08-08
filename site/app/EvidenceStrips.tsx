import type { SignalTrendPoint } from "./map-draw";
import { shortDate } from "./case-model";

/** A month of daily values as bars: flagged days highlighted, an optional
 * baseline as a dashed reference line. Reported days only — gaps stay gaps. */
export function DailyStrip({
  points,
  reference,
  label,
}: {
  points: { date: string; value: number; flagged: boolean }[];
  reference?: number;
  label: string;
}) {
  if (points.length === 0) return null;
  const width = 232;
  const height = 44;
  const gap = 1.5;
  const max = Math.max(...points.map((point) => point.value), reference ?? 0, 1);
  const barWidth = (width - gap * (points.length - 1)) / points.length;
  const barHeight = (value: number) => Math.max((value / max) * (height - 2), 1);
  return (
    <figure className="trend-spark">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label}>
        {points.map((point, index) => (
          <rect
            key={point.date}
            className={point.flagged ? "bar now decrease" : "bar"}
            x={index * (barWidth + gap)}
            y={height - barHeight(point.value)}
            width={barWidth}
            height={barHeight(point.value)}
          />
        ))}
        {reference !== undefined ? (
          <line
            className="expected-line"
            x1={0}
            y1={height - (reference / max) * (height - 2)}
            x2={width}
            y2={height - (reference / max) * (height - 2)}
          />
        ) : null}
      </svg>
      <figcaption aria-hidden="true">
        <span>{shortDate(points[0].date)}</span>
        {reference !== undefined ? <span>usual {reference.toLocaleString("en-NZ")}</span> : null}
        <span>{shortDate(points[points.length - 1].date)}</span>
      </figcaption>
    </figure>
  );
}

/** Prior matched weekday/hour counts as bars, the observed hour highlighted,
 * and the expected median as a dashed reference line. */
export function TrendSparkline({
  history,
  observed,
  expected,
  changeDirection,
}: {
  history: SignalTrendPoint[];
  observed: number;
  expected: number;
  changeDirection: string;
}) {
  if (history.length === 0) return null;
  const width = 232;
  const height = 44;
  const gap = 2;
  const counts = [...history.map((point) => point.observed_count), observed];
  const max = Math.max(...counts, expected, 1);
  const barWidth = (width - gap * (counts.length - 1)) / counts.length;
  const barHeight = (count: number) => Math.max((count / max) * (height - 2), 1);
  const expectedY = height - (expected / max) * (height - 2);
  return (
    <figure className="trend-spark">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`Observed ${observed.toLocaleString("en-NZ")} against ${history.length} prior matched hours, expected ${expected.toLocaleString("en-NZ")}`}
      >
        {counts.map((count, index) => {
          const now = index === counts.length - 1;
          return (
            <rect
              key={index}
              className={now ? `bar now ${changeDirection}` : "bar"}
              x={index * (barWidth + gap)}
              y={height - barHeight(count)}
              width={barWidth}
              height={barHeight(count)}
            />
          );
        })}
        <line className="expected-line" x1={0} y1={expectedY} x2={width} y2={expectedY} />
      </svg>
      <figcaption aria-hidden="true">
        <span>{shortDate(history[0].observed_at)}</span>
        <span>expected {expected.toLocaleString("en-NZ")}</span>
        <span>now</span>
      </figcaption>
    </figure>
  );
}
