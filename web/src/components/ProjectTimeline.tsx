import { Anchor, Menu, Text } from "@mantine/core";
import { IconCalendarEvent, IconCalendarOff, IconLink, IconPencil, IconTrash } from "@tabler/icons-react";
import { Link as RouterLink } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { DependencyEndpoint } from "../api/dependencies";
import type { ProjectMilestone, ProjectView } from "../api/milestones";
import { useHolidays } from "../hooks/useHolidays";
import { addDays } from "../utils/isoDate";
import { projectPath } from "../utils/planLinks";
import { arrowSpecs, conflictsByBar, ghostEndpoints, ghostRowId, projectRowId, summaryRowNeeded } from "../utils/projectDependencies";
import type { BarId, RovingTarget, TimelineBandData, TimelineColumn, TimelineRowData } from "../utils/timelineModel";
import type { TimelineScale, Zoom } from "../utils/timelineScale";
import RowActionsMenu from "./RowActionsMenu";
import Timeline from "./Timeline";
import TimelineArrows from "./TimelineArrows";
import TimelineUnscheduledTray, { type TrayItem } from "./TimelineUnscheduledTray";

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
};

const COLUMN_WIDTHS = { name: 220, team: 130, estimate: 120, actions: 56 } as const;

/** The estimate with its unit ("12.25 man-days"). */
const estimateText = (t: TFunction, milestone: ProjectMilestone) => t("project.estimateUnit", { count: milestone.estimateMd });

/** The name with the description as dimmed text after it; one line (rows are a fixed height), the cell clips the rest. */
function NameCell({ milestone }: { milestone: ProjectMilestone }) {
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

/** Does the caller have any row action on this milestone? Without one there is no menu (and, in the grid, a plain static cell stays the stop). */
const hasMenu = ({ can }: ProjectMilestone, canLink: boolean) => can.edit || can.schedule || can.delete || canLink;

/**
 * The row menu of one milestone, each item gated by its own flag: Edit and Delete by the owner chain's `can.edit`/`can.delete`,
 * the schedule items by `can.schedule` (the team's manager or an ADMIN). `trigger` makes the kebab a stop of the timeline's grid.
 */
function MilestoneMenu({
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
        <Menu.Item
          color="red"
          leftSection={<IconTrash size={14} />}
          onClick={() => actions.remove(milestone)}
          aria-label={t("common.action.deleteAria", { name: milestone.name })}
        >
          {t("common.action.delete")}
        </Menu.Item>
      )}
    </RowActionsMenu>
  );
}

/** The target window as a band across every row, and — when the derived span ends after the target — the overrun in the drift tone. */
function bandsOf(view: ProjectView, t: TFunction): TimelineBandData[] {
  const { targetStart, targetEnd } = view.project;
  if (targetStart === null || targetEnd === null) return [];
  const bands: TimelineBandData[] = [{ id: "window", start: targetStart, end: targetEnd, label: t("project.windowBand", { start: targetStart, end: targetEnd }), tone: "window" }];
  if (view.span !== null && view.drift !== null && view.drift.endDays > 0) {
    bands.push({ id: "drift", start: addDays(targetEnd, 1), end: view.span.end, label: t("project.driftBand", { count: view.drift.endDays }), tone: "drift" });
  }
  return bands;
}

/** The accessible name of an own bar, with the ", N conflicts" suffix when violated links end on it (so a screen-reader user on the bar hears it). */
const withConflicts = (t: TFunction, describe: string, count: number) => (count > 0 ? `${describe}, ${t("project.barConflicts", { count })}` : describe);

/**
 * The summary row: the project itself as a dependency endpoint (its name, its derived span as a hollow bar; no bar while nothing is
 * scheduled). Present only while some link ends on the whole project.
 */
