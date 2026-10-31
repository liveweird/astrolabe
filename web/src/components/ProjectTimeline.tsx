import { Menu, Text } from "@mantine/core";
import { IconCalendarEvent, IconCalendarOff, IconPencil, IconTrash } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { ProjectMilestone, ProjectView } from "../api/milestones";
import { addDays } from "../utils/isoDate";
import type { RovingTarget, TimelineBandData, TimelineColumn, TimelineRowData } from "../utils/timelineModel";
import type { TimelineScale, Zoom } from "../utils/timelineScale";
import RowActionsMenu from "./RowActionsMenu";
import Timeline from "./Timeline";
import TimelineUnscheduledTray, { type TrayItem } from "./TimelineUnscheduledTray";

/** What a milestone row can ask the page to do — the page owns the editors, the delete confirmation and the schedule write path. */
export type MilestoneActions = {
  edit: (milestone: ProjectMilestone) => void;
  editSchedule: (milestone: ProjectMilestone) => void;
  unschedule: (milestone: ProjectMilestone) => void;
  remove: (milestone: ProjectMilestone) => void;
  /** The tray's Schedule button: the page chooses the dates (one calendar week from the later of today and the target start). */
  schedule: (milestone: ProjectMilestone) => void;
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
const hasMenu = ({ can }: ProjectMilestone) => can.edit || can.schedule || can.delete;

/**
 * The row menu of one milestone, each item gated by its own flag: Edit and Delete by the owner chain's `can.edit`/`can.delete`,
 * the schedule items by `can.schedule` (the team's manager or an ADMIN). `trigger` makes the kebab a stop of the timeline's grid.
 */
function MilestoneMenu({ milestone, actions, trigger }: { milestone: ProjectMilestone; actions: MilestoneActions; trigger?: RovingTarget }) {
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
      {can.delete && (can.edit || can.schedule) && <Menu.Divider />}
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

/**
 * The project's scheduled milestones as timeline rows: one row per milestone (name, team, estimate, the row menu; one bar,
 * editable only with the milestone's `can.schedule`), the target window as a band. It must sit inside the page's
 * `TimelineDndContext`. Nothing here decides rights — the flags do.
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
  const columns: TimelineColumn[] = [
    { id: "name", header: t("project.column.milestone"), width: COLUMN_WIDTHS.name },
    { id: "team", header: t("project.column.team"), width: COLUMN_WIDTHS.team },
    { id: "estimate", header: t("project.column.estimate"), width: COLUMN_WIDTHS.estimate },
    { id: "actions", header: t("common.table.operations"), width: COLUMN_WIDTHS.actions },
  ];
  const rows: TimelineRowData[] = view.scheduled.map((milestone) => ({
    id: milestone.id,
    cells: [
      <NameCell key="name" milestone={milestone} />,
      milestone.teamName,
      estimateText(t, milestone),
      // A function cell holds its own focusable; with no menu the cell stays a static stop, so the tab stop never lands on a missing element.
      hasMenu(milestone) ? (stop: RovingTarget) => <MilestoneMenu milestone={milestone} actions={actions} trigger={stop} /> : null,
    ],
    bars:
      milestone.startDate !== null && milestone.endDate !== null
        ? [
            {
              id: milestone.id,
              start: milestone.startDate,
              end: milestone.endDate,
              label: milestone.name,
              describe: t("project.barAria", {
                name: milestone.name,
                team: milestone.teamName,
                start: milestone.startDate,
                end: milestone.endDate,
                estimate: estimateText(t, milestone),
              }),
              editable: milestone.can.schedule,
            },
          ]
        : [],
  }));
  return <Timeline label={label} scale={scale} onZoomChange={onZoomChange} today={today} columns={columns} rows={rows} bands={bandsOf(view, t)} busy={busy} />;
}

/** The Unscheduled tray of the project's milestones without dates: drag onto the timeline (pointer) or Schedule (button), inside the same `TimelineDndContext`. */
export function ProjectTray({ view, actions, label }: { view: ProjectView; actions: MilestoneActions; label: string }) {
  const { t } = useTranslation();
  const items: TrayItem[] = view.unscheduled.map((milestone) => ({
    id: milestone.id,
    label: milestone.name,
    cells: [<NameCell key="name" milestone={milestone} />, milestone.teamName, estimateText(t, milestone)],
    canSchedule: milestone.can.schedule,
    actions: hasMenu(milestone) ? <MilestoneMenu milestone={milestone} actions={actions} /> : null,
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
