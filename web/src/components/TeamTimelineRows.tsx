import type { ReactNode } from "react";
import { Group, Menu, Text } from "@mantine/core";
import type { TFunction } from "i18next";
import type { TeamChainMember, TeamCriticalChain, TeamMilestone, TeamView } from "../api/teams";
import { barList, type BaselineRow } from "../utils/baselineOverlay";
import { baselineUnscheduledIds, jiraScheduleDates, jiraTrayRowId, jiraTrayRows } from "../utils/jiraBars";
import { ghostRowId } from "../utils/dependencyArrows";
import { orderedMembers } from "../utils/teamChain";
import type { RunPreviewEntry, TeamRunPreview } from "../utils/teamRunPreview";
import { teamTint, type TeamColour } from "../utils/teamColours";
import type { RovingTarget, TimelineBarData, TimelineRowData } from "../utils/timelineModel";
import { BaselineRowName } from "./BaselineParts";
import JiraRowMenu from "./JiraRowMenu";
import SlackCell from "./SlackCell";
import { OpenMilestoneMenu, OpenProjectItem, OpenProjectMenu } from "./TeamTimelineMenu";
import EntityLink from "./EntityLink";

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
        // A tray milestone is a live one: its name and its project lead to their pages (the baseline's rows above are frozen and stay text).
        (stop: RovingTarget) => (
          <Text component="span" size="sm" c="dimmed" truncate>
            <EntityLink entity={{ kind: "milestone", id: milestone.id, projectId: milestone.projectId }} name={milestone.name} c="dimmed" stop={stop} /> {t("timeline.jiraUnscheduledMark")}
          </Text>
        ),
        (stop: RovingTarget) => (
          <EntityLink entity={{ kind: "project", id: milestone.projectId }} name={milestone.projectName} size="sm" c="dimmed" truncate title={milestone.projectName} stop={stop} />
        ),
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

/** What a ghost row's name and menu cells need of its milestone or project: the chain's members and the run preview's entries both have it. */
type GhostEnd = Pick<TeamChainMember, "kind" | "id" | "name" | "projectId" | "teamId" | "teamName">;

/** A ghost row's name cell: a milestone's name (its link is the pointer's) and its team (the cell's one stop, the way on); a whole project's is plain text. */
function ghostNameCell(member: GhostEnd, t: TFunction): TimelineRowData["cells"][number] {
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
      {/* The cell's one stop is the team (the way on); the milestone's link is the pointer's, its keyboard path is the row menu's "Open milestone" (D4). */}
      <EntityLink entity={{ kind: "milestone", id: member.id, projectId: member.projectId }} name={member.name} size="sm" c="dimmed" truncate secondary />
      <EntityLink entity={{ kind: "team", id: teamId }} name={teamName} size="sm" c="dimmed" truncate stop={stop} />
    </Group>
  );
}

/** A milestone member's menu is its way to the milestone; a whole project's is its way to the project (the Project cell, now hideable, was the only link: "Hidden columns"). */
function ghostMenu(member: GhostEnd & { projectName: string }): TimelineRowData["cells"][number] {
  if (member.kind === "PROJECT") return (stop: RovingTarget) => <OpenProjectMenu row={{ name: member.name, projectId: member.projectId }} trigger={stop} />;
  if (member.teamId === null || member.teamName === null) return null;
  return (stop: RovingTarget) => <OpenMilestoneMenu name={member.name} projectId={member.projectId} id={member.id} trigger={stop} />;
}

/**
 * The critical chain's ghost rows (1.27): another team's milestone, or a whole project a chain link names, that lies on the chain through this team's
 * work - read-only (no handle, no estimate; a milestone's menu holds only "Open milestone", a whole project's only "Open project"), dimmed, one gray bar that says it is on the chain, "0 critical path" in the Slack column. The way on is the
 * member's team (a link after its name; "Project X" has none, so its row menu is its way on), its project and the milestone itself (the name's link, pointer only); ids are the project page's ghost ids (`ghostRowId`). `projectNames` names the
 * team's projects for the bar's "on the critical chain of"; a milestone member's bar takes its own team's colour from `colours` (1.29; a project member, or a team the
 * lookup lacks, stays neutral gray; the team's name is in the same row).
 */
