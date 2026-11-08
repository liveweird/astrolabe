import type { ReactNode } from "react";
import { Anchor, Text } from "@mantine/core";
import { Link as RouterLink } from "react-router-dom";
import type { TFunction } from "i18next";
import type { DependencyEndpoint } from "../api/dependencies";
import type { ProjectMilestone, ProjectView, UpstreamEntity } from "../api/milestones";
import { barList, baselineBars, newSince, removedRows } from "../utils/baselineOverlay";
import { idleBands } from "../utils/idleGaps";
import { addDays } from "../utils/isoDate";
import { jiraBar, siteUrls, type JiraWindow } from "../utils/jiraBars";
import { projectPath } from "../utils/planLinks";
import { ghostRowId, projectRowId, summaryCritical, upstreamOf } from "../utils/projectDependencies";
import type { BarId, RovingTarget, TimelineBandData, TimelineBarData, TimelineRowData } from "../utils/timelineModel";
import { BaselineRowName } from "./BaselineParts";
import { MilestoneFlags } from "./MilestoneFlags";
import MilestoneMenu, { type MilestoneActions } from "./MilestoneMenu";
import NameCell from "./MilestoneNameCell";
import SlackCell from "./SlackCell";

/*
 * The view -> `TimelineRowData` adapter of the project timeline: the pure builders `ProjectTimeline` composes (the summary row, a milestone row, the
 * baseline's removed rows, a ghost row, the bands). Nothing here decides rights or checks; the flags and the server's `check` do.
 */

/** The estimate with its unit ("12.25 man-days"). */
export const estimateText = (t: TFunction, milestone: ProjectMilestone) => t("project.estimateUnit", { count: milestone.estimateMd });

/** Does the caller have any row action on this milestone? Without one there is no menu (and, in the grid, a plain static cell stays the stop). */
export const hasMenu = ({ can }: ProjectMilestone, canLink: boolean) => can.edit || can.schedule || can.delete || canLink;

/**
 * The target window as a band across every row, and — when the derived span ends after the target — the overrun in the drift tone;
 * then (v0.7) one hatched `idle` band per idle gap the server lists, after them so the hatch is painted over the window's tint.
 */
export function bandsOf(view: ProjectView, t: TFunction): TimelineBandData[] {
  const { targetStart, targetEnd } = view.project;
  const bands: TimelineBandData[] = [];
  if (targetStart !== null && targetEnd !== null) {
    bands.push({ id: "window", start: targetStart, end: targetEnd, label: t("project.windowBand", { start: targetStart, end: targetEnd }), tone: "window" });
    if (view.span !== null && view.drift !== null && view.drift.endDays > 0) {
      bands.push({ id: "drift", start: addDays(targetEnd, 1), end: view.span.end, label: t("project.driftBand", { count: view.drift.endDays }), tone: "drift" });
    }
  }
  return [...bands, ...idleBands(view.idleGaps, t)];
}

/**
 * The critical-path emphasis of one bar (v0.7), applied only while the page's toggle is on AND the entity is critical: the bar's `emphasis`
 * and the ", on the critical path" suffix of its accessible name. Anything else keeps its name and carries no `emphasis` at all.
 */
const emphasized = (t: TFunction, critical: boolean, describe: string): Pick<TimelineBarData, "describe" | "emphasis"> =>
  critical ? { describe: `${describe}, ${t("timeline.bar.critical")}`, emphasis: "critical" } : { describe };

/**
 * The cells of a row with the optional Flags cell (1.3, while some scheduled milestone is linked to Jira) and then the Slack cell (while the toggle is on)
 * before the actions cell (the last one): `null` = that column is not shown, `""` = shown and empty.
 */
const withOptional = (cells: TimelineRowData["cells"], flags: ReactNode | null, slack: ReactNode | null): TimelineRowData["cells"] => [
  ...cells.slice(0, -1),
  ...(flags === null ? [] : [flags]),
  ...(slack === null ? [] : [slack]),
  ...cells.slice(-1),
];

/** The accessible name of an own bar, with the ", N conflicts" suffix when violated links end on it (so a screen-reader user on the bar hears it). */
const withConflicts = (t: TFunction, describe: string, count: number) => (count > 0 ? `${describe}, ${t("project.barConflicts", { count })}` : describe);

/**
 * The summary row: the project itself as a dependency endpoint (its name, its derived span as a hollow bar; no bar while nothing is
 * scheduled). Present only while some link ends on the whole project.
 */
export function summaryRow(view: ProjectView, t: TFunction, conflicts: ReadonlyMap<BarId, number>, criticalPath: boolean, flagsColumn: boolean): TimelineRowData {
  const id = projectRowId(view.project.id);
  const { name } = view.project;
  return {
    id,
    cells: withOptional(
      [
        <Text key="name" component="span" size="sm" truncate>
          <Text span fw={500}>
            {name}
          </Text>
          <Text span c="dimmed">
            {" "}
            {t("project.summaryTag")}
          </Text>
        </Text>,
        "",
        "",
        null,
      ],
      flagsColumn ? "" : null,
      criticalPath ? "" : null,
    ),
    bars:
      view.span === null
        ? []
        : [
            {
              id,
              start: view.span.start,
              end: view.span.end,
              label: name,
              ...emphasized(t, criticalPath && summaryCritical(view), withConflicts(t, t("timeline.bar.summary", { name, start: view.span.start, end: view.span.end }), conflicts.get(id) ?? 0)),
              editable: false,
              tone: "summary",
            },
          ],
  };
}

/**
 * A ghost row: another project's milestone (or another project's span) that a link of this project ends on. Read-only and dimmed;
 * its name is the way to that project's page (a function cell, so the link is the row's one stop). With the critical-path toggle on
 * (`upstream` is then the server's lookup by kind + id) it shows the neighbour's slack and is emphasised when that entity is critical.
 */
