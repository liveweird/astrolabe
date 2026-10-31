import { DAY_MS, epochMillisToIsoDate, isoDateToEpochMillis } from "./isoDate";

/**
 * The Timeline's coordinate model, pure: dates are ISO `YYYY-MM-DD` strings at the component boundary and EPOCH DAYS (whole days
 * since 1970-01-01, UTC) inside; a day is `dayWidth` pixels wide, the range `[from, to]` is inclusive on both ends, and a bar
 * spans from the left edge of its first day to the right edge of its last. Header labels are language-neutral (`W37`, `2026-09`,
 * `2026-Q3`, day numbers — the `formatDate.ts` rule). The calendar side is ported from Flow's `deepDiveCalendar.ts`
 * (`weekdayOf`, `isoWeekLabel`, the month partition clipped to the range).
 */

export type Zoom = "week" | "month" | "quarter";

export const ZOOMS: readonly Zoom[] = ["week", "month", "quarter"];

/** Pixels per day at each zoom. */
export const DAY_WIDTH: Record<Zoom, number> = { week: 28, month: 8, quarter: 3 };

const DAYS_PER_WEEK = 7;
/** Saturday and Sunday are the 6th and 7th day of a Monday-start week. */
const WORKING_DAYS_PER_WEEK = 5;

export interface TimelineScale {
  zoom: Zoom;
  /** First and last day shown, as epoch days. */
  from: number;
  to: number;
  dayWidth: number;
  /** The pixel width of the whole range. */
  totalWidth: number;
  /** The x of the LEFT edge of `day`, from the range start. */
  xOf: (day: number) => number;
  /** The width of the bar covering `start`..`end` inclusive. */
  widthOf: (start: number, end: number) => number;
  /** The day under an x offset from the range start. */
  dayAt: (x: number) => number;
}

/** A whole range in epoch days. */
export interface DayRange {
  from: number;
  to: number;
}

/** `YYYY-MM-DD` to its epoch day. */
export function toEpochDay(iso: string): number {
  return Math.round(isoDateToEpochMillis(iso) / DAY_MS);
}

/** An epoch day to `YYYY-MM-DD`. */
export function toIsoDate(day: number): string {
  return epochMillisToIsoDate(day * DAY_MS);
}

/** Monday = 0 … Sunday = 6 (epoch day 0, 1970-01-01, was a Thursday). */
export function weekdayOf(day: number): number {
  return (((day + 3) % DAYS_PER_WEEK) + DAYS_PER_WEEK) % DAYS_PER_WEEK;
}

export function isWeekend(day: number): boolean {
  return weekdayOf(day) >= WORKING_DAYS_PER_WEEK;
}

export function makeScale(zoom: Zoom, range: DayRange): TimelineScale {
  const dayWidth = DAY_WIDTH[zoom];
  const from = range.from;
  const to = Math.max(range.to, range.from);
  return {
    zoom,
    from,
    to,
    dayWidth,
    totalWidth: (to - from + 1) * dayWidth,
    xOf: (day) => (day - from) * dayWidth,
    widthOf: (start, end) => (end - start + 1) * dayWidth,
    dayAt: (x) => from + Math.floor(x / dayWidth),
  };
}

// ---- the calendar: month / quarter / week arithmetic on epoch days ---------------------------------------------------

function ymd(day: number): [number, number, number] {
  const date = new Date(day * DAY_MS);
  return [date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()];
}

/** The first day of the month `months` after the month containing `day` (negative = before). */
function monthStartShifted(day: number, months: number): number {
  const [year, month] = ymd(day);
  return Date.UTC(year, month + months, 1) / DAY_MS;
}

const monthStart = (day: number) => monthStartShifted(day, 0);
const monthEnd = (day: number) => monthStartShifted(day, 1) - 1;

/** The first month (0-based) of the quarter containing `day`'s month. */
const quarterOffset = (day: number) => ymd(day)[1] % 3;
const quarterStart = (day: number) => monthStartShifted(day, -quarterOffset(day));
const quarterEnd = (day: number) => monthStartShifted(day, 3 - quarterOffset(day)) - 1;

const weekStart = (day: number) => day - weekdayOf(day);
const weekEnd = (day: number) => weekStart(day) + DAYS_PER_WEEK - 1;

/** The ISO week a day belongs to: the year and number of the Thursday of its Monday-start week. */
export function isoWeekOf(day: number): { year: number; week: number } {
  const thursday = weekStart(day) + 3;
  const year = ymd(thursday)[0];
  const dayOfYear = thursday - Date.UTC(year, 0, 1) / DAY_MS;
  return { year, week: Math.floor(dayOfYear / DAYS_PER_WEEK) + 1 };
}

const pad2 = (n: number) => String(n).padStart(2, "0");

// ---- the header ------------------------------------------------------------------------------------------------------

export interface HeaderCell {
  /** Unique within its header row. */
  key: string;
  label: string;
  /** First and last day of the cell, CLIPPED to the range. */
  from: number;
  to: number;
  /** A day cell that is a Saturday or Sunday (the other grains are never "weekend"). */
  weekend: boolean;
}

export interface TimelineHeaderRows {
  groups: HeaderCell[];
  cells: HeaderCell[];
}

type Grain = "day" | "week" | "month" | "quarter";

interface GrainSpec {
  end: (day: number) => number;
  key: (day: number) => string;
  label: (day: number) => string;
}

