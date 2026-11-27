import { DEFAULT_MAX_HEIGHT, ROW_HEIGHT, type TimelineRowData } from "./timelineModel";
import { toEpochDay, type TimelineScale } from "./timelineScale";

/**
 * Where every Gantt opens (`.claude/docs/timeline.md` "Where a Gantt opens"), pure: ONE rule for the project page, the team page, the Roadmap's two
 * modes and the programs view, applied by `hooks/useTimelineOpen.ts` through the shared `Timeline`.
 */

/** Today sits this share of the visible grid (the track part of the scroller, the sticky columns excluded) from its left edge. */
export const OPEN_TODAY_SHARE = 0.25;

/** The lead before the first bar when the grid opens at it instead (a bar flush against the sticky columns reads as cut). */
export const OPEN_LEAD_PX = 40;

/** Half the width of the header's "Today" pill, with a margin: a pill whose centre is nearer an edge than this is cut there. */
export const TODAY_PILL_HALF_PX = 32;

/** The rows the first screen shows: the body's default height (`DEFAULT_MAX_HEIGHT`) over a row. Only their bars decide whether the first screen is empty. */
export const OPEN_ROWS = Math.ceil(DEFAULT_MAX_HEIGHT / ROW_HEIGHT);

/** A bar's days, as epoch days. */
export interface OpenSpan {
  start: number;
  end: number;
}

/** The drawn bars of the rows the first screen shows (every tone: a milestone, a project span, a window, a baseline, a Jira or a proposal bar). */
export function openSpans(rows: readonly TimelineRowData[]): OpenSpan[] {
  return rows.slice(0, OPEN_ROWS).flatMap((row) => row.bars.map((bar) => ({ start: toEpochDay(bar.start), end: toEpochDay(bar.end) })));
}

/**
 * The `scrollLeft` a Gantt opens at, for a scroller `viewport` px wide whose first `leftWidth` px are the sticky columns (the same arithmetic as
 * `scrollLeftToCenter`):
 *
 * 1. today a quarter of the visible grid from its left edge;
 * 2. if no bar of `spans` touches that screen, the grid opens at the first bar instead, `OPEN_LEAD_PX` before it: the earliest bar that lies after
 *    the screen, or, with none ahead (all the work is past), the earliest bar of all;
 * 3. no bars at all: rule 1;
 * 4. the header's Today pill is never cut at the right edge: a pill straddling it is brought wholly into the screen (opening at a past bar can put today there).
 *
 * The browser clamps a `scrollLeft` anyway; the result is clamped here too, so the tests and the "is this still where it opened" check agree.
 */
export function openScrollLeft(scale: TimelineScale, today: number, spans: readonly OpenSpan[], viewport: number, leftWidth: number): number {
  const visible = viewport - leftWidth;
  if (visible <= 0) return 0;
  const maxLeft = Math.max(0, scale.totalWidth - visible);
  const clamp = (left: number) => Math.min(maxLeft, Math.max(0, left));
  const todayX = scale.xOf(today) + scale.dayWidth / 2;
  const atToday = clamp(todayX - OPEN_TODAY_SHARE * visible);

  let left = atToday;
  const touchesScreen = spans.some((span) => scale.xOf(span.start) < atToday + visible && scale.xOf(span.end) + scale.dayWidth > atToday);
  if (spans.length > 0 && !touchesScreen) {
    // Nothing touches the screen, so every bar lies wholly before or wholly after it.
    const ahead = spans.filter((span) => scale.xOf(span.start) >= atToday + visible);
    const first = Math.min(...(ahead.length > 0 ? ahead : spans).map((span) => span.start));
    left = clamp(scale.xOf(first) - OPEN_LEAD_PX);
  }
  if (today < scale.from || today > scale.to) return left;
  const pillAt = todayX - left;
  // Only the right edge can cut it: opening at a bar ahead puts today far left of the screen, and the range's padding keeps today clear of both its ends.
  if (pillAt + TODAY_PILL_HALF_PX > visible && pillAt - TODAY_PILL_HALF_PX < visible) left += pillAt + TODAY_PILL_HALF_PX - visible;
  return clamp(left);
}
