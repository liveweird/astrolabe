import { Menu, Text } from "@mantine/core";
import type { TFunction } from "i18next";
import type { TeamMilestone, TeamView } from "../api/teams";
import { barList, type BaselineRow } from "../utils/baselineOverlay";
import { baselineUnscheduledIds, jiraScheduleDates, jiraTrayRowId, jiraTrayRows } from "../utils/jiraBars";
import type { RovingTarget, TimelineBarData, TimelineRowData } from "../utils/timelineModel";
import { AppendedRowName, BaselineRowName } from "./BaselineParts";
import JiraRowMenu from "./JiraRowMenu";
import { OpenProjectItem, OpenProjectMenu } from "./TeamTimelineMenu";

/*
 * The appended rows of the team timeline that carry a dashed Jira bar or a baseline shadow: the pure builders `TeamTimeline` composes (the baseline's
 * removed rows and the tray milestones that Jira dates). Nothing here decides rights: `scheduleOnJira` arrives as `null` where the page is read-only.
 */

/** The estimate with its unit ("12.25 man-days"). */
export const estimateText = (t: TFunction, milestone: TeamMilestone) => t("project.estimateUnit", { count: milestone.estimateMd });

/** What the appended rows need from the timeline: the translator, the view, the optional cells, the tray's Jira bars and the dashed row's item. */
export type AppendedContext = {
  view: TeamView;
  t: TFunction;
  /** The Flags and Slack cells before the operations cell (`milestone` null = a row with nothing of its own). */
  withOptional: (cells: TimelineRowData["cells"], milestone: TeamMilestone | null) => TimelineRowData["cells"];
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
