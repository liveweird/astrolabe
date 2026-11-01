import type { TimelineArrowData, TimelineGeometry } from "./timelineModel";

/**
 * The routing math of the Timeline's dependency arrows (`.claude/docs/timeline.md` "Arrows"). Pure: points in, points out; the
 * Timeline's geometry supplies the anchors, `TimelineArrows` draws the result. All pixels, from the track origin.
 */

/** How far an arrow runs straight out of / straight into a bar's edge before it turns. */
const ARROW_STUB = 8;

export interface Point {
  x: number;
  y: number;
}

/** Where an arrow touches a bar: the middle of one edge. `START` = the left edge, `END` = the right edge. */
export interface Anchor extends Point {
  kind: "START" | "END";
}

/** The side a bar's `kind` edge faces: a START edge faces left (-1), an END edge faces right (+1). */
const outward = (kind: Anchor["kind"]) => (kind === "START" ? -1 : 1);

/** The anchor on a bar's rectangle (from `TimelineGeometry.barRect`). */
export function anchorOf(rect: { x: number; y: number; width: number; height: number }, kind: Anchor["kind"]): Anchor {
  return { x: kind === "START" ? rect.x : rect.x + rect.width, y: rect.y + rect.height / 2, kind };
}

/**
 * The orthogonal route from the predecessor's anchor to the successor's, as the corner points (first = `from`, last = `to`).
 * It leaves `from` by a stub, turns toward the successor's row and enters `to` moving INTO the bar.
 *
 * - Both edges face the same way (FF, SS) on different rows: the vertical leg runs just outside the further of the two stubs;
 *   never a backtrack.
 * - Opposite ways (FS, SF) and the successor's anchor lies AHEAD of the predecessor's in the leaving direction (FS: `to.x >= from.x`,
 *   SF: `to.x <= from.x`): one vertical leg at `min(stub, gap / 2)` from the predecessor's edge, then straight into the bar. A
 *   narrow gap (back-to-back bars, Friday to Monday at quarter zoom) therefore shrinks the stubs instead of reading as a backtrack.
 * - Otherwise (FS with the successor starting before the predecessor ends — a violation or a lead; SF whenever the successor ends
 *   right of the predecessor's start, its usual case; and SS/FF on the SAME row, whose straight leg would run through the bars'
 *   centre line): the vertical leg runs along the boundary between the rows (`detourY`), a second horizontal leg goes to the
 *   approach point and a short vertical leg drops onto the successor's row, so no arrow crosses a bar it connects.
 *
 * `detourY` is the y of that row boundary, chosen by the caller from the rows' order (the bottom boundary for one row).
 */
export function arrowRoute(from: Anchor, to: Anchor, detourY: number): Point[] {
  const away = outward(from.kind);
  const start: Point = { x: from.x, y: from.y };
  const end: Point = { x: to.x, y: to.y };
  const leave: Point = { x: from.x + away * ARROW_STUB, y: from.y };
  const approach: Point = { x: to.x + outward(to.kind) * ARROW_STUB, y: to.y };
  if (from.kind === to.kind && from.y !== to.y) {
    const turnX = away === 1 ? Math.max(leave.x, approach.x) : Math.min(leave.x, approach.x);
    return dropRepeats([start, leave, { x: turnX, y: from.y }, { x: turnX, y: to.y }, end]);
  }
  const gap = (to.x - from.x) * away;
  if (from.kind !== to.kind && gap >= 0) {
    const turnX = from.x + away * Math.min(ARROW_STUB, gap / 2);
    return dropRepeats([start, { x: turnX, y: from.y }, { x: turnX, y: to.y }, end]);
  }
  return dropRepeats([start, leave, { x: leave.x, y: detourY }, { x: approach.x, y: detourY }, { x: approach.x, y: to.y }, end]);
}

/** Consecutive equal points add nothing to a path (and would confuse the marker's orientation). */
function dropRepeats(points: Point[]): Point[] {
  return points.filter((point, i) => i === 0 || point.x !== points[i - 1].x || point.y !== points[i - 1].y);
}

/** The SVG `d` of a polyline route. */
export function arrowPath(points: readonly Point[]): string {
  return points.map((point, i) => `${i === 0 ? "M" : "L"}${point.x} ${point.y}`).join(" ");
}

/** An arrow resolved to what is drawn. */
export interface DrawnArrow {
  id: string | number;
  d: string;
  violated: boolean;
  critical: boolean;
  label: string;
}

/**
 * Resolve the arrows against the Timeline's geometry. An arrow is skipped when a row or a bar of either end is missing
 * (`rowIndexOf` / `barRect` null) or when NEITHER end's row is mounted (`visibleRows`: on the virtual path that is the window,
 * otherwise every row). An arrow with one end mounted is drawn whole: the other end's position comes from data, not the DOM.
 */
export function arrowsToDraw(arrows: readonly TimelineArrowData[], geometry: TimelineGeometry): DrawnArrow[] {
  const { first, last } = geometry.visibleRows;
  const mounted = (row: number) => row >= first && row <= last;
  const drawn: DrawnArrow[] = [];
  for (const arrow of arrows) {
    const fromRow = geometry.rowIndexOf(arrow.from.row);
    const toRow = geometry.rowIndexOf(arrow.to.row);
    if (fromRow === null || toRow === null || !(mounted(fromRow) || mounted(toRow))) continue;
    const fromRect = geometry.barRect(fromRow, arrow.from.bar);
    const toRect = geometry.barRect(toRow, arrow.to.bar);
    if (fromRect === null || toRect === null) continue;
    // Backtracking runs along the boundary on the predecessor's side of the successor's row.
    const detourY = fromRow < toRow ? geometry.rowTop(toRow) : geometry.rowTop(toRow) + geometry.rowHeight;
    const route = arrowRoute(anchorOf(fromRect, arrow.from.kind), anchorOf(toRect, arrow.to.kind), detourY);
    drawn.push({ id: arrow.id, d: arrowPath(route), violated: arrow.violated, critical: arrow.critical === true, label: arrow.label });
  }
  return drawn;
}
