import { useEffect, useRef, type RefObject } from "react";

/** The button carrying a control key (`DeviationAckCell`, `DeviationAckAll`, `CapacityAckCell` and the "Acknowledge all" buttons mark theirs with it). */
const buttonOf = (key: string) => document.querySelector<HTMLElement>(`[data-ack-for="${key}"]`);

export type AckFocus = {
  /** Arms one move: the control keys to try for the focus, in order of preference, once the page has been re-read. */
  arm: (keys: readonly string[]) => void;
  /** Runs the re-read, then takes a last look at the focus (the move is dropped after it, armed or not). */
  refresh: (refreshing: () => Promise<void>) => Promise<void>;
};

/**
 * Where the focus goes after an acknowledge or a withdraw (shared by `useAcknowledge` and `useCapacityAcknowledge`). The clicked button is gone once the
 * refetch has taken the row off the Open list (or swapped Acknowledge for Unacknowledge), and the browser would leave the focus on `body`. After a write
 * that re-reads (`arm`, then `refresh`), the focus goes, at every render and once more when the re-read has settled, by `useDeleteConfirm`'s rule: focus
 * on `body` -> take it (the first of the armed keys whose button is still there, else `fallback`, the list's heading); anywhere else (the user, or the
 * browser, put it somewhere real) -> leave it. A write that failed without a re-read never arms it: the button is still where it was.
 */
export function useAckFocus(fallback: RefObject<HTMLElement | null>): AckFocus {
  // The rows whose button may take the focus, in order of preference; null = no move is waiting.
  const pending = useRef<readonly string[] | null>(null);

  const settleFocus = () => {
    const candidates = pending.current;
    if (candidates === null) return;
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    pending.current = null;
    const target = candidates.map(buttonOf).find((button) => button !== null) ?? fallback.current;
    target?.focus({ preventScroll: true });
  };
  // Every render, after the DOM is committed: the refetch that takes the row away is such a render.
  useEffect(settleFocus);

  return {
    arm: (keys) => {
      pending.current = keys;
    },
    refresh: async (refreshing) => {
      await refreshing();
      // A last look for the case where no render followed the re-read; then the move is dropped, so a later body focus is the user's.
      window.setTimeout(() => {
        settleFocus();
        pending.current = null;
      }, 0);
    },
  };
}
