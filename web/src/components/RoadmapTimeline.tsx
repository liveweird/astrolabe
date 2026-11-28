import type { ReactNode, Ref } from "react";
import { Group, Menu, Text, VisuallyHidden } from "@mantine/core";
import { IconListNumbers, IconX } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import type { RemovedProject, RoadmapProject, RoadmapView } from "../api/roadmap";
import { useHolidays } from "../hooks/useHolidays";
import { useTimelineColumns } from "../hooks/useTimelineColumns";
import { removedProjectRows } from "../utils/baselineOverlay";
import type { ProposedSpans } from "../utils/programsTree";
import type { JiraWindow } from "../utils/jiraBars";
import { projectTrack, planArrows } from "../utils/planTrack";
import { criticalIndex } from "../utils/roadmapCritical";
import { conflictsByProject, countFlags, displayRows, DIVIDER_ID, pendingTeamNames, type DisplayRow, type VisibleProjects } from "../utils/roadmapRows";
import type { RovingTarget, TimelineColumn, TimelineRowData } from "../utils/timelineModel";
import { PLAN_ZOOMS, type TimelineScale, type Zoom } from "../utils/timelineScale";
import { BaselineRowName } from "./BaselineParts";
import { CriticalPathItem, DependenciesItem, FlagCountsCell, OpenProjectItem, ProjectLink, TargetWindowItems, type WindowActions } from "./PlanProjectCells";
import EntityLink from "./EntityLink";
import MoveItems from "./MoveItems";
import OpenEntityItem from "./OpenEntityItem";
import RowActionsMenu from "./RowActionsMenu";
import Timeline, { type TimelineHandle } from "./Timeline";
import TimelineArrows from "./TimelineArrows";
import TimelineColumnsControl from "./TimelineColumnsControl";
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
  /** The critical path toward a project (1.7): the menu's "Show critical path to this project" / "Hide critical path"; `target` is the project the page shows it toward. */
  critical: { target: number | null; toggle: (project: RoadmapProject) => void; disabled: boolean };
};

/** A previewed schedule proposal (1.39): the span each project would get (dashed bars) and whether the ranking and the target windows are read-only meanwhile. */
type RoadmapPreview = { proposed: ProposedSpans; locked: boolean };
const NO_PREVIEW: RoadmapPreview = { proposed: new Map(), locked: false };

/** The sticky left columns: 460 px in all, so the track keeps the width on a laptop (work stream and owner are filters, not columns). The rank column grows to hold "(was 12)" while a baseline is picked. */
const COLUMN_WIDTHS = { rank: 44, rankWithBaseline: 96, project: 240, flags: 120, actions: 56 } as const;

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
 * `can.editTargetWindow` (Edit target window…, Clear target window), the critical path toward this project (1.7) and always a link to the project. This menu is the keyboard and
 * screen-reader path of the row drag and of the band's drag, and its button keeps focus through its own move. While a proposal is previewed (`locked`) the ranking and window items are left out.
 */
function ProjectMenu({
  project,
  rankedIndex,
  rankedCount,
  canRank,
  locked,
  actions,
  trigger,
}: {
  project: RoadmapProject;
  /** The row's index among the visible ranked rows; `null` for an unranked row. */
  rankedIndex: number | null;
  rankedCount: number;
  canRank: boolean;
  /** A schedule proposal is requested or open (1.39): no rank and no target window item. */
  locked: boolean;
  actions: RoadmapActions;
  trigger: RovingTarget;
}) {
  const { t } = useTranslation();
  const { name } = project;
  const first = rankedIndex === 0;
  const last = rankedIndex === rankedCount - 1;
  return (
    <RowActionsMenu label={t("common.table.operationsAria", { name })} trigger={{ ...trigger, "data-operations-for": project.id }} onClosed={() => actions.menuClosed(project)}>
      {canRank && !locked && rankedIndex !== null && (
        <>
          <MoveItems name={name} scope="roadmap.action" first={first} last={last} onMove={(delta) => actions.move(project, delta)} onMoveTo={(edge) => actions.moveTo(project, edge)} />
          <Menu.Item leftSection={<IconX size={14} />} onClick={() => actions.unrank(project)} aria-label={t("roadmap.action.unrankAria", { name })}>
            {t("roadmap.action.unrank")}
          </Menu.Item>
          <Menu.Divider />
        </>
      )}
      {canRank && !locked && rankedIndex === null && (
        <>
          <Menu.Item leftSection={<IconListNumbers size={14} />} onClick={() => actions.rank(project)} aria-label={t("roadmap.action.rankAria", { name })}>
            {t("roadmap.action.rank")}
          </Menu.Item>
          <Menu.Divider />
        </>
      )}
      <CriticalPathItem project={project} target={actions.critical.target} disabled={actions.critical.disabled} onToggle={() => actions.critical.toggle(project)} />
      {!locked && <TargetWindowItems project={project} actions={actions.window} />}
      <DependenciesItem project={project} />
      <OpenProjectItem project={project} />
      <OpenEntityItem entity={{ kind: "program", id: project.programId }} name={project.programName} />
    </RowActionsMenu>
  );
}

