import type { ReactNode, Ref } from "react";
import { ActionIcon, Group, Text } from "@mantine/core";
import { IconChevronDown, IconChevronRight } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { RoadmapCriticalPath, RoadmapLink, RoadmapProject } from "../api/roadmap";
import { useHolidays } from "../hooks/useHolidays";
import { useTimelineColumns } from "../hooks/useTimelineColumns";
import { shadowBar } from "../utils/baselineOverlay";
import type { JiraWindow } from "../utils/jiraBars";
import { planArrows, projectTrack, proposedSpanBar, withConflicts } from "../utils/planTrack";
import { isNodeRow, type NodeRow, type ProjectTreeRow, type RemovedTreeRow, type TreeRow } from "../utils/programsTree";
import { criticalIndex } from "../utils/roadmapCritical";
import { conflictsByProject, conflictsByRow, countFlags, pendingTeamNames, rolledUpLinks } from "../utils/roadmapRows";
import type { BarId, RovingTarget, TimelineBarData, TimelineColumn, TimelineRowData } from "../utils/timelineModel";
import { PLAN_ZOOMS, type TimelineScale, type Zoom } from "../utils/timelineScale";
import { BaselineRowName } from "./BaselineParts";
import { CriticalPathItem, DependenciesItem, FlagCountsCell, OpenProjectItem, ProjectLink, TargetWindowItems, type WindowActions } from "./PlanProjectCells";
import EntityLink from "./EntityLink";
import OpenEntityItem from "./OpenEntityItem";
import RowActionsMenu from "./RowActionsMenu";
import Timeline, { type TimelineHandle } from "./Timeline";
import TimelineArrows from "./TimelineArrows";
import TimelineColumnsControl from "./TimelineColumnsControl";

/** The sticky left columns: 448 px in all (the roll-up counts of a work stream run to three digits - found on the sample plan - hence the much wider Flags column than the roadmap's 64 px). */
const COLUMN_WIDTHS = { name: 272, flags: 120, actions: 56 } as const;

/**
 * A name cell's links sit in their own flex items (never one run of text beside other text: axe `link-in-text-block` would ask the theme's underline-on-hover
 * links for an underline); the whitespace between the items keeps the cell's text reading "Name Owner". The owner shrinks first.
 */
const FLEX_FIRST = { minWidth: 0 } as const;
const FLEX_LAST = { minWidth: 0, flexShrink: 1000 } as const;

/** The indent per tree level, and the width of the chevron's slot (a row with nothing to expand keeps the slot, so the names line up). */
const INDENT = 16;
const CHEVRON_SLOT = 22;

/** The node the page is narrowed to (a work stream by `workStreamId`, a sole picked program): its own row names it, so its name is plain text there. */
export type OwnNode = { kind: "workStream" | "program"; id: number };

/**
 * The name of a tree row (1.31): the chevron button of an expandable node (`aria-expanded`; its name tells the level - "Work stream X" / "Program Y" - and it is
 * the ONE roving stop of the cell), then the name as the link to the work stream's or program's overview (the pointer's link: the row menu's "Open ..." item is
 * the keyboard's) with the owner, a link too, dimmed after it. A node with no children has no chevron: its name is the cell's stop (`stop`), plain text for the
 * node the page is narrowed to (`own`, rule 1).
 */
