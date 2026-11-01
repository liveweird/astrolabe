import type { Ref } from "react";
import { Anchor, Badge, Group, Menu, Text, VisuallyHidden } from "@mantine/core";
import { IconAlertTriangle, IconArrowBarDown, IconArrowBarUp, IconArrowDown, IconArrowUp, IconExternalLink, IconInfoCircle, IconListNumbers, IconX } from "@tabler/icons-react";
import { Link as RouterLink } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { RoadmapLink, RoadmapProject, RoadmapView } from "../api/roadmap";
import { projectPath } from "../utils/planLinks";
import {
  arrowSpecsForLinks,
  conflictsByProject,
  countFlags,
  displayRows,
  DIVIDER_ID,
  driftBandOf,
  type DisplayRow,
  type VisibleProjects,
} from "../utils/roadmapRows";
import type { RovingTarget, TimelineBandData, TimelineBarData, TimelineColumn, TimelineRowData } from "../utils/timelineModel";
import { PLAN_ZOOMS, type TimelineScale, type Zoom } from "../utils/timelineScale";
import RowActionsMenu from "./RowActionsMenu";
import Timeline, { type TimelineHandle } from "./Timeline";
import TimelineArrows from "./TimelineArrows";
import TimelineRowHandle from "./TimelineRowHandle";

/** What a project row can ask the page to do — the page owns the ranking write path (and binds the visible ranked ids to the moves). */
export type RoadmapActions = {
  /** Move one place up (-1) or down (+1) among the visible ranked rows. */
  move: (project: RoadmapProject, delta: -1 | 1) => void;
  moveTo: (project: RoadmapProject, edge: "top" | "bottom") => void;
  rank: (project: RoadmapProject) => void;
  unrank: (project: RoadmapProject) => void;
};

/** The sticky left columns: 404 px in all, so the track keeps the width on a laptop (work stream and owner are filters, not columns). */
const COLUMN_WIDTHS = { rank: 44, project: 240, flags: 64, actions: 56 } as const;

/** The flags of a row as icons with counts: an orange warning triangle and/or a gray info circle; the words are for assistive technology. */
function FlagsCell({ project }: { project: RoadmapProject }) {
  const { t } = useTranslation();
  const { warnings, infos } = countFlags(project.flags);
  if (warnings + infos === 0) return null;
  const sentence = [warnings > 0 ? t("roadmap.facts.warnings", { count: warnings }) : null, infos > 0 ? t("roadmap.facts.infos", { count: infos }) : null].filter(Boolean).join(", ");
  return (
    <Group gap={4} wrap="nowrap" title={sentence} data-flags={`${warnings},${infos}`}>
      {warnings > 0 && (
        <Badge aria-hidden="true" color="orange" variant="light" size="sm" px={4} leftSection={<IconAlertTriangle size={12} />}>
          {warnings}
        </Badge>
      )}
      {infos > 0 && (
        <Badge aria-hidden="true" color="gray" variant="light" size="sm" px={4} leftSection={<IconInfoCircle size={12} />}>
          {infos}
        </Badge>
      )}
      <VisuallyHidden>{sentence}</VisuallyHidden>
    </Group>
  );
}

/**
 * The row menu of one project: the ranking moves by the view's `can.editRank` (a ranked row: Move up / down / to top / to bottom, disabled at the
 * ends of the VISIBLE ranked rows, and Unrank; an unranked row: Rank, which appends), and always a link to the project. This menu is the keyboard
 * and screen-reader path of the row drag, and its button keeps focus through its own move.
 */
