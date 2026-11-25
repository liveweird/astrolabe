import type { PlanProgram, PlanProject, PlanView, PlanWorkStream } from "../api/plan";
import { byNameThenId, foldDiacritics } from "./text";

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
  /** The row only shows the way to a match (drawn dimmed); never set while nothing is searched. */
  context: boolean;
};

type StreamRow = RowBase & { kind: "workStream"; depth: 0; stream: PlanWorkStream; childCount: number; expanded: boolean };
type ProgramRow = RowBase & { kind: "program"; depth: 1; stream: PlanWorkStream; program: PlanProgram; childCount: number; expanded: boolean };
type ProjectRow = RowBase & { kind: "project"; depth: 2; stream: PlanWorkStream; program: PlanProgram; project: PlanProject };

/** A work stream or program row: the ones that can fold (when they hold children). */
export type NodeRow = StreamRow | ProgramRow;
export type PlanTreeRow = NodeRow | ProjectRow;

/** What narrows the tree: a name search, one owner, and whether closed work streams are left out. */
export type PlanFilter = { q: string; ownerPersonId: number | null; hideClosed: boolean };
export const NO_FILTER: PlanFilter = { q: "", ownerPersonId: null, hideClosed: false };

/** Whether a search or an owner picks rows (hide closed alone only drops whole streams, so the stored folds still apply). */
export const isSearching = (filter: PlanFilter): boolean => foldDiacritics(filter.q.trim()) !== "" || filter.ownerPersonId !== null;

/** Whether any part of the filter is on. */
export const isFiltered = (filter: PlanFilter): boolean => isSearching(filter) || filter.hideClosed;

/** The node test of a search: the folded name contains the folded text (case- and accent-insensitive) AND the owner is the one picked. */
function matcher(filter: PlanFilter): (node: { name: string; ownerPersonId: number }) => boolean {
  const needle = foldDiacritics(filter.q.trim());
  return (node) => (needle === "" || foldDiacritics(node.name).includes(needle)) && (filter.ownerPersonId === null || node.ownerPersonId === filter.ownerPersonId);
}

/** The work streams the filter leaves: hide closed drops the streams with an end date. */
const shownStreams = (view: PlanView, filter: PlanFilter): PlanWorkStream[] => (filter.hideClosed ? view.workStreams.filter((stream) => stream.endDate === null) : view.workStreams);

/** A node's place in a search: shown at all, and shown only as the way to a match (a context row). */
type Show = { shown: boolean; context: boolean };
const HIDDEN: Show = { shown: false, context: false };
const SHOWN: Show = { shown: true, context: false };
const CONTEXT: Show = { shown: true, context: true };

/**
 * The visible rows, top to bottom, in the server's order: every shown work stream, under an EXPANDED one its programs, under an expanded program
 * its projects. `collapsed` holds the keys of the folded nodes (a key the plan does not hold is ignored, a node with no children never folds), so a
 * node nobody has folded - a new one included - is open.
 *
 * With a search or an owner in `filter` only the matches show, with the way to them and what is under them: a match, its ancestors as CONTEXT rows
 * (`context: true`, drawn dimmed) and its descendants. The counts on a row are always the document's own. The caller decides which folds apply
 * (the stored ones with no search, a transient set while one runs: `usePlanFolds`).
 */
