import type { DependencyListRow } from "./dependencyListRows";
import { idOf } from "./deviationFilters";

/** Which dependencies the page lists by their check: the ones that do not hold, the ones that hold, the ones with an unscheduled end. Unset = every one. */
export type DependencyListStatus = "violated" | "ok" | "unscheduled";

/** The Dependencies page's filters, as the URL holds them: a status, a team and a project. Unset = off. */
export type DependencyListFilter = { status?: DependencyListStatus; teamId?: number; projectId?: number };

const STATUSES: readonly DependencyListStatus[] = ["violated", "ok", "unscheduled"];

/** The three address parameter names a list's filters are spelled with: the Dependencies page's own, or (1.29) the Roadmap and Programs panels' prefixed ones. */
type DependencyParamNames = { status: string; teamId: string; projectId: string };

/** The Dependencies page's names (`/dependencies?status=…&teamId=…&projectId=…`). */
const PAGE_PARAMS: DependencyParamNames = { status: "status", teamId: "teamId", projectId: "projectId" };

/** The panel's names: the Roadmap's own `teamId` is a different filter, so the panel's are prefixed; `dependencies` is the status AND names the panel open. */
export const PANEL_PARAMS: DependencyParamNames = { status: "dependencies", teamId: "dependencyTeamId", projectId: "dependencyProjectId" };

/** The filters as read from the URL: every unknown or malformed value is dropped (`status=all` included; a stale link never breaks the page); ids follow `idOf`'s rule. */
export function parseDependencyListFilter(params: URLSearchParams, names: DependencyParamNames = PAGE_PARAMS): DependencyListFilter {
  const filter: DependencyListFilter = {};
  const status = STATUSES.find((candidate) => candidate === params.get(names.status));
  if (status !== undefined) filter.status = status;
  const teamId = idOf(params.get(names.teamId));
  if (teamId !== undefined) filter.teamId = teamId;
  const projectId = idOf(params.get(names.projectId));
  if (projectId !== undefined) filter.projectId = projectId;
  return filter;
}

/** The filters as URL parameters (only the set ones, in one stable order), the inverse of {@link parseDependencyListFilter}. */
export function dependencyListFilterParams(filter: DependencyListFilter): URLSearchParams {
  const params = new URLSearchParams();
  if (filter.status !== undefined) params.set(PAGE_PARAMS.status, filter.status);
  if (filter.teamId !== undefined) params.set(PAGE_PARAMS.teamId, String(filter.teamId));
  if (filter.projectId !== undefined) params.set(PAGE_PARAMS.projectId, String(filter.projectId));
  return params;
}

/** The words `dependencies=` may hold: a status, or `all` (every dependency). Anything else is no word, so no opening. */
const PANEL_WORDS: readonly string[] = ["all", ...STATUSES];

/** True when the address names a panel (`dependencies=all|violated|ok|unscheduled`): the panel is open for that visit, whatever the browser remembers. */
export function namesPanel(params: URLSearchParams): boolean {
  return PANEL_WORDS.includes(params.get(PANEL_PARAMS.status) ?? "");
}

/**
 * The address with the panel's filters replaced by `filter`; every other parameter is kept. The status word is ALWAYS written (`all` when unset): a user who
 * changes a filter of an open panel says so in the address, and the word is what a copied link opens the panel by.
 */
export function withPanelFilter(current: URLSearchParams, filter: DependencyListFilter): URLSearchParams {
  const next = new URLSearchParams(current);
  for (const name of Object.values(PANEL_PARAMS)) next.delete(name);
  next.set(PANEL_PARAMS.status, filter.status ?? "all");
  if (filter.teamId !== undefined) next.set(PANEL_PARAMS.teamId, String(filter.teamId));
  if (filter.projectId !== undefined) next.set(PANEL_PARAMS.projectId, String(filter.projectId));
  return next;
}

/** The address without the word that opens the panel (the filters stay, for the next time it is opened); every other parameter is kept. */
export function withoutPanelWord(current: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(current);
  next.delete(PANEL_PARAMS.status);
  return next;
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