const SPEC: Record<Grain, GrainSpec> = {
  day: {
    end: (day) => day,
    key: (day) => `d${day}`,
    label: (day) => String(ymd(day)[2]),
  },
  week: {
    end: weekEnd,
    key: (day) => `w${weekStart(day)}`,
    label: (day) => `W${pad2(isoWeekOf(day).week)}`,
  },
  month: {
    end: monthEnd,
    key: (day) => `m${monthStart(day)}`,
    label: (day) => `${ymd(day)[0]}-${pad2(ymd(day)[1] + 1)}`,
  },
  quarter: {
    end: quarterEnd,
    key: (day) => `q${quarterStart(day)}`,
    label: (day) => `${ymd(day)[0]}-Q${Math.floor(ymd(day)[1] / 3) + 1}`,
  },
};

/** The cells of one grain partitioning the range, each clipped to it. */
function partition(range: DayRange, grain: Grain, groupLabels = false): HeaderCell[] {
  const spec = SPEC[grain];
  const out: HeaderCell[] = [];
  for (let start = range.from; start <= range.to; ) {
    const to = Math.min(range.to, spec.end(start));
    const label =
      groupLabels && grain === "week" ? `W${pad2(isoWeekOf(start).week)} ${isoWeekOf(start).year}` : spec.label(start);
    out.push({ key: spec.key(start), label, from: start, to, weekend: grain === "day" && isWeekend(start) });
    start = to + 1;
  }
  return out;
}

const HEADER_GRAINS: Record<Zoom, { group: Grain; cell: Grain }> = {
  week: { group: "week", cell: "day" },
  month: { group: "month", cell: "week" },
  quarter: { group: "quarter", cell: "month" },
};

/**
 * The two header rows: the group row (weeks / months / quarters) over the cell row (days / weeks / months) at week / month /
 * quarter zoom. Both PARTITION the range, so a group or cell crossing the range edge is clipped, never dropped.
 */
export function headerRows(scale: TimelineScale): TimelineHeaderRows {
  const range = { from: scale.from, to: scale.to };
  const grains = HEADER_GRAINS[scale.zoom];
  return { groups: partition(range, grains.group, true), cells: partition(range, grains.cell) };
}

// ---- the weekend hatch -----------------------------------------------------------------------------------------------

/** The zooms at which weekends are drawn: at 3 px per day the pattern is noise. */
const HATCHED_ZOOMS: readonly Zoom[] = ["week", "month"];

/**
 * The weekend pattern as ONE periodic background per row: a `repeating-linear-gradient(90deg, …)` whose period is a week
 * (`7 × dayWidth`), transparent on Monday–Friday and `ink` on Saturday–Sunday, phased so that its first Monday sits at the
 * right x (a repeating gradient repeats in both directions, so the phase may be negative). `null` where nothing is drawn.
 */
export function weekendBackground(scale: TimelineScale, ink = "var(--timeline-hatch)"): string | null {
  if (!HATCHED_ZOOMS.includes(scale.zoom)) return null;
  const { dayWidth } = scale;
  const period = DAYS_PER_WEEK * dayWidth;
  // The x of the Monday on or before the range start, folded into one period so the stops stay small.
  const phase = (((scale.xOf(weekStart(scale.from)) % period) + period) % period) - period;
  const workEnd = phase + WORKING_DAYS_PER_WEEK * dayWidth;
  return `repeating-linear-gradient(90deg, transparent ${phase}px ${workEnd}px, ${ink} ${workEnd}px ${phase + period}px)`;
}

// ---- the default range -----------------------------------------------------------------------------------------------

interface RangeRule {
  start: (day: number) => number;
  end: (day: number) => number;
  /** `n` units after the unit containing `day` (negative = before), landing on some day of that unit. */
  shift: (day: number, n: number) => number;
  /** Units of padding around the data / around today when nothing is scheduled. */
  pad: number;
  emptyPad: number;
}

const RANGE_RULES: Record<Zoom, RangeRule> = {
  week: { start: weekStart, end: weekEnd, shift: (day, n) => day + n * DAYS_PER_WEEK, pad: 2, emptyPad: 6 },
  month: { start: monthStart, end: monthEnd, shift: monthStartShifted, pad: 1, emptyPad: 3 },
  quarter: { start: quarterStart, end: quarterEnd, shift: (day, n) => monthStartShifted(day, 3 * n), pad: 1, emptyPad: 2 },
};

/**
 * The range a page opens with: the min and max of `dates` (ISO) together with `today`, padded ±2 weeks / ±1 month / ±1 quarter
 * and snapped outward to whole Monday–Sunday weeks / months / quarters; with no dates, today ±6 weeks / ±3 months / ±2 quarters.
 */
export function defaultRange(dates: readonly string[], today: string, zoom: Zoom): DayRange {
  const rule = RANGE_RULES[zoom];
  const todayDay = toEpochDay(today);
  const days = dates.map(toEpochDay);
  const pad = days.length === 0 ? rule.emptyPad : rule.pad;
  const low = Math.min(todayDay, ...days);
  const high = Math.max(todayDay, ...days);
  return { from: rule.start(rule.shift(low, -pad)), to: rule.end(rule.shift(high, pad)) };
}

/** The `scrollLeft` that centres `day` in the track part of a viewport (`viewport` wide, the first `left` px being the sticky columns). */
export function scrollLeftToCenter(scale: TimelineScale, day: number, viewport: number, left: number): number {
  return Math.max(0, scale.xOf(day) + scale.dayWidth / 2 - (viewport - left) / 2);
}