export function planRows(view: PlanView, collapsed: ReadonlySet<string>, filter: PlanFilter = NO_FILTER): PlanTreeRow[] {
  const searching = isSearching(filter);
  const matches = matcher(filter);
  const rows: PlanTreeRow[] = [];
  for (const stream of shownStreams(view, filter)) {
    const sKey = streamKey(stream.id);
    const streamMatch = searching && matches(stream);
    // What each program and project shows, from its own match, its ancestors' and its descendants' (a program is context when only a project below matches).
    const programShows = stream.programs.map((program): { show: Show; projects: Show[] } => {
      const programMatch = searching && matches(program);
      const projects = program.projects.map((project): Show => (!searching || streamMatch || programMatch || matches(project) ? SHOWN : HIDDEN));
      const below = projects.some((project) => project.shown);
      const show = !searching || streamMatch || programMatch ? SHOWN : below ? CONTEXT : HIDDEN;
      return { show, projects };
    });
    const streamShow = !searching || streamMatch ? SHOWN : programShows.some((entry) => entry.show.shown) ? CONTEXT : HIDDEN;
    if (!streamShow.shown) continue;
    const streamOpen = stream.programs.length > 0 && !collapsed.has(sKey);
    rows.push({ kind: "workStream", key: sKey, parentKey: null, depth: 0, context: streamShow.context, stream, childCount: stream.programs.length, expanded: streamOpen });
    if (!streamOpen) continue;
    stream.programs.forEach((program, index) => {
      const { show, projects } = programShows[index];
      if (!show.shown) return;
      const pKey = programKey(program.id);
      const programOpen = program.projects.length > 0 && !collapsed.has(pKey);
      rows.push({ kind: "program", key: pKey, parentKey: sKey, depth: 1, context: show.context, stream, program, childCount: program.projects.length, expanded: programOpen });
      if (!programOpen) return;
      program.projects.forEach((project, at) => {
        if (projects[at].shown) rows.push({ kind: "project", key: projectKey(project.id), parentKey: pKey, depth: 2, context: false, stream, program, project });
      });
    });
  }
  return rows;
}

/** How many nodes match a search (its context rows and what is under a match do not count); 0 while nothing is searched. */
export function matchCount(view: PlanView, filter: PlanFilter): number {
  if (!isSearching(filter)) return 0;
  const matches = matcher(filter);
  let count = 0;
  for (const stream of shownStreams(view, filter)) {
    if (matches(stream)) count++;
    for (const program of stream.programs) {
      if (matches(program)) count++;
      for (const project of program.projects) if (matches(project)) count++;
    }
  }
  return count;
}

/** The keys of every SHOWN node that has children (what Collapse all folds), for the rows the filter shows. */
export function foldableKeys(view: PlanView, filter: PlanFilter = NO_FILTER): string[] {
  return planRows(view, new Set(), filter)
    .filter((row) => row.kind !== "project" && row.childCount > 0)
    .map((row) => row.key);
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

/**
 * The folded set after the user's change: `fold` keys added, `open` keys removed, everything else kept (a fold the change does not mention - a
 * hidden closed stream's, say - stays), and the keys of nodes the plan no longer holds (a deleted node's) dropped.
 */
export function withFolds(view: PlanView, collapsed: ReadonlySet<string>, change: { fold?: readonly string[]; open?: readonly string[] }): string[] {
  const next = new Set(collapsed);
  for (const key of change.fold ?? []) next.add(key);
  for (const key of change.open ?? []) next.delete(key);
  const known = nodeKeys(view);
  return [...next].filter((candidate) => known.has(candidate));
}

/** The folded set with `key` flipped (see {@link withFolds}). */
export function toggledCollapsed(view: PlanView, collapsed: ReadonlySet<string>, key: string): string[] {
  return withFolds(view, collapsed, collapsed.has(key) ? { open: [key] } : { fold: [key] });
}

/** The node's own name. */
export function rowName(row: PlanTreeRow): string {
  return row.kind === "workStream" ? row.stream.name : row.kind === "program" ? row.program.name : row.project.name;
}

/** The people who own at least one node of the plan (the owner filter's options), by name; one entry per person. */
export function ownerOptions(view: PlanView): { id: number; name: string }[] {
  const owners = new Map<number, string>();
  for (const stream of view.workStreams) {
    owners.set(stream.ownerPersonId, stream.ownerName);
    for (const program of stream.programs) {
      owners.set(program.ownerPersonId, program.ownerName);
      for (const project of program.projects) owners.set(project.ownerPersonId, project.ownerName);
    }
  }
  return [...owners].map(([id, name]) => ({ id, name })).sort(byNameThenId);
}