function ProjectMenu({
  project,
  rankedIndex,
  rankedCount,
  canRank,
  actions,
  trigger,
}: {
  project: RoadmapProject;
  /** The row's index among the visible ranked rows; `null` for an unranked row. */
  rankedIndex: number | null;
  rankedCount: number;
  canRank: boolean;
  actions: RoadmapActions;
  trigger: RovingTarget;
}) {
  const { t } = useTranslation();
  const { name } = project;
  const first = rankedIndex === 0;
  const last = rankedIndex === rankedCount - 1;
  return (
    <RowActionsMenu label={t("common.table.operationsAria", { name })} trigger={{ ...trigger, "data-operations-for": project.id }}>
      {canRank && rankedIndex !== null && (
        <>
          <Menu.Item leftSection={<IconArrowUp size={14} />} disabled={first} onClick={() => actions.move(project, -1)} aria-label={t("roadmap.action.moveUpAria", { name })}>
            {t("roadmap.action.moveUp")}
          </Menu.Item>
          <Menu.Item leftSection={<IconArrowDown size={14} />} disabled={last} onClick={() => actions.move(project, 1)} aria-label={t("roadmap.action.moveDownAria", { name })}>
            {t("roadmap.action.moveDown")}
          </Menu.Item>
          <Menu.Item leftSection={<IconArrowBarUp size={14} />} disabled={first} onClick={() => actions.moveTo(project, "top")} aria-label={t("roadmap.action.moveTopAria", { name })}>
            {t("roadmap.action.moveTop")}
          </Menu.Item>
          <Menu.Item leftSection={<IconArrowBarDown size={14} />} disabled={last} onClick={() => actions.moveTo(project, "bottom")} aria-label={t("roadmap.action.moveBottomAria", { name })}>
            {t("roadmap.action.moveBottom")}
          </Menu.Item>
          <Menu.Item leftSection={<IconX size={14} />} onClick={() => actions.unrank(project)} aria-label={t("roadmap.action.unrankAria", { name })}>
            {t("roadmap.action.unrank")}
          </Menu.Item>
          <Menu.Divider />
        </>
      )}
      {canRank && rankedIndex === null && (
        <>
          <Menu.Item leftSection={<IconListNumbers size={14} />} onClick={() => actions.rank(project)} aria-label={t("roadmap.action.rankAria", { name })}>
            {t("roadmap.action.rank")}
          </Menu.Item>
          <Menu.Divider />
        </>
      )}
      <Menu.Item component={RouterLink} to={projectPath(project.id)} leftSection={<IconExternalLink size={14} />} aria-label={t("roadmap.action.openProjectAria", { name })}>
        {t("roadmap.action.openProject")}
      </Menu.Item>
    </RowActionsMenu>
  );
}

/** The project cell: the pointer-only drag handle (only when the viewer may rank), the name as the link into the project, the program dimmed after it. */
function ProjectCell({ project, placement, stop }: { project: RoadmapProject; placement: { index: number; count: number } | null; stop: RovingTarget }) {
  const { t } = useTranslation();
  return (
    <Group gap={4} wrap="nowrap" style={{ minWidth: 0 }}>
      {placement !== null && <TimelineRowHandle id={project.id} label={project.name} position={placement.index + 1} count={placement.count} />}
      <Text component="span" size="sm" truncate style={{ minWidth: 0 }}>
        <Anchor component={RouterLink} to={projectPath(project.id)} inherit fw={500} aria-label={t("roadmap.openProjectAria", { name: project.name })} {...stop}>
          {project.name}
        </Anchor>
        <Text span c="dimmed">
          {" "}
          {project.programName}
        </Text>
      </Text>
    </Group>
  );
}

/** The accessible name of a span bar, with the ", N conflicts" suffix when violated links end on its project. */
const withConflicts = (t: TFunction, describe: string, count: number) => (count > 0 ? `${describe}, ${t("project.barConflicts", { count })}` : describe);

/** The bars of a project row: its target window (a read-only band-look bar behind) and the span its milestones cover (hollow, on top). */
function barsOf(project: RoadmapProject, t: TFunction, conflicts: number): TimelineBarData[] {
  const { id, name, targetStart, targetEnd, span } = project;
  const bars: TimelineBarData[] = [];
  if (targetStart !== null && targetEnd !== null) {
    bars.push({ id: `window:${id}`, start: targetStart, end: targetEnd, label: name, describe: t("timeline.bar.window", { name, start: targetStart, end: targetEnd }), editable: false, tone: "window" });
  }
  if (span !== null) {
    bars.push({ id, start: span.start, end: span.end, label: name, describe: withConflicts(t, t("roadmap.barAria", { name, start: span.start, end: span.end }), conflicts), editable: false, tone: "summary" });
  }
  return bars;
}

/** The overrun band behind a late project: from the day after its target window to the end of its span. */
function bandsOf(project: RoadmapProject, t: TFunction): TimelineBandData[] {
  const band = driftBandOf(project);
  return band === null || project.drift === null ? [] : [{ id: `drift:${project.id}`, ...band, label: t("project.driftBand", { count: project.drift.endDays }), tone: "drift" }];
}

