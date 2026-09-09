import type { TrendPoint } from "@chief-of-staff-demo/shared";
import { chartGeometry } from "../chart";

/**
 * The sixth UI primitive (ADR-0015, amended): a single-series line chart, used
 * at two scales — a channel's total views over time, and one video's when its
 * row is expanded.
 *
 * Single-series on purpose. One line per video on a two-hundred-video channel is
 * a smear, and a selectable multi-series chart is exactly where a charting
 * library gets adopted — which is what ADR-0015 exists to resist. Inline SVG,
 * no dependency, no axes: the numbers are in the table beside it, and this says
 * one thing, which is the shape.
 */
export function LineChart({
  points,
  label,
  width = 360,
  height = 56,
}: {
  points: TrendPoint[];
  /** What the line is of, for the reader who cannot see it. */
  label: string;
  width?: number;
  height?: number;
}) {
  const geometry = chartGeometry(points, width, height);
  if (!geometry) {
    return (
      <p className="muted chart-empty">
        {points.length === 1
          ? "One day measured so far — a line needs two."
          : "Nothing measured yet."}
      </p>
    );
  }

  const first = geometry.points[0]!;
  const last = geometry.points[geometry.points.length - 1]!;
  const broken = geometry.segments.length > 1;
  /* The whole chart as one sentence: an SVG is an image to everything that
     cannot see it, and the shape is the only thing it adds to the table. */
  const description =
    `${label}: ${first.views.toLocaleString()} views on ${first.day}, ` +
    `${last.views.toLocaleString()} on ${last.day}, ` +
    `${geometry.points.length} days measured` +
    (broken
      ? `, with ${geometry.segments.length === 2 ? "a gap" : "gaps"} where nothing ran.`
      : ".");

  return (
    <svg
      className="line-chart"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={description}
    >
      {geometry.segments.map((segment, index) => (
        <polyline
          key={index}
          className="line-chart-line"
          points={segment.map((point) => `${point.x},${point.y}`).join(" ")}
          fill="none"
        />
      ))}
      {/* The newest measurement, marked: it is the number the table shows. */}
      <circle className="line-chart-latest" cx={last.x} cy={last.y} r={2.5} />
    </svg>
  );
}
