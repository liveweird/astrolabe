import type { Movement } from "../api/baselines";
import type { ProgramsProgram, ProgramsView, ProgramsWorkStream } from "../api/programs";
import type { RoadmapProject } from "../api/roadmap";
import { removedProjectDays, type RemovedProjectRow } from "./baselineOverlay";
import { jiraRangeDates, type JiraWindow } from "./jiraBars";
import type { FlagCounts, ProgramOption } from "./roadmapRows";
import type { BarId } from "./timelineModel";

// The programs page's pure model: the server's tree (work stream -> program -> project) turned into the rows of the timeline for the program
// pick and the set of expanded nodes. No React and no i18n here - the page's components make cells, bars and sentences. Every figure the server
// derived (spans, flag counts, drift) is only READ; the one thing computed here is the roll-up of a work stream that the pick shows only in part
// (its own figures count programs the viewer has hidden), and that is the server's own definition over the programs that remain.

type DateSpan = { start: string; end: string };
type NodeBaseline = { span: DateSpan; movement: Movement | null };

/** The key of a work stream's row in the expanded set. */
const streamKey = (id: number) => `ws:${id}`;
/** The key of a program's row in the expanded set. */
const programKey = (id: number) => `pg:${id}`;

type NodeBase = {
  /** The node's key in the expanded set (`ws:<id>` / `pg:<id>`); also the timeline row's id. */
  key: string;
  id: number;
  name: string;
  ownerName: string;
  /** The derived span over the node's projects (a work stream's over its shown programs'); `null` while none is scheduled. */
  span: DateSpan | null;
  /** The roll-up of the flags raised on the node's projects. */
  flags: FlagCounts;
  /**
   * With a baseline picked (v0.9): the span the node's baselined projects had then and its movement against the live span (`null` movement for a work
   * stream the pick shows in part - rolled up over the programs that remain, whose own movement the server does not know); `null` = nothing to draw.
   */
  baseline: NodeBaseline | null;
  /** The children one level down (programs of a stream, projects of a program); a node with none cannot be expanded. */
  childCount: number;
  expanded: boolean;
};

type StreamRow = NodeBase & { kind: "workStream"; /** The stream has an end date: it was closed (it still takes programs). */ closed: boolean };
type ProgramRow = NodeBase & { kind: "program"; workStreamId: number };
export type ProjectTreeRow = { kind: "project"; project: RoadmapProject; programId: number };
/** A project the baseline froze that is deleted now (1.10), appended under the program it sat in when that program is shown and expanded. */
export type RemovedTreeRow = { kind: "removedProject"; removed: RemovedProjectRow; programId: number };
/** A work stream or program row (the expandable ones). */
export type NodeRow = StreamRow | ProgramRow;
export type TreeRow = NodeRow | ProjectTreeRow | RemovedTreeRow;

/** The earliest start to the latest end over the spans that exist; `null` when there is none. ISO dates compare as strings. */
function unionSpan(spans: readonly (DateSpan | null)[]): DateSpan | null {
  const present = spans.filter((span): span is DateSpan => span !== null);
  if (present.length === 0) return null;
  return { start: present.reduce((a, b) => (b.start < a ? b.start : a), present[0].start), end: present.reduce((a, b) => (b.end > a ? b.end : a), present[0].end) };
}

const sumFlags = (all: readonly FlagCounts[]): FlagCounts => all.reduce((sum, flags) => ({ warnings: sum.warnings + flags.warnings, infos: sum.infos + flags.infos }), { warnings: 0, infos: 0 });

type ShownStream = { stream: ProgramsWorkStream; programs: ProgramsProgram[]; span: DateSpan | null; flags: FlagCounts; baseline: NodeBaseline | null };

/** A node's baseline as the row draws it: only a span that exists is drawn. */
const nodeBaseline = (baseline: { span: DateSpan | null; movement: Movement } | undefined): NodeBaseline | null =>
  baseline?.span ? { span: baseline.span, movement: baseline.movement } : null;

