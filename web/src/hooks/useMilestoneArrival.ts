import { useEffect, useState, type RefObject } from "react";
import { useSearchParams } from "react-router-dom";
import type { ProjectView } from "../api/milestones";
import type { TimelineHandle } from "../components/Timeline";
import { idOf } from "../utils/deviationFilters";
import { UNSCHEDULED_PARAM } from "../utils/planLinks";

/** The address's own word for a milestone (`milestonePath`: `/projects/P?milestone=M`). */
const PARAM = "milestone";

/** Where the milestone of an address is on the project page: a timeline row, a tray row, or nowhere (removed, moved, or never of this project). */
type Place = "scheduled" | "tray" | "gone";

function placeOf(view: ProjectView, id: number | undefined): Place {
  if (id !== undefined && view.scheduled.some((milestone) => milestone.id === id)) return "scheduled";
  if (id !== undefined && view.unscheduled.some((milestone) => milestone.id === id)) return "tray";
  return "gone";
}

/** The tray row of a milestone (`TimelineUnscheduledTray` names each row `data-tray-item`). */
function focusTrayRow(id: number): void {
  document.querySelector<HTMLElement>(`[data-tray-item="${id}"]`)?.focus();
}

/**
 * A milestone's ADDRESS on the project page (1.31, `?milestone=M`; `milestonePath`). Once the page's view has loaded, the milestone it names is MARKED
 * (the timeline row, or the tray row of an unscheduled one; the page reads `marked`) and takes the focus - the
 * timeline's own `focusRow` (mounted or virtualised, then `scrollToDay` to the bar's start) or the tray row - and the parameter is then DROPPED with a `replace`: Back does not return to the
 * address that stole the focus, and a reload leaves it where the user put it. The mark stays for the page's life (a milestone that leaves the view
 * loses it). Another milestone's address on the same page marks that one instead.
 *
 * A milestone the project does not have (removed, moved to another project, a malformed id) is no error page: `gone` says so (a dismissible
 * notice) and the page works as ever. That verdict waits for `settled` (the last read SUCCEEDED and none is in flight: a failed refetch leaves a stale copy that says nothing), so a milestone created a moment ago, missing from a
 * cached copy, is not reported gone before the refetch answers; a milestone the view DOES hold is marked at once.
 */
export function useMilestoneArrival(
  view: ProjectView | undefined,
  settled: boolean,
  timelineRef: RefObject<TimelineHandle | null>,
): { marked: number | null; gone: boolean; dismiss: () => void } {
  const [params, setParams] = useSearchParams();
  const raw = params.get(PARAM);
  const requested = idOf(raw);
  const place = view === undefined || raw === null ? null : placeOf(view, requested);
  const decided = place === "gone" && !settled ? null : place;
  // Where the bar starts (a scheduled milestone): the track scrolls there. Once the address is dropped `decided` is null, so a later refetch moving the dates scrolls nothing.
  const start = view?.scheduled.find((milestone) => milestone.id === requested)?.startDate;
  const [marked, setMarked] = useState<number | null>(null);
  const [gone, setGone] = useState(false);
  // The address decides what is marked and whether the notice shows; both are state because the address is dropped right after (adjusted during render, as the page's range is).
  if (decided !== null) {
    const nextMarked = decided === "gone" ? null : (requested ?? null);
    if (marked !== nextMarked) setMarked(nextMarked);
    if (gone !== (decided === "gone")) setGone(decided === "gone");
  }

  useEffect(() => {
    if (decided === null) return;
    if (requested !== undefined) {
      if (decided === "scheduled") {
        timelineRef.current?.focusRow(requested);
        // The row header is sticky: the bar may lie off to the right, so the track follows to its start (after the focus, whose reveal only works vertically for a left cell).
        if (start != null) timelineRef.current?.scrollToDay(start);
      } else if (decided === "tray") focusTrayRow(requested);
    }
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        next.delete(PARAM);
        // The retired Milestones table's parameter: ignored, and dropped here too (`useUnscheduledArrival` stands aside while this address is on it).
        next.delete(UNSCHEDULED_PARAM);
        return next;
      },
      { replace: true },
    );
  }, [decided, requested, start, timelineRef, setParams]);

  // A milestone that left the view (deleted, moved to another project) is marked no more.
  const present = view !== undefined && marked !== null && placeOf(view, marked) !== "gone";
  return { marked: present ? marked : null, gone, dismiss: () => setGone(false) };
}
