import { type KeyboardEvent, useState } from "react";
import { menuTriggerOf } from "../utils/menuOpener";

const CONTROLS = "input, select, textarea, button, a[href], [tabindex]";

/** Whether a control is a Tab stop (a menu item is `tabindex="-1"`; of a radio group only the checked one is). */
function isTabStop(element: HTMLElement): boolean {
  if (element.tabIndex < 0 || element.matches(":disabled")) return false;
  return !(element instanceof HTMLInputElement && element.type === "radio" && !element.checked);
}

/** Whether another Tab stop sits inside the menu in the direction of travel: there Tab belongs to Mantine's focus trap, which moves among them. */
function hasTabStopBeyond(dropdown: HTMLElement, from: Element, backwards: boolean): boolean {
  const direction = backwards ? Node.DOCUMENT_POSITION_PRECEDING : Node.DOCUMENT_POSITION_FOLLOWING;
  return Array.from(dropdown.querySelectorAll<HTMLElement>(CONTROLS)).some(
    (control) => control !== from && (from.compareDocumentPosition(control) & direction) !== 0 && isTabStop(control),
  );
}

/**
 * Tab (and Shift+Tab) leaves an open menu: the menu closes and the focus moves on from its trigger, as the WAI-ARIA menu pattern says. Mantine's
 * `trapFocus` would otherwise swallow the key (menu items are `tabindex="-1"`, so its `scopeTab` finds nothing tabbable and prevents the default;
 * Escape was the only exit). The hook owns the menu's `opened` state: spread `menu` on `<Menu>` and `dropdown` on `<Menu.Dropdown>`.
 *
 * On Tab the handler stops the event before it reaches the trap's `document` listener (which then never prevents the default), focuses the trigger
 * synchronously and closes the menu; the browser's own Tab default then runs from the trigger, to the next stop after it (Shift+Tab: the one
 * before it). Mantine's focus return finds the focus moved on by the time it looks (10 ms after the close) and leaves it alone.
 *
 * A dropdown with its own tabbable controls (the account menu's theme switch) keeps Tab among them: the key is only taken over when no further
 * Tab stop lies in that direction, so Tab leaves from the last control and Shift+Tab from the first.
 *
 * It is the BUBBLE `onKeyDown`, not `onKeyDownCapture`: `Popover.Dropdown` swaps the capture handler for its Escape-only one while `closeOnEscape` is on.
 */
export function useMenuTabExit() {
  const [opened, setOpened] = useState(false);
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Tab" || event.ctrlKey || event.altKey || event.metaKey) return;
    const target = event.target as Element;
    const trigger = menuTriggerOf(target);
    if (trigger === null || hasTabStopBeyond(event.currentTarget, target, event.shiftKey)) return;
    event.stopPropagation();
    trigger.focus({ preventScroll: true });
    setOpened(false);
  };
  return { menu: { opened, onChange: setOpened }, dropdown: { onKeyDown } };
}
