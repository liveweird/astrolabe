import { useEffect, useRef } from "react";

/**
 * Focus follows the schedule proposal's preview on the team page, the project page and the Roadmap overview (one rule for a fresh run and a saved one): when a run OPENS, its
 * section's heading (`headingRef`: an h3 with `tabIndex={-1}` and `ANCHORED_HEADING_STYLE`, whose scroll margin clears the sticky header) is scrolled to the top of the viewport and takes
 * the focus (`preventScroll`), so the reader starts at the top of what was proposed. It was Discard that took the focus until 1.37, the LAST control of a section as tall as the run, so the
 * page jumped to the bottom. An opening is the run object itself (`open`): a tick, a refetch, a failed accept or a window focus never lands again, a Propose again (or a stale refusal's
 * fresh run, or another saved proposal) is a new opening and lands again; the latch is cleared when the run closes, so the same stored run opened again lands again too.
 * Propose gets the focus back once the preview is closed (discarded, accepted or voided by a stale refusal) and no write is running any more (`busy`), since a button that is still
 * disabled cannot take it. Returns the refs the page hands to the heading and to Propose.
 */
export function useProposalFocus(open: object | null, busy: boolean) {
  const proposeRef = useRef<HTMLButtonElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const wasOpen = useRef(false);
  const landedOn = useRef<object | null>(null);
  const isOpen = open !== null;
  useEffect(() => {
    if (open === null) {
      landedOn.current = null;
      return;
    }
    wasOpen.current = true;
    if (landedOn.current === open) return;
    landedOn.current = open;
    headingRef.current?.scrollIntoView?.({ block: "start" });
    headingRef.current?.focus({ preventScroll: true });
  }, [open]);
  useEffect(() => {
    if (!isOpen && wasOpen.current && !busy) {
      wasOpen.current = false;
      proposeRef.current?.focus();
    }
  }, [isOpen, busy]);
  return { proposeRef, headingRef };
}
