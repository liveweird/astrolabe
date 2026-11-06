import type { ReactNode } from "react";
import { Anchor, Group, Menu, Text } from "@mantine/core";
import { IconArrowBarDown, IconArrowBarUp, IconArrowDown, IconArrowUp, IconCalendarEvent, IconCalendarOff, IconExternalLink } from "@tabler/icons-react";
import { Link as RouterLink } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { TeamMilestone, TeamView } from "../api/teams";
import { useHolidays } from "../hooks/useHolidays";
import { barList, baselineBars, newSince, removedRows, type BaselineRow } from "../utils/baselineOverlay";
import { arrowSpecsFor, conflictsByBarFor } from "../utils/dependencyArrows";
import { idleBands } from "../utils/idleGaps";
import { projectPath } from "../utils/planLinks";
import { proposalBars, proposalRows, type TeamProposalView } from "../utils/scheduleProposal";
import type { BarId, RovingTarget, TimelineBarData, TimelineColumn, TimelineRowData } from "../utils/timelineModel";
import type { TimelineScale, Zoom } from "../utils/timelineScale";
import { markKey, type JiraMark } from "../utils/jiraMarks";
import { BaselineRowName } from "./BaselineParts";
import { JiraRowMark } from "./JiraChips";
import RowActionsMenu from "./RowActionsMenu";
import Timeline from "./Timeline";
import TimelineArrows from "./TimelineArrows";
import TimelineLoadStrip from "./TimelineLoadStrip";
import TimelineRowHandle from "./TimelineRowHandle";
import TimelineUnscheduledTray, { type TrayItem } from "./TimelineUnscheduledTray";

/** What a milestone row can ask the page to do — the page owns the schedule write path and the order write path. */
export type TeamActions = {
  editSchedule: (milestone: TeamMilestone) => void;
  unschedule: (milestone: TeamMilestone) => void;
  /** The tray's Schedule button: the page chooses the dates (one calendar week from today). */
  schedule: (milestone: TeamMilestone) => void;
  /** Move one place up (-1) or down (+1) in the team's order. */
  move: (milestone: TeamMilestone, delta: -1 | 1) => void;
  moveTo: (milestone: TeamMilestone, edge: "top" | "bottom") => void;
};

const COLUMN_WIDTHS = { name: 220, project: 150, estimate: 120, jira: 130, actions: 56 } as const;

/** The estimate with its unit ("12.25 man-days"). */
const estimateText = (t: TFunction, milestone: TeamMilestone) => t("project.estimateUnit", { count: milestone.estimateMd });

/**
 * The name with the description as dimmed text after it; one line (rows are a fixed height), the cell clips the rest. A row a preview appends is
 * marked "(new)"; `sinceBaseline` (v0.9) marks a milestone the picked baseline did not know.
 */