/**
 * The roadmap's timeline: one row per visible project in rank order, a divider row, then the unranked ones. A project row is the `#`, the project
 * (handle, link, program), its flags and the row menu on the left; on the track the span its milestones cover over the target window's band and,
 * past the window, the drift band. The arrows are the rolled-up links between the projects (direct links by type, one bundle per ordered pair).
 * It must sit inside the page's `TimelineDndContext`; nothing here decides rights or checks — the view's `can` flags and the server's figures do.
 */
export default function RoadmapTimeline({
  view,
  visible,
  actions,
  scale,
  onZoomChange,
  today,
  busy,
  label,
  timelineRef,
}: {
  view: RoadmapView;
  visible: VisibleProjects;
  actions: RoadmapActions;
  scale: TimelineScale;
  onZoomChange: (zoom: Zoom) => void;
  today: string;
  busy: boolean;
  label: string;
  timelineRef: Ref<TimelineHandle>;
}) {
  const { t } = useTranslation();
  const canRank = view.can.editRank;
  const columns: TimelineColumn[] = [
    { id: "rank", header: t("roadmap.column.rank"), width: COLUMN_WIDTHS.rank },
    { id: "project", header: t("roadmap.column.project"), width: COLUMN_WIDTHS.project },
    { id: "flags", header: t("roadmap.column.flags"), width: COLUMN_WIDTHS.flags },
    { id: "actions", header: t("common.table.operations"), width: COLUMN_WIDTHS.actions },
  ];
  const display = displayRows(visible);
  const conflicts = conflictsByProject(view.links);
  const rankedCount = visible.ranked.length;
  function rowOf(entry: DisplayRow, index: number): TimelineRowData {
    if (entry.kind === "divider") {
      return {
        id: DIVIDER_ID,
        cells: [
          "",
          <Text key="divider" size="sm" fw={600} c="dimmed">
            {t("roadmap.unrankedDivider")}
          </Text>,
          "",
          "",
        ],
        bars: [],
      };
    }
    const { project, position } = entry;
    // Every ranked row sits at its display index; an unranked one has no index among the ranked.
    const rankedIndex = position === null ? null : index;
    return {
      id: project.id,
      cells: [
        position === null ? "—" : position,
        (stop: RovingTarget) => <ProjectCell project={project} placement={canRank ? { index, count: display.length } : null} stop={stop} />,
        <FlagsCell key="flags" project={project} />,
        (stop: RovingTarget) => <ProjectMenu project={project} rankedIndex={rankedIndex} rankedCount={rankedCount} canRank={canRank} actions={actions} trigger={stop} />,
      ],
      bars: barsOf(project, t, conflicts.get(project.id) ?? 0),
      bands: bandsOf(project, t),
    };
  }

  const rows: TimelineRowData[] = display.map(rowOf);

  const withSpan = new Set(display.flatMap((entry) => (entry.kind === "project" && entry.project.span !== null ? [entry.project.id] : [])));
  const names = new Map(display.flatMap((entry) => (entry.kind === "project" ? [[entry.project.id, entry.project.name] as const] : [])));
  const nameOf = (id: number) => names.get(id) ?? "";
  const arrows = arrowSpecsForLinks(view.links, (projectId) => (withSpan.has(projectId) ? projectId : null), {
    direct: (link: RoadmapLink) => `${nameOf(link.predecessorProjectId)} → ${nameOf(link.successorProjectId)}, ${link.direct?.type ?? ""}`,
    bundle: (link: RoadmapLink) =>
      t("roadmap.bundleLabel", { from: nameOf(link.predecessorProjectId), to: nameOf(link.successorProjectId), count: link.milestoneLinks.count, violated: link.milestoneLinks.violated }),
  });

  return (
    <Timeline
      ref={timelineRef}
      label={label}
      scale={scale}
      zooms={PLAN_ZOOMS}
      onZoomChange={onZoomChange}
      today={today}
      columns={columns}
      rows={rows}
      busy={busy}
      overlay={arrows.length === 0 ? undefined : (geometry) => <TimelineArrows arrows={arrows} geometry={geometry} />}
    />
  );
}
