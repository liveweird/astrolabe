import { Anchor, Group, Menu, Text } from "@mantine/core";
import { IconArrowBarDown, IconArrowBarUp, IconArrowDown, IconArrowUp, IconCalendarEvent, IconCalendarOff, IconExternalLink } from "@tabler/icons-react";
import { Link as RouterLink } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { TeamMilestone, TeamView } from "../api/teams";
import { arrowSpecsFor, conflictsByBarFor } from "../utils/dependencyArrows";
import { projectPath } from "../utils/planLinks";
import type { BarId, RovingTarget, TimelineColumn, TimelineRowData } from "../utils/timelineModel";
import type { TimelineScale, Zoom } from "../utils/timelineScale";
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

const COLUMN_WIDTHS = { name: 220, project: 150, estimate: 120, actions: 56 } as const;

/** The estimate with its unit ("12.25 man-days"). */
const estimateText = (t: TFunction, milestone: TeamMilestone) => t("project.estimateUnit", { count: milestone.estimateMd });

/** The name with the description as dimmed text after it; one line (rows are a fixed height), the cell clips the rest. */
function NameCell({ milestone }: { milestone: TeamMilestone }) {
  return (
    <Text component="span" size="sm" truncate>
      <Text span fw={500}>
        {milestone.name}
      </Text>
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
function RowNameCell({ milestone, placement }: { milestone: TeamMilestone; placement: { index: number; count: number } | null }) {
  if (placement === null) return <NameCell milestone={milestone} />;
  return (
    <Group gap={4} wrap="nowrap" style={{ minWidth: 0 }}>
      <TimelineRowHandle id={milestone.id} label={milestone.name} position={placement.index + 1} count={placement.count} />
      <NameCell milestone={milestone} />
    </Group>
  );
}

/**
 * The row menu of one milestone: the schedule items by the view's `can.schedule`, the four order moves by `can.editOrder` (disabled at
 * the ends of the list; a tray row has no order and gets none), and a link to the milestone's project. `position`/`count` place a
 * timeline row in the order; `trigger` makes the kebab a stop of the timeline's grid.
 */
function MilestoneMenu({
  milestone,
  view,
  actions,
  placement,
  trigger,
}: {
  milestone: TeamMilestone;
  view: TeamView;
  actions: TeamActions;
  /** A timeline row's place in the order (0-based index and row count); absent for a tray row. */
  placement?: { index: number; count: number };
  trigger?: RovingTarget;
}) {
  const { t } = useTranslation();
  const { can } = view.team;
  const { name } = milestone;
  const first = placement?.index === 0;
  const last = placement !== undefined && placement.index === placement.count - 1;
  const ordering = can.editOrder && placement !== undefined;
  return (
    <RowActionsMenu label={t("common.table.operationsAria", { name })} trigger={trigger}>
      {can.schedule && (
        <Menu.Item leftSection={<IconCalendarEvent size={14} />} onClick={() => actions.editSchedule(milestone)} aria-label={t("project.action.editScheduleAria", { name })}>
          {t("project.action.editSchedule")}
        </Menu.Item>
      )}
      {can.schedule && milestone.startDate !== null && (
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

/** The accessible name of a bar, with the ", N conflicts" suffix when violated links end on it (so a screen-reader user on the bar hears it). */
const withConflicts = (t: TFunction, describe: string, count: number) => (count > 0 ? `${describe}, ${t("project.barConflicts", { count })}` : describe);

/**
 * The team's timeline: one row per scheduled milestone in the view's order (the team's own, or the project rank's by default), the
 * weekly load strip in the sticky header, and the dependency arrows between THIS timeline's rows (an end that is not a row here — a
 * project, an unscheduled or another team's milestone — is simply not drawn; the project's page is where those are read). It must sit
 * inside the page's `TimelineDndContext`. Nothing here decides rights or checks — the view's `can` flags and the server's `check` do.
 */
export default function TeamTimeline({
  view,
  scale,
  onZoomChange,
  today,
  busy,
  actions,
  label,
}: {
  view: TeamView;
  scale: TimelineScale;
  onZoomChange: (zoom: Zoom) => void;
  today: string;
  busy: boolean;
  actions: TeamActions;
  label: string;
}) {
  const { t } = useTranslation();
  const columns: TimelineColumn[] = [
    { id: "name", header: t("project.column.milestone"), width: COLUMN_WIDTHS.name },
    { id: "project", header: t("teams.view.column.project"), width: COLUMN_WIDTHS.project },
    { id: "estimate", header: t("teams.view.column.estimate"), width: COLUMN_WIDTHS.estimate },
    { id: "actions", header: t("common.table.operations"), width: COLUMN_WIDTHS.actions },
  ];
  const rowIds = new Set<BarId>(view.scheduled.map((milestone) => milestone.id));
  const barOf = (endpoint: { kind: string; id: number }): BarId | null => (endpoint.kind === "MILESTONE" && rowIds.has(endpoint.id) ? endpoint.id : null);
  const conflicts = conflictsByBarFor(view.dependencies, barOf);
  const count = view.scheduled.length;
  const rows: TimelineRowData[] = view.scheduled.map((milestone, index) => ({
    id: milestone.id,
    cells: [
      <RowNameCell key="name" milestone={milestone} placement={view.team.can.editOrder ? { index, count } : null} />,
      (stop: RovingTarget) => (
        <Anchor component={RouterLink} to={projectPath(milestone.projectId)} size="sm" truncate title={milestone.projectName} aria-label={t("teams.view.openProjectAria", { name: milestone.projectName })} {...stop}>
          {milestone.projectName}
        </Anchor>
      ),
      estimateText(t, milestone),
      (stop: RovingTarget) => <MilestoneMenu milestone={milestone} view={view} actions={actions} placement={{ index, count }} trigger={stop} />,
    ],
    bars:
      milestone.startDate !== null && milestone.endDate !== null
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
              editable: view.team.can.schedule,
            },
          ]
        : [],
  }));
  const arrows = arrowSpecsFor(view.dependencies, barOf);
  return (
    <Timeline
      label={label}
      scale={scale}
      onZoomChange={onZoomChange}
      today={today}
      columns={columns}
      rows={rows}
      busy={busy}
      strip={{ label: t("teams.view.stripLabel"), render: (stripScale) => <TimelineLoadStrip weeks={view.weeks} scale={stripScale} /> }}
      overlay={arrows.length === 0 ? undefined : (geometry) => <TimelineArrows arrows={arrows} geometry={geometry} />}
    />
  );
}

/** The Unscheduled tray of the team's milestones without dates: drag onto the timeline (pointer) or Schedule (button), inside the same `TimelineDndContext`. */
export function TeamTray({ view, actions, label }: { view: TeamView; actions: TeamActions; label: string }) {
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
    ],
    canSchedule: view.team.can.schedule,
    actions: <MilestoneMenu milestone={milestone} view={view} actions={actions} />,
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
