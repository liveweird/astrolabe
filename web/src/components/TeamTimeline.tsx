import type { ReactNode } from "react";
import { Anchor, Group, Text } from "@mantine/core";
import { Link as RouterLink } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { TeamMilestone, TeamView } from "../api/teams";
import { useHolidays } from "../hooks/useHolidays";
import { barList, baselineBars, newSince, removedRows } from "../utils/baselineOverlay";
import { arrowSpecsFor, conflictsByBarFor, markCriticalArrows } from "../utils/dependencyArrows";
import { idleBands } from "../utils/idleGaps";
import { projectPath } from "../utils/planLinks";
import { proposalBars, proposalRows, type TeamProposalView } from "../utils/scheduleProposal";
import type { BarId, RovingTarget, TimelineBarData, TimelineColumn, TimelineRowData } from "../utils/timelineModel";
import type { TimelineScale, Zoom } from "../utils/timelineScale";
import { jiraTrayNote } from "../utils/flagSentences";
import { jiraBar, siteUrls, type JiraWindow } from "../utils/jiraBars";
import { BaselineRowName } from "./BaselineParts";
import { MilestoneFlags, NameWithFlags } from "./MilestoneFlags";
import SlackCell from "./SlackCell";
import MilestoneMenu, { OpenProjectMenu, type TeamActions } from "./TeamTimelineMenu";
import Timeline from "./Timeline";
import TimelineArrows from "./TimelineArrows";
import TimelineLoadStrip from "./TimelineLoadStrip";
import TimelineRowHandle from "./TimelineRowHandle";
import TimelineUnscheduledTray, { type TrayItem } from "./TimelineUnscheduledTray";

export type { TeamActions } from "./TeamTimelineMenu";

/** The Flags column grows to `FLAGS_WITH_ROLLUP_WIDTH` while a scheduled row shows a Jira roll-up ("5/12 · 34 pt"). */
const FLAGS_WITH_ROLLUP_WIDTH = 210;
const COLUMN_WIDTHS = { name: 220, project: 150, estimate: 120, flags: 130, slack: 130, actions: 56 } as const;

/** The estimate with its unit ("12.25 man-days"). */
const estimateText = (t: TFunction, milestone: TeamMilestone) => t("project.estimateUnit", { count: milestone.estimateMd });

/**
 * The name with the description as dimmed text after it; one line (rows are a fixed height), the cell clips the rest. A row a preview appends is
 * marked "(new)"; `sinceBaseline` (v0.9) marks a milestone the picked baseline did not know; `note` (1.3) is a tray row's "Jira: start to end".
 */
function NameCell({ milestone, isNew = false, sinceBaseline = false, note }: { milestone: TeamMilestone; isNew?: boolean; sinceBaseline?: boolean; note?: string }) {
  const { t } = useTranslation();
  return (
    <Text component="span" size="sm" truncate>
      <Text span fw={500}>
        {milestone.name}
      </Text>
      {isNew && (
        <Text span c="dimmed">
          {" "}
          {t("teams.proposal.newMark")}
        </Text>
      )}
      {sinceBaseline && (
        <Text span c="dimmed">
          {" "}
          {t("timeline.baseline.newMark")}
        </Text>
      )}
      {note !== undefined && (
        <Text span c="dimmed">
          {" "}
          {note}
        </Text>
      )}
      {milestone.description && (
        <Text span c="dimmed">
          {" "}
          {milestone.description}
        </Text>
      )}
    </Text>
  );
}

/** A timeline row's name cell: with `placement` (the viewer may reorder) the row's pointer-only drag handle comes first. */
function RowNameCell({ milestone, placement, sinceBaseline }: { milestone: TeamMilestone; placement: { index: number; count: number } | null; sinceBaseline: boolean }) {
  if (placement === null) return <NameCell milestone={milestone} sinceBaseline={sinceBaseline} />;
  return (
    <Group gap={4} wrap="nowrap" style={{ minWidth: 0 }}>
      <TimelineRowHandle id={milestone.id} label={milestone.name} position={placement.index + 1} count={placement.count} />
      <NameCell milestone={milestone} sinceBaseline={sinceBaseline} />
    </Group>
  );
}

