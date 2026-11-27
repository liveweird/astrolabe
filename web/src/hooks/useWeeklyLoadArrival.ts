import { useEffect, useRef, useState, type RefObject } from "react";
import { useLocation, useSearchParams } from "react-router-dom";
import type { TeamView } from "../api/teams";
import { firstWeekOf, parseWeeklyLoadAddress, WEEKLY_LOAD_PARAM, type WeeklyLoadAddress } from "../utils/weeklyLoadAddress";

/** What the team page hands its weekly load section (`TeamWeeklyLoad`'s `arrival`): the disclosure's state, the mark and the things the arrival may focus. */
export type WeeklyLoadArrival = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The table's scroller (a focusable, labelled region): what the arrival focuses and scrolls. */
  regionRef: RefObject<HTMLDivElement | null>;
  /** The section's heading (`tabIndex={-1}`): what the arrival focuses when there is no table (a team with no week listed). */
  headingRef: RefObject<HTMLHeadingElement | null>;
  /** The Monday of the week the arrival landed on (its row is marked `aria-current` and `.rowCurrent`), or `null`. */
  marked: string | null;
};

/** What the page tells the arrival: its view's query, whether the layout above the table is final, the view (its `weeks` are the table's rows) and the viewer's local day. */
type Inputs = { read: { isSuccess: boolean; isFetching: boolean }; ready: boolean; view: Pick<TeamView, "weeks"> | undefined; today: string };

/** Scrolls the region's OWN scroller so `row` sits just under the sticky header (the page is not moved: the region was scrolled into view first). */
function scrollRowIntoRegion(region: HTMLElement, row: HTMLElement) {
  const head = region.querySelector("thead")?.getBoundingClientRect().height ?? 0;
  region.scrollTop = Math.max(0, row.getBoundingClientRect().top - region.getBoundingClientRect().top + region.scrollTop - head);
}

/**
 * The address of a team's weekly load table (1.36, `?load=overloaded|wip|nocapacity`, the kind of week the clicked badge counts, or `weeks`: open it and nothing
 * more; `teamWeeklyLoadPath`). Once the page has SETTLED - the view's query succeeded and none is running (`read`), and the layout above the table is final
 * (`ready`: the Flow section's reads are answered, or failed, since the section is above the table and grows when they land; a failed or running read does
 * nothing and leaves the address) - the table's disclosure OPENS for this visit (its state is the page's own: nothing is remembered, so nothing is written) and the
 * parameter is DROPPED with a `replace` (Back does not return to the address that stole the focus, a reload leaves the page where the user put it).
 * Once the table is mounted open (the arrival is taken once per history entry, so closing the table afterwards is final), the page scrolls it to the centre, the region's own scroller shows the first week of that kind (at or after this week, else
 * the latest before it: `firstWeekOf`) and the row is marked (`marked`), and the region takes the focus - once per arrival (the section's heading when no week is listed).
 * The open table is the user's afterwards: they may close it, and nothing opens it again. The mark stays until another arrival.
 */
export function useWeeklyLoadArrival({ read, ready, view, today }: Inputs): WeeklyLoadArrival {
  const [params, setParams] = useSearchParams();
  const address = parseWeeklyLoadAddress(params.get(WEEKLY_LOAD_PARAM));
  const arriving = read.isSuccess && !read.isFetching && ready ? address : undefined;
  const [open, setOpen] = useState(false);
  // An arrival taken, waiting for its table to be mounted open (the next commit): the second step below lands it.
  const [landing, setLanding] = useState<WeeklyLoadAddress | null>(null);
  const [marked, setMarked] = useState<string | null>(null);
  const regionRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Step 1: take the arrival once per address (the history entry's key is the latch): the disclosure opens and the landing is queued, during render as `useMilestoneArrival`
  // adjusts its state. Nothing here depends on `open`, so a Hide click right after can never be undone; the address is dropped below.
  const location = useLocation();
  const [takenAt, setTakenAt] = useState<string | null>(null);
  if (arriving !== undefined && takenAt !== location.key) {
    setTakenAt(location.key);
    setOpen(true);
    setLanding(arriving);
  }
  useEffect(() => {
    if (arriving === undefined) return;
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        next.delete(WEEKLY_LOAD_PARAM);
        return next;
      },
      { replace: true },
    );
  }, [arriving, setParams]);

  // Step 2: the table is mounted open now; land on it.
  useEffect(() => {
    if (landing === null) return;
    const region = regionRef.current;
    const week = firstWeekOf(view?.weeks ?? [], landing, today);
    const row = week === undefined ? null : region?.querySelector<HTMLElement>(`tr[data-load-week="${week}"]`);
    const target = region ?? headingRef.current;
    target?.scrollIntoView?.({ block: "center" });
    if (region && row) {
      scrollRowIntoRegion(region, row);
      // A viewport shorter than the region (a landscape phone): centring the region can leave the row out of view, so the row itself is brought in (the nearest edge).
      row.scrollIntoView?.({ block: "nearest" });
    }
    target?.focus({ preventScroll: true });
    setMarked(row ? (week ?? null) : null);
    setLanding(null);
  }, [landing, view, today]);

  return { open, onOpenChange: setOpen, regionRef, headingRef, marked };
}
