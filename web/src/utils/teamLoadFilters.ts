import type { TeamLoadRow } from "../api/teamLoad";
import { foldDiacritics } from "./text";

/** Which teams the Teams page lists: those with an overloaded week, those over the WIP limit, or those with either. Unset = every team. */
export type TeamLoadWarning = "overloaded" | "wip" | "any";

/** The Teams page's load filter, as the URL holds it: `warning` narrows the teams. (`?past=true`, 1.22, is gone with the weeks table, 1.36: an old link's `past` is ignored.) */
export type TeamLoadFilter = { warning?: TeamLoadWarning };

const WARNINGS: readonly TeamLoadWarning[] = ["overloaded", "wip", "any"];

/** The filter as read from the URL: an unknown or missing `warning` reads as "every team" (a stale link never breaks the page; any other parameter is ignored). */
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

/** What narrows the Teams table: the warning (URL) and the name typed in the filter panel (page state, never stored). */
export type TeamNarrowing = { warning?: TeamLoadWarning; name: string };

/** Whether any of the two controls narrows the table (a name of blanks does not). */
export function isNarrowing({ warning, name }: TeamNarrowing): boolean {
  return warning !== undefined || name.trim() !== "";
}

/**
 * The rows both controls keep, in the order given: the warning as {@link matchesWarning}, the name as a case- and accent-insensitive substring of the
 * team's name. The ONE function the table and the "Showing N of M" line both read.
 */
export function teamsKept(rows: readonly TeamLoadRow[], { warning, name }: TeamNarrowing): TeamLoadRow[] {
  const needle = foldDiacritics(name.trim());
  return rows.filter((row) => matchesWarning(row, warning) && (needle === "" || foldDiacritics(row.name).includes(needle)));
}
