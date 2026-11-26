import { useEffect, useRef, type RefObject } from "react";
import type { TimelineHandle } from "../components/Timeline";
import type { usePlanOrder } from "./usePlanOrder";
import { useRowMenuFocus } from "./useRowMenuFocus";

/**
 * Where the keyboard focus goes after a row menu's Move up / Move down on the Plan page: the row's menu button (`data-operations-for`, the scope-qualified
 * id `tree:pg:12`) - once at render, because a browser blurs a row moved in the DOM, and again when the menu has FINISHED closing (`menuClosed`), because
 * the dropdown's focus trap pulls an earlier focus back until it unmounts (`useRowMenuFocus`, the Roadmap's mechanism, widened to string ids). A change
 * that was rolled back returns the focus to the row it came from, unless the user has moved it elsewhere. The page has no timeline to scroll to, so a
 * row that is gone falls back to `fallback` (the page title).
 */
export function usePlanOrderFocus(order: Pick<ReturnType<typeof usePlanOrder>, "pending" | "rollbacks" | "writeCount">, fallback: RefObject<HTMLElement | null>) {
  const noTimeline = useRef<TimelineHandle | null>(null);
  const focus = useRowMenuFocus(noTimeline, fallback);
  const { returnToOrigin, forgetOrigin } = focus;
  const { pending, rollbacks } = order;
  // Only the failure of the write a change sent can return the focus: once it has settled (rolled back or not) the row is forgotten.
  const seenRollbacks = useRef(0);
  useEffect(() => {
    if (pending) return;
    if (rollbacks === seenRollbacks.current) forgetOrigin();
    else {
      seenRollbacks.current = rollbacks;
      returnToOrigin();
    }
  }, [pending, rollbacks, returnToOrigin, forgetOrigin]);
  return {
    /** A change from the menu of `opsId`: the focus stays on that menu button; if it sent a PUT and that is rolled back, the focus returns to it. */
    change: (opsId: string, run: () => boolean) => {
      const sent = order.writeCount();
      focus.keep(opsId, run());
      if (order.writeCount() > sent) focus.watchRollback(opsId);
    },
    menuClosed: focus.menuClosed,
  };
}
