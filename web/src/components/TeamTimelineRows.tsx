import type { ReactNode } from "react";
import { Anchor, Group, Menu, Text } from "@mantine/core";
import { Link as RouterLink } from "react-router-dom";
import type { TFunction } from "i18next";
import type { TeamChainMember, TeamCriticalChain, TeamMilestone, TeamView } from "../api/teams";
import { barList, type BaselineRow } from "../utils/baselineOverlay";
import { baselineUnscheduledIds, jiraScheduleDates, jiraTrayRowId, jiraTrayRows } from "../utils/jiraBars";
import { projectPath } from "../utils/planLinks";
import { ghostRowId } from "../utils/dependencyArrows";
import { orderedMembers } from "../utils/teamChain";
import { teamTint, type TeamColour } from "../utils/teamColours";
import { teamPath } from "../utils/teamLinks";
import type { RovingTarget, TimelineBarData, TimelineRowData } from "../utils/timelineModel";
import { AppendedRowName, BaselineRowName } from "./BaselineParts";
import JiraRowMenu from "./JiraRowMenu";
import SlackCell from "./SlackCell";
import { OpenProjectItem, OpenProjectMenu } from "./TeamTimelineMenu";

/*
 * The appended rows of the team timeline that carry a dashed Jira bar or a baseline shadow: the pure builders `TeamTimeline` composes (the baseline's
 * removed rows and the tray milestones that Jira dates) - and, after the team's own rows, the critical chain's ghost rows (1.27). Nothing here decides
 * rights: `scheduleOnJira` arrives as `null` where the page is read-only.
 */

/** The estimate with its unit ("12.25 man-days"). */
export const estimateText = (t: TFunction, milestone: TeamMilestone) => t("project.estimateUnit", { count: milestone.estimateMd });

/** What the appended rows need from the timeline: the translator, the view, the optional cells, the tray's Jira bars and the dashed row's item. */
export type AppendedContext = {
  view: TeamView;
  t: TFunction;
  /** The Flags and Slack cells before the operations cell (`milestone` null = a row with nothing of its own; `slack` = the Slack cell of such a row). */
  withOptional: (cells: TimelineRowData["cells"], milestone: TeamMilestone | null, slack?: ReactNode) => TimelineRowData["cells"];
  trayBars: ReadonlyMap<number, TimelineBarData>;
  /** "Schedule on Jira's dates" (1.17), or `null` where it is not offered: the team's `can.schedule` is off or a proposal previews. */
  scheduleOnJira: ((milestone: TeamMilestone) => void) | null;
};

/**
 * The actions cell of a row that carries a milestone's dashed Jira bar: "Schedule on Jira's dates" (then a divider and "Open project") while the page
 * offers it and Jira's two dates are a usable pair; else 1.16's menu, "Open project" only.
 */
function jiraBarMenu(row: Pick<BaselineRow, "name" | "projectId">, milestone: TeamMilestone | undefined, { scheduleOnJira }: AppendedContext) {
  const dates = milestone === undefined || scheduleOnJira === null ? null : jiraScheduleDates(milestone.jira);
  return (stop: RovingTarget) =>
    milestone === undefined || scheduleOnJira === null || dates === null ? (
      <OpenProjectMenu row={row} trigger={stop} />
    ) : (
      <JiraRowMenu name={row.name} start={dates.start} end={dates.end} onSchedule={() => scheduleOnJira(milestone)} trigger={stop}>
        <Menu.Divider />
        <OpenProjectItem projectId={row.projectId} />
      </JiraRowMenu>
    );
}

/**
 * The baseline's rows (`appended`, from `removedRows`): gone from the team, or in the tray now though the baseline had them scheduled - dimmed, the
 * shadow bar only (and, on an "unscheduled" row whose milestone Jira dates, that milestone's Jira bar, 1.16, with the Jira row's menu, 1.17).
 */
export function baselineAppendedRows(appended: readonly BaselineRow[], ctx: AppendedContext): TimelineRowData[] {
  const { view, t, withOptional, trayBars } = ctx;
  return appended.map((row) => {
    const jiraBarRow = row.reason === "unscheduled" && trayBars.has(row.milestoneId);
    return {
      id: row.id,
      cells: withOptional(
        [
          <BaselineRowName key="name" row={row} />,
          row.projectName === null ? (
            ""
          ) : (
            <Text key="project" component="span" size="sm" c="dimmed" truncate title={row.projectName}>
              {row.projectName}
            </Text>
          ),
          <Text key="estimate" component="span" size="sm" c="dimmed">
            {t("project.estimateUnit", { count: row.estimateMd })}
          </Text>,
          jiraBarRow ? jiraBarMenu(row, view.unscheduled.find((m) => m.id === row.milestoneId), ctx) : (stop: RovingTarget) => <OpenProjectMenu row={row} trigger={stop} />,
        ],
        null,
      ),
      bars: [row.bar, ...barList(jiraBarRow ? trayBars.get(row.milestoneId) : undefined)],
    };
  });
}

