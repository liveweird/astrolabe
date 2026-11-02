import type { BaselineView, BaselineViewMilestone, BaselineViewProject } from "../api/baselines";
import { formatMd } from "./timelineLoad";
import { foldDiacritics } from "./text";

/** The comparison page's client-side filters (the document is already the CHANGED rows only; nothing here refetches). */
export type CompareFilters = {
  /** Only milestone rows of this team (and the projects that have any); null = every team. */
  teamId: number | null;
  /** A case- and accent-insensitive substring of the project name; blank = every project. */
  text: string;
  /** Hide a project that has no change of its own and no changed milestone row. */
  changedOnly: boolean;
};

/** A project and the changed milestone rows under it, in the server's order. */
export type ProjectGroup = { project: BaselineViewProject; milestones: BaselineViewMilestone[] };

/** The teams the changed milestone rows sit on, by name — what the team filter offers. */
export function compareTeams(view: BaselineView): { id: number; name: string }[] {
  const byId = new Map<number, string>();
  for (const row of view.milestones) byId.set(row.teamId, row.teamName);
  return [...byId].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);
}

/** True when the project's own span moved, or any of its milestones did (the counts are over EVERY milestone row, listed or not). */
function projectChanged(project: BaselineViewProject): boolean {
  const c = project.counts;
  return project.movement.kind !== "UNCHANGED" || c.moved + c.scheduled + c.unscheduled + c.added + c.removed > 0;
}

/**
 * The page's table as groups: the server's project order, each with its changed milestone rows (a row whose project is not in the list is
 * dropped — the server sends the union, so none is). A team filter keeps only the projects that have a row of the team; "changed only" keeps
 * a project that changed itself or has a listed row (an estimate-only change is a listed row); the text filter matches the project name.
 */
export function compareGroups(view: BaselineView, filters: CompareFilters): ProjectGroup[] {
  const rows = new Map<number, BaselineViewMilestone[]>();
  for (const row of view.milestones) {
    if (filters.teamId !== null && row.teamId !== filters.teamId) continue;
    const list = rows.get(row.projectId);
    if (list) list.push(row);
    else rows.set(row.projectId, [row]);
  }
  const query = foldDiacritics(filters.text.trim());
  return view.projects
    .filter((project) => query === "" || foldDiacritics(project.name).includes(query))
    .map((project) => ({ project, milestones: rows.get(project.projectId) ?? [] }))
    .filter(({ project, milestones }) => {
      if (filters.teamId !== null) return milestones.length > 0;
      return !filters.changedOnly || milestones.length > 0 || projectChanged(project);
    });
}

/** The estimate cell: "10" when it did not change, "10 → 12.5" when it did, the one side that exists otherwise, "—" for neither. */
export function estimateText(row: BaselineViewMilestone): string {
  const then = row.frozen?.estimateMd;
  const now = row.live?.estimateMd;
  if (then === undefined && now === undefined) return "—";
  if (then === undefined || now === undefined) return formatMd((then ?? now) as number);
  return then === now ? formatMd(now) : `${formatMd(then)} → ${formatMd(now)}`;
}
