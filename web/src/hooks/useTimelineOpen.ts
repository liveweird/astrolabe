import { useLayoutEffect, useRef, type RefObject } from "react";
import type { TimelineRowData } from "../utils/timelineModel";
import { openScrollLeft, openSpans } from "../utils/timelineOpen";
import { toEpochDay, type TimelineScale, type Zoom } from "../utils/timelineScale";

/** Where the grid was put, to tell later whether it is still there and the same scale is still under it. */
interface Opened {
  left: number;
  leftWidth: number;
  zoom: Zoom;
  from: number;
}

/** A browser rounds a `scrollLeft` to its device pixels. */
const SAME_PX = 1;

/**
 * Where a Gantt opens (`timeline.md` "Where a Gantt opens", the rule is `utils/timelineOpen.ts`): applied in a layout effect (before the first paint) when the
 * scroller has a width. The pane is then fitted to a narrow scroller in the page's own layout effect, which changes `leftWidth` and so the visible grid: that
 * synchronous re-render re-applies the rule. The grid is settled for good as soon as that first pass is over (a microtask after the first apply: a layout-effect
 * state update is flushed before it), so a later pane change (Hide columns, a resize across 600 px), a refetch, a growing range or a zoom change never moves the grid,
 * and neither does anything that moved it by hand or by address first. Returns `settle`, which the frame calls when something else scrolls on purpose
 * (`scrollToDay`: the Scroll to today button and an arrival address's bar; `focusRow`), so an explicit target always wins over the default.
 */
export function useTimelineOpen(
  scrollRef: RefObject<HTMLDivElement | null>,
  scale: TimelineScale,
  today: string,
  leftWidth: number,
  rows: readonly TimelineRowData[],
): () => void {
  const state = useRef<{ settled: boolean; opened: Opened | null }>({ settled: false, opened: null });

  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const current = state.current;
    if (scroller === null || current.settled) return;
    const { opened } = current;
    if (opened !== null) {
      // Nothing new for the rule to know (a refetch, a re-render): leave it.
      if (opened.leftWidth === leftWidth) return;
      // The pane was fitted after the open: re-apply, unless the viewer or the page has moved the grid or changed the scale since.
      // A browser clamps a scroll position to a narrower pane's end, which is not the viewer's doing: compare with where the clamp would leave it.
      const stays = scroller.scrollWidth > 0 ? Math.min(opened.left, Math.max(0, scroller.scrollWidth - scroller.clientWidth)) : opened.left;
      if (opened.zoom !== scale.zoom || opened.from !== scale.from || Math.abs(scroller.scrollLeft - stays) > SAME_PX) {
        current.settled = true;
        return;
      }
    } else if (scroller.scrollLeft > SAME_PX) {
      current.settled = true;
      return;
    }
    // Not laid out (a test DOM, a hidden tab): nothing to open on yet; the next render tries again.
    if (scroller.clientWidth <= 0) return;
    scroller.scrollLeft = openScrollLeft(scale, toEpochDay(today), openSpans(rows), scroller.clientWidth, leftWidth);
    current.opened = { left: scroller.scrollLeft, leftWidth, zoom: scale.zoom, from: scale.from };
    // The page's own fit re-renders synchronously, before this runs; whatever changes the pane after it is the viewer's.
    queueMicrotask(() => {
      current.settled = true;
    });
  });

  return () => {
    state.current.settled = true;
  };
}
