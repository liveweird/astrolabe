import { useEffect, useRef } from "react";
import { isFocusInTransit } from "../utils/focusTransit";
import { menuTriggerOf, takeMenuTrigger } from "../utils/menuOpener";

/** How long after a close the hook keeps the focus safe from the refetch that follows a save. */
const WATCH_AFTER_CLOSE_MS = 5_000;

function focusIsOnBody(): boolean {
  return document.activeElement === null || document.activeElement === document.body;
}

/** The element holding the focus, unless that is `body`, a dialog's own content or a closing menu's item (which is about to unmount). */
function focusedOpener(): HTMLElement | null {
  const active = document.activeElement;
  return active instanceof HTMLElement && active !== document.body && !isFocusInTransit(active) ? active : null;
}

/**
 * A focus that arrives somewhere the user chose: not the opener, not a dialog that was already there when ours closed (ours fading, or one
 * beneath it) and not the opener's own menu. A focus inside a dialog that appeared AFTER the close is another flow taking over (the same row's
 * Delete confirmation, a palette): the watch is over.
 */
function isChoiceAwayFrom(trigger: HTMLElement, target: EventTarget | null, dialogsAtClose: ReadonlySet<Element>): boolean {
  if (!(target instanceof HTMLElement) || target === trigger) return false;
  const dialog = target.closest('[role="dialog"]');
  if (dialog !== null) return !dialogsAtClose.has(dialog);
  return target.closest('[role="menu"]') === null || menuTriggerOf(target) !== trigger;
}

/**
 * Gives the focus back when a dialog closes. Mantine's own return-focus does not cover our dialogs: most mount with `opened` already true
 * (`{editor && <XModal opened ... />}`), so it never records an opener and the focus lands on `body`. The hook records it when `opened` turns
 * true: the kebab, when the dialog came from a row menu (the menu item unmounts with its menu; `RowActionsMenu` remembers the kebab for the
 * length of the click, `utils/menuOpener.ts`), else the element holding the focus (a plain button). A modal's `data-autofocus` is applied later,
 * from a timeout, so the focus is still on the opener here; a React `autoFocus` inside the dialog would already have moved it, and then there is
 * nothing to return to (the modals use `data-autofocus`).
 *
 * Closing puts the focus on the opener at once (the modal's focus trap is released; a fading dialog does not matter). For a few seconds after
 * that the save's refetch cannot lose it: a browser blurs a row React moves in the DOM (a rename that re-sorts it), so a focus on `body` goes back
 * to the opener, and if the opener is gone (a move refetched its row away) to the shell's `#main-content` (the `useFocusMainOnNavigation` target).
 * A focus the user has put on another element after the close is left alone and ends the watch; a focus parked in a closing menu or dialog
 * (`utils/focusTransit.ts`) does not end it: the dropdown unmounts a moment later and the next render finds the focus on `body`. The render is
 * not the only witness: a `focusin` anywhere but the opener, a dialog or the opener's own menu (another row's kebab or menu) ends the watch as
 * it happens, since that row's action may drop the focus to `body` before the next render and must not be answered with the first kebab. The
 * listener is attached whenever the dialog is closed and does nothing while no opener is held (after the watch, or before any dialog opened).
 * A focus inside a `[role="dialog"]` that was NOT in the document when this dialog closed ends the watch too (1.23): another flow has taken over,
 * typically the same row's Delete confirmation within seconds of an edit, whose own focus rule (`useDeleteConfirm`) must find the page as the
 * delete leaves it, not a focus the watch put back on a kebab that is about to go. The dialogs there at the close (ours fading, one beneath it)
 * stay exempt. The hook's order against `useDeleteConfirm` in a component therefore no longer matters.
 *
 * Pass "either is open" for a flow of several dialogs (a confirm followed by a reveal), so the focus returns after the last one.
 *
 * A dialog that opens only after an await (a fetch first) calls the returned `claim(promise)` synchronously in the click: the kebab is taken
 * then, kept while the promise is pending and dropped if it rejects.
 */
export function useDialogFocus(opened: boolean): { claim: <T>(pending: Promise<T>) => Promise<T> } {
  const wasOpened = useRef(false);
  const opener = useRef<HTMLElement | null>(null);
  const claimed = useRef<HTMLElement | null>(null);
  const watchUntil = useRef(0);
  // The dialogs in the document when ours closed: a focus inside one of them is not a choice, inside a later one it is.
  const dialogsAtClose = useRef<ReadonlySet<Element>>(new Set());

  // The watch is over: no opener to look after, and no detached dialog kept until the next close.
  const endWatch = () => {
    opener.current = null;
    dialogsAtClose.current = new Set();
  };

  // Every render, after the DOM is committed: the refetch that moves or removes the opener is such a render.
  useEffect(() => {
    const closing = wasOpened.current && !opened;
    if (opened && !wasOpened.current) {
      opener.current = takeMenuTrigger() ?? focusedOpener() ?? claimed.current;
      claimed.current = null;
    }
    wasOpened.current = opened;
    const trigger = opener.current;
    if (opened || trigger === null) return;
    if (closing) {
      watchUntil.current = Date.now() + WATCH_AFTER_CLOSE_MS;
      dialogsAtClose.current = new Set(document.querySelectorAll('[role="dialog"]'));
    }
    if (Date.now() > watchUntil.current) {
      endWatch();
    } else if (!trigger.isConnected) {
      endWatch();
      if (focusIsOnBody()) document.getElementById("main-content")?.focus({ preventScroll: true });
    } else if (closing || focusIsOnBody()) {
      trigger.focus();
    } else if (document.activeElement !== trigger && !isFocusInTransit(document.activeElement)) {
      // Somewhere the user chose: the watch ends. A focus parked in a closing menu or dialog is in transit and keeps it.
      endWatch();
    }
  });

  // Between the close and the end of the watch the user's own move to another row ends it at once, not at the next render.
  useEffect(() => {
    if (opened) return undefined;
    const onFocusIn = (event: FocusEvent) => {
      const trigger = opener.current;
      if (trigger !== null && isChoiceAwayFrom(trigger, event.target, dialogsAtClose.current)) endWatch();
    };
    document.addEventListener("focusin", onFocusIn);
    return () => document.removeEventListener("focusin", onFocusIn);
  }, [opened]);

  return {
    claim: (pending) => {
      const trigger = takeMenuTrigger();
      claimed.current = trigger;
      return pending.catch((error: unknown) => {
        if (claimed.current === trigger) claimed.current = null;
        throw error;
      });
    },
  };
}
