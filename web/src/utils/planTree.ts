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
  /** The key of the node's parent row; `null` for a work stream (and for the root of a focus or of a pinned subtree). */
  parentKey: string | null;
  /** The row only shows the way to a match (drawn dimmed); never set while nothing is searched. */
  context: boolean;
  /** How far the row is indented, in levels: its depth in the plan, less the depth of the root the table (or a pinned subtree) starts from. */
  indent: number;
  /** The row cannot fold: it is the root of a focus, which is always open (and has no disclosure button). */
  locked: boolean;
};

type StreamRow = RowBase & { kind: "workStream"; depth: 0; stream: PlanWorkStream; childCount: number; expanded: boolean };
type ProgramRow = RowBase & { kind: "program"; depth: 1; stream: PlanWorkStream; program: PlanProgram; childCount: number; expanded: boolean };
type ProjectRow = RowBase & { kind: "project"; depth: 2; stream: PlanWorkStream; program: PlanProgram; project: PlanProject };

/** A work stream or program row: the ones that can fold (when they hold children). */
export type NodeRow = StreamRow | ProgramRow;
export type PlanTreeRow = NodeRow | ProjectRow;

/** The subtree "Show only this" restricts the table to: one work stream or one program (and everything under it). */
export type PlanFocus = { kind: "workStream" | "program"; id: number };

/** What narrows the tree: a name search, one owner, whether closed work streams are left out, and the focus. */
export type PlanFilter = { q: string; ownerPersonId: number | null; hideClosed: boolean; focus: PlanFocus | null };
export const NO_FILTER: PlanFilter = { q: "", ownerPersonId: null, hideClosed: false, focus: null };

/** Whether a search or an owner picks rows (hide closed and the focus alone only drop whole nodes, so the stored folds still apply). */
export const isSearching = (filter: PlanFilter): boolean => foldDiacritics(filter.q.trim()) !== "" || filter.ownerPersonId !== null;

/** Whether any part of the filter is on (the focus included: not every row of the plan is shown). */
export const isFiltered = (filter: PlanFilter): boolean => isSearching(filter) || filter.hideClosed || filter.focus !== null;

/** The node test of a search: the folded name contains the folded text (case- and accent-insensitive) AND the owner is the one picked. */
function matcher(filter: PlanFilter): (node: { name: string; ownerPersonId: number }) => boolean {
  const needle = foldDiacritics(filter.q.trim());
  return (node) => (needle === "" || foldDiacritics(node.name).includes(needle)) && (filter.ownerPersonId === null || node.ownerPersonId === filter.ownerPersonId);
}

/** The focus when the plan still holds the node it names; a link to a node that is gone shows the whole plan. */
export function knownFocus(view: PlanView, focus: PlanFocus | null): PlanFocus | null {
  if (focus === null) return null;
  const held = focus.kind === "workStream" ? view.workStreams.some((stream) => stream.id === focus.id) : view.workStreams.some((stream) => stream.programs.some((program) => program.id === focus.id));
  return held ? focus : null;
}

/** The first of the named foci the plan holds (a program the plan lost falls back to a valid work stream of the same address), else none. */
export function firstKnownFocus(view: PlanView, foci: readonly PlanFocus[]): PlanFocus | null {
  for (const focus of foci) if (knownFocus(view, focus) !== null) return focus;
  return null;
}

/** The work streams a program belongs to, with the programs the table starts from. */
type Scoped = { stream: PlanWorkStream; programs: PlanProgram[] };

/**
 * What the filter leaves to draw, before any search: the focus restricts to its subtree, and hide closed drops the closed streams - except the one
 * that holds the focus. `rootDepth` is where the table starts (1 under a program focus, which shows no work stream row of its own).
 */
function scope(view: PlanView, filter: PlanFilter): { streams: Scoped[]; rootDepth: 0 | 1 } {
  const { focus } = filter;
  const streams: Scoped[] = [];
  for (const stream of view.workStreams) {
    if (focus?.kind === "workStream" && stream.id !== focus.id) continue;
    const programs = focus?.kind === "program" ? stream.programs.filter((program) => program.id === focus.id) : stream.programs;
    if (focus?.kind === "program" && programs.length === 0) continue;
    if (filter.hideClosed && stream.endDate !== null && focus === null) continue;
    streams.push({ stream, programs });
  }
  return { streams, rootDepth: focus?.kind === "program" ? 1 : 0 };
}

/** A node's place in a search: shown at all, and shown only as the way to a match (a context row). */
type Show = { shown: boolean; context: boolean };
const HIDDEN: Show = { shown: false, context: false };
const SHOWN: Show = { shown: true, context: false };
const CONTEXT: Show = { shown: true, context: true };

