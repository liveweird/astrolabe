import { useEffect, useRef } from "react";
import { takeMenuTrigger } from "../utils/menuOpener";

/** How long after a close the hook keeps the focus safe from the refetch that follows a save. */
const WATCH_AFTER_CLOSE_MS = 5_000;

function focusIsOnBody(): boolean {
  return document.activeElement === null || document.activeElement === document.body;
}

/** The element holding the focus, unless that is `body`, a dialog's own content or a closing menu's item (which is about to unmount). */
function focusedOpener(): HTMLElement | null {
  const active = document.activeElement;
  return active instanceof HTMLElement && active !== document.body && active.closest('[role="dialog"], [role="menu"]') === null ? active : null;
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
 * A focus the user has put on another element after the close is left alone and ends the watch.
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
    if (closing) watchUntil.current = Date.now() + WATCH_AFTER_CLOSE_MS;
    if (Date.now() > watchUntil.current) {
      opener.current = null;
    } else if (!trigger.isConnected) {
      opener.current = null;
      if (focusIsOnBody()) document.getElementById("main-content")?.focus({ preventScroll: true });
    } else if (closing || focusIsOnBody()) {
      trigger.focus();
    } else if (document.activeElement !== trigger) {
      opener.current = null;
    }
  });

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