/** The accessible name of a bar, with the ", N conflicts" suffix when violated links end on it (so a screen-reader user on the bar hears it). */
const withConflicts = (t: TFunction, describe: string, count: number) => (count > 0 ? `${describe}, ${t("project.barConflicts", { count })}` : describe);

/** The ", on the critical path" suffix of a critical bar's accessible name (after any ", N conflicts"; the Timeline adds ", read-only" last). */
const withCritical = (t: TFunction, describe: string, critical: boolean) => (critical ? `${describe}, ${t("timeline.bar.critical")}` : describe);

/** The milestone's proposal bar as a list of zero or one bars (to spread into a row). */
const proposalBarOf = (proposed: ReadonlyMap<number, TimelineBarData>, milestone: TeamMilestone): TimelineBarData[] => {
  const bar = proposed.get(milestone.id);
  return bar === undefined ? [] : [bar];
};

/**
 * The team's timeline: one row per scheduled milestone in the view's order (the team's own, or the project rank's by default), the
 * weekly load strip in the sticky header, and the dependency arrows between THIS timeline's rows (an end that is not a row here — a
 * project, an unscheduled or another team's milestone — is simply not drawn; the project's page is where those are read). It must sit
 * inside the page's `TimelineDndContext`. Nothing here decides rights or checks — the view's `can` flags and the server's `check` do.
 *
 * With a `proposal` (v0.8) the timeline PREVIEWS it, read-only: every moved milestone that has a row gets a second, proposal-toned bar
 * beside its current one, a tray milestone the proposal schedules gets a row APPENDED after the scheduled ones (only the proposal bar,
 * "(new)" after its name), the strip shows the proposed load instead, the current bars lose their handles, the row handles are gone and
 * the idle bands (about the current schedule) are not drawn. Arrows stay on the current bars; none ends on a proposal bar.
 *
 * With the view's `baseline` (v0.9, `?baseline=N`) every row the baseline had scheduled gets a thin shadow bar under its bar, a milestone it did not
 * know reads "(new since the baseline)", and the baseline's milestones that are gone from the team (deleted, moved to another team) and the tray
 * milestones it had scheduled are appended as dimmed rows with the shadow bar only (after the scheduled rows, then a preview's rows). It coexists
 * with a proposal preview: three bars in a row, the tones differ.
 *
 * Jira (1.3, all from the view): while some scheduled milestone is linked there is a Flags column (the row's Jira key and its open Jira flags as the roadmap's
 * icons, the sentences as the accessible label), and with `jira` (the page's window, the "Jira dates" toggle on) each linked row gets a dashed shadow bar of the
 * dates Jira holds, beside the baseline's.
 *
 * With `criticalPath` (1.7, the page's toggle; the server's `slackDays`/`critical` per milestone toward ITS OWN project's end and the links' `critical`) a Slack
 * column appears after Flags (the project page's cell), a critical milestone's bar is emphasised (and its accessible name says so) and the critical links' arrows
 * are drawn heavier. Off, none of it is in the DOM.
 */