/**
 * The tray milestones that Jira dates and the baseline did not append (1.16): dimmed, the dashed Jira bar only; before the preview's rows. Their menu is
 * "Schedule on Jira's dates" for whoever may schedule the team's milestones (1.17).
 */
export function jiraTrayAppendedRows(appended: readonly BaselineRow[], ctx: AppendedContext): TimelineRowData[] {
  const { view, t, withOptional, trayBars } = ctx;
  return jiraTrayRows(view.unscheduled, trayBars, baselineUnscheduledIds(appended)).map((milestone) => ({
    id: jiraTrayRowId(milestone.id),
    cells: withOptional(
      [
        <AppendedRowName key="name" name={milestone.name} mark={t("timeline.jiraUnscheduledMark")} />,
        <Text key="project" component="span" size="sm" c="dimmed" truncate title={milestone.projectName}>
          {milestone.projectName}
        </Text>,
        <Text key="estimate" component="span" size="sm" c="dimmed">
          {estimateText(t, milestone)}
        </Text>,
        jiraBarMenu(milestone, milestone, ctx),
      ],
      null,
    ),
    bars: barList(trayBars.get(milestone.id)),
  }));
}

/**
 * The critical chain's ghost rows (1.27): another team's milestone, or a whole project a chain link names, that lies on the chain through this team's
 * work - read-only (no menu, no handle, no estimate), dimmed, one gray bar that says it is on the chain, "0 critical path" in the Slack column. The way on is the
 * member's team (a link after its name; "Project X" has none) and its project; ids are the project page's ghost ids (`ghostRowId`). `projectNames` names the
 * team's projects for the bar's "on the critical chain of"; a milestone member's bar takes its own team's colour from `colours` (1.29; a project member, or a team the
 * lookup lacks, stays neutral gray; the team's name is in the same row).
 */
export function chainGhostRows(
  chain: TeamCriticalChain,
  { t, withOptional, projectNames, colours }: Pick<AppendedContext, "t" | "withOptional"> & { projectNames: ReadonlyMap<number, string>; colours: ReadonlyMap<number, TeamColour> },
): TimelineRowData[] {
  const slack = <SlackCell key="slack" slackDays={0} critical />;
  const nameCell = (member: TeamChainMember): TimelineRowData["cells"][number] => {
    if (member.kind === "PROJECT" || member.teamId === null || member.teamName === null) {
      return (
        <Text key="name" component="span" size="sm" c="dimmed" truncate>
          {member.kind === "PROJECT" ? t("project.dependency.wholeProject", { name: member.name }) : member.name}
        </Text>
      );
    }
    const { teamId, teamName } = member;
    return (stop: RovingTarget) => (
      <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
        <Text component="span" size="sm" c="dimmed" truncate>
          {member.name}
        </Text>
        <Anchor component={RouterLink} to={teamPath(teamId)} size="sm" c="dimmed" truncate aria-label={t("teams.openAria", { name: teamName })} {...stop}>
          {teamName}
        </Anchor>
      </Group>
    );
  };
  return orderedMembers(chain).map((member) => {
    const id = ghostRowId(member);
    const chains = member.chainOf.flatMap((projectId) => {
      const name = projectNames.get(projectId);
      return name === undefined ? [] : [name];
    }).join(", ");
    const named = chains === "" ? t("teams.view.chain.ownProjects") : chains;
    const describe =
      member.kind === "PROJECT"
        ? t("teams.view.ghostProjectBarAria", { name: member.name, start: member.startDate, end: member.endDate, chains: named })
        : t("teams.view.ghostBarAria", { name: member.name, team: member.teamName ?? "", project: member.projectName, start: member.startDate, end: member.endDate, chains: named });
    return {
      id,
      cells: withOptional(
        [
          nameCell(member),
          (stop: RovingTarget) => (
            <Anchor component={RouterLink} to={projectPath(member.projectId)} size="sm" c="dimmed" truncate title={member.projectName} aria-label={t("teams.view.openProjectAria", { name: member.projectName })} {...stop}>
              {member.projectName}
            </Anchor>
          ),
          "",
          null,
        ],
        null,
        slack,
      ),
      bars: [{ id, start: member.startDate, end: member.endDate, label: member.name, describe, editable: false, tone: "ghost", emphasis: "critical", ...teamTint(colours, member.teamId) }],
    };
  });
}
