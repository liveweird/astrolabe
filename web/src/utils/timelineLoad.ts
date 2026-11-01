import { toEpochDay, type TimelineScale } from "./timelineScale";

/**
 * The Timeline's load strip, pure (`.claude/docs/timeline.md` "The load strip"): one cell per ISO week, positioned by the scale.
 * The input is a LOCAL mirror of the server's week row (`GET /views/team/{id}` `weeks[]`) so the strip knows no API type; the page
 * maps its view onto it. Decorative — the page's weekly table is the accessible surface — so nothing here is a name or a state
 * a user must read; colour is the component's, never decided here.
 */

/** The strip's column height at 100 % of the capacity: the capacity line sits this far above the baseline. */
const STRIP_FULL_HEIGHT = 24;
/** A column never rises past this multiple of the capacity (the overload is read as "past the line", not by its size). */
const STRIP_MAX_RATIO = 1.25;
/** A cell narrower than this (a week cut by the range edge) prints no figure: it would not fit; the `title` keeps it. */
const MIN_TEXT_WIDTH = 40;

/** One week as the strip reads it; the field names and meanings are the server's week row. */
export interface LoadWeek {
  /** The Monday of the ISO week, `YYYY-MM-DD`. */
  weekStart: string;
  /** Man-days scheduled into the week. */
  load: number;
  /** The week's capacity in man-days, or `null` = the team has no capacity yet: never flagged. */
  capacity: number | null;
  overloaded: boolean;
  /** The man-days past the capacity; `null` unless overloaded. */
  overloadMd: number | null;
  /** The most milestones in progress on one working day of the week. */
  maxWip: number;
  /** Some working day had more milestones in progress than the WIP limit in force that day. */
  wipExceeded: boolean;
}

/** What `TimelineLoadStrip` draws for one week. */
export interface StripCell {
  weekStart: string;
  /** Left edge in px from the range start, and width; clipped to the range like the header's cells. */
  x: number;
  width: number;
  /** The column's height in px: 0 when the week has no capacity (no column and no capacity line). */
  fillHeight: number;
  hasCapacity: boolean;
  /** The week's figures, as given (the cell's `title` is built from them). */
  load: number;
  capacity: number | null;
  overloaded: boolean;
  /** The figure printed in the cell: "8.5 / 14" at week zoom, "8.5" at month zoom, "" at quarter and year zoom (the strip is never shown at year zoom), in a cell under 40 px or when nothing is loaded. */
  text: string;
  maxWip: number;
  wipExceeded: boolean;
  /** The WIP chip's text (the peak) at week and month zoom; "" at quarter and year zoom, where the chip is a dot. */
  wipText: string;
}

/** A man-day figure for a cell: at most two decimals, no trailing zeros ("14", "8.5", "0.8"). */
export function formatMd(value: number): string {
  return String(Number(value.toFixed(2)));
}

/** The column's height: load over capacity of {@link STRIP_FULL_HEIGHT}, capped at 125 %; a load against a zero capacity is the cap. */
function fillHeightOf(load: number, capacity: number | null): number {
  if (capacity === null || load <= 0) return 0;
  const ratio = capacity > 0 ? load / capacity : STRIP_MAX_RATIO;
  // a small but non-zero load still shows a 1 px column
  return Math.max(1, Math.round(Math.min(ratio, STRIP_MAX_RATIO) * STRIP_FULL_HEIGHT));
}

function textOf(week: LoadWeek, zoom: TimelineScale["zoom"]): string {
  if (zoom === "quarter" || zoom === "year" || (week.load <= 0 && week.capacity === null)) return "";
  if (zoom === "month" || week.capacity === null) return formatMd(week.load);
  return `${formatMd(week.load)} / ${formatMd(week.capacity)}`;
}

/**
 * The cells for the weeks the range shows. A week partly outside the range is clipped to it (the header's rule); one wholly outside
 * is dropped. The order of `weeks` is kept.
 */
export function stripCells(weeks: readonly LoadWeek[], scale: TimelineScale): StripCell[] {
  const cells: StripCell[] = [];
  for (const week of weeks) {
    const monday = toEpochDay(week.weekStart);
    const from = Math.max(monday, scale.from);
    const to = Math.min(monday + 6, scale.to);
    if (to < from) continue;
    const width = scale.widthOf(from, to);
    cells.push({
      weekStart: week.weekStart,
      x: scale.xOf(from),
      width,
      fillHeight: fillHeightOf(week.load, week.capacity),
      hasCapacity: week.capacity !== null,
      load: week.load,
      capacity: week.capacity,
      overloaded: week.overloaded,
      text: width < MIN_TEXT_WIDTH ? "" : textOf(week, scale.zoom),
      maxWip: week.maxWip,
      wipExceeded: week.wipExceeded,
      wipText: scale.zoom === "quarter" || scale.zoom === "year" ? "" : String(week.maxWip),
    });
  }
  return cells;
}
