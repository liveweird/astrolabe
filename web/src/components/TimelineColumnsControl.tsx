import { Button, Menu } from "@mantine/core";
import { IconChevronDown } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { useMenuTabExit } from "../hooks/useMenuTabExit";
import type { TimelineColumnView } from "../utils/timelineColumns";

/**
 * The Gantt's "Hide columns" control (`timeline.md` "Hidden columns"), the page's `toolbar` slot: a disclosure button that collapses every column
 * the page offers (and brings them back) joined to a chevron that opens a menu of checkboxes, one per column. The menu shows what is DRAWN, stays
 * open on a tick (several picks in a row) and leaves on Tab like the row menus. Nothing to hide, nothing drawn.
 */
export default function TimelineColumnsControl({ view }: { view: TimelineColumnView }) {
  const { t } = useTranslation();
  const tabExit = useMenuTabExit();
  if (view.offered.length === 0) return null;
  const drawn = view.offered.filter((column) => !view.hidden.has(column.id)).map((column) => column.id);
  return (
    <Button.Group aria-label={t("timeline.columns.aria")}>
      <Button size="compact-sm" variant="default" aria-expanded={!view.allHidden} onClick={view.toggleAll}>
        {view.allHidden ? t("timeline.columns.show") : t("timeline.columns.hide")}
      </Button>
      <Menu {...tabExit.menu}>
        <Menu.Target>
          <Button size="compact-sm" variant="default" aria-label={t("timeline.columns.choose")}>
            <IconChevronDown size={14} />
          </Button>
        </Menu.Target>
        <Menu.Dropdown {...tabExit.dropdown}>
          <Menu.CheckboxGroup value={drawn} onChange={view.setShown}>
            {view.offered.map((column) => (
              <Menu.CheckboxItem key={column.id} value={column.id}>
                {column.header}
              </Menu.CheckboxItem>
            ))}
          </Menu.CheckboxGroup>
        </Menu.Dropdown>
      </Menu>
    </Button.Group>
  );
}
