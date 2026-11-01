import { arrowsToDraw } from "../utils/timelineArrows";
import type { TimelineArrowData, TimelineGeometry } from "../utils/timelineModel";
import classes from "../theme.module.css";

/** The three arrowheads (the critical one, v0.7, only while an arrow is critical). Fixed ids: a page has ONE timeline (`timeline.md`), and a marker is looked up by document-wide id. */
const HEAD = "timeline-arrowhead";
const HEAD_VIOLATED = "timeline-arrowhead-violated";
const HEAD_CRITICAL = "timeline-arrowhead-critical";

/** A violated arrow stays red even if it were flagged critical (the server never does: a violation ends the chain). */
const styleOf = (arrow: { violated: boolean; critical: boolean }) => (arrow.violated ? "violated" : arrow.critical ? "critical" : "plain");
const PATH_CLASS = { plain: classes.timelineArrow, violated: classes.timelineArrowViolated, critical: classes.timelineArrowCritical } as const;
const MARKER = { plain: HEAD, violated: HEAD_VIOLATED, critical: HEAD_CRITICAL } as const;

/**
 * The Timeline's dependency arrows, for its `overlay` slot: `overlay={(geometry) => <TimelineArrows arrows={…} geometry={geometry} />}`.
 * Renders inside the Timeline's one decorative `<svg aria-hidden>` — the accessible surface is the page's dependency table, never
 * these paths. One `<path>` per arrow that `arrowsToDraw` keeps (mounted rows only), from the COMMITTED dates the geometry is
 * built on (a drag preview does not drag an arrow). Tests and e2e count `data-arrow` and read `data-violated` / `data-critical`
 * (present only on a critical arrow); colour (gray, red for a violated constraint, a heavier text-colour stroke for a critical one)
 * is theme-owned and never asserted.
 */
export default function TimelineArrows({ arrows, geometry }: { arrows: readonly TimelineArrowData[]; geometry: TimelineGeometry }) {
  return (
    <>
      <defs>
        <marker id={HEAD} className={classes.timelineArrowHead} viewBox="0 0 10 10" refX="10" refY="5" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M0 0 L10 5 L0 10 z" />
        </marker>
        <marker id={HEAD_VIOLATED} className={classes.timelineArrowHeadViolated} viewBox="0 0 10 10" refX="10" refY="5" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M0 0 L10 5 L0 10 z" />
        </marker>
        {arrows.some((arrow) => arrow.critical === true) && (
          <marker id={HEAD_CRITICAL} className={classes.timelineArrowHeadCritical} viewBox="0 0 10 10" refX="10" refY="5" markerWidth="7" markerHeight="7" orient="auto">
            <path d="M0 0 L10 5 L0 10 z" />
          </marker>
        )}
      </defs>
      {arrowsToDraw(arrows, geometry).map((arrow) => (
        <path
          key={arrow.id}
          d={arrow.d}
          data-arrow={arrow.id}
          data-violated={arrow.violated}
          data-critical={arrow.critical && !arrow.violated ? "true" : undefined}
          className={PATH_CLASS[styleOf(arrow)]}
          markerEnd={`url(#${MARKER[styleOf(arrow)]})`}
        >
          <title>{arrow.label}</title>
        </path>
      ))}
    </>
  );
}