function summaryRow(view: ProjectView, t: TFunction, conflicts: ReadonlyMap<BarId, number>): TimelineRowData {
  const id = projectRowId(view.project.id);
  const { name } = view.project;
  return {
    id,
    cells: [
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
    bars:
      view.span === null
        ? []
        : [
            {
              id,
              start: view.span.start,
              end: view.span.end,
              label: name,
              describe: withConflicts(t, t("timeline.bar.summary", { name, start: view.span.start, end: view.span.end }), conflicts.get(id) ?? 0),
              editable: false,
              tone: "summary",
            },
          ],
  };
}

/**
 * A ghost row: another project's milestone (or another project's span) that a link of this project ends on. Read-only and dimmed;
 * its name is the way to that project's page (a function cell, so the link is the row's one stop).
 */
function ghostRow(endpoint: DependencyEndpoint, t: TFunction): TimelineRowData {
  const id = ghostRowId(endpoint);
  const start = endpoint.startDate ?? "";
  const end = endpoint.endDate ?? "";
  const text = endpoint.kind === "MILESTONE" ? t("project.ghostName", { project: endpoint.projectName, name: endpoint.name }) : endpoint.name;
  return {
    id,
    cells: [
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
    bars: [
      {
        id,
        start,
        end,
        label: endpoint.name,
        describe: t("timeline.bar.ghost", { label: t("project.ghostSpan", { name: endpoint.name, start, end }), project: endpoint.projectName }),
        editable: false,
        tone: "ghost",
      },
    ],
  };
}

/**
 * The project's timeline rows: the summary row (only while the project itself is a link endpoint), one row per scheduled milestone
 * (name, team, estimate, the row menu; one bar, editable only with the milestone's `can.schedule`), then a ghost row per external
 * link endpoint that has dates; the target window is a band; the links are arrows through the overlay slot. It must sit inside the
 * page's `TimelineDndContext`. Nothing here decides rights or checks — the flags and the server's `check` do.
 */
export default function ProjectTimeline({
  view,
  scale,
  onZoomChange,
  today,
  busy,
  actions,
  label,
}: {
  view: ProjectView;
  scale: TimelineScale;
  onZoomChange: (zoom: Zoom) => void;
  today: string;
  busy: boolean;
  actions: MilestoneActions;
  label: string;
}) {
  const { t } = useTranslation();
  const { holidays, failed: holidaysFailed } = useHolidays();
  const canLink = view.project.can.createDependency;
  const conflicts = conflictsByBar(view);
  const columns: TimelineColumn[] = [
    { id: "name", header: t("project.column.milestone"), width: COLUMN_WIDTHS.name },
    { id: "team", header: t("project.column.team"), width: COLUMN_WIDTHS.team },
    { id: "estimate", header: t("project.column.estimate"), width: COLUMN_WIDTHS.estimate },
    { id: "actions", header: t("common.table.operations"), width: COLUMN_WIDTHS.actions },
  ];
  const milestoneRows: TimelineRowData[] = view.scheduled.map((milestone) => ({
    id: milestone.id,
    cells: [
      <NameCell key="name" milestone={milestone} />,
      milestone.teamName,
      estimateText(t, milestone),
      // A function cell holds its own focusable; with no menu the cell stays a static stop, so the tab stop never lands on a missing element.
      hasMenu(milestone, canLink) ? (stop: RovingTarget) => <MilestoneMenu milestone={milestone} actions={actions} canLink={canLink} trigger={stop} /> : null,
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
                t("project.barAria", {
                  name: milestone.name,
                  team: milestone.teamName,
                  start: milestone.startDate,
                  end: milestone.endDate,
                  estimate: estimateText(t, milestone),
                }),
                conflicts.get(milestone.id) ?? 0,
              ),
              editable: milestone.can.schedule,
            },
          ]
        : [],
  }));
  const rows = [...(summaryRowNeeded(view) ? [summaryRow(view, t, conflicts)] : []), ...milestoneRows, ...ghostEndpoints(view).map((endpoint) => ghostRow(endpoint, t))];
  const arrows = arrowSpecs(view);
  return (
    <Timeline
      label={label}
      scale={scale}
      onZoomChange={onZoomChange}
      today={today}
      columns={columns}
      rows={rows}
      bands={bandsOf(view, t)}
      holidays={holidays}
      holidaysFailed={holidaysFailed}
      busy={busy}
      overlay={arrows.length === 0 ? undefined : (geometry) => <TimelineArrows arrows={arrows} geometry={geometry} />}
    />
  );
}

/** The Unscheduled tray of the project's milestones without dates: drag onto the timeline (pointer) or Schedule (button), inside the same `TimelineDndContext`. */
export function ProjectTray({ view, actions, label }: { view: ProjectView; actions: MilestoneActions; label: string }) {
  const { t } = useTranslation();
  const canLink = view.project.can.createDependency;
  const items: TrayItem[] = view.unscheduled.map((milestone) => ({
    id: milestone.id,
    label: milestone.name,
    cells: [<NameCell key="name" milestone={milestone} />, milestone.teamName, estimateText(t, milestone)],
    canSchedule: milestone.can.schedule,
    actions: hasMenu(milestone, canLink) ? <MilestoneMenu milestone={milestone} actions={actions} canLink={canLink} /> : null,
  }));
  return (
    <TimelineUnscheduledTray
      label={label}
      columns={[t("project.column.milestone"), t("project.column.team"), t("project.column.estimate")]}
      items={items}
      emptyText={t("project.noUnscheduled")}
      onSchedule={(id) => {
        const milestone = view.unscheduled.find((m) => m.id === id);
        if (milestone !== undefined) actions.schedule(milestone);
      }}
    />
  );
}
