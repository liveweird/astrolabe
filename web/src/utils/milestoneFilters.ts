import { idOf } from "./deviationFilters";

/** The Milestones page's filters, as the URL holds them: `scheduled` (`false` = the unscheduled ones), a team, a project and a name search. Unset = off. */
export type MilestoneFilter = { scheduled?: boolean; teamId?: number; projectId?: number; name?: string };

/** The Schedule select's three choices: every milestone, the ones without dates, the ones with dates. */
export type ScheduleChoice = "all" | "unscheduled" | "scheduled";

/**
 * The filters as read from the URL: every unknown or malformed value is dropped (a stale link never breaks the page). `scheduled` is a state only
 * as the exact word `true` or `false` (`false` is the unscheduled list, not "off"); ids follow `idOf`'s rule; a blank name is no filter.
 */
export function parseMilestoneFilter(params: URLSearchParams): MilestoneFilter {
  const filter: MilestoneFilter = {};
  const scheduled = params.get("scheduled");
  if (scheduled === "true" || scheduled === "false") filter.scheduled = scheduled === "true";
  const teamId = idOf(params.get("teamId"));
  if (teamId !== undefined) filter.teamId = teamId;
  const projectId = idOf(params.get("projectId"));
  if (projectId !== undefined) filter.projectId = projectId;
  const name = params.get("name")?.trim();
  if (name) filter.name = name;
  return filter;
}

/** The filters as URL parameters (only the set ones, in one stable order), the inverse of {@link parseMilestoneFilter}. */
export function milestoneFilterParams(filter: MilestoneFilter): URLSearchParams {
  const params = new URLSearchParams();
  if (filter.scheduled !== undefined) params.set("scheduled", String(filter.scheduled));
  if (filter.teamId !== undefined) params.set("teamId", String(filter.teamId));
  if (filter.projectId !== undefined) params.set("projectId", String(filter.projectId));
  const name = filter.name?.trim();
  if (name) params.set("name", name);
  return params;
}

/** How many filters narrow the list (the Schedule choice counts once it is not "All"). */
export function narrowingCount(filter: MilestoneFilter): number {
  return Object.values(filter).filter((value) => value !== undefined).length;
}

/** The Schedule choice a filter reads as. */
export function scheduleChoice(filter: MilestoneFilter): ScheduleChoice {
  return filter.scheduled === undefined ? "all" : filter.scheduled ? "scheduled" : "unscheduled";
}

/** The `scheduled` filter a Schedule choice stands for (`undefined` = both). */
export function scheduledOf(choice: ScheduleChoice): boolean | undefined {
  return choice === "all" ? undefined : choice === "scheduled";
}
