import type { RoadmapCriticalPath, RoadmapCriticalProject, RoadmapProject, RoadmapView } from "../api/roadmap";
import { pairKey } from "./roadmapRows";

// The roadmap's critical path toward one picked project (1.7, `GET /views/roadmap?criticalPath=N`): pure reads of the server's `criticalPath` block.
// The server decides the chain, the slack and the hops; nothing here recomputes them.

/** What the page draws from the block: the projects whose span bar is emphasised (the target and every upstream project on the chain) and the pairs whose arrows are. */
export type CriticalIndex = { target: number | null; projects: ReadonlySet<number>; pairs: ReadonlySet<string> };

const NONE: CriticalIndex = { target: null, projects: new Set(), pairs: new Set() };

/** The emphasis sets of a view: empty without the `criticalPath` block. The target is critical by definition (slack 0); an upstream project only when the server says so. */
export function criticalIndex(view: Pick<RoadmapView, "criticalPath">): CriticalIndex {
  const block = view.criticalPath;
  if (block === undefined) return NONE;
  return {
    target: block.projectId,
    projects: new Set([block.projectId, ...block.projects.filter((project) => project.critical).map((project) => project.projectId)]),
    pairs: new Set(block.pairs.map((pair) => pairKey(pair.predecessorProjectId, pair.successorProjectId))),
  };
}

/** The view without its `criticalPath` block: what a placeholder copy kept from the previous target must show (its chain belongs to the old target). */
export function withoutCriticalPath<V extends { criticalPath?: unknown }>(view: V): V {
  if (view.criticalPath === undefined) return view;
  const copy = { ...view };
  delete copy.criticalPath;
  return copy;
}

/** An upstream project joined to its row in the view. */
export type ChainProject = { project: RoadmapProject; slackDays: number; critical: boolean; hops: number };

/**
 * The panel's rows in the server's order (hops, slack, id); a project the page does not hold (`projects`: the roadmap's `allProjects`, the programs
 * page's `treeProjects`) is left out (it cannot be named or linked).
 */
export function chainProjects(projects: readonly RoadmapProject[], block: RoadmapCriticalPath | undefined): ChainProject[] {
  if (block === undefined) return [];
  const byId = new Map(projects.map((project) => [project.id, project]));
  return block.projects.flatMap((entry: RoadmapCriticalProject) => {
    const project = byId.get(entry.projectId);
    return project === undefined ? [] : [{ project, slackDays: entry.slackDays, critical: entry.critical, hops: entry.hops }];
  });
}
