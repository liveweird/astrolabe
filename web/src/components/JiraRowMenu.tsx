import type { ComponentProps, ReactNode } from "react";
import { Menu } from "@mantine/core";
import { IconCalendarEvent } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import RowActionsMenu from "./RowActionsMenu";

/**
 * The menu of a tray milestone's dashed Jira row (1.17): one item, "Schedule on Jira's dates", which asks the page to write the two dates Jira holds
 * through its one schedule write path. The kebab is named apart ("... (dates from Jira)") from the tray row's own, which carries the same milestone name.
 * The caller decides who is offered it (the view's `can.schedule`); `children` are whatever the page adds after the item (the team page's divider and
 * "Open project").
 */
export default function JiraRowMenu({
  name,
  start,
  end,
  onSchedule,
  trigger,
  children,
}: {
  name: string;
  /** Jira's REAL dates, shown in the item's accessible name. */
  start: string;
  end: string;
  onSchedule: () => void;
  /** The grid cell's roving stop: the kebab is its own tab stop. */
  trigger: ComponentProps<typeof RowActionsMenu>["trigger"];
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <RowActionsMenu label={t("timeline.jiraRow.operationsAria", { name })} trigger={trigger}>
      <Menu.Item leftSection={<IconCalendarEvent size={14} />} onClick={onSchedule} aria-label={t("timeline.jiraRow.scheduleAria", { name, start, end })}>
        {t("timeline.jiraRow.schedule")}
      </Menu.Item>
      {children}
    </RowActionsMenu>
  );
}
