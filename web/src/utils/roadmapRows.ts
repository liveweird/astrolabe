import type { PlanFlag, RoadmapLink, RoadmapProject, RoadmapRankedProject, RoadmapView } from "../api/roadmap";
import { EDGES } from "./dependencyArrows";
import { addDays } from "./isoDate";
import { jiraRangeDates, type JiraWindow } from "./jiraBars";
import type { TimelineArrowData } from "./timelineModel";

// The roadmap page's pure model: which projects the filters and the program pick leave visible, the rows they make (ranked rows, the divider,
// unranked rows), the flag totals and the panel's entries, and the arrows of the rolled-up links. No React and no i18n here — the page's
// components turn these into cells, bars and sentences. Everything the server derived (spans, drift, flags, link checks) is only READ.

/** The row id of the "Unranked" divider (a project row's id is its project id). */
export const DIVIDER_ID = "unranked";

export type RoadmapFilters = {
  workStreamId: number | null;
  teamId: number | null;
  ownerPersonId: number | null;
  flaggedOnly: boolean;
};

/** What the filters and the program pick leave of the view: the ranked rows (keeping the server's positions, so a gap shows) and the unranked ones. */
export type VisibleProjects = { ranked: RoadmapRankedProject[]; unranked: RoadmapProject[] };

export type NamedId = { id: number; name: string };

/** Every project of the view, ranked first. */
export function allProjects(view: Pick<RoadmapView, "ranked" | "unranked">): RoadmapProject[] {
  return [...view.ranked.map((entry) => entry.project), ...view.unranked];
}

const byName = (a: NamedId, b: NamedId) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id - b.id;

function distinct(projects: readonly RoadmapProject[], pick: (project: RoadmapProject) => NamedId): NamedId[] {
  return [...new Map(projects.map((project) => [pick(project).id, pick(project)])).values()].sort(byName);
}

/** The work streams the view's projects belong to (the filter's options). */
export const workStreamOptions = (view: RoadmapView): NamedId[] => distinct(allProjects(view), (p) => ({ id: p.workStreamId, name: p.workStreamName }));

/** The owners of the view's projects (the filter's options). */
export const ownerOptions = (view: RoadmapView): NamedId[] => distinct(allProjects(view), (p) => ({ id: p.ownerPersonId, name: p.ownerName }));

/** A program with its work stream (two streams may each have a program of the same name, so the pick shows both). */
export type ProgramOption = NamedId & { workStreamName: string };

/** The programs of the view's projects (the program pick's options), by name. */
export function programOptions(view: RoadmapView): ProgramOption[] {
  const programs = new Map<number, ProgramOption>();
  for (const project of allProjects(view)) {
    programs.set(project.programId, { id: project.programId, name: project.programName, workStreamName: project.workStreamName });
  }
  return [...programs.values()].sort(byName);
}

/** A stored filter id the view no longer offers (the project moved, the person left) filters nothing instead of hiding every row. */
export function knownFilters(view: RoadmapView, filters: RoadmapFilters): RoadmapFilters {
  const has = (options: readonly NamedId[], id: number | null) => (id !== null && options.some((option) => option.id === id) ? id : null);
  return {
    ...filters,
    workStreamId: has(workStreamOptions(view), filters.workStreamId),
    teamId: has(view.teams, filters.teamId),
    ownerPersonId: has(ownerOptions(view), filters.ownerPersonId),
  };
}

/**
 * The picked programs among the ones a page knows; `null` = no pick in force (every program shows). Stored ids of programs that are gone are
 * ignored. The roadmap page and the programs page each pass the programs THEIR view holds (the one stored pick is shared).
 */
export function pickAmong(known: readonly { id: number }[], pick: readonly number[]): Set<number> | null {
  const ids = new Set(known.map((program) => program.id));
  const picked = new Set(pick.filter((id) => ids.has(id)));
  return picked.size === 0 ? null : picked;
}

/** The picked programs the roadmap view still knows (see `pickAmong`). */
export const knownPick = (view: RoadmapView, pick: readonly number[]): Set<number> | null => pickAmong(programOptions(view), pick);

