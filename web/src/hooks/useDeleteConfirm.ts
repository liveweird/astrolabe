import { useEffect, useRef, useState, type RefObject } from "react";
import { useDisclosure } from "@mantine/hooks";
import { useMutation, type UseMutationResult } from "@tanstack/react-query";
import { takeMenuTrigger } from "../utils/menuOpener";
import { showSuccessToast } from "../utils/toast";

/** How long `onExited` keeps waiting for the closed dialog to leave the DOM: 20 looks, 25 ms apart (half a second). */
const EXIT_RETRIES = 20;
const EXIT_RETRY_MS = 25;

export type DeleteConfirm<T> = {
  target: T | null;
  opened: boolean;
  requestDelete: (row: T) => void;
  cancelDelete: () => void;
  confirmDelete: () => void;
  /** The modal has finished its exit transition: put the focus back if a successful delete is still waiting for it (`ConfirmDeleteModal` wires it to `onExitTransitionEnd`). */
  onExited: () => void;
  mutation: UseMutationResult<unknown, Error, T>;
};

/**
 * The shared request→confirm→mutate flow behind every ConfirmDeleteModal: the hook owns the
 * modal state, the success toast and where the focus goes afterwards; the page owns query
 * invalidation (via onSuccess).
 *
 * **Focus after a successful delete.** The focus was on the row's kebab, then on the dialog's Delete button; both are gone once the modal has
 * faded and the refetch has dropped the row, and the browser leaves the focus on `body` (a keyboard or screen-reader user starts over at the
 * top of the document). So the focus goes to `focusAfterDelete` (the page's heading, or the section's), or - pass `null` - nowhere because the
 * page navigates away and `useFocusMainOnNavigation` owns the focus (the hook is unmounted with the page, so the two never fight; navigation wins).
 * The order of the three events (the modal closing, Mantine returning the focus to the kebab 10 ms later, the refetch removing the row) is
 * not fixed, so the target is tried at every render and again when the modal has finished closing (`onExited`, which keeps looking every 25 ms for up to half a second while the leaving dialog still holds the focus, then drops the move), by one rule:
 * the active element is `body` -> focus the target; it is inside a dialog (the modal is still fading) -> wait; anywhere else (the user, or
 * Mantine, put it somewhere real) -> leave it. A failed delete never arms this: the modal stays open with its error and the focus in it.
 *
 * **Focus after a cancel** (Escape, Cancel, the X, a click outside). A dialog opened from a row menu has no opener to go back to: the menu item
 * that opened it is unmounted, so Mantine's return-focus has nowhere to go and the focus lands on `body`. `requestDelete` therefore takes the
 * menu's trigger that `RowActionsMenu` remembered for the click (`utils/menuOpener.ts`, resolved from the item's `[role="menu"]`); a cancel goes through the
 * same rule, and a focus left on `body` returns to that kebab if it is still connected, else to `focusAfterDelete` (a `null` target and no kebab:
 * nowhere). A dialog opened by a plain button leaves no menu to find: Mantine's own return-focus works and the rule finds the focus elsewhere.
 */
export function useDeleteConfirm<T>({
  mutationFn,
  onSuccess,
  successMessage,
  focusAfterDelete,
}: {
  mutationFn: (row: T) => Promise<unknown>;
  onSuccess: (row: T) => Promise<unknown> | void;
  successMessage?: string;
  focusAfterDelete: RefObject<HTMLElement | null> | null;
}): DeleteConfirm<T> {
  const [target, setTarget] = useState<T | null>(null);
  const [opened, { open, close }] = useDisclosure(false);
  // What the next settle puts the focus back for: after a successful delete the heading only, after a cancel the kebab first.
  const pending = useRef<"deleted" | "cancelled" | null>(null);
  const opener = useRef<HTMLElement | null>(null);

  /** Settles the pending focus move; true while it still waits for the focus to leave a dialog. */
  const settleFocus = (): boolean => {
    const reason = pending.current;
    if (reason === null) return false;
    const active = document.activeElement;
    if (active !== null && active !== document.body && active.closest('[role="dialog"]') !== null) return true;
    pending.current = null;
    if (active !== null && active !== document.body) return false;
    if (reason === "cancelled" && opener.current?.isConnected) {
      opener.current.focus();
      return false;
    }
    // The heading is at the top of the page: after a delete far down a long list the viewer's place must not jump there.
    focusAfterDelete?.current?.focus({ preventScroll: true });
    return false;
  };
  // Every render, after the DOM is committed (the useRowMenuFocus idiom): the refetch that removes the row is such a render.
  useEffect(() => {
    settleFocus();
  });

  const mutation = useMutation({
    mutationFn,
    onSuccess: async (_result: unknown, row: T) => {
      close();
      pending.current = focusAfterDelete === null ? null : "deleted";
      setTarget(null);
      if (successMessage) showSuccessToast(successMessage);
      await onSuccess(row);
    },
  });

  function requestDelete(row: T) {
    pending.current = null;
    opener.current = takeMenuTrigger();
    setTarget(row);
    mutation.reset();
    open();
  }
  function cancelDelete() {
    if (mutation.isPending) return;
    pending.current = "cancelled";
    close();
    setTarget(null);
    mutation.reset();
  }
  function confirmDelete() {
    if (target) mutation.mutate(target);
  }

  // Mantine reports the end of the exit transition just before the dialog leaves the DOM, and that removal is a commit of Mantine's own
  // component, not of the page, so no render of ours follows it. Look after it, and keep looking for a moment while the focus is still in
  // the leaving dialog: under load the removal can come later than one macrotask, and the focus would otherwise be left on body.
  function onExited() {
    let tries = 0;
    const attempt = () => {
      if (!settleFocus()) return;
      if (++tries < EXIT_RETRIES) window.setTimeout(attempt, EXIT_RETRY_MS);
      // The dialog never let go of the focus: drop the move, so a much later render cannot take a focus the user has put on body by then.
      else pending.current = null;
    };
    window.setTimeout(attempt, 0);
  }

  return { target, opened, requestDelete, cancelDelete, confirmDelete, onExited, mutation };
}
