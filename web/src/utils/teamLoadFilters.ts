import type { TeamLoadRow } from "../api/teamLoad";

/** Which teams the Team load page lists: those with an overloaded week, those over the WIP limit, or those with either. Unset = every team. */
export type TeamLoadWarning = "overloaded" | "wip" | "any";

/** The Team load page's filter, as the URL holds it. */
export type TeamLoadFilter = { warning?: TeamLoadWarning };

const WARNINGS: readonly TeamLoadWarning[] = ["overloaded", "wip", "any"];

/** The filter as read from the URL: an unknown or missing `warning` reads as "every team" (a stale link never breaks the page). */
export function parseTeamLoadFilter(params: URLSearchParams): TeamLoadFilter {
  const warning = WARNINGS.find((candidate) => candidate === params.get("warning"));
  return warning === undefined ? {} : { warning };
}

/** The filter as URL parameters (only a set one), the inverse of {@link parseTeamLoadFilter}. */
export function teamLoadFilterParams(filter: TeamLoadFilter): URLSearchParams {
  const params = new URLSearchParams();
  if (filter.warning !== undefined) params.set("warning", filter.warning);
  return params;
}

/** Whether a row belongs under a warning filter (`undefined` = every team); the weeks without capacity are a fact, not a warning, so they never match. */
export function matchesWarning(row: TeamLoadRow, warning: TeamLoadWarning | undefined): boolean {
  switch (warning) {
    case undefined:
      return true;
    case "overloaded":
      return row.overloadedWeeks > 0;
    case "wip":
      return row.wipExceededWeeks > 0;
    case "any":
      return row.overloadedWeeks > 0 || row.wipExceededWeeks > 0;
  }
}
