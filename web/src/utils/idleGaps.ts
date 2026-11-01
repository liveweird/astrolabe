import type { TFunction } from "i18next";
import type { IdleGap } from "../api/milestones";
import type { TimelineBandData } from "./timelineModel";

/**
 * The server's idle gaps as timeline bands, one `idle` band per gap in the server's order (by start). A gap runs from its first to its
 * last idle WORKING day, so the band covers exactly those days (the weekend or holiday after it is not tinted). Read, never recomputed;
 * the band is `aria-hidden` and `pointer-events: none` like every band (its title is no hover tooltip), so the Idle gaps table is
 * where a gap's dates and length are read.
 */
export function idleBands(gaps: readonly IdleGap[], t: TFunction): TimelineBandData[] {
  return gaps.map((gap) => ({
    id: `idle:${gap.start}`,
    start: gap.start,
    end: gap.end,
    label: t("timeline.idle.band", { start: gap.start, end: gap.end, count: gap.workingDays }),
    tone: "idle",
  }));
}