function NameCell({ milestone, isNew = false, sinceBaseline = false }: { milestone: TeamMilestone; isNew?: boolean; sinceBaseline?: boolean }) {
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

/**
 * The row menu of one milestone: the schedule items by the view's `can.schedule`, the four order moves by `can.editOrder` (disabled at
 * the ends of the list; a tray row has no order and gets none), and a link to the milestone's project. `position`/`count` place a
 * timeline row in the order; `trigger` makes the kebab a stop of the timeline's grid. While a proposal is previewing the page is read-only:
 * only the link to the project stays.
 */
function MilestoneMenu({
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
      {ordering && (
        <>
          <Menu.Divider />
          <Menu.Item leftSection={<IconArrowUp size={14} />} disabled={first} onClick={() => actions.move(milestone, -1)} aria-label={t("teams.view.action.moveUpAria", { name })}>
            {t("teams.view.action.moveUp")}
          </Menu.Item>
          <Menu.Item leftSection={<IconArrowDown size={14} />} disabled={last} onClick={() => actions.move(milestone, 1)} aria-label={t("teams.view.action.moveDownAria", { name })}>
            {t("teams.view.action.moveDown")}
          </Menu.Item>
          <Menu.Item leftSection={<IconArrowBarUp size={14} />} disabled={first} onClick={() => actions.moveTo(milestone, "top")} aria-label={t("teams.view.action.moveTopAria", { name })}>
            {t("teams.view.action.moveTop")}
          </Menu.Item>
          <Menu.Item leftSection={<IconArrowBarDown size={14} />} disabled={last} onClick={() => actions.moveTo(milestone, "bottom")} aria-label={t("teams.view.action.moveBottomAria", { name })}>
            {t("teams.view.action.moveBottom")}
          </Menu.Item>
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
function OpenProjectMenu({ row, trigger }: { row: BaselineRow; trigger: RovingTarget }) {
  const { t } = useTranslation();
  return (
    <RowActionsMenu label={t("common.table.operationsAria", { name: row.name })} trigger={trigger}>
      <Menu.Item component={RouterLink} to={projectPath(row.projectId)} leftSection={<IconExternalLink size={14} />}>
        {t("teams.view.action.openProject")}
      </Menu.Item>
    </RowActionsMenu>
  );
}

/** The accessible name of a bar, with the ", N conflicts" suffix when violated links end on it (so a screen-reader user on the bar hears it). */
const withConflicts = (t: TFunction, describe: string, count: number) => (count > 0 ? `${describe}, ${t("project.barConflicts", { count })}` : describe);

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
  jiraColumn,
}: {
  view: TeamView;
  scale: TimelineScale;
  onZoomChange: (zoom: Zoom) => void;
  today: string;
  busy: boolean;
  actions: TeamActions;
  label: string;
  proposal?: TeamProposalView;
  /** The Timeline's `toolbar` slot: the page's baseline picker. */
  toolbar?: ReactNode;
  /** The team's Jira links by `markKey("MILESTONE", id)` (a SEPARATE query). */
  jira?: ReadonlyMap<string, JiraMark>;
  /** Whether the Jira column exists (`useJiraColumn`: the last visit's answer until the query answers, so a repeat visit never shifts the layout). */
  jiraColumn?: boolean;
}) {
  const { t } = useTranslation();
  const { holidays, failed: holidaysFailed } = useHolidays();
  const previewing = proposal !== undefined;
  const showJira = jiraColumn === true;
  /** The Jira cell goes just before the operations cell, and only while the column exists. */
  const withJira = (cells: TimelineRowData["cells"], milestoneId: number | null): TimelineRowData["cells"] => {
    if (!showJira) return cells;
    const mark = milestoneId === null ? undefined : jira?.get(markKey("MILESTONE", milestoneId));
    return [...cells.slice(0, -1), mark === undefined ? "" : <JiraRowMark key="jira" mark={mark} />, ...cells.slice(-1)];
  };
  const proposed = proposalBars(proposal?.moves ?? [], t);
  const columns: TimelineColumn[] = [
    { id: "name", header: t("project.column.milestone"), width: COLUMN_WIDTHS.name },
    { id: "project", header: t("teams.view.column.project"), width: COLUMN_WIDTHS.project },
    { id: "estimate", header: t("teams.view.column.estimate"), width: COLUMN_WIDTHS.estimate },
    ...(showJira ? [{ id: "jira", header: t("deviations.chip.column"), width: COLUMN_WIDTHS.jira }] : []),
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
    cells: withJira([
      <RowNameCell key="name" milestone={milestone} placement={view.team.can.editOrder && !previewing ? { index, count } : null} sinceBaseline={fresh?.has(milestone.id) === true} />,
      (stop: RovingTarget) => (
        <Anchor component={RouterLink} to={projectPath(milestone.projectId)} size="sm" truncate title={milestone.projectName} aria-label={t("teams.view.openProjectAria", { name: milestone.projectName })} {...stop}>
          {milestone.projectName}
        </Anchor>
      ),
      estimateText(t, milestone),
      (stop: RovingTarget) => <MilestoneMenu milestone={milestone} view={view} actions={actions} placement={{ index, count }} trigger={stop} previewing={previewing} />,
    ], milestone.id),
    bars: [
      ...(milestone.startDate !== null && milestone.endDate !== null
        ? [
            {
              id: milestone.id,
              start: milestone.startDate,
              end: milestone.endDate,
              label: milestone.name,
              describe: withConflicts(
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
              editable: view.team.can.schedule && !previewing,
            },
          ]
        : []),
      ...proposalBarOf(proposed, milestone),
      ...barList(shadows?.get(milestone.id)),
    ],
  }));
  // The baseline's rows (v0.9): gone from the team, or in the tray now though the baseline had them scheduled - dimmed, the shadow bar only.
  for (const row of overlay === undefined ? [] : removedRows(overlay, view.unscheduled, t)) {
    rows.push({
      id: row.id,
      cells: withJira([
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
      cells: withJira([
        <NameCell key="name" milestone={milestone} isNew />,
        (stop: RovingTarget) => (
          <Anchor component={RouterLink} to={projectPath(milestone.projectId)} size="sm" truncate title={milestone.projectName} aria-label={t("teams.view.openProjectAria", { name: milestone.projectName })} {...stop}>
            {milestone.projectName}
          </Anchor>
        ),
        estimateText(t, milestone),
        (stop: RovingTarget) => <MilestoneMenu milestone={milestone} view={view} actions={actions} trigger={stop} previewing proposedRow />,
      ], milestone.id),
      bars: proposalBarOf(proposed, milestone),
    });
  }
  const arrows = arrowSpecsFor(view.dependencies, barOf);
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
export function TeamTray({ view, actions, label, previewing = false, jira, jiraColumn = false }: { view: TeamView; actions: TeamActions; label: string; previewing?: boolean; jira?: ReadonlyMap<string, JiraMark>; jiraColumn?: boolean }) {
  const { t } = useTranslation();
  const items: TrayItem[] = view.unscheduled.map((milestone) => ({
    id: milestone.id,
    label: milestone.name,
    cells: [
      <NameCell key="name" milestone={milestone} />,
      <Anchor key="project" component={RouterLink} to={projectPath(milestone.projectId)} size="sm" truncate title={milestone.projectName} aria-label={t("teams.view.openProjectAria", { name: milestone.projectName })}>
        {milestone.projectName}
      </Anchor>,
      estimateText(t, milestone),
      ...(jiraColumn ? [<JiraRowMark key="jira" mark={jira?.get(markKey("MILESTONE", milestone.id))} />] : []),
    ],
    canSchedule: view.team.can.schedule,
    // While a proposal previews, the page is read-only: the Schedule button is disabled and the row cannot be dragged.
    disabled: previewing,
    actions: <MilestoneMenu milestone={milestone} view={view} actions={actions} previewing={previewing} />,
  }));
  return (
    <TimelineUnscheduledTray
      label={label}
      columns={[t("project.column.milestone"), t("teams.view.column.project"), t("teams.view.column.estimate"), ...(jiraColumn ? [t("deviations.chip.column")] : [])]}
      items={items}
      emptyText={t("project.noUnscheduled")}
      onSchedule={(id) => {
        const milestone = view.unscheduled.find((m) => m.id === id);
        if (milestone !== undefined) actions.schedule(milestone);
      }}
    />
  );
}
