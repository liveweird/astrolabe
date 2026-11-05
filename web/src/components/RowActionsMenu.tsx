import { type ReactNode, useCallback, useRef } from "react";
import { ActionIcon, Menu } from "@mantine/core";
import { IconDotsVertical } from "@tabler/icons-react";
import { useMenuTabExit } from "../hooks/useMenuTabExit";
import { rememberMenuTrigger } from "../utils/menuOpener";

// Mantine re-attaches the dropdown's merged ref when the menu starts closing (the node is the same, kept through the exit transition): without
// this memory the callback would pull the focus Escape had just returned to the kebab back into the closing menu, and it would end on `body`.
const seenDropdowns = new WeakSet<HTMLElement>();
/**
 * Mantine's focus trap puts the focus on the first `focusable` descendant of the dropdown, and its test counts a DISABLED item (a `tabindex="-1"`
 * button) as focusable: a menu whose first item is disabled (the first ranked row's "Move up") then leaves the focus on the kebab, outside the menu,
 * where the arrow keys and Escape do nothing. So once the dropdown is mounted the first ENABLED item takes the focus if the trap has not put it
 * anywhere in the menu (`MenuDropdown`'s own ArrowDown picks the same item, by the same selector). Once per dropdown node, per opening.
 */
function focusFirstEnabledItem(dropdown: HTMLDivElement | null): void {
  if (dropdown === null || seenDropdowns.has(dropdown)) return;
  seenDropdowns.add(dropdown);
  window.setTimeout(() => {
    if (!dropdown.isConnected || dropdown.contains(document.activeElement)) return;
    dropdown.querySelector<HTMLElement>("[data-menu-item]:not(:disabled)")?.focus({ preventScroll: true });
  });
}

/**
 * The per-row actions menu (v1.19.0): an icon-only kebab trigger whose accessible name the
 * caller supplies in full ("Operations for {{name}}") — unit tests and the e2e `rowOperation`
 * helper locate rows by that name and read the trigger's `aria-expanded`/`aria-controls`,
 * both of which Mantine's Menu.Target wires. The caller owns the items (`Menu.Item`,
 * `Menu.Divider`); this component owns only the trigger's shape, so every table's kebab is
 * the same control. The cell around it is `Table.Td style={{ width: 1 }} ta="right"`. A click in the menu remembers the kebab for the dialog
 * its item may open (`utils/menuOpener.ts`, `useDialogFocus`); Tab or Shift+Tab closes it and moves on from the kebab (`useMenuTabExit`).
 */
export default function RowActionsMenu({
  label,
  loading,
  trigger,
  onClosed,
  children,
}: {
  label: string;
  loading?: boolean;
  /** Extra attributes for the trigger — a roving-grid cell (the Timeline's) makes the kebab its own tab stop with them. */
  trigger?: { tabIndex: number } & Record<string, string | number>;
  /**
   * Called when the dropdown has FINISHED leaving (its exit transition is over). Mantine keeps the dropdown, and its focus trap, mounted through
   * the transition, so a caller that wants to put the focus somewhere itself (the roadmap's menu button after a move) must do it here: a focus
   * moved earlier is pulled back into the dropdown (onto an item) and lands on `body` when the dropdown unmounts. Opt-in; no other caller sets it.
   */
  onClosed?: () => void;
  children: ReactNode;
}) {
  const tabExit = useMenuTabExit();
  const dropdown = useRef<HTMLDivElement | null>(null);
  const attachDropdown = useCallback((node: HTMLDivElement | null) => {
    dropdown.current = node;
    focusFirstEnabledItem(node);
  }, []);
  // Reopened inside the exit transition, the menu keeps the same node and no mount happens: this opening needs the focus placed as well.
  const refocusReopened = () => {
    if (dropdown.current === null) return;
    seenDropdowns.delete(dropdown.current);
    focusFirstEnabledItem(dropdown.current);
  };
  return (
    <Menu {...tabExit.menu} onOpen={refocusReopened} onExitTransitionEnd={onClosed}>
      <Menu.Target>
        <ActionIcon size="sm" aria-label={label} loading={loading} {...trigger}>
          <IconDotsVertical size={16} />
        </ActionIcon>
      </Menu.Target>
      {/* Capture: runs before the item's own onClick, so a dialog that item opens can take the trigger in the same click (mouse, or Enter on the item). */}
      <Menu.Dropdown ref={attachDropdown} {...tabExit.dropdown} onClickCapture={(event) => rememberMenuTrigger(event.target as Element)}>
        {children}
      </Menu.Dropdown>
    </Menu>
  );
}