/** The project cell: the pointer-only drag handle (only when the viewer may rank), the name as the link into the project (the stop), the program after it as the pointer's link (D4). */
function ProjectCell({ project, placement, stop }: { project: RoadmapProject; placement: { index: number; count: number } | null; stop: RovingTarget }) {
  return (
    <Group gap={4} wrap="nowrap" style={{ minWidth: 0 }}>
      {placement !== null && <TimelineRowHandle id={project.id} label={project.name} position={placement.index + 1} count={placement.count} />}
      {/* Each link in its own flex item (never one run of text beside other text: axe `link-in-text-block`); the owner-like second name shrinks first. */}
      <Text component="span" size="sm" truncate style={{ minWidth: 0 }}>
        <ProjectLink project={project} stop={stop} />
      </Text>{" "}
      {/* The cell's one stop is the project's link: the program's is for the pointer, the row menu's "Open program" is the keyboard's. */}
      <Text component="span" size="sm" truncate style={{ minWidth: 0, flexShrink: 1000 }}>
        <EntityLink entity={{ kind: "program", id: project.programId }} name={project.programName} c="dimmed" secondary />
      </Text>
    </Group>
  );
}

/**
 * The roadmap's timeline: one row per visible project in rank order, a divider row, then the unranked ones, then (with a baseline picked) a dimmed row per project it froze that is deleted now. A project row is the `#`, the project
 * (handle, link, program), its flags and the row menu on the left; on the track the span its milestones cover over the target window's band and,
 * past the window, the drift band. The arrows are the rolled-up links between the projects (direct links by type, one bundle per ordered pair).
 * It must sit inside the page's `TimelineDndContext`; nothing here decides rights or checks — the view's `can` flags and the server's figures do.
 */
export default function RoadmapTimeline({
  view,
  visible,
  removed,
  actions,
  scale,
  onZoomChange,
  today,
  busy,
  label,
  timelineRef,
  toolbar,
  jira,
  preview = NO_PREVIEW,
}: {
  view: RoadmapView;
  visible: VisibleProjects;
  /** The baseline's deleted projects the filters leave visible (`visibleRemoved`): appended after every current row, shadow bar only. */
  removed: readonly RemovedProject[];
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
  /** The page's previewed schedule proposal (1.39, Prioritization): dashed bars, and while `locked` no row handle and no rank or window item (the page's guard refuses the writes too). */
  preview?: RoadmapPreview;
}) {
  const { t } = useTranslation();
  const { holidays, failed: holidaysFailed } = useHolidays();
  const canRank = view.can.editRank;
  const { locked } = preview;
  const teamNames = new Map(view.teams.map((team) => [team.id, team.name]));
  const columns: TimelineColumn[] = [
    { id: "rank", header: t("roadmap.column.rank"), width: view.baseline === undefined ? COLUMN_WIDTHS.rank : COLUMN_WIDTHS.rankWithBaseline },
    { id: "project", header: t("roadmap.column.project"), width: COLUMN_WIDTHS.project },
    { id: "flags", header: t("roadmap.column.flags"), width: COLUMN_WIDTHS.flags, hideable: true },
    { id: "actions", header: t("common.table.operations"), width: COLUMN_WIDTHS.actions, iconOnly: true },
  ];
  const columnView = useTimelineColumns("roadmap", columns);
  const display = displayRows(visible);
  const conflicts = conflictsByProject(view.links);
  const chain = criticalIndex(view);
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
        (stop: RovingTarget) => <ProjectCell project={project} placement={canRank && !locked ? { index, count: display.length } : null} stop={stop} />,
        <FlagCountsCell key="flags" counts={countFlags(project.flags)} flowPending={(project.flowPendingTeamIds?.length ?? 0) > 0} pendingTeams={pendingTeamNames(project, teamNames)} />,
        (stop: RovingTarget) => <ProjectMenu project={project} rankedIndex={rankedIndex} rankedCount={rankedCount} canRank={canRank} locked={locked} actions={actions} trigger={stop} />,
      ],
      ...projectTrack(project, t, conflicts, jira, chain.projects.has(project.id), { proposed: preview.proposed.get(project.id), locked }),
    };
  }

  // A baseline picked (1.10): its deleted projects follow every current row (after the unranked block) - no rank, dimmed name, the frozen span as the shadow bar.
  const gone: TimelineRowData[] = removedProjectRows(removed, t).map((row) => ({
    id: row.id,
    cells: [
      <Text key="rank" component="span" size="sm" c="dimmed">
        —
      </Text>,
      <span key="name" title={`${row.programName} · ${row.workStreamName}`} style={{ minWidth: 0, display: "flex" }}>
        <BaselineRowName row={{ name: row.name, reason: "removed", movedTo: null }} />
      </span>,
      "",
      "",
    ],
    bars: [row.bar],
  }));
  const rows: TimelineRowData[] = [...display.map(rowOf), ...gone];

  const withSpan = new Set(display.flatMap((entry) => (entry.kind === "project" && entry.project.span !== null ? [entry.project.id] : [])));
  const names = new Map(display.flatMap((entry) => (entry.kind === "project" ? [[entry.project.id, entry.project.name] as const] : [])));
  const arrows = planArrows(t, view.links, names, (id) => (withSpan.has(id) ? id : null), chain.pairs);

  return (
    <Timeline
      ref={timelineRef}
      label={label}
      scale={scale}
      zooms={PLAN_ZOOMS}
      onZoomChange={onZoomChange}
      today={today}
      columns={columnView.columns}
      hiddenColumns={columnView.hidden}
      scrollRef={columnView.scrollRef}
      rows={rows}
      holidays={holidays}
      holidaysFailed={holidaysFailed}
      busy={busy}
      toolbar={<><TimelineColumnsControl view={columnView} />{toolbar}</>}
      overlay={arrows.length === 0 ? undefined : (geometry) => <TimelineArrows arrows={arrows} geometry={geometry} />}
    />
  );
}