export default function TeamTimeline({
  view,
  scale,
  onZoomChange,
  today,
  busy,
  actions,
  label,
  proposal,
  toolbar,
  jira,
  criticalPath = false,
}: {
  view: TeamView;
  scale: TimelineScale;
  onZoomChange: (zoom: Zoom) => void;
  today: string;
  busy: boolean;
  actions: TeamActions;
  label: string;
  proposal?: TeamProposalView;
  /** The Timeline's `toolbar` slot: the page's baseline picker and "Jira dates" toggle. */
  toolbar?: ReactNode;
  /** The page's Jira window while the "Jira dates" toggle is on (each linked row's shadow bar), else absent. */
  jira?: JiraWindow | null;
  /** The page's critical-path toggle (1.7): the Slack column, the critical bars' emphasis and the critical arrows. */
  criticalPath?: boolean;
}) {
  const { t } = useTranslation();
  const { holidays, failed: holidaysFailed } = useHolidays();
  const previewing = proposal !== undefined;
  // The Flags column exists while some scheduled milestone is linked to Jira (the view says so: no stored answer, no second request).
  const flagsColumn = view.scheduled.some((milestone) => milestone.jira !== null);
  const flagsWidth = view.scheduled.some((milestone) => milestone.jira?.rollup != null) ? FLAGS_WITH_ROLLUP_WIDTH : COLUMN_WIDTHS.flags;
  const sites = siteUrls(view.jiraSites);
  /**
   * The optional cells go just before the operations cell, Flags then Slack, each only while its column exists; `milestone` null = a row with nothing of
   * its own (empty cells). A tray milestone a preview appends has no slack (the cell renders nothing).
   */
  const withOptional = (cells: TimelineRowData["cells"], milestone: TeamMilestone | null): TimelineRowData["cells"] => {
    if (!flagsColumn && !criticalPath) return cells;
    const flags = milestone === null ? "" : <MilestoneFlags key="flags" flags={milestone.flags} link={milestone.jira} sites={sites} />;
    const slack = milestone === null ? "" : <SlackCell key="slack" slackDays={milestone.slackDays} critical={milestone.critical} />;
    return [...cells.slice(0, -1), ...(flagsColumn ? [flags] : []), ...(criticalPath ? [slack] : []), ...cells.slice(-1)];
  };
  const proposed = proposalBars(proposal?.moves ?? [], t);
  const columns: TimelineColumn[] = [
    { id: "name", header: t("project.column.milestone"), width: COLUMN_WIDTHS.name },
    { id: "project", header: t("teams.view.column.project"), width: COLUMN_WIDTHS.project },
    { id: "estimate", header: t("teams.view.column.estimate"), width: COLUMN_WIDTHS.estimate },
    ...(flagsColumn ? [{ id: "flags", header: t("roadmap.column.flags"), width: flagsWidth }] : []),
    ...(criticalPath ? [{ id: "slack", header: t("project.column.slack"), width: COLUMN_WIDTHS.slack }] : []),
    { id: "actions", header: t("common.table.operations"), width: COLUMN_WIDTHS.actions },
  ];
  const rowIds = new Set<BarId>(view.scheduled.map((milestone) => milestone.id));
  const barOf = (endpoint: { kind: string; id: number }): BarId | null => (endpoint.kind === "MILESTONE" && rowIds.has(endpoint.id) ? endpoint.id : null);
  const conflicts = conflictsByBarFor(view.dependencies, barOf);
  const count = view.scheduled.length;
  const overlay = view.baseline;
  const shadows = overlay === undefined ? null : baselineBars(overlay, view.scheduled, t);
  const fresh = overlay === undefined ? null : newSince(overlay, view.scheduled);
  const rows: TimelineRowData[] = view.scheduled.map((milestone, index) => ({
    id: milestone.id,
    cells: withOptional([
      <RowNameCell key="name" milestone={milestone} placement={view.team.can.editOrder && !previewing ? { index, count } : null} sinceBaseline={fresh?.has(milestone.id) === true} />,
      (stop: RovingTarget) => (
        <Anchor component={RouterLink} to={projectPath(milestone.projectId)} size="sm" truncate title={milestone.projectName} aria-label={t("teams.view.openProjectAria", { name: milestone.projectName })} {...stop}>
          {milestone.projectName}
        </Anchor>
      ),
      estimateText(t, milestone),
      (stop: RovingTarget) => <MilestoneMenu milestone={milestone} view={view} actions={actions} placement={{ index, count }} trigger={stop} previewing={previewing} />,
    ], milestone),
    bars: [
      ...(milestone.startDate !== null && milestone.endDate !== null
        ? [
            {
              id: milestone.id,
              start: milestone.startDate,
              end: milestone.endDate,
              label: milestone.name,
              describe: withCritical(
                t,
                withConflicts(
                  t,
                  t("teams.view.barAria", {
                    name: milestone.name,
                    project: milestone.projectName,
                    start: milestone.startDate,
                    end: milestone.endDate,
                    estimate: estimateText(t, milestone),
                  }),
                  conflicts.get(milestone.id) ?? 0,
                ),
                criticalPath && milestone.critical,
              ),
              ...(criticalPath && milestone.critical ? { emphasis: "critical" as const } : {}),
              editable: view.team.can.schedule && !previewing,
            },
          ]
        : []),
      ...proposalBarOf(proposed, milestone),
      ...barList(shadows?.get(milestone.id)),
      ...barList(jira == null ? undefined : jiraBar(milestone.id, milestone.name, milestone.jira, milestone.flags, jira, t)),
    ],
  }));
  // The baseline's rows (v0.9): gone from the team, or in the tray now though the baseline had them scheduled - dimmed, the shadow bar only.
  for (const row of overlay === undefined ? [] : removedRows(overlay, view.unscheduled, t)) {
    rows.push({
      id: row.id,
      cells: withOptional([
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
        (stop: RovingTarget) => <OpenProjectMenu row={row} trigger={stop} />,
      ], null),
      bars: [row.bar],
    });
  }
  // A preview appends the tray milestones the proposal schedules: only the proposal bar (they have no current one).
  for (const milestone of proposalRows(view, proposal?.moves ?? [])) {
    rows.push({
      id: milestone.id,
      cells: withOptional([
        <NameCell key="name" milestone={milestone} isNew />,
        (stop: RovingTarget) => (
          <Anchor component={RouterLink} to={projectPath(milestone.projectId)} size="sm" truncate title={milestone.projectName} aria-label={t("teams.view.openProjectAria", { name: milestone.projectName })} {...stop}>
            {milestone.projectName}
          </Anchor>
        ),
        estimateText(t, milestone),
        (stop: RovingTarget) => <MilestoneMenu milestone={milestone} view={view} actions={actions} trigger={stop} previewing proposedRow />,
      ], milestone),
      bars: proposalBarOf(proposed, milestone),
    });
  }
  const drawn = arrowSpecsFor(view.dependencies, barOf);
  const arrows = criticalPath ? markCriticalArrows(drawn, view.dependencies) : drawn;
  return (
    <Timeline
      label={label}
      scale={scale}
      onZoomChange={onZoomChange}
      today={today}
      columns={columns}
      rows={rows}
      bands={previewing ? [] : idleBands(view.idleGaps, t)}
      holidays={holidays}
      holidaysFailed={holidaysFailed}
      busy={busy}
      toolbar={toolbar}
      strip={{
        label: previewing ? t("timeline.strip.proposedLabel") : t("teams.view.stripLabel"),
        render: (stripScale) => <TimelineLoadStrip weeks={proposal?.weeks ?? view.weeks} scale={stripScale} />,
      }}
      overlay={arrows.length === 0 ? undefined : (geometry) => <TimelineArrows arrows={arrows} geometry={geometry} />}
    />
  );
}

