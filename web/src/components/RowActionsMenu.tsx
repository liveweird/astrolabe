import { type ReactNode } from "react";
import { ActionIcon, Menu } from "@mantine/core";
import { IconDotsVertical } from "@tabler/icons-react";

/**
 * The per-row actions menu (v1.19.0): an icon-only kebab trigger whose accessible name the
 * caller supplies in full ("Operations for {{name}}") — unit tests and the e2e `rowOperation`
 * helper locate rows by that name and read the trigger's `aria-expanded`/`aria-controls`,
 * both of which Mantine's Menu.Target wires. The caller owns the items (`Menu.Item`,
 * `Menu.Divider`); this component owns only the trigger's shape, so every table's kebab is
 * the same control. The cell around it is `Table.Td style={{ width: 1 }} ta="right"`.
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
   * moved earlier is pulled back into the dropdown's sentinel and lands on `body` when the dropdown unmounts. Opt-in; no other caller sets it.
   */
  onClosed?: () => void;
  children: ReactNode;
}) {
  return (
    <Menu onExitTransitionEnd={onClosed}>
      <Menu.Target>
        <ActionIcon size="sm" aria-label={label} loading={loading} {...trigger}>
          <IconDotsVertical size={16} />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>{children}</Menu.Dropdown>
    </Menu>
  );
}
