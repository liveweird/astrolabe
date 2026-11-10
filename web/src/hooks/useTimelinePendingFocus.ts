import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

/** The wished-for grid position `r,c` (1-based row, 0-based column) of a row the virtual path has not mounted yet. */
export type PendingFocus = { r: number; c: number };

/**
 * The "focus this cell once its row mounts" wish of the virtual path (↑/↓ and Ctrl+Home/End at an unmounted row, `focusRow`). Returns the ref the
 * frame writes the wish into. Scrolled-to rows mount a frame later: a layout effect focuses the wanted cell (or the nearest to its left) as soon as it
 * exists. A wish must not outlive the user's intent: any other key, a focus elsewhere or a scroll by hand (wheel, touch, pointer, keys on the scroller
 * itself) drops it, so it cannot steal focus later.
 */
export function useTimelinePendingFocus(scrollRef: RefObject<HTMLDivElement | null>, gridRef: RefObject<HTMLDivElement | null>): RefObject<PendingFocus | null> {
  const pendingFocus = useRef<PendingFocus | null>(null);

  useLayoutEffect(() => {
    const wanted = pendingFocus.current;
    const root = gridRef.current;
    if (wanted === null || root === null) return;
    for (let c = wanted.c; c >= 0; c -= 1) {
      const cell = root.querySelector<HTMLElement>(`[data-grid-pos="${wanted.r},${c}"]`);
      if (cell !== null) {
        pendingFocus.current = null;
        cell.focus();
        return;
      }
    }
  });

  useEffect(() => {
    const scroller = scrollRef.current;
    const cancel = () => {
      pendingFocus.current = null;
    };
    const cancelOnScroller = (event: Event) => {
      if (event.type !== "keydown" || event.target === scroller) cancel();
    };
    const focusElsewhere = (event: FocusEvent) => {
      if (!gridRef.current?.contains(event.target as Node)) cancel();
    };
    const events = ["wheel", "touchmove", "pointerdown", "keydown"];
    events.forEach((name) => scroller?.addEventListener(name, cancelOnScroller, { passive: true }));
    document.addEventListener("focusin", focusElsewhere);
    return () => {
      events.forEach((name) => scroller?.removeEventListener(name, cancelOnScroller));
      document.removeEventListener("focusin", focusElsewhere);
    };
  }, [scrollRef, gridRef]);

  return pendingFocus;
}
