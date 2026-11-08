import { Menu } from "@mantine/core";
import { IconBrandJira, IconCalendarEvent, IconCalendarOff, IconLink, IconLinkOff, IconPencil, IconTrash } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import type { ProjectMilestone } from "../api/milestones";
import type { RovingTarget } from "../utils/timelineModel";
import DestructiveMenuItem from "./DestructiveMenuItem";
import RowActionsMenu from "./RowActionsMenu";

/** What a milestone row can ask the page to do — the page owns the editors, the delete confirmation and the schedule write path. */
export type MilestoneActions = {
  edit: (milestone: ProjectMilestone) => void;
  editSchedule: (milestone: ProjectMilestone) => void;
  unschedule: (milestone: ProjectMilestone) => void;
  remove: (milestone: ProjectMilestone) => void;
  /** The tray's Schedule button: the page chooses the dates (one calendar week from the later of today and the target start). */
  schedule: (milestone: ProjectMilestone) => void;
  /** "Add dependency…": open the editor with this milestone as the successor (offered only with the project's `can.createDependency`). */
  addDependency: (milestone: ProjectMilestone) => void;
  /** "Link to Jira…" (offered with the milestone's own `can.edit` - the bind's guard is the owner chain, the same arithmetic). Absent = the page offers no Jira link. */
  linkJira?: (milestone: ProjectMilestone) => void;
  /** The milestone's Jira key when it is linked (the view's own `jira` block): the menu then says so instead of offering the link. */
  jiraKeyOf?: (milestone: ProjectMilestone) => string | undefined;
  /** "Unlink from Jira: KEY" for a linked milestone (with its own `can.edit`): the page confirms and deletes the binding. */
  unlinkJira?: (milestone: ProjectMilestone) => void;
};

/**
 * The milestone's Jira item in its row menu, by what the page knows (the view's own `jira` blocks) and the milestone's own `can.edit` (the bind's guard):
 * "Link to Jira…" when it is not linked, "Unlink from Jira: KEY" (the red destructive item, confirmed by the page) when it is, and for a viewer who may
 * not edit only the key as a disabled line - links are 1:1, so a linked milestone is never offered the link.
 */
function JiraLinkItem({ milestone, actions, linkJira }: { milestone: ProjectMilestone; actions: MilestoneActions; linkJira: (milestone: ProjectMilestone) => void }) {
  const { t } = useTranslation();
  const key = actions.jiraKeyOf?.(milestone);
  const { name } = milestone;
  if (key === undefined) {
    return milestone.can.edit ? (
      <Menu.Item leftSection={<IconBrandJira size={14} />} onClick={() => linkJira(milestone)} aria-label={t("deviations.link.actionAria", { name })}>
        {t("deviations.link.action")}
      </Menu.Item>
    ) : null;
  }
  if (!milestone.can.edit || actions.unlinkJira === undefined) {
    return (
      <Menu.Item leftSection={<IconBrandJira size={14} />} disabled aria-label={t("deviations.link.linkedAria", { key, name })}>
        {t("deviations.link.linked", { key })}
      </Menu.Item>
    );
  }
  const unlink = actions.unlinkJira;
  return (
    <DestructiveMenuItem leftSection={<IconLinkOff size={14} />} onClick={() => unlink(milestone)} aria-label={t("deviations.link.unlinkKeyAria", { key, name })}>
      {t("deviations.link.unlinkKey", { key })}
    </DestructiveMenuItem>
  );
}

/**
 * The row menu of one milestone, each item gated by its own flag: Edit and Delete by the owner chain's `can.edit`/`can.delete`,
 * the schedule items by `can.schedule` (the team's manager or an ADMIN). `trigger` makes the kebab a stop of the timeline's grid.
 */
export default function MilestoneMenu({
  milestone,
  actions,
  canLink,
  trigger,
}: {
  milestone: ProjectMilestone;
  actions: MilestoneActions;
  /** The project's `can.createDependency`: a milestone is linked as a SUCCESSOR through the project's chain, not its own flags. */
  canLink: boolean;
  trigger?: RovingTarget;
}) {
  const { t } = useTranslation();
  const { can } = milestone;
  const scheduled = milestone.startDate !== null;
  return (
    <RowActionsMenu label={t("common.table.operationsAria", { name: milestone.name })} trigger={trigger}>
      {can.edit && (
        <Menu.Item leftSection={<IconPencil size={14} />} onClick={() => actions.edit(milestone)} aria-label={t("common.action.editAria", { name: milestone.name })}>
          {t("common.action.edit")}
        </Menu.Item>
      )}
      {actions.linkJira !== undefined && <JiraLinkItem milestone={milestone} actions={actions} linkJira={actions.linkJira} />}
      {can.schedule && (
        <Menu.Item
          leftSection={<IconCalendarEvent size={14} />}
          onClick={() => actions.editSchedule(milestone)}
          aria-label={t("project.action.editScheduleAria", { name: milestone.name })}
        >
          {t("project.action.editSchedule")}
        </Menu.Item>
      )}
      {can.schedule && scheduled && (
        <Menu.Item
          leftSection={<IconCalendarOff size={14} />}
          onClick={() => actions.unschedule(milestone)}
          aria-label={t("project.action.unscheduleAria", { name: milestone.name })}
        >
          {t("project.action.unschedule")}
        </Menu.Item>
      )}
      {canLink && (
        <Menu.Item
          leftSection={<IconLink size={14} />}
          onClick={() => actions.addDependency(milestone)}
          aria-label={t("project.action.addDependencyAria", { name: milestone.name })}
        >
          {t("project.action.addDependency")}
        </Menu.Item>
      )}
      {can.delete && (can.edit || can.schedule || canLink) && <Menu.Divider />}
      {can.delete && (
        <DestructiveMenuItem
          leftSection={<IconTrash size={14} />}
          onClick={() => actions.remove(milestone)}
          aria-label={t("common.action.deleteAria", { name: milestone.name })}
        >
          {t("common.action.delete")}
        </DestructiveMenuItem>
      )}
    </RowActionsMenu>
  );
}
