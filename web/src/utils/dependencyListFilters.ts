import type { DependencyListRow } from "./dependencyListRows";
import { idOf } from "./deviationFilters";

/** Which dependencies the page lists by their check: the ones that do not hold, the ones that hold, the ones with an unscheduled end. Unset = every one. */
export type DependencyListStatus = "violated" | "ok" | "unscheduled";

/** The Dependencies page's filters, as the URL holds them: a status, a team and a project. Unset = off. */
export type DependencyListFilter = { status?: DependencyListStatus; teamId?: number; projectId?: number };

const STATUSES: readonly DependencyListStatus[] = ["violated", "ok", "unscheduled"];

/** The filters as read from the URL: every unknown or malformed value is dropped (`status=all` included; a stale link never breaks the page); ids follow `idOf`'s rule. */
export function parseDependencyListFilter(params: URLSearchParams): DependencyListFilter {
  const filter: DependencyListFilter = {};
  const status = STATUSES.find((candidate) => candidate === params.get("status"));
  if (status !== undefined) filter.status = status;
  const teamId = idOf(params.get("teamId"));
  if (teamId !== undefined) filter.teamId = teamId;
  const projectId = idOf(params.get("projectId"));
  if (projectId !== undefined) filter.projectId = projectId;
  return filter;
}

/** The filters as URL parameters (only the set ones, in one stable order), the inverse of {@link parseDependencyListFilter}. */
export function dependencyListFilterParams(filter: DependencyListFilter): URLSearchParams {
  const params = new URLSearchParams();
  if (filter.status !== undefined) params.set("status", filter.status);
  if (filter.teamId !== undefined) params.set("teamId", String(filter.teamId));
  if (filter.projectId !== undefined) params.set("projectId", String(filter.projectId));
  return params;
}

/** How many filters narrow the list. */
export function narrowingCount(filter: DependencyListFilter): number {
  return Object.values(filter).filter((value) => value !== undefined).length;
}

const STATUS_OF_CHECK: Record<DependencyListRow["check"]["status"], DependencyListStatus> = {
  VIOLATED: "violated",
  OK: "ok",
  UNSCHEDULED: "unscheduled",
};

/**
 * Whether a row survives the filters, all combined with AND: the status equals the row's check; a team keeps a row when either end is a milestone of it
 * (a project end has no team); a project keeps a row when either end belongs to it (a project end's `projectId` is its own id).
 */
export function matchesDependencyFilter(row: DependencyListRow, filter: DependencyListFilter): boolean {
  const { predecessor, successor } = row;
  if (filter.status !== undefined && STATUS_OF_CHECK[row.check.status] !== filter.status) return false;
  if (filter.teamId !== undefined && predecessor.teamId !== filter.teamId && successor.teamId !== filter.teamId) return false;
  if (filter.projectId !== undefined && predecessor.projectId !== filter.projectId && successor.projectId !== filter.projectId) return false;
  return true;
}
