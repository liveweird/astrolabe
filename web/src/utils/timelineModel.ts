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
export const HEADER_HEIGHT = 2 * HEADER_ROW_HEIGHT;
export const BAR_INSET = 6;
export const BAR_HEIGHT = ROW_HEIGHT - 2 * BAR_INSET;
/** Rows above this count are virtualised (TanStack Virtual); at or below it every row is mounted. */
export const DEFAULT_VIRTUALIZE_FROM = 80;
export const OVERSCAN_ROWS = 8;
/** The body is at least this many rows tall, so an empty (or nearly empty) timeline still has a visible area to drop an Unscheduled item on. */
export const MIN_BODY_ROWS = 3;

/** A bar owns up to three roving columns after the row's left cells: the bar, then (editable only) its start and end handles. */
export const COLUMNS_PER_BAR = 3;

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
}

export interface TimelineBandData {
  id: string | number;
  start: string;
  end: string;
  label: string;
  /** `window` = a plan window (quiet gray, dashed edges); `drift` = a deviation from it (orange). */
  tone: "window" | "drift";
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

export interface TimelineRowData {
  id: number | string;
  /** One entry per column, in order; the first is the row header (the name). */
  cells: readonly TimelineCell[];
  bars: readonly TimelineBarData[];
  /** Bands confined to this row's track. */
  bands?: readonly TimelineBandData[];
  /** Replaces the bar rendering of this row's track (the v0.5 load strip): positioned with the exported scale. */
  track?: ReactNode;
}

/** What the overlay slot (v0.4 arrows) draws against; all in pixels from the track origin (left of the range, top of the first row). */
export interface TimelineGeometry {
  scale: TimelineScale;
  /** The x of the LEFT edge of an ISO day. */
  xOf: (iso: string) => number;
  rowTop: (rowIndex: number) => number;
  rowHeight: number;
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
