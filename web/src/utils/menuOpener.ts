let remembered: HTMLElement | null = null;
let expiry: number | undefined;

/**
 * Remembers the kebab (the menu's trigger) of the row menu a click is happening in, for the dialog that click is about to open. A menu item
 * unmounts with its menu, so a dialog opened from it has no opener of its own to give the focus back to; whoever opens the dialog
 * (`useDialogFocus`, `useDeleteConfirm`) `take`s the trigger in the same click.
 *
 * The trigger is resolved from an element INSIDE the menu: Mantine's dropdown is `[role="menu"]` and its `aria-labelledby` is the target's id.
 * The memory expires at the end of the click (a macrotask later), so a menu item that opens no dialog (Move up, a link) can never leave a stale
 * trigger for a dialog a plain button opens later.
 */
export function rememberMenuTrigger(fromElementInsideMenu: Element): void {
  window.clearTimeout(expiry);
  const id = fromElementInsideMenu.closest('[role="menu"]')?.getAttribute("aria-labelledby");
  remembered = id ? document.getElementById(id) : null;
  if (remembered !== null) expiry = window.setTimeout(() => (remembered = null), 0);
}

/** The remembered trigger, once: null when the click was not in a row menu or has ended. */
export function takeMenuTrigger(): HTMLElement | null {
  window.clearTimeout(expiry);
  const trigger = remembered;
  remembered = null;
  return trigger;
}
