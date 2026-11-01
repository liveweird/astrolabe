import type { ReactNode } from "react";
import type { rovingProps } from "../hooks/useRovingGrid";
import type { TimelineScale } from "./timelineScale";

/**
 * The Timeline's data contract and layout constants (`.claude/docs/timeline.md`). A page adapts its view to `TimelineRowData[]`;
 * the component draws, proposes changes through `onSchedule` and never decides anything. Dates are ISO `YYYY-MM-DD`.
 */

/** Pixel layout. Bar positions are pure functions of these and the scale, so an overlay never measures the DOM. */
export const ROW_HEIGHT = 36;
export const HEADER_ROW_HEIGHT = 28;
const HEADER_HEIGHT = 2 * HEADER_ROW_HEIGHT;
/** The optional third header row (the v0.5 load strip). */
export const STRIP_HEIGHT = 36;
export const BAR_INSET = 6;
export const BAR_HEIGHT = ROW_HEIGHT - 2 * BAR_INSET;
/** Rows above this count are virtualised (TanStack Virtual); at or below it every row is mounted. */
export const DEFAULT_VIRTUALIZE_FROM = 80;
export const OVERSCAN_ROWS = 8;
/** The body is at least this many rows tall, so an empty (or nearly empty) timeline still has a visible area to drop an Unscheduled item on. */
export const MIN_BODY_ROWS = 3;

/** A bar owns up to three roving columns after the row's left cells: the bar, then (editable only) its start and end handles. */
export const COLUMNS_PER_BAR = 3;

/**
 * The sticky header's height, which EVERY consumer must follow: the drop zone's visible top, the virtualiser's `scrollMargin` and
 * `scrollPaddingStart`, `revealFocused`'s clear top and (as `--timeline-head`) the CSS `scroll-margin-top`s. Without a strip it
 * is exactly `HEADER_HEIGHT`, so a timeline without one is unchanged.
 */
export function headerHeight(hasStrip: boolean): number {
  return HEADER_HEIGHT + (hasStrip ? STRIP_HEIGHT : 0);
}

export type BarId = number | string;

export interface TimelineBarData {
  id: BarId;
  start: string;
  end: string;
  /** The bar's short name (handle labels, announcements). */
  label: string;
  /** The bar's accessible name; the component appends "read-only" when `editable` is false. */
  describe: string;
  /** May the caller propose new dates? (The page's `can` flag; the server still decides.) */
  editable: boolean;
  /**
   * How the bar is drawn, read-only or editable: `ghost` = an endpoint that lives on another project (a faint dashed bar),
   * `summary` = the project's own derived span (a hollow outline), `window` (v0.6) = a target window (the band look: the full row
   * height, the band tint, dashed edges; an EDITABLE window bar keeps its move and resize handles and its keyboard path). Absent = the
   * ordinary neutral bar.
   */
  tone?: "ghost" | "summary" | "window";
}

export interface TimelineBandData {
  id: string | number;
  start: string;
  end: string;
  label: string;
  /**
   * `window` = a plan window (quiet gray, dashed edges); `drift` = a deviation from it (orange); `idle` (v0.7) = a run of idle
   * working days (a diagonal gray hatch, no edges: information, neither a plan nor a warning).
   */
  tone: "window" | "drift" | "idle";
}

/**
 * One end of a dependency arrow: a bar of a row, and which edge of it the arrow touches. `START` = the bar's left edge,
 * `END` = its right edge. `row` is the row's `TimelineRowData.id`, `bar` the bar's `TimelineBarData.id` in that row.
 */
interface TimelineArrowEnd {
  row: number | string;
  bar: BarId;
  kind: "START" | "END";
}

/**
 * A dependency arrow, predecessor to successor, for the Timeline's `overlay` (`TimelineArrows`). Decorative: the facts live in the
 * page's table. Dependency type FS = `from.kind END` to `to.kind START`, SS = START to START, FF = END to END, SF = START to END.
 */
