import { useCallback, useEffect, useRef, type RefObject } from "react";
import type { TimelineHandle } from "../components/Timeline";
import type { BarId } from "../utils/timelineModel";

/**
 * Where the keyboard focus goes after a project row's menu was used (the roadmap's rank moves, both plan pages' target-window items), so a
 * keyboard user stays on the row they were working on. A change can leave the focused element gone - a browser blurs a row moved in the DOM, a
 * dialog opened from a menu item takes the item with it - and the focus must come back to the row's menu button (`data-operations-for`).
 * Where the virtual path has unmounted the row (Move to bottom, Rank) the button is gone, so the timeline scrolls to the row and focuses its
 * header instead (`focusRow`). Where the timeline does not hold the row either - or is not mounted at all, as when the last row of a filtered list
 * was ranked and the page shows its empty state - the focus goes to `fallbackRef` (the Roadmap passes its Filters button); without one, nowhere.
 *
 * The menu that was used keeps its dropdown - and its focus trap - mounted through its exit transition (~150 ms), and the trap pulls a focus moved
 * meanwhile back into the dropdown, which lands on `body` when the dropdown unmounts. So the focus is put once at render (`keep`) and again when the menu
 * has FINISHED closing (`menuClosed`, from `RowActionsMenu`'s opt-in `onClosed`): the first covers rows whose menu is gone with the row, the
 * second the ones that stay. A row that has left the DOM by the render that follows `keep` takes its menu with it, which will never report a close:
 * the second put is dropped then, so a row of the same id coming back later (the filter turned off) is not mistaken for that close.
 *
 * `returnToOrigin` undoes a change that was rolled back: the focus goes back to the row the change came from, but only if it still sits where this
 * hook put it, or on `body` - a focus the user has moved meanwhile is left alone. Only the failure of a write the page SAW go out
 * (`watchRollback`) can return the focus, and the page forgets the row (`forgetOrigin`) when that write settles without a rollback: a later,
 * unrelated failure (a pointer drag) never pulls the focus to an old row.
 */
export function useRowMenuFocus(
  timelineRef: RefObject<TimelineHandle | null>,
  fallbackRef?: RefObject<HTMLElement | null>,
): {
  /**
   * Put the focus back on the row of `id` after the next render and again when the menu of `from` (default: the same row) has closed - only when
   * the change was `taken`. `from` differs when the used row leaves the list and the focus goes to a neighbour (Rank under "Unranked projects only").
   */
  keep: (id: BarId, taken?: boolean, from?: BarId) => void;
  /** Put the focus back on the row of `id` after the next render only: a dialog opened from the menu has closed (its menu finished closing long ago). */
  restore: (id: BarId) => void;
  /** The row's menu has finished closing: refocus if a change asked for it. */
  menuClosed: (id: BarId) => void;
  /** A write for the change just kept went out (not a no-op): if it is rolled back, `returnToOrigin` goes to the row `from`. */
  watchRollback: (from: BarId) => void;
  /** The watched write was rolled back: put the focus on the row it came from, unless the user has moved it elsewhere. Once per write. */
  returnToOrigin: () => void;
  /** The watched write settled without a rollback: nothing is left to return to. */
  forgetOrigin: () => void;
} {
  const refocus = useRef<BarId | null>(null);
  const afterExit = useRef<{ menu: BarId; target: BarId } | null>(null);
  const origin = useRef<BarId | null>(null);
  /** The element this hook last put the focus on (null: unknown, as when the virtual path focuses the row later). */
  const placed = useRef<Element | null>(null);
  const putFocusOn = useCallback(
    (id: BarId) => {
      const button = document.querySelector<HTMLElement>(`[data-operations-for="${id}"]`);
      if (button !== null) {
        button.focus();
        placed.current = button;
        return;
      }
      const before = document.activeElement;
      if (timelineRef.current?.focusRow(id) === true) {
        const after = document.activeElement;
        placed.current = after === before ? null : after;
        return;
      }
      fallbackRef?.current?.focus();
      placed.current = fallbackRef?.current ?? null;
    },
    [timelineRef, fallbackRef],
  );
  // Every render, after the DOM is committed: the row that was moved is where it is going to be.
  useEffect(() => {
    if (refocus.current === null) return;
    const id = refocus.current;
    refocus.current = null;
    putFocusOn(id);
    const armed = afterExit.current;
    if (armed !== null && document.querySelector(`[data-operations-for="${armed.menu}"]`) === null) afterExit.current = null;
  });
  const forgetOrigin = useCallback(() => {
    origin.current = null;
  }, []);
  const returnToOrigin = useCallback(() => {
    const id = origin.current;
    if (id === null) return;
    origin.current = null;
    const active = document.activeElement;
    if (active === null || active === document.body || active === placed.current) putFocusOn(id);
  }, [putFocusOn]);
  return {
    keep: (id, taken = true, from = id) => {
      if (!taken) return;
      refocus.current = id;
      afterExit.current = { menu: from, target: id };
    },
    watchRollback: (from) => {
      origin.current = from;
    },
    restore: (id) => {
      refocus.current = id;
    },
    menuClosed: (id) => {
      const armed = afterExit.current;
      if (armed?.menu !== id) return;
      afterExit.current = null;
      putFocusOn(armed.target);
    },
    returnToOrigin,
    forgetOrigin,
  };
}