/** The projects the filters (all of them must hold) and the program pick (`null` = all programs) leave visible. */
export function visibleProjects(view: RoadmapView, filters: RoadmapFilters, pick: ReadonlySet<number> | null): VisibleProjects {
  const keeps = (project: RoadmapProject) =>
    (pick === null || pick.has(project.programId)) &&
    (filters.workStreamId === null || project.workStreamId === filters.workStreamId) &&
    (filters.teamId === null || project.teamIds.includes(filters.teamId)) &&
    (filters.ownerPersonId === null || project.ownerPersonId === filters.ownerPersonId) &&
    (!filters.flaggedOnly || project.flags.length > 0);
  return { ranked: view.ranked.filter((entry) => keeps(entry.project)), unranked: view.unranked.filter(keeps) };
}

/** How many filters are in force (the toggle's badge): each field of the filters, plus the program pick. */
export function activeFilterCount(filters: RoadmapFilters, pick: ReadonlySet<number> | null): number {
  const set = [filters.workStreamId, filters.teamId, filters.ownerPersonId].filter((id) => id !== null).length;
  return set + (filters.flaggedOnly ? 1 : 0) + (pick === null ? 0 : 1);
}

/** One row of the timeline: a project (with its server position when ranked) or the divider between the ranked and the unranked. */
export type DisplayRow = { kind: "project"; project: RoadmapProject; position: number | null } | { kind: "divider" };

/** Ranked rows in position order, the divider (only while something unranked is visible), unranked rows by name. */
export function displayRows(visible: VisibleProjects): DisplayRow[] {
  return [
    ...visible.ranked.map((entry): DisplayRow => ({ kind: "project", project: entry.project, position: entry.position })),
    ...(visible.unranked.length > 0 ? [{ kind: "divider" } as const] : []),
    ...visible.unranked.map((project): DisplayRow => ({ kind: "project", project, position: null })),
  ];
}

export type FlagCounts = { warnings: number; infos: number };

export function countFlags(flags: readonly PlanFlag[]): FlagCounts {
  const warnings = flags.filter((flag) => flag.severity === "WARNING").length;
  return { warnings, infos: flags.length - warnings };
}

/** The flag totals over the visible rows (the facts line). */
export function flagTotals(visible: VisibleProjects): FlagCounts {
  const projects = [...visible.ranked.map((entry) => entry.project), ...visible.unranked];
  return projects.reduce(
    (sum, project) => {
      const counts = countFlags(project.flags);
      return { warnings: sum.warnings + counts.warnings, infos: sum.infos + counts.infos };
    },
    { warnings: 0, infos: 0 },
  );
}

/** One line of the flag panel: a flag with the project it is raised on. */
export type FlagEntry = { project: RoadmapProject; flag: PlanFlag; position: number | null };

/** Every flag of the visible rows, warnings first, then by rank position (unranked last), then in the order the server listed them. */
export function flagEntries(visible: VisibleProjects): FlagEntry[] {
  const rows = [
    ...visible.ranked.map((entry) => ({ project: entry.project, position: entry.position as number | null })),
    ...visible.unranked.map((project) => ({ project, position: null as number | null })),
  ];
  const entries = rows.flatMap(({ project, position }) => project.flags.map((flag): FlagEntry => ({ project, flag, position })));
  const severity = (entry: FlagEntry) => (entry.flag.severity === "WARNING" ? 0 : 1);
  // `sort` is stable: flags of one project keep the server's order.
  return entries.sort((a, b) => severity(a) - severity(b) || (a.position ?? Infinity) - (b.position ?? Infinity));
}

/** The overrun band of a project whose span ends after its target window: the days after the window's end up to the span's end, or `null`. */
export function driftBandOf(project: RoadmapProject): { start: string; end: string } | null {
  if (project.targetEnd === null || project.span === null || project.drift === null || project.drift.endDays <= 0) return null;
  return { start: addDays(project.targetEnd, 1), end: project.span.end };
}

