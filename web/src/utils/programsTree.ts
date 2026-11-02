import type { Movement } from "../api/baselines";
import type { ProgramsProgram, ProgramsView, ProgramsWorkStream } from "../api/programs";
import type { RoadmapProject } from "../api/roadmap";
import type { FlagCounts, ProgramOption } from "./roadmapRows";

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
/** A work stream or program row (the expandable ones). */
export type NodeRow = StreamRow | ProgramRow;
export type TreeRow = NodeRow | ProjectTreeRow;

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
 * expanded program its projects (ranked first, as the server lists them). `open` holds the keys of the expanded nodes; a node with no children
 * is never expanded.
 */
export function treeRows(view: ProgramsView, pick: ReadonlySet<number> | null, open: ReadonlySet<string>): TreeRow[] {
  const rows: TreeRow[] = [];
  for (const { stream, programs, span, flags, baseline } of shownStreams(view, pick)) {
    const key = streamKey(stream.id);
    const expanded = programs.length > 0 && open.has(key);
    rows.push({ kind: "workStream", key, id: stream.id, name: stream.name, ownerName: stream.ownerName, closed: stream.endDate !== null, span, flags, baseline, childCount: programs.length, expanded });
    if (!expanded) continue;
    for (const program of programs) {
      const programRowKey = programKey(program.id);
      const programExpanded = program.projects.length > 0 && open.has(programRowKey);
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
        childCount: program.projects.length,
        expanded: programExpanded,
      });
      if (programExpanded) for (const project of program.projects) rows.push({ kind: "project", project, programId: program.id });
    }
  }
  return rows;
}

/** What the page opens with: every work stream expanded (its programs show), every program collapsed. */
export function defaultOpen(view: ProgramsView): Set<string> {
  return new Set(view.workStreams.map((stream) => streamKey(stream.id)));
}

/** Every work stream and program that has children: "Expand all". */
export function allOpen(view: ProgramsView): Set<string> {
  return new Set(
    view.workStreams.flatMap((stream) => [
      ...(stream.programs.length > 0 ? [streamKey(stream.id)] : []),
      ...stream.programs.filter((program) => program.projects.length > 0).map((program) => programKey(program.id)),
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

/** Every date the page can show (spans, target windows and, with a baseline picked, the frozen spans of ALL projects): the range the timeline must cover, whatever is folded or picked away. */
export function treeDates(view: ProgramsView): string[] {
  return treeProjects(view).flatMap((project) =>
    [project.span?.start, project.span?.end, project.targetStart, project.targetEnd, project.baseline?.span?.start, project.baseline?.span?.end].filter((d): d is string => typeof d === "string"),
  );
}