export function chainGhostRows(
  chain: TeamCriticalChain,
  { t, withOptional, projectNames, colours, dashed }: Pick<AppendedContext, "t" | "withOptional"> & { projectNames: ReadonlyMap<number, string>; colours: ReadonlyMap<number, TeamColour>; dashed?: ReadonlyMap<string, TimelineBarData> },
): TimelineRowData[] {
  const slack = <SlackCell key="slack" slackDays={0} critical />;
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
          ghostNameCell(member, t),
          (stop: RovingTarget) => (
            <EntityLink entity={{ kind: "project", id: member.projectId }} name={member.projectName} size="sm" c="dimmed" truncate title={member.projectName} stop={stop} />
          ),
          "",
          ghostMenu(member),
        ],
        null,
        slack,
      ),
      bars: [{ id, start: member.startDate, end: member.endDate, label: member.name, describe, editable: false, tone: "ghost", emphasis: "critical", ...teamTint(colours, member.teamId) }, ...barList(dashed?.get(id))],
    };
  });
}

/**
 * The dashed bars of a cross-team run planned from this page (1.38), by row id: another team's milestone, or a whole project, that the run moves, drawn where its row is
 * (a critical-chain ghost row takes it as a second bar instead of getting a second row). Only the entries that keep a dash (`drawn`: they follow the ticks).
 */
export function runDashedBars(preview: TeamRunPreview, t: TFunction): Map<string, TimelineBarData> {
  const bars = new Map<string, TimelineBarData>();
  for (const entry of preview.byRow.values()) {
    if (!entry.drawn) continue;
    bars.set(entry.rowId, {
      id: entry.kind === "MILESTONE" ? `proposal:${entry.id}` : `proposal:p:${entry.id}`,
      start: entry.proposed.start,
      end: entry.proposed.end,
      label: entry.name,
      describe: t("timeline.bar.proposal", { name: entry.name, start: entry.proposed.start, end: entry.proposed.end }),
      editable: false,
      tone: "proposal",
    });
  }
  return bars;
}

/**
 * The rows a run planned from this page adds (1.38, `entries` = `TeamRunPreview.rows`): another team's milestone, or a whole project, that a link of this team's work names and the run
 * moves - dimmed and read-only like the chain's ghost rows (the same name, project and menu cells; no Slack figure): the ghost bar is where it stands now (none while it has no dates), the
 * dashed bar (`dashed`, `runDashedBars`) where the run would put it. A milestone's bar takes its team's colour from `colours`.
 */
export function runPreviewRows(
  entries: readonly RunPreviewEntry[],
  { t, withOptional, colours, dashed }: Pick<AppendedContext, "t" | "withOptional"> & { colours: ReadonlyMap<number, TeamColour>; dashed: ReadonlyMap<string, TimelineBarData> },
): TimelineRowData[] {
  return entries.map((entry) => {
    const now = entry.current;
    const describe =
      now === null
        ? ""
        : entry.kind === "PROJECT"
          ? t("teams.run.ghostProjectBarAria", { name: entry.name, start: now.start, end: now.end })
          : t("teams.run.ghostBarAria", { name: entry.name, team: entry.teamName ?? "", project: entry.projectName, start: now.start, end: now.end });
    return {
      id: entry.rowId,
      cells: withOptional(
        [
          ghostNameCell(entry, t),
          (stop: RovingTarget) => (
            <EntityLink entity={{ kind: "project", id: entry.projectId }} name={entry.projectName} size="sm" c="dimmed" truncate title={entry.projectName} stop={stop} />
          ),
          "",
          ghostMenu(entry),
        ],
        null,
      ),
      bars: [
        ...(now === null ? [] : [{ id: entry.rowId, start: now.start, end: now.end, label: entry.name, describe, editable: false, tone: "ghost" as const, ...teamTint(colours, entry.teamId) }]),
        ...barList(dashed.get(entry.rowId)),
      ],
    };
  });
}
