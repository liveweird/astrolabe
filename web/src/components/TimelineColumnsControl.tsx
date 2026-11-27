import { Button, Menu } from "@mantine/core";
import { IconChevronDown } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { useMenuTabExit } from "../hooks/useMenuTabExit";
import type { TimelineColumnView } from "../utils/timelineColumns";
import { TOOLBAR_CONTROL_SIZE } from "../utils/timelineModel";

/**
 * The Gantt's "Hide columns" control (`timeline.md` "Hidden columns"), the page's `toolbar` slot: a disclosure button that collapses every column
 * the page offers (and brings them back) joined to a chevron that opens a menu of checkboxes, one per column. The menu shows what is DRAWN, stays
 * open on a tick (several picks in a row) and leaves on Tab like the row menus. While any offered column is not drawn the chevron says how many ("2 hidden",
 * also in its name). Nothing to hide, nothing drawn.
 */
export default function TimelineColumnsControl({ view }: { view: TimelineColumnView }) {
  const { t } = useTranslation();
  const tabExit = useMenuTabExit();
  if (view.offered.length === 0) return null;
  const drawn = view.offered.filter((column) => !view.hidden.has(column.id)).map((column) => column.id);
  const hiddenCount = view.offered.length - drawn.length;
  const hiddenText = hiddenCount > 0 ? t("timeline.columns.hiddenCount", { count: hiddenCount }) : null;
  const chooseLabel = hiddenCount > 0 ? t("timeline.columns.chooseHidden", { count: hiddenCount }) : t("timeline.columns.choose");
  return (
    <Button.Group aria-label={t("timeline.columns.aria")}>
      <Button size={TOOLBAR_CONTROL_SIZE} variant="default" aria-expanded={!view.allHidden} onClick={view.toggleAll}>
        {view.allHidden ? t("timeline.columns.show") : t("timeline.columns.hide")}
      </Button>
      <Menu {...tabExit.menu}>
        <Menu.Target>
          <Button size={TOOLBAR_CONTROL_SIZE} variant="default" aria-label={chooseLabel} leftSection={hiddenText}>
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