function NodeLabel({ row, own, onToggle, stop }: { row: NodeRow; own: OwnNode | null; onToggle: (key: string) => void; stop: RovingTarget }) {
  const { t } = useTranslation();
  const stream = row.kind === "workStream";
  const chevron = row.childCount > 0;
  const name = { entity: { kind: row.kind, id: row.id }, name: row.name, fw: stream ? 700 : 600, current: own?.kind === row.kind && own.id === row.id } as const;
  return (
    <Group gap={4} wrap="nowrap" style={{ minWidth: 0, paddingLeft: stream ? 0 : INDENT }}>
      {chevron ? (
        <ActionIcon
          size="sm"
          data-node-key={row.key}
          aria-expanded={row.expanded}
          aria-label={t(stream ? "programs.streamAria" : "programs.programAria", { name: row.name })}
          onClick={() => onToggle(row.key)}
          {...stop}
        >
          {row.expanded ? <IconChevronDown size={16} /> : <IconChevronRight size={16} />}
        </ActionIcon>
      ) : (
        <span aria-hidden="true" style={{ width: CHEVRON_SLOT, flex: "none" }} />
      )}
      <Text component="span" size="sm" truncate style={FLEX_FIRST}>
        {chevron ? <EntityLink {...name} secondary /> : <EntityLink {...name} stop={stop} />}
      </Text>
      {row.kind === "workStream" && row.closed && (
        <>
          {" "}
          <Text component="span" size="sm" c="dimmed" style={{ flex: "none" }}>
            ({t("programs.closed")})
          </Text>
        </>
      )}{" "}
      <Text component="span" size="sm" truncate style={FLEX_LAST}>
        <EntityLink entity={{ kind: "person", id: row.ownerPersonId }} name={row.ownerName} c="dimmed" secondary />
      </Text>
    </Group>
  );
}

/** A node row's menu: "Open ..." for its owner and, while the chevron holds the cell's stop, for its name (the keyboard's way to the links the pointer has). */
function NodeMenu({ row, own, stop }: { row: NodeRow; own: OwnNode | null; stop: RovingTarget }) {
  const { t } = useTranslation();
  const named = row.childCount > 0 && !(own?.kind === row.kind && own.id === row.id);
  return (
    <RowActionsMenu label={t("common.table.operationsAria", { name: row.name })} trigger={{ ...stop, "data-operations-for": row.key }}>
      {named && <OpenEntityItem entity={{ kind: row.kind, id: row.id }} name={row.name} />}
      <OpenEntityItem entity={{ kind: "person", id: row.ownerPersonId }} name={row.ownerName} />
    </RowActionsMenu>
  );
}

/** The name cell of a project row: indented under its program, the name as the link into the project (the roving stop), the owner dimmed after it (the pointer's link). */
function ProjectLabel({ project, stop }: { project: RoadmapProject; stop: RovingTarget }) {
  return (
    <Group gap={4} wrap="nowrap" style={{ minWidth: 0, paddingLeft: 2 * INDENT }}>
      <span aria-hidden="true" style={{ width: CHEVRON_SLOT, flex: "none" }} />
      <Text component="span" size="sm" truncate style={FLEX_FIRST}>
        <ProjectLink project={project} stop={stop} />
      </Text>{" "}
      <Text component="span" size="sm" truncate style={FLEX_LAST}>
        <EntityLink entity={{ kind: "person", id: project.ownerPersonId }} name={project.ownerName} c="dimmed" secondary />
      </Text>
    </Group>
  );
}

/** The name cell of a deleted project's row (1.10): indented like a project row, dimmed, "(removed)" after the name, its program and work stream as the title. */
function RemovedLabel({ row }: { row: RemovedTreeRow["removed"] }) {
  return (
    <Group gap={4} wrap="nowrap" style={{ minWidth: 0, paddingLeft: 2 * INDENT }} title={`${row.programName} · ${row.workStreamName}`}>
      <span aria-hidden="true" style={{ width: CHEVRON_SLOT, flex: "none" }} />
      <BaselineRowName row={{ name: row.name, reason: "removed", movedTo: null }} />
    </Group>
  );
}

/**
 * A work stream's or program's summary bar: the span its projects cover, read-only; with a baseline picked the span they had then follows
 * as a thin shadow bar (also where nothing is scheduled any more). `conflicts` = the violated links of the rolled-up arrows that end on the row
 * (1.16), said after the span like a project row's. `holdsCritical` (1.16) = the row is FOLDED over a project on the picked critical path (it stands for
 * it, `arrowAnchors`): the bar is outlined and says so; an expanded node is not (its children are). A node with a `proposedSpan` (1.33, a previewed
 * schedule proposal) gets the dashed proposal bar `proposal:<key>` over the span its projects would cover.
 */