/**
 * The visible rows, top to bottom, in the server's order: every work stream in scope, under an EXPANDED one its programs, under an expanded program
 * its projects. `collapsed` holds the keys of the folded nodes (a key the plan does not hold is ignored, a node with no children never folds), so a
 * node nobody has folded - a new one included - is open. The focus root is always open.
 *
 * With a search or an owner in `filter` only the matches show, with the way to them and what is under them: a match, its ancestors as CONTEXT rows
 * (`context: true`, drawn dimmed) and its descendants; a focus bounds the search to its subtree. The counts on a row are always the document's own.
 * The caller decides which folds apply (the stored ones with no search, a transient set while one runs: `usePlanFolds`).
 */
export function planRows(view: PlanView, collapsed: ReadonlySet<string>, filter: PlanFilter = NO_FILTER): PlanTreeRow[] {
  const searching = isSearching(filter);
  const matches = matcher(filter);
  const { focus } = filter;
  const { streams, rootDepth } = scope(view, filter);
  const rows: PlanTreeRow[] = [];
  for (const { stream, programs } of streams) {
    const sKey = streamKey(stream.id);
    // Under a program focus the work stream is not a row: it neither matches nor makes its programs visible.
    const streamMatch = searching && rootDepth === 0 && matches(stream);
    // What each program and project shows, from its own match, its ancestors' and its descendants' (a program is context when only a project below matches).
    const programShows = programs.map((program): { show: Show; projects: Show[] } => {
      const programMatch = searching && matches(program);
      const projects = program.projects.map((project): Show => (!searching || streamMatch || programMatch || matches(project) ? SHOWN : HIDDEN));
      const below = projects.some((project) => project.shown);
      const show = !searching || streamMatch || programMatch ? SHOWN : below ? CONTEXT : HIDDEN;
      return { show, projects };
    });
    const streamShow = !searching || streamMatch ? SHOWN : programShows.some((entry) => entry.show.shown) ? CONTEXT : HIDDEN;
    if (!streamShow.shown) continue;
    const streamRoot = focus?.kind === "workStream";
    const streamOpen = programs.length > 0 && (streamRoot || !collapsed.has(sKey));
    if (rootDepth === 0) {
      rows.push({ kind: "workStream", key: sKey, parentKey: null, depth: 0, indent: 0, locked: streamRoot, context: streamShow.context, stream, childCount: stream.programs.length, expanded: streamOpen });
      if (!streamOpen) continue;
    }
    programs.forEach((program, index) => {
      const { show, projects } = programShows[index];
      if (!show.shown) return;
      const pKey = programKey(program.id);
      const programRoot = focus?.kind === "program";
      const programOpen = program.projects.length > 0 && (programRoot || !collapsed.has(pKey));
      rows.push({
        kind: "program",
        key: pKey,
        parentKey: rootDepth === 0 ? sKey : null,
        depth: 1,
        indent: 1 - rootDepth,
        locked: programRoot,
        context: show.context,
        stream,
        program,
        childCount: program.projects.length,
        expanded: programOpen,
      });
      if (!programOpen) return;
      program.projects.forEach((project, at) => {
        if (projects[at].shown) rows.push({ kind: "project", key: projectKey(project.id), parentKey: pKey, depth: 2, indent: 2 - rootDepth, locked: false, context: false, stream, program, project });
      });
    });
  }
  return rows;
}

/** How many nodes match a search (its context rows and what is under a match do not count); 0 while nothing is searched. */
export function matchCount(view: PlanView, filter: PlanFilter): number {
  if (!isSearching(filter)) return 0;
  const matches = matcher(filter);
  const { streams, rootDepth } = scope(view, filter);
  let count = 0;
  for (const { stream, programs } of streams) {
    if (rootDepth === 0 && matches(stream)) count++;
    for (const program of programs) {
      if (matches(program)) count++;
      for (const project of program.projects) if (matches(project)) count++;
    }
  }
  return count;
}

/** The keys of every SHOWN node that has children and can fold (what Collapse all folds), for the rows the filter shows: not the focus root, which is always open. */
export function foldableKeys(view: PlanView, filter: PlanFilter = NO_FILTER): string[] {
  return planRows(view, new Set(), filter)
    .filter((row) => row.kind !== "project" && row.childCount > 0 && !row.locked)
    .map((row) => row.key);
}

/** The keys of every node of the plan: what a stored set is pruned against when the user changes it (never while a view is missing). */
export function nodeKeys(view: PlanView): Set<string> {
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

/** The way down to a focus: the work stream and, for a program, the program; empty when nothing is focused or the plan no longer holds it. */
export function focusTrail(view: PlanView, focus: PlanFocus | null): { key: string; kind: PlanFocus["kind"]; id: number; name: string }[] {
  if (focus === null) return [];
  for (const stream of view.workStreams) {
    if (focus.kind === "workStream" && stream.id === focus.id) return [{ key: streamKey(stream.id), kind: "workStream", id: stream.id, name: stream.name }];
    const program = focus.kind === "program" ? stream.programs.find((candidate) => candidate.id === focus.id) : undefined;
    if (program !== undefined) {
      return [
        { key: streamKey(stream.id), kind: "workStream", id: stream.id, name: stream.name },
        { key: programKey(program.id), kind: "program", id: program.id, name: program.name },
      ];
    }
  }
  return [];
}
