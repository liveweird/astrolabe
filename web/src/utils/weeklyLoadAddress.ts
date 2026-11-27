import type { WeekLoad } from "../api/teams";
import { addDays } from "./isoDate";
import { toEpochDay, weekdayOf } from "./timelineScale";

/**
 * The address's word for a team's weekly load table (`/teams/:id?load=<kind>`, 1.36; `teamWeeklyLoadPath`, `useWeeklyLoadArrival`): the kind of week the
 * clicked badge counts. `weeks` (no particular week) only opens the table; an unknown word is no address.
 */
export const WEEKLY_LOAD_PARAM = "load";
const WEEKLY_LOAD_KINDS = ["overloaded", "wip", "nocapacity"] as const;
export type WeeklyLoadKind = (typeof WEEKLY_LOAD_KINDS)[number];
export type WeeklyLoadAddress = WeeklyLoadKind | "weeks";

/** The address's kind, or `undefined` for a missing or unknown word (a stale link never breaks the page). */
export function parseWeeklyLoadAddress(value: string | null): WeeklyLoadAddress | undefined {
  return value === "weeks" ? value : WEEKLY_LOAD_KINDS.find((kind) => kind === value);
}

/** Whether a week is one the badge of that kind counts: the server's own verdicts (`capacity === null` = the weeks without capacity). */
function weekIs(week: WeekLoad, kind: WeeklyLoadKind): boolean {
  switch (kind) {
    case "overloaded":
      return week.overloaded;
    case "wip":
      return week.wipExceeded;
    case "nocapacity":
      return week.capacity === null;
  }
}

/** The Monday of the week `iso` falls in (ISO date text, which sorts). */
export const mondayOf = (iso: string) => addDays(iso, -weekdayOf(toEpochDay(iso)));

/**
 * The week the click lands on: the first week of that kind at or after this week (`today`'s Monday), else the LATEST of that kind before it (weeks arrive
 * oldest first; the nearest past week, e.g. for a viewer far ahead of the server's UTC week); `undefined` when the table lists none (or for the plain `weeks`).
 */
export function firstWeekOf(weeks: readonly WeekLoad[], address: WeeklyLoadAddress, today: string): string | undefined {
  if (address === "weeks") return undefined;
  const of = weeks.filter((week) => weekIs(week, address));
  const from = mondayOf(today);
  return (of.find((week) => week.weekStart >= from) ?? of.at(-1))?.weekStart;
}