function summaryBars(row: NodeRow, t: TFunction, conflicts: number, holdsCritical: boolean): TimelineBarData[] {
  const bars: TimelineBarData[] = [];
  if (row.span !== null) {
    const { start, end } = row.span;
    const key = row.kind === "workStream" ? "programs.streamBarAria" : "programs.programBarAria";
    const describe = withConflicts(t, t(key, { name: row.name, start, end }), conflicts);
    const bar: TimelineBarData = { id: row.key, start, end, label: row.name, describe, editable: false, tone: "summary" };
    bars.push(holdsCritical ? { ...bar, describe: `${describe}, ${t("programs.barCriticalInside")}`, emphasis: "critical" } : bar);
  }
  if (row.proposedSpan !== undefined) bars.push(proposedSpanBar(row.key, row.name, row.proposedSpan, t));
  if (row.baseline !== null) bars.push(shadowBar(row.key, row.name, row.baseline.span, row.baseline.movement, t));
  return bars;
}

/**
 * The programs page's timeline: the plan as a tree on the shared Timeline - a row per work stream, under an expanded one its programs, under an
 * expanded program its projects. A stream or program row shows its derived span as a summary bar and the roll-up of its projects' flags; a project
 * row is the roadmap's (`projectTrack`: the window and span bars, the drift band; the flag icons; a menu with the link into the project). The
 * arrows are the links between the projects whose rows are shown and, where a project's row is folded away, between the folded program or work stream
 * that stands for it (`anchors`, one arrow per pair of rows). It must sit inside the page's `TimelineDndContext`; nothing here
 * writes or decides rights - a project's window bar is editable, its draw surface present and its menu offers the window items by the
 * project's own `can.editTargetWindow`, and the page's write path answers the proposals. The picked critical path (1.16, `criticalPath`, the roadmap's
 * block) outlines the project rows on the chain and the arrows of its pairs, and - where the row of a chain project is folded - the folded program or work
 * stream that stands for it; `critical` is the row menu's "Show / Hide critical path" item. `locked` (1.33, a schedule proposal is requested or open)
 * makes the target windows read-only: no editable band, no draw surface, no window items in the row menu.
 */
