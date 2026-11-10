import { Menu } from "@mantine/core";
import { IconCalendarEvent, IconCalendarOff, IconExternalLink, IconPin, IconPinnedOff } from "@tabler/icons-react";
import { Link as RouterLink } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { TeamMilestone, TeamView } from "../api/teams";
import type { BaselineRow } from "../utils/baselineOverlay";
import { projectPath } from "../utils/planLinks";
import type { RovingTarget } from "../utils/timelineModel";
import MoveItems from "./MoveItems";
import RowActionsMenu from "./RowActionsMenu";

/** What a milestone row can ask the page to do — the page owns the schedule write path and the order write path. */
export type TeamActions = {
  editSchedule: (milestone: TeamMilestone) => void;
  unschedule: (milestone: TeamMilestone) => void;
  /** "Pin dates" / "Unpin dates" of a scheduled row: a pinned milestone is fixed in the auto-proposal. */
  pin: (milestone: TeamMilestone, pinned: boolean) => void;
  /** The tray's Schedule button: the page chooses the dates (one calendar week from today). */
  schedule: (milestone: TeamMilestone) => void;
  /** Move one place up (-1) or down (+1) in the team's order. */
  move: (milestone: TeamMilestone, delta: -1 | 1) => void;
  moveTo: (milestone: TeamMilestone, edge: "top" | "bottom") => void;
};

/**
 * The row menu of one milestone: the schedule items by the view's `can.schedule`, the four order moves by `can.editOrder` (disabled at
 * the ends of the list; a tray row has no order and gets none), and a link to the milestone's project. `position`/`count` place a
 * timeline row in the order; `trigger` makes the kebab a stop of the timeline's grid. While a proposal is previewing the page is read-only:
 * only the link to the project stays.
 */
export default function MilestoneMenu({
  milestone,
  view,
  actions,
  placement,
  trigger,
  previewing = false,
  proposedRow = false,
}: {
  milestone: TeamMilestone;
  view: TeamView;
  actions: TeamActions;
  previewing?: boolean;
  /** The row a preview appends for a tray milestone: its kebab is named apart from the tray row's own (same milestone, same name). */
  proposedRow?: boolean;
  /** A timeline row's place in the order (0-based index and row count); absent for a tray row. */
  placement?: { index: number; count: number };
  trigger?: RovingTarget;
}) {
  const { t } = useTranslation();
  const { can } = view.team;
  const { name } = milestone;
  const first = placement?.index === 0;
  const last = placement !== undefined && placement.index === placement.count - 1;
  const ordering = can.editOrder && placement !== undefined && !previewing;
  const scheduling = can.schedule && !previewing;
  return (
    <RowActionsMenu label={t(proposedRow ? "teams.proposal.operationsAria" : "common.table.operationsAria", { name })} trigger={trigger}>
      {scheduling && (
        <Menu.Item leftSection={<IconCalendarEvent size={14} />} onClick={() => actions.editSchedule(milestone)} aria-label={t("project.action.editScheduleAria", { name })}>
          {t("project.action.editSchedule")}
        </Menu.Item>
      )}
      {scheduling && milestone.startDate !== null && (
        <Menu.Item leftSection={<IconCalendarOff size={14} />} onClick={() => actions.unschedule(milestone)} aria-label={t("project.action.unscheduleAria", { name })}>
          {t("project.action.unschedule")}
        </Menu.Item>
      )}
      {scheduling && milestone.startDate !== null && (
        <Menu.Item
          leftSection={milestone.pinned ? <IconPinnedOff size={14} /> : <IconPin size={14} />}
          onClick={() => actions.pin(milestone, !milestone.pinned)}
          aria-label={t(milestone.pinned ? "common.action.unpinAria" : "common.action.pinAria", { name })}
        >
          {t(milestone.pinned ? "common.action.unpin" : "common.action.pin")}
        </Menu.Item>
      )}
      {ordering && (
        <>
          <Menu.Divider />
          <MoveItems name={name} scope="teams.view.action" first={first} last={last} onMove={(delta) => actions.move(milestone, delta)} onMoveTo={(edge) => actions.moveTo(milestone, edge)} />
        </>
      )}
      <Menu.Divider />
      <Menu.Item
        component={RouterLink}
        to={projectPath(milestone.projectId)}
        leftSection={<IconExternalLink size={14} />}
        aria-label={t("teams.view.openProjectAria", { name: milestone.projectName })}
      >
        {t("teams.view.action.openProject")}
      </Menu.Item>
    </RowActionsMenu>
  );
}

/** The menu of a baseline row: it holds only the link to the milestone's project (a removed milestone's project may be gone too: the link then lands on its not-found page). */
export function OpenProjectMenu({ row, trigger }: { row: BaselineRow; trigger: RovingTarget }) {
  const { t } = useTranslation();
  return (
    <RowActionsMenu label={t("common.table.operationsAria", { name: row.name })} trigger={trigger}>
      <Menu.Item component={RouterLink} to={projectPath(row.projectId)} leftSection={<IconExternalLink size={14} />}>
        {t("teams.view.action.openProject")}
      </Menu.Item>
    </RowActionsMenu>
  );
}
