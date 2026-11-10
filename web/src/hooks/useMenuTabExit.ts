import { type KeyboardEvent, useState } from "react";
import { menuTriggerOf } from "../utils/menuOpener";

/**
 * Tab (and Shift+Tab) leaves an open menu: the menu closes and the focus moves on from its trigger, as the WAI-ARIA menu pattern says. Mantine's
 * `trapFocus` would otherwise swallow the key (menu items are `tabindex="-1"`, so its `scopeTab` finds nothing tabbable and prevents the default;
 * Escape was the only exit). The hook owns the menu's `opened` state: spread `menu` on `<Menu>` and `dropdown` on `<Menu.Dropdown>`.
 *
 * On Tab the handler stops the event before it reaches the trap's `document` listener (which then never prevents the default), focuses the trigger
 * synchronously and closes the menu; the browser's own Tab default then runs from the trigger, to the next stop after it (Shift+Tab: the one
 * before it). Mantine's focus return finds the focus moved on by the time it looks (10 ms after the close) and leaves it alone.
 *
 * Every menu is items only (no Tab stop of its own; the account menu's theme choice is items since its radiogroup failed axe inside `role="menu"`),
 * so Tab leaves from any item. A menu that ever needs its own tabbable controls must keep Tab among them first.
 *
 * It is the BUBBLE `onKeyDown`, not `onKeyDownCapture`: `Popover.Dropdown` swaps the capture handler for its Escape-only one while `closeOnEscape` is on.
 */
export function useMenuTabExit() {
  const [opened, setOpened] = useState(false);
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Tab" || event.ctrlKey || event.altKey || event.metaKey) return;
    const target = event.target as Element;
    const trigger = menuTriggerOf(target);
    if (trigger === null) return;
    event.stopPropagation();
    trigger.focus({ preventScroll: true });
    setOpened(false);
  };
  return { menu: { opened, onChange: setOpened }, dropdown: { onKeyDown } };
}