export default function ProgramsTimeline({
  links,
  teams,
  rows: treeRows,
  anchors,
  onToggle,
  windowActions,
  menuClosed,
  scale,
  onZoomChange,
  today,
  busy,
  label,
  timelineRef,
  toolbar,
  jira,
  criticalPath,
  critical,
  own,
  locked = false,
}: {
  links: readonly RoadmapLink[];
  /** The view's `teams` (active teams with milestones): the names of a project's Flow-pending teams. */
  teams: readonly { id: number; name: string }[];
  rows: readonly TreeRow[];
  /** The bar that stands for each project on the timeline (`arrowAnchors`): the project's own, or its folded program's or work stream's summary bar. */
  anchors: ReadonlyMap<number, BarId>;
  /** Flip a work stream or program (the page owns the expanded set and says what happened). */
  onToggle: (key: string) => void;
  /** The target window's menu items of a project row (shown only for a project whose `can.editTargetWindow` is set). */
  windowActions: WindowActions;
  /** A project row's menu has finished closing (its exit transition is over): the page puts the focus back here if a menu action just ran. */
  menuClosed: (project: RoadmapProject) => void;
  scale: TimelineScale;
  onZoomChange: (zoom: Zoom) => void;
  today: string;
  /** A write is in flight (`aria-busy` on the grid). */
  busy: boolean;
  label: string;
  timelineRef: Ref<TimelineHandle>;
  /** The Timeline's `toolbar` slot: the page's baseline picker and the "Jira dates" toggle. */
  toolbar?: ReactNode;
  /** The page's Jira window while the "Jira dates" toggle is on (each project's Jira shadow bar), else `null`. */
  jira: JiraWindow | null;
  /** The view's critical-path block while a target is set (1.16), else `undefined`: with none, nothing here differs from 1.15. */
  criticalPath: RoadmapCriticalPath | undefined;
  /** The row menu's critical-path item: the page's target, whether a write is in flight, and the toggle. */
  critical: { target: number | null; disabled: boolean; toggle: (project: RoadmapProject) => void };
  /** The work stream or program the page is narrowed to, whose own row shows its name as plain text; `null` = none. */
  own: OwnNode | null;
  locked?: boolean;
}) {
  const { t } = useTranslation();
  const { holidays, failed: holidaysFailed } = useHolidays();
  const columns: TimelineColumn[] = [
    { id: "name", header: t("programs.column.name"), width: COLUMN_WIDTHS.name },
    { id: "flags", header: t("roadmap.column.flags"), width: COLUMN_WIDTHS.flags, hideable: true },
    { id: "actions", header: t("common.table.operations"), width: COLUMN_WIDTHS.actions },
  ];
  const columnView = useTimelineColumns("programs", columns);
  const projects = treeRows.filter((row): row is ProjectTreeRow => row.kind === "project").map((row) => row.project);
  const conflicts = conflictsByProject(links);
  const teamNames = new Map(teams.map((team) => [team.id, team.name]));
  const anchorOf = (projectId: number) => anchors.get(projectId) ?? null;
  const rowConflicts = conflictsByRow(rolledUpLinks(links, anchorOf));
  const chain = criticalIndex({ criticalPath });
  // The folded rows that stand for a project on the chain (a node key, never a project id: an open row's own project bar is emphasised instead).
  const holdsCritical = new Set<BarId>([...chain.projects].flatMap((id) => anchors.get(id) ?? []).filter((bar) => typeof bar === "string"));

  function rowOf(row: TreeRow): TimelineRowData {
    if (row.kind === "removedProject") return { id: row.removed.id, cells: [<RemovedLabel key="name" row={row.removed} />, "", ""], bars: [row.removed.bar] };
    if (isNodeRow(row)) {
      return {
        id: row.key,
        // A node with something to expand puts its chevron button on the roving stop, a leaf node its name; the menu holds the "Open ..." items of the links out of the tab order.
        cells: [(stop: RovingTarget) => <NodeLabel row={row} own={own} onToggle={onToggle} stop={stop} />, <FlagCountsCell key="flags" counts={row.flags} />, (stop: RovingTarget) => <NodeMenu row={row} own={own} stop={stop} />],
        bars: summaryBars(row, t, rowConflicts.get(row.key) ?? 0, holdsCritical.has(row.key)),
      };
    }
    const { project } = row;
    return {
      id: project.id,
      cells: [
        (stop: RovingTarget) => <ProjectLabel project={project} stop={stop} />,
        <FlagCountsCell key="flags" counts={countFlags(project.flags)} flowPending={(project.flowPendingTeamIds?.length ?? 0) > 0} pendingTeams={pendingTeamNames(project, teamNames)} />,
        (stop: RovingTarget) => (
          <RowActionsMenu label={t("common.table.operationsAria", { name: project.name })} trigger={{ ...stop, "data-operations-for": project.id }} onClosed={() => menuClosed(project)}>
            <CriticalPathItem project={project} target={critical.target} disabled={critical.disabled} onToggle={() => critical.toggle(project)} />
            {!locked && <TargetWindowItems project={project} actions={windowActions} />}
            <DependenciesItem project={project} />
            <OpenProjectItem project={project} />
            <OpenEntityItem entity={{ kind: "person", id: project.ownerPersonId }} name={project.ownerName} />
          </RowActionsMenu>
        ),
      ],
      ...projectTrack(project, t, conflicts, jira, chain.projects.has(project.id), { proposed: row.proposed, locked }),
    };
  }

  const names = new Map<BarId, string>([...projects.map((project) => [project.id, project.name] as const), ...treeRows.filter(isNodeRow).map((row) => [row.key, row.name] as const)]);
  const arrows = planArrows(t, links, names, anchorOf, chain.pairs);

  return (
    <Timeline
      ref={timelineRef}
      label={label}
      scale={scale}
      zooms={PLAN_ZOOMS}
      onZoomChange={onZoomChange}
      today={today}
      columns={columns}
      hiddenColumns={columnView.hidden}
      rows={treeRows.map(rowOf)}
      holidays={holidays}
      holidaysFailed={holidaysFailed}
      busy={busy}
      toolbar={<><TimelineColumnsControl view={columnView} />{toolbar}</>}
      overlay={arrows.length === 0 ? undefined : (geometry) => <TimelineArrows arrows={arrows} geometry={geometry} />}
    />
  );
}