export interface TimelineArrowData {
  /** Unique among the timeline's arrows; becomes the path's `data-arrow`. */
  id: string | number;
  from: TimelineArrowEnd;
  to: TimelineArrowEnd;
  /** The constraint does not hold: drawn red (and `data-violated="true"`). */
  violated: boolean;
  /** A short human description ("A → B, FS"); the path's `<title>` (not an accessible name: the svg is `aria-hidden`). */
  label: string;
}

/** The attributes that make an element a stop of the roving grid; a cell function spreads them on its focus target. */
export type RovingTarget = ReturnType<typeof rovingProps>;

/** A left cell: static content (the cell itself is the focus stop) or a function receiving the stop to spread on its own focusable. */
type TimelineCell = ReactNode | ((target: RovingTarget) => ReactNode);

export interface TimelineColumn {
  id: string;
  /** The column header text. */
  header: string;
  width: number;
}

/**
 * Opts a row in to the DRAW gesture (v0.6): a pointer drag across the row's empty stretch proposes a span through the page's
 * `onSchedule(barId, start, end)` (the same seam as a bar move), `barId` being the id of the bar the row would have once drawn.
 * Pointer-only: the page's dialog is the keyboard and touch path.
 */
export interface TimelineDrawData {
  barId: BarId;
  /** The drawn thing's short name (the announcements). */
  label: string;
}

export interface TimelineRowData {
  id: number | string;
  /** One entry per column, in order; the first is the row header (the name). */
  cells: readonly TimelineCell[];
  bars: readonly TimelineBarData[];
  /** Bands confined to this row's track. */
  bands?: readonly TimelineBandData[];
  /** Draw a new span across this row's empty stretch (a row without its target window). Absent = no draw surface. */
  draw?: TimelineDrawData;
  /** Replaces the bar rendering of this row's track, positioned with the exported scale. No page uses it: the v0.5 load strip is a header band (`TimelineStripData`). */
  track?: ReactNode;
}

/**
 * A third, sticky header row under the date cells (v0.5: the team's weekly load). Decorative (`aria-hidden`): the page's table is the
 * accessible surface. `label` is the visible caption of the sticky left part; `render` draws the track part, positioned with the scale.
 */
export interface TimelineStripData {
  label: string;
  render: (scale: TimelineScale) => ReactNode;
}

/** What the overlay slot (v0.4 arrows) draws against; all in pixels from the track origin (left of the range, top of the first row). */
export interface TimelineGeometry {
  scale: TimelineScale;
  /** The x of the LEFT edge of an ISO day. */
  xOf: (iso: string) => number;
  rowTop: (rowIndex: number) => number;
  rowHeight: number;
  /** The index of the row with this `TimelineRowData.id`, or `null` when there is none. */
  rowIndexOf: (rowId: number | string) => number | null;
  /** The rectangle of a bar (committed dates, not a drag preview), or `null` when the row or the bar does not exist. */
  barRect: (rowIndex: number, barId: BarId) => { x: number; y: number; width: number; height: number } | null;
  /** The first and last MOUNTED row indices (the whole list when not virtualised): draw arrows only for these. */
  visibleRows: { first: number; last: number };
}

/** Does a row have the roving cell at column `c`? (Left cells always; a bar's handles only when it is editable.) */
export function hasColumn(row: TimelineRowData, leftCount: number, c: number): boolean {
  if (c < leftCount) return true;
  const offset = c - leftCount;
  const bar = row.bars[Math.floor(offset / COLUMNS_PER_BAR)];
  return bar !== undefined && (offset % COLUMNS_PER_BAR === 0 || bar.editable);
}

/** The grid's last column index, from the widest row. */
export function lastColumn(rows: readonly TimelineRowData[], leftCount: number): number {
  const bars = rows.reduce((most, row) => Math.max(most, row.bars.length), 0);
  return leftCount + bars * COLUMNS_PER_BAR - 1;
}