/** The Unscheduled tray of the team's milestones without dates: drag onto the timeline (pointer) or Schedule (button), inside the same `TimelineDndContext`. */
export function TeamTray({ view, actions, label, previewing = false }: { view: TeamView; actions: TeamActions; label: string; previewing?: boolean }) {
  const { t } = useTranslation();
  const sites = siteUrls(view.jiraSites);
  const items: TrayItem[] = view.unscheduled.map((milestone) => ({
    id: milestone.id,
    label: milestone.name,
    cells: [
      // A tray row has no Flags column: the Jira key and the flag icon sit beside the name and, for a Jira item that has dates the plan item lacks, the note says which.
      <NameWithFlags key="name" flags={milestone.flags} link={milestone.jira} sites={sites}>
        <NameCell milestone={milestone} note={jiraTrayNote(t, milestone.jira, milestone.flags)} />
      </NameWithFlags>,
      <Anchor key="project" component={RouterLink} to={projectPath(milestone.projectId)} size="sm" truncate title={milestone.projectName} aria-label={t("teams.view.openProjectAria", { name: milestone.projectName })}>
        {milestone.projectName}
      </Anchor>,
      estimateText(t, milestone),
    ],
    canSchedule: view.team.can.schedule,
    // While a proposal previews, the page is read-only: the Schedule button is disabled and the row cannot be dragged.
    disabled: previewing,
    actions: <MilestoneMenu milestone={milestone} view={view} actions={actions} previewing={previewing} />,
  }));
  return (
    <TimelineUnscheduledTray
      label={label}
      columns={[t("project.column.milestone"), t("teams.view.column.project"), t("teams.view.column.estimate")]}
      items={items}
      emptyText={t("project.noUnscheduled")}
      onSchedule={(id) => {
        const milestone = view.unscheduled.find((m) => m.id === id);
        if (milestone !== undefined) actions.schedule(milestone);
      }}
    />
  );
}