/**
 * Every date the page shows (spans, target windows and, with a baseline picked, the frozen spans): the range the timeline must cover. With the page's
 * Jira `window` (the "Jira dates" toggle on, `jiraWindow(datesOf(view), today)`) the Jira dates of each bound project join it, CUT at the window so a
 * mistyped Jira date cannot stretch the range (the range only grows, and the toggle could not undo it).
 */
export function datesOf(view: RoadmapView, jira: JiraWindow | null = null): string[] {
  const own = allProjects(view).flatMap((project) =>
    [project.span?.start, project.span?.end, project.targetStart, project.targetEnd, project.baseline?.span?.start, project.baseline?.span?.end].filter((d): d is string => typeof d === "string"),
  );
  if (jira === null) return own;
  return [...own, ...jiraRangeDates(allProjects(view), jira)];
}

/** How many violated links end on each project (a direct link and the violated milestone links of a pair), for the span bar's accessible name. */
export function conflictsByProject(links: readonly RoadmapLink[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const link of links) {
    const violated = (link.direct?.check.status === "VIOLATED" ? 1 : 0) + link.milestoneLinks.violated;
    if (violated === 0) continue;
    for (const id of [link.predecessorProjectId, link.successorProjectId]) counts.set(id, (counts.get(id) ?? 0) + violated);
  }
  return counts;
}

/** The two sentences an arrow's `<title>` can carry; the page owns the words. */
export type ArrowLabels = {
  direct: (link: RoadmapLink) => string;
  bundle: (link: RoadmapLink) => string;
};

/** The key of an ordered project pair in a set of critical pairs (1.7). */
export const pairKey = (predecessorProjectId: number, successorProjectId: number) => `${predecessorProjectId}-${successorProjectId}`;

const NO_PAIRS: ReadonlySet<string> = new Set();

/**
 * The arrows of the rolled-up links. A pair's `direct` project-to-project link (unless its check is UNSCHEDULED: no dates, nothing to point at) is drawn
 * as its type says on the two span bars, red when VIOLATED; its milestone links are ONE bundle arrow per ordered pair (`bundle:<pred>-<succ>`,
 * end to start), red when any of them is violated. `rowOf` answers the row of a project that has a span bar on this timeline, else `null` and
 * the arrow is left out. The bar of a project's row is the span bar and has the project's id, like the row. `criticalPairs` (1.7, the pairs the server
 * put on the chain toward the picked project, as `pairKey`s) marks BOTH arrows of such a pair `critical`; without it no spec carries the flag.
 */
export function arrowSpecsForLinks(
  links: readonly RoadmapLink[],
  rowOf: (projectId: number) => number | null,
  labels: ArrowLabels,
  criticalPairs: ReadonlySet<string> = NO_PAIRS,
): TimelineArrowData[] {
  const specs: TimelineArrowData[] = [];
  for (const link of links) {
    const from = rowOf(link.predecessorProjectId);
    const to = rowOf(link.successorProjectId);
    if (from === null || to === null) continue;
    const { direct, milestoneLinks } = link;
    const emphasis = criticalPairs.has(pairKey(link.predecessorProjectId, link.successorProjectId)) ? { critical: true } : {};
    if (direct !== null && direct.check.status !== "UNSCHEDULED") {
      const [fromKind, toKind] = EDGES[direct.type];
      specs.push({
        id: direct.id,
        from: { row: from, bar: from, kind: fromKind },
        to: { row: to, bar: to, kind: toKind },
        violated: direct.check.status === "VIOLATED",
        label: labels.direct(link),
        ...emphasis,
      });
    }
    if (milestoneLinks.count > 0) {
      specs.push({
        id: `bundle:${link.predecessorProjectId}-${link.successorProjectId}`,
        from: { row: from, bar: from, kind: "END" },
        to: { row: to, bar: to, kind: "START" },
        violated: milestoneLinks.violated > 0,
        label: labels.bundle(link),
        ...emphasis,
      });
    }
  }
  return specs;
}
