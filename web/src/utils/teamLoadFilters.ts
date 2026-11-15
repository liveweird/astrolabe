import type { TeamLoadRow } from "../api/teamLoad";
import type { WeekLoad } from "../api/teams";

/** Which teams the Team load page lists: those with an overloaded week, those over the WIP limit, or those with either. Unset = every team. */
export type TeamLoadWarning = "overloaded" | "wip" | "any";

/**
 * The Team load page's filter, as the URL holds it: `warning` narrows the teams and their weeks; `past` (`?past=true`, 1.22) brings the listed weeks
 * BEFORE the document's current week back (unset = the weeks from the current week on).
 */
export type TeamLoadFilter = { warning?: TeamLoadWarning; past?: true };

const WARNINGS: readonly TeamLoadWarning[] = ["overloaded", "wip", "any"];

/**
 * The filter as read from the URL: an unknown or missing `warning` reads as "every team" and anything but the exact word `past=true` reads as off
 * (a stale link never breaks the page).
 */
export function parseTeamLoadFilter(params: URLSearchParams): TeamLoadFilter {
  const warning = WARNINGS.find((candidate) => candidate === params.get("warning"));
  return { ...(warning === undefined ? {} : { warning }), ...(params.get("past") === "true" ? { past: true as const } : {}) };
}

/** The filter as URL parameters (only a set one), the inverse of {@link parseTeamLoadFilter}. */
export function teamLoadFilterParams(filter: TeamLoadFilter): URLSearchParams {
  const params = new URLSearchParams();
  if (filter.warning !== undefined) params.set("warning", filter.warning);
  if (filter.past === true) params.set("past", "true");
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

/**
 * Whether a listed week belongs under a warning filter (`undefined` = every listed week). The document lists only warning weeks, so "any" keeps all;
 * "overloaded" and "wip" keep the weeks carrying that verdict (a week can carry both). With `from` (the document's current week, an ISO Monday) a week
 * before it is not kept either: ISO dates compare as text, and a week ON `from` stays.
 */
export function matchesWeek(week: WeekLoad, warning: TeamLoadWarning | undefined, from?: string): boolean {
  if (from !== undefined && week.weekStart < from) return false;
  switch (warning) {
    case undefined:
    case "any":
      return true;
    case "overloaded":
      return week.overloaded;
    case "wip":
      return week.wipExceeded;
  }
}

/**
 * How many listed weeks of `rows` the warning keeps but the date hides (those before `from`): what the default view leaves out, counted from the
 * rows it shows. A count of the document's listed weeks only, never of the team page's weeks (a cut document lists fewer).
 */
export function earlierWeekCount(rows: readonly TeamLoadRow[], warning: TeamLoadWarning | undefined, from: string): number {
  return rows.reduce((sum, row) => sum + row.warningWeeks.filter((week) => week.weekStart < from && matchesWeek(week, warning)).length, 0);
}