/** The baseline of a work stream shown in part: the union of the shown programs' frozen spans (no movement: the server's belongs to the whole stream). */
function partialBaseline(programs: readonly ProgramsProgram[]): NodeBaseline | null {
  const span = unionSpan(programs.map((program) => program.baseline?.span ?? null));
  return span === null ? null : { span, movement: null };
}

/**
 * The work streams the program pick leaves (`null` = no pick: every stream, empty ones too) with the programs it leaves in each. A picked program
 * keeps its work stream's row; a stream with no picked program is hidden. A stream that shows all its programs keeps the server's span and counts;
 * one the pick shows in part is rolled up over the programs that remain, so its bar and counts do not speak for programs the viewer left out.
 */
function shownStreams(view: ProgramsView, pick: ReadonlySet<number> | null): ShownStream[] {
  return view.workStreams.flatMap((stream) => {
    const programs = pick === null ? stream.programs : stream.programs.filter((program) => pick.has(program.id));
    if (pick !== null && programs.length === 0) return [];
    const whole = programs.length === stream.programs.length;
    return [
      {
        stream,
        programs,
        span: whole ? stream.span : unionSpan(programs.map((program) => program.span)),
        flags: whole ? stream.flags : sumFlags(programs.map((program) => program.flags)),
        baseline: whole ? nodeBaseline(stream.baseline) : partialBaseline(programs),
      },
    ];
  });
}

/**
 * The rows of the timeline, top to bottom, in the server's order: a row per shown work stream, under an EXPANDED one its shown programs, under an
 * expanded program its projects (ranked first, as the server lists them), then the `removed` rows (1.10: the baseline's deleted projects, pre-built
 * by `removedProjectRows`) whose program it was - one whose program is gone, hidden by the pick or folded draws nothing. They count as the program's
 * children, so a program whose live projects are all deleted can still be expanded. `open` holds the keys of the expanded nodes; a node with no
 * children is never expanded.
 */
export function treeRows(view: ProgramsView, pick: ReadonlySet<number> | null, open: ReadonlySet<string>, removed: readonly RemovedProjectRow[] = []): TreeRow[] {
  const rows: TreeRow[] = [];
  for (const { stream, programs, span, flags, baseline } of shownStreams(view, pick)) {
    const key = streamKey(stream.id);
    const expanded = programs.length > 0 && open.has(key);
    rows.push({ kind: "workStream", key, id: stream.id, name: stream.name, ownerName: stream.ownerName, closed: stream.endDate !== null, span, flags, baseline, childCount: programs.length, expanded });
    if (!expanded) continue;
    for (const program of programs) {
      const programRowKey = programKey(program.id);
      const gone = removed.filter((row) => row.programId === program.id);
      const childCount = program.projects.length + gone.length;
      const programExpanded = childCount > 0 && open.has(programRowKey);
      rows.push({
        kind: "program",
        key: programRowKey,
        id: program.id,
        name: program.name,
        ownerName: program.ownerName,
        workStreamId: stream.id,
        span: program.span,
        flags: program.flags,
        baseline: nodeBaseline(program.baseline),
        childCount,
        expanded: programExpanded,
      });
      if (!programExpanded) continue;
      for (const project of program.projects) rows.push({ kind: "project", project, programId: program.id });
      for (const row of gone) rows.push({ kind: "removedProject", removed: row, programId: program.id });
    }
  }
  return rows;
}

/**
 * The bar that stands for each project on the timeline (1.16, the arrows' ends): the project's own span bar (its id) while its work stream and program
 * are open, else its program's summary bar (`pg:<id>`; the stream open, the program folded), else its work stream's (`ws:<id>`; the stream folded). A project
 * of a program the pick hides has no entry (the stream's bar does not speak for it), and a row with no span bar anchors nothing: no entry either. The folds are
 * `treeRows`' own (a node with no children is never open; a program's deleted-project rows leave the projects' anchors alone).
 */
