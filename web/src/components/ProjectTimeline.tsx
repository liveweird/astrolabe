import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ProjectView } from "../api/milestones";
import { useHolidays } from "../hooks/useHolidays";
import { jiraTrayNote } from "../utils/flagSentences";
import { siteUrls, type JiraWindow } from "../utils/jiraBars";
import { arrowSpecs, conflictsByBar, ghostEndpoints, summaryRowNeeded, upstreamIndex } from "../utils/projectDependencies";
import type { TimelineColumn } from "../utils/timelineModel";
import type { TimelineScale, Zoom } from "../utils/timelineScale";
import { NameWithFlags } from "./MilestoneFlags";
import MilestoneMenu, { type MilestoneActions } from "./MilestoneMenu";
import NameCell from "./MilestoneNameCell";
import { bandsOf, baselineRows, estimateText, ghostRow, hasMenu, milestoneRows, summaryRow } from "./ProjectTimelineRows";
import Timeline from "./Timeline";
import TimelineArrows from "./TimelineArrows";
import TimelineUnscheduledTray, { type TrayItem } from "./TimelineUnscheduledTray";

/** The Flags column grows to `FLAGS_WITH_ROLLUP_WIDTH` while a scheduled row shows a Jira roll-up ("5/12 · 34 pt"). */
const FLAGS_WITH_ROLLUP_WIDTH = 210;
const COLUMN_WIDTHS = { name: 220, team: 130, estimate: 120, flags: 130, slack: 130, actions: 56 } as const;

/**
 * The project's timeline rows: the summary row (only while the project itself is a link endpoint), one row per scheduled milestone
 * (name, team, estimate, the row menu; one bar, editable only with the milestone's `can.schedule`), then a ghost row per external
 * link endpoint that has dates; the target window is a band; the links are arrows through the overlay slot. It must sit inside the
 * page's `TimelineDndContext`. Nothing here decides rights or checks — the flags and the server's `check` do.
 *
 * Jira (1.3, all from the view): while some scheduled milestone is linked or flagged there is a Flags column (the row's Jira key and its flags, the Jira ones and the calendar's
 * `NO_WORKING_DAY`, as the roadmap's icons, the sentences as the accessible label; a cell is empty only for a row that is neither linked nor flagged), and with `jira` (the page's window, the "Jira dates" toggle on) each linked row gets a dashed shadow bar
 * of the dates Jira holds.
 */
export default function ProjectTimeline({
  view,
  scale,
  onZoomChange,
  today,
  busy,
  actions,
  label,
  criticalPath,
  toolbar,
  jira,
}: {
  view: ProjectView;
  scale: TimelineScale;
  onZoomChange: (zoom: Zoom) => void;
  today: string;
  busy: boolean;
  actions: MilestoneActions;
  label: string;
  /** The critical-path toggle is on: the Slack column, the bar and arrow emphasis and the ghost rows' slack. */
  criticalPath: boolean;
  /** The Timeline's `toolbar` slot: the page's toggle buttons. */
  toolbar: ReactNode;
  /** The page's Jira window while the "Jira dates" toggle is on (each linked row's shadow bar), else `null`. */
  jira: JiraWindow | null;
}) {
  const { t } = useTranslation();
  const { holidays, failed: holidaysFailed } = useHolidays();
  const conflicts = conflictsByBar(view);
  // The Flags column exists while some scheduled milestone is linked to Jira or carries a flag (the view says so: no stored answer, no second request).
  const flagsColumn = view.scheduled.some((milestone) => milestone.jira !== null || milestone.flags.length > 0);
  const flagsWidth = view.scheduled.some((milestone) => milestone.jira?.rollup != null) ? FLAGS_WITH_ROLLUP_WIDTH : COLUMN_WIDTHS.flags;
  const columns: TimelineColumn[] = [
    { id: "name", header: t("project.column.milestone"), width: COLUMN_WIDTHS.name },
    { id: "team", header: t("project.column.team"), width: COLUMN_WIDTHS.team },
    { id: "estimate", header: t("project.column.estimate"), width: COLUMN_WIDTHS.estimate },
    ...(flagsColumn ? [{ id: "flags", header: t("roadmap.column.flags"), width: flagsWidth }] : []),
    ...(criticalPath ? [{ id: "slack", header: t("project.column.slack"), width: COLUMN_WIDTHS.slack }] : []),
    { id: "actions", header: t("common.table.operations"), width: COLUMN_WIDTHS.actions },
  ];
  const upstream = criticalPath ? upstreamIndex(view) : null;
  const rows = [
    ...(summaryRowNeeded(view) ? [summaryRow(view, t, conflicts, criticalPath, flagsColumn)] : []),
    ...milestoneRows(view, t, { actions, jira, conflicts, criticalPath, flagsColumn }),
    ...baselineRows(view, t, { criticalPath, flagsColumn }),
    ...ghostEndpoints(view).map((endpoint) => ghostRow(endpoint, t, upstream, flagsColumn)),
  ];
  const arrows = arrowSpecs(view, criticalPath);
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
      toolbar={toolbar}
      overlay={arrows.length === 0 ? undefined : (geometry) => <TimelineArrows arrows={arrows} geometry={geometry} />}
    />
  );
}

/** The Unscheduled tray of the project's milestones without dates: drag onto the timeline (pointer) or Schedule (button), inside the same `TimelineDndContext`. */
export function ProjectTray({ view, actions, label }: { view: ProjectView; actions: MilestoneActions; label: string }) {
  const { t } = useTranslation();
  const canLink = view.project.can.createDependency;
  const sites = siteUrls(view.jiraSites);
  const items: TrayItem[] = view.unscheduled.map((milestone) => ({
    id: milestone.id,
    label: milestone.name,
    // A tray row has no Flags column: the Jira key and the flag icon sit beside the name and, for a Jira item that has dates the plan item lacks, the note says which.
    cells: [
      <NameWithFlags key="name" flags={milestone.flags} link={milestone.jira} sites={sites}>
        <NameCell milestone={milestone} note={jiraTrayNote(t, milestone.jira, milestone.flags)} />
      </NameWithFlags>,
      milestone.teamName,
      estimateText(t, milestone),
    ],
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
