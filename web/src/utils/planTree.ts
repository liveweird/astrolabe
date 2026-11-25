import type { PlanProgram, PlanProject, PlanView, PlanWorkStream } from "../api/plan";

// The Plan page's pure model: the plan view's tree (work stream -> program -> project, in the server's order) turned into the rows of ONE table
// for a set of folded nodes. No React and no i18n here; the components make the cells and the sentences. The page's later pieces (the filters,
// the pins, the order) slot in as more inputs to `planRows` and more fields on the row, never as another tree walk.

/** The key of a work stream's row: its fold key and its `data-key`. Stable across reloads (kind + id). */
export const streamKey = (id: number) => `ws:${id}`;
/** The key of a program's row. */
export const programKey = (id: number) => `pg:${id}`;
/** The key of a project's row. */
export const projectKey = (id: number) => `pj:${id}`;

type RowBase = {
  /** The node's key (`ws:<id>` / `pg:<id>` / `pj:<id>`). */
  key: string;
  /** The key of the node's parent row; `null` for a work stream. */
  parentKey: string | null;
  /** The row only shows the way to a match (dimmed); never set while nothing filters the tree. */
  context: boolean;
};

type StreamRow = RowBase & { kind: "workStream"; depth: 0; stream: PlanWorkStream; childCount: number; expanded: boolean };
type ProgramRow = RowBase & { kind: "program"; depth: 1; stream: PlanWorkStream; program: PlanProgram; childCount: number; expanded: boolean };
type ProjectRow = RowBase & { kind: "project"; depth: 2; stream: PlanWorkStream; program: PlanProgram; project: PlanProject };

/** A work stream or program row: the ones that can fold (when they hold children). */
export type NodeRow = StreamRow | ProgramRow;
export type PlanTreeRow = NodeRow | ProjectRow;

/**
 * The visible rows, top to bottom: every work stream, under an EXPANDED one its programs, under an expanded program its projects. `collapsed`
 * holds the keys of the folded nodes (a key the plan does not hold is ignored, and a node with no children never folds), so a node nobody has
 * folded - a new one included - is open.
 */
export function planRows(view: PlanView, collapsed: ReadonlySet<string>): PlanTreeRow[] {
  const rows: PlanTreeRow[] = [];
  for (const stream of view.workStreams) {
    const sKey = streamKey(stream.id);
    const streamOpen = stream.programs.length > 0 && !collapsed.has(sKey);
    rows.push({ kind: "workStream", key: sKey, parentKey: null, depth: 0, context: false, stream, childCount: stream.programs.length, expanded: streamOpen });
    if (!streamOpen) continue;
    for (const program of stream.programs) {
      const pKey = programKey(program.id);
      const programOpen = program.projects.length > 0 && !collapsed.has(pKey);
      rows.push({ kind: "program", key: pKey, parentKey: sKey, depth: 1, context: false, stream, program, childCount: program.projects.length, expanded: programOpen });
      if (!programOpen) continue;
      for (const project of program.projects) {
        rows.push({ kind: "project", key: projectKey(project.id), parentKey: pKey, depth: 2, context: false, stream, program, project });
      }
    }
  }
  return rows;
}

/** The keys of every node that has children (what Collapse all folds). */
export function foldableKeys(view: PlanView): string[] {
  return view.workStreams.flatMap((stream) => [
    ...(stream.programs.length > 0 ? [streamKey(stream.id)] : []),
    ...stream.programs.flatMap((program) => (program.projects.length > 0 ? [programKey(program.id)] : [])),
  ]);
}

/** The keys of every node of the plan: what a stored set is pruned against when the user changes it (never while a view is missing). */
function nodeKeys(view: PlanView): Set<string> {
  const keys = new Set<string>();
  for (const stream of view.workStreams) {
    keys.add(streamKey(stream.id));
    for (const program of stream.programs) {
      keys.add(programKey(program.id));
      for (const project of program.projects) keys.add(projectKey(project.id));
    }
  }
  return keys;
}

/** The folded set with `key` flipped, written as the user's change: keys of nodes the plan no longer holds (a deleted node's) are dropped. */
export function toggledCollapsed(view: PlanView, collapsed: ReadonlySet<string>, key: string): string[] {
  const next = new Set(collapsed);
  if (!next.delete(key)) next.add(key);
  const known = nodeKeys(view);
  return [...next].filter((candidate) => known.has(candidate));
}

/** The node's own name. */
export function rowName(row: PlanTreeRow): string {
  return row.kind === "workStream" ? row.stream.name : row.kind === "program" ? row.program.name : row.project.name;
}
