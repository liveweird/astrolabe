import { useEffect, type RefObject } from "react";
import { useSearchParams } from "react-router-dom";
import { UNSCHEDULED_PARAM as PARAM, UNSCHEDULED_VALUE as UNSCHEDULED } from "../utils/planLinks";
/** A milestone's address (`useMilestoneArrival`) is the more specific ask: it focuses its own row and drops this parameter with its own. */
const MILESTONE_PARAM = "milestone";

/**
 * The project page's "not scheduled" arrival (Home's project figure, the retired `/milestones?scheduled=false`). With `?milestones=unscheduled` the
 * Unscheduled section's heading takes the focus (and so scrolls into view) ONCE, when `ready` (the page's view is here and its last read succeeded with none in
 * flight: a failed or running read leaves the address alone, so a recovery still arrives), then the parameter is DROPPED with a `replace` (the other parameters
 * stay), so Back and a reload do not take the focus again. The heading is the target for a tray with rows and for the "Every milestone is scheduled" line alike;
 * a project without milestones has no section (`headingRef` empty): nothing to focus, the parameter is still dropped. Any other value of the parameter
 * (`scheduled`, `all`, a stray word) is ignored and dropped without a focus. While `?milestone=` is on the address the milestone's own arrival decides (it drops both).
 */
export function useUnscheduledArrival(ready: boolean, headingRef: RefObject<HTMLElement | null>): void {
  const [params, setParams] = useSearchParams();
  const raw = params.get(PARAM);
  const standAside = params.has(MILESTONE_PARAM);
  useEffect(() => {
    if (!ready || raw === null || standAside) return;
    if (raw === UNSCHEDULED) headingRef.current?.focus();
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        next.delete(PARAM);
        return next;
      },
      { replace: true },
    );
  }, [ready, raw, standAside, headingRef, setParams]);
}
