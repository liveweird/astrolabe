import type { ReactNode, Ref } from "react";
import { Group, Menu, Text, VisuallyHidden } from "@mantine/core";
import { IconArrowBarDown, IconArrowBarUp, IconArrowDown, IconArrowUp, IconListNumbers, IconX } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import type { RoadmapProject, RoadmapView } from "../api/roadmap";
import { useHolidays } from "../hooks/useHolidays";
import type { JiraWindow } from "../utils/jiraBars";
import { projectTrack, planArrows } from "../utils/planTrack";
import { conflictsByProject, countFlags, displayRows, DIVIDER_ID, type DisplayRow, type VisibleProjects } from "../utils/roadmapRows";
import type { RovingTarget, TimelineColumn, TimelineRowData } from "../utils/timelineModel";
import { PLAN_ZOOMS, type TimelineScale, type Zoom } from "../utils/timelineScale";
import { FlagCountsCell, OpenProjectItem, ProjectLink, TargetWindowItems, type WindowActions } from "./PlanProjectCells";
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
  /** The row's menu has finished closing (its exit transition is over): the page puts the focus back here if a change just moved the row. */
  menuClosed: (project: RoadmapProject) => void;
  /** The target window's menu items (shown only for a project whose `can.editTargetWindow` is set): open the dialog / clear the window. */
  window: WindowActions;
};

/** The sticky left columns: 404 px in all, so the track keeps the width on a laptop (work stream and owner are filters, not columns). The rank column grows to hold "(was 12)" while a baseline is picked. */
const COLUMN_WIDTHS = { rank: 44, rankWithBaseline: 96, project: 240, flags: 64, actions: 56 } as const;

/**
 * The rank cell: the position ("—" unranked), and while a baseline is picked a dimmed "(was 3)" / "(was unranked)" when the frozen rank differs
 * (nothing extra for an unchanged rank or a project newer than the baseline, which has no `baseline` block). The visible pair is `aria-hidden`
 * behind one sentence, so a screen reader hears "Rank 5, was rank 3 in the baseline" once.
 */
function RankCell({ project, position }: { project: RoadmapProject; position: number | null }) {
  const { t } = useTranslation();
  const frozen = project.baseline;
  if (frozen === undefined || frozen.rankPosition === position) return <>{position === null ? "—" : position}</>;
  const was = frozen.rankPosition;
  const sentence =
    was === null
      ? t("roadmap.rank.sentenceFromUnranked", { rank: position })
      : position === null
        ? t("roadmap.rank.sentenceToUnranked", { was })
        : t("roadmap.rank.sentence", { rank: position, was });
  return (
    <>
      <span aria-hidden="true">
        {position === null ? "—" : position}{" "}
        <Text span size="xs" c="dimmed">
          {was === null ? t("roadmap.rank.wasUnranked") : t("roadmap.rank.was", { rank: was })}
        </Text>
      </span>
      <VisuallyHidden>{sentence}</VisuallyHidden>
    </>
  );
}

/**
 * The row menu of one project: the ranking moves by the view's `can.editRank` (a ranked row: Move up / down / to top / to bottom, disabled at the
 * ends of the VISIBLE ranked rows, and Unrank; an unranked row: Rank, which appends), the target window's items by the project's own
 * `can.editTargetWindow` (Edit target window…, Clear target window), and always a link to the project. This menu is the keyboard and
 * screen-reader path of the row drag and of the band's drag, and its button keeps focus through its own move.
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
    <RowActionsMenu label={t("common.table.operationsAria", { name })} trigger={{ ...trigger, "data-operations-for": project.id }} onClosed={() => actions.menuClosed(project)}>
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
      <TargetWindowItems project={project} actions={actions.window} />
      <OpenProjectItem project={project} />
    </RowActionsMenu>
  );
}

/** The project cell: the pointer-only drag handle (only when the viewer may rank), the name as the link into the project, the program dimmed after it. */
function ProjectCell({ project, placement, stop }: { project: RoadmapProject; placement: { index: number; count: number } | null; stop: RovingTarget }) {
  return (
    <Group gap={4} wrap="nowrap" style={{ minWidth: 0 }}>
      {placement !== null && <TimelineRowHandle id={project.id} label={project.name} position={placement.index + 1} count={placement.count} />}
      <Text component="span" size="sm" truncate style={{ minWidth: 0 }}>
        <ProjectLink project={project} stop={stop} />
        <Text span c="dimmed">
          {" "}
          {project.programName}
        </Text>
      </Text>
    </Group>
  );
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
  toolbar,
  jira,
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
  /** The Timeline's `toolbar` slot: the page's baseline picker and the "Jira dates" toggle. */
  toolbar?: ReactNode;
  /** The page's Jira window while the "Jira dates" toggle is on (each project's Jira shadow bar), else `null`. */
  jira: JiraWindow | null;
}) {
  const { t } = useTranslation();
  const { holidays, failed: holidaysFailed } = useHolidays();
  const canRank = view.can.editRank;
  const columns: TimelineColumn[] = [
    { id: "rank", header: t("roadmap.column.rank"), width: view.baseline === undefined ? COLUMN_WIDTHS.rank : COLUMN_WIDTHS.rankWithBaseline },
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
        <RankCell key="rank" project={project} position={position} />,
        (stop: RovingTarget) => <ProjectCell project={project} placement={canRank ? { index, count: display.length } : null} stop={stop} />,
        <FlagCountsCell key="flags" counts={countFlags(project.flags)} />,
        (stop: RovingTarget) => <ProjectMenu project={project} rankedIndex={rankedIndex} rankedCount={rankedCount} canRank={canRank} actions={actions} trigger={stop} />,
      ],
      ...projectTrack(project, t, conflicts, jira),
    };
  }

  const rows: TimelineRowData[] = display.map(rowOf);

  const withSpan = new Set(display.flatMap((entry) => (entry.kind === "project" && entry.project.span !== null ? [entry.project.id] : [])));
  const names = new Map(display.flatMap((entry) => (entry.kind === "project" ? [[entry.project.id, entry.project.name] as const] : [])));
  const arrows = planArrows(t, view.links, names, withSpan);

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
      holidays={holidays}
      holidaysFailed={holidaysFailed}
      busy={busy}
      toolbar={toolbar}
      overlay={arrows.length === 0 ? undefined : (geometry) => <TimelineArrows arrows={arrows} geometry={geometry} />}
    />
  );
}