export function ghostRow(endpoint: DependencyEndpoint, t: TFunction, upstream: ReadonlyMap<string, UpstreamEntity> | null, flagsColumn: boolean): TimelineRowData {
  const id = ghostRowId(endpoint);
  const start = endpoint.startDate ?? "";
  const end = endpoint.endDate ?? "";
  const text = endpoint.kind === "MILESTONE" ? t("project.ghostName", { project: endpoint.projectName, name: endpoint.name }) : endpoint.name;
  const entry = upstream === null ? undefined : upstreamOf(upstream, endpoint);
  return {
    id,
    cells: withOptional(
      [
        (stop: RovingTarget) => (
          <Anchor component={RouterLink} to={projectPath(endpoint.projectId)} size="sm" c="dimmed" truncate aria-label={t("project.ghostLinkAria", { text, project: endpoint.projectName })} {...stop}>
            {text}
          </Anchor>
        ),
        // dimmed like the name: a ghost row is another project's, read-only
        endpoint.teamName === null ? "" : <Text key="team" component="span" size="sm" c="dimmed">{endpoint.teamName}</Text>,
        "",
        null,
      ],
      flagsColumn ? "" : null,
      upstream === null ? null : <SlackCell key="slack" slackDays={entry?.slackDays ?? null} critical={entry?.critical === true} absent={entry === undefined} />,
    ),
    bars: [
      {
        id,
        start,
        end,
        label: endpoint.name,
        ...emphasized(
          t,
          entry?.critical === true,
          t("timeline.bar.ghost", { label: t("project.ghostSpan", { name: endpoint.name, start, end }), project: endpoint.projectName }),
        ),
        editable: false,
        tone: "ghost",
      },
    ],
  };
}

/** What the milestone and baseline rows need beyond the view: the page's critical-path toggle and whether the Flags column is shown. */
type RowOptions = { criticalPath: boolean; flagsColumn: boolean };

/**
 * One row per scheduled milestone (name, team, estimate, the row menu; one bar, editable only with the milestone's `can.schedule`), each with its
 * baseline shadow bar and, with `jira` (the "Jira dates" toggle on), its dashed Jira bar.
 */
export function milestoneRows(
  view: ProjectView,
  t: TFunction,
  { actions, jira, conflicts, criticalPath, flagsColumn }: RowOptions & { actions: MilestoneActions; jira: JiraWindow | null; conflicts: ReadonlyMap<BarId, number> },
): TimelineRowData[] {
  const canLink = view.project.can.createDependency;
  const sites = siteUrls(view.jiraSites);
  // v0.9: with `?baseline=` the view carries the overlay - a shadow bar per row the baseline had scheduled, a dimmed "(new …)" mark on a milestone it did not know.
  const overlay = view.baseline;
  const shadows = overlay === undefined ? null : baselineBars(overlay, view.scheduled, t);
  const fresh = overlay === undefined ? null : newSince(overlay, view.scheduled);
  return view.scheduled.map((milestone) => ({
    id: milestone.id,
    cells: withOptional(
      [
        <NameCell key="name" milestone={milestone} mark={fresh?.has(milestone.id) === true ? t("timeline.baseline.newMark") : undefined} />,
        milestone.teamName,
        estimateText(t, milestone),
        // A function cell holds its own focusable; with no menu the cell stays a static stop, so the tab stop never lands on a missing element.
        hasMenu(milestone, canLink) ? (stop: RovingTarget) => <MilestoneMenu milestone={milestone} actions={actions} canLink={canLink} trigger={stop} /> : null,
      ],
      flagsColumn ? <MilestoneFlags key="flags" flags={milestone.flags} link={milestone.jira} sites={sites} /> : null,
      criticalPath ? <SlackCell key="slack" slackDays={milestone.slackDays} critical={milestone.critical} /> : null,
    ),
    bars: [
      ...(milestone.startDate !== null && milestone.endDate !== null
        ? [
            {
              id: milestone.id,
              start: milestone.startDate,
              end: milestone.endDate,
              label: milestone.name,
              ...emphasized(
                t,
                criticalPath && milestone.critical,
                withConflicts(
                  t,
                  t("project.barAria", {
                    name: milestone.name,
                    team: milestone.teamName,
                    start: milestone.startDate,
                    end: milestone.endDate,
                    estimate: estimateText(t, milestone),
                  }),
                  conflicts.get(milestone.id) ?? 0,
                ),
              ),
              editable: milestone.can.schedule,
            },
          ]
        : []),
      ...barList(shadows?.get(milestone.id)),
      ...barList(jira === null ? undefined : jiraBar(milestone.id, milestone.name, milestone.jira, milestone.flags, jira, t)),
    ],
  }));
}

/** The baseline's milestones that are gone, and the ones now in the tray that it had scheduled: dimmed rows appended after the current ones, the shadow bar only. */
export function baselineRows(view: ProjectView, t: TFunction, { criticalPath, flagsColumn }: RowOptions): TimelineRowData[] {
  const overlay = view.baseline;
  if (overlay === undefined) return [];
  return removedRows(overlay, view.unscheduled, t).map((row) => ({
    id: row.id,
    cells: withOptional(
      [
        <BaselineRowName key="name" row={row} />,
        <Text key="team" component="span" size="sm" c="dimmed">
          {row.teamName}
        </Text>,
        <Text key="estimate" component="span" size="sm" c="dimmed">
          {t("project.estimateUnit", { count: row.estimateMd })}
        </Text>,
        null,
      ],
      flagsColumn ? "" : null,
      criticalPath ? "" : null,
    ),
    bars: [row.bar],
  }));
}
