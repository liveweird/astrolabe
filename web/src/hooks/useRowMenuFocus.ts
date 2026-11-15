import { useEffect, useRef, type RefObject } from "react";
import type { TimelineHandle } from "../components/Timeline";

/**
 * Where the keyboard focus goes after a project row's menu was used (the roadmap's rank moves, both plan pages' target-window items), so a
 * keyboard user stays on the row they were working on. A change can leave the focused element gone - a browser blurs a row moved in the DOM, a
 * dialog opened from a menu item takes the item with it - and the focus must come back to the row's menu button (`data-operations-for`).
 * Where the virtual path has unmounted the row (Move to bottom, Rank) the button is gone, so the timeline scrolls to the row and focuses its
 * header instead (`focusRow`).
 *
 * The menu that was used keeps its dropdown - and its focus trap - mounted through its exit transition (~150 ms), and the trap pulls a focus moved
 * meanwhile back into the dropdown, which lands on `body` when the dropdown unmounts. So the focus is put once at render (`keep`) and again when the menu
 * has FINISHED closing (`menuClosed`, from `RowActionsMenu`'s opt-in `onClosed`): the first covers rows whose menu is gone with the row, the
 * second the ones that stay.
 */
export function useRowMenuFocus(timelineRef: RefObject<TimelineHandle | null>): {
  /**
   * Put the focus back on the row of `id` after the next render and again when the menu of `from` (default: the same row) has closed - only when
   * the change was `taken`. `from` differs when the used row leaves the list and the focus goes to a neighbour (Rank under "Unranked projects only").
   */
  keep: (id: number, taken?: boolean, from?: number) => void;
  /** Put the focus back on the row of `id` after the next render only: a dialog opened from the menu has closed (its menu finished closing long ago). */
  restore: (id: number) => void;
  /** The row's menu has finished closing: refocus if a change asked for it. */
  menuClosed: (id: number) => void;
} {
  const refocus = useRef<number | null>(null);
  const afterExit = useRef<{ menu: number; target: number } | null>(null);
  const putFocusOn = (id: number) => {
    const button = document.querySelector<HTMLElement>(`[data-operations-for="${id}"]`);
    if (button === null) timelineRef.current?.focusRow(id);
    else button.focus();
  };
  // Every render, after the DOM is committed: the row that was moved is where it is going to be.
  useEffect(() => {
    if (refocus.current === null) return;
    const id = refocus.current;
    refocus.current = null;
    putFocusOn(id);
  });
  return {
    keep: (id, taken = true, from = id) => {
      if (!taken) return;
      refocus.current = id;
      afterExit.current = { menu: from, target: id };
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
  };
}
