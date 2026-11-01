import { useState } from "react";
import { localIsoDate } from "../utils/isoDate";
import { defaultRange, makeScale, PLAN_ZOOMS, type TimelineScale, type Zoom } from "../utils/timelineScale";
import { isOneOf, useStoredState } from "./useStoredState";

/**
 * The scale of the two plan timelines (the roadmap and the programs tree): the Month / Quarter / Year zoom, remembered under its OWN key
 * `timeline.planZoom` (default Quarter; the project and team pages keep `timeline.zoom`), and a range that only ever GROWS over the dates the
 * page hands in (every span and window of the whole plan, never just the visible rows), so a filter, a fold or an edit never shifts the bars
 * under the user. `today` is the viewer's own calendar day, not UTC.
 */
export function usePlanScale(dates: readonly string[]): { scale: TimelineScale; setZoom: (zoom: Zoom) => void; today: string } {
  const [zoom, setZoom] = useStoredState<Zoom>("timeline.planZoom", "quarter", isOneOf(PLAN_ZOOMS));
  // The earliest and latest day this page has shown.
  const [seen, setSeen] = useState<{ min: string; max: string } | null>(null);
  const today = localIsoDate();
  if (dates.length > 0) {
    const min = dates.reduce((a, b) => (b < a ? b : a));
    const max = dates.reduce((a, b) => (b > a ? b : a));
    if (seen === null || min < seen.min || max > seen.max) setSeen({ min: seen !== null && seen.min < min ? seen.min : min, max: seen !== null && seen.max > max ? seen.max : max });
  }
  return { scale: makeScale(zoom, defaultRange(seen === null ? [] : [seen.min, seen.max], today, zoom)), setZoom, today };
}