export function arrowAnchors(view: ProgramsView, pick: ReadonlySet<number> | null, open: ReadonlySet<string>): Map<number, BarId> {
  const anchors = new Map<number, BarId>();
  for (const { stream, programs, span } of shownStreams(view, pick)) {
    const streamOpen = programs.length > 0 && open.has(streamKey(stream.id));
    for (const program of programs) {
      const programOpen = streamOpen && program.projects.length > 0 && open.has(programKey(program.id));
      for (const project of program.projects) {
        // The deepest row the tree shows for the project, with the span its bar is drawn over.
        let bar: { id: BarId; span: DateSpan | null } = { id: streamKey(stream.id), span };
        if (programOpen) bar = { id: project.id, span: project.span };
        else if (streamOpen) bar = { id: programKey(program.id), span: program.span };
        if (bar.span !== null) anchors.set(project.id, bar.id);
      }
    }
  }
  return anchors;
}

/** Is this row a work stream or program (the expandable ones, with a `key`)? */
export const isNodeRow = (row: TreeRow): row is NodeRow => row.kind === "workStream" || row.kind === "program";

/** What the page opens with: every work stream expanded (its programs show), every program collapsed. */
export function defaultOpen(view: ProgramsView): Set<string> {
  return new Set(view.workStreams.map((stream) => streamKey(stream.id)));
}

/** Every work stream and program that has children (the `removed` rows count, as in `treeRows`): "Expand all". */
export function allOpen(view: ProgramsView, removed: readonly RemovedProjectRow[] = []): Set<string> {
  return new Set(
    view.workStreams.flatMap((stream) => [
      ...(stream.programs.length > 0 ? [streamKey(stream.id)] : []),
      ...stream.programs.filter((program) => program.projects.length > 0 || removed.some((row) => row.programId === program.id)).map((program) => programKey(program.id)),
    ]),
  );
}

/** The expanded set with one node flipped. */
export function toggled(open: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(open);
  if (!next.delete(key)) next.add(key);
  return next;
}

/** The programs of the view (the program pick's options), by name; the work stream tells two programs of one name apart. */
export function programChoices(view: ProgramsView): ProgramOption[] {
  return view.workStreams
    .flatMap((stream) => stream.programs.map((program) => ({ id: program.id, name: program.name, workStreamName: stream.name })))
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id - b.id);
}

/** What the pick leaves of the plan, for the facts line: the counts of shown work streams, programs and projects, and the flag roll-up over them. */
export function treeFacts(view: ProgramsView, pick: ReadonlySet<number> | null): { workStreams: number; programs: number; projects: number; flags: FlagCounts } {
  const shown = shownStreams(view, pick);
  const programs = shown.flatMap((entry) => entry.programs);
  return {
    workStreams: shown.length,
    programs: programs.length,
    projects: programs.reduce((sum, program) => sum + program.projects.length, 0),
    flags: sumFlags(shown.map((entry) => entry.flags)),
  };
}

/** Every project of the plan, in the tree's order, whatever is folded or picked away. */
export function treeProjects(view: ProgramsView): RoadmapProject[] {
  return view.workStreams.flatMap((stream) => stream.programs.flatMap((program) => program.projects));
}

/**
 * Every date the page can show (spans, target windows and, with a baseline picked, the frozen spans of ALL projects and of the deleted ones): the range the timeline must cover,
 * whatever is folded or picked away. With the page's Jira `window` (the "Jira dates" toggle on, `jiraWindow(treeDates(view), today)`) the Jira dates of
 * each bound project join it, CUT at the window so a mistyped Jira date cannot stretch the grow-only range.
 */
export function treeDates(view: ProgramsView, jira: JiraWindow | null = null): string[] {
  const projects = treeProjects(view);
  const own = projects.flatMap((project) =>
    [project.span?.start, project.span?.end, project.targetStart, project.targetEnd, project.baseline?.span?.start, project.baseline?.span?.end].filter((d): d is string => typeof d === "string"),
  );
  const days = [...own, ...removedProjectDays(view.baseline?.removedProjects)];
  if (jira === null) return days;
  return [...days, ...jiraRangeDates(projects, jira)];
}
