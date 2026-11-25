import { idOf } from "./deviationFilters";
import type { PlanParents } from "./planNames";

/**
 * The Milestones page's filters, as the URL holds them: `scheduled` (`false` = the unscheduled ones), a team, a work stream, a program, a project and
 * a name search. Unset = off.
 */
export type MilestoneFilter = { scheduled?: boolean; teamId?: number; workStreamId?: number; programId?: number; projectId?: number; name?: string };

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
  const workStreamId = idOf(params.get("workStreamId"));
  if (workStreamId !== undefined) filter.workStreamId = workStreamId;
  const programId = idOf(params.get("programId"));
  if (programId !== undefined) filter.programId = programId;
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
  if (filter.workStreamId !== undefined) params.set("workStreamId", String(filter.workStreamId));
  if (filter.programId !== undefined) params.set("programId", String(filter.programId));
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

const differs = (known: number | undefined, picked: number) => known !== undefined && known !== picked;

/**
 * The patch a pick of a work stream or program stands for, with what it makes inconsistent dropped: a work stream pick drops a program or project
 * outside it, a program pick drops a project outside it (a dropped key is an explicit `undefined`, which {@link milestoneFilterParams} omits). A node
 * the plan does not know is never judged (nothing is dropped on data that has not arrived), a patch that picks neither level is returned as it is, and
 * clearing a level drops nothing. Pure: the select options are already narrowed, so this only matters when a pick leaves an earlier one behind.
 */
export function cascadePatch(filter: MilestoneFilter, patch: Partial<MilestoneFilter>, parents: PlanParents | undefined): Partial<MilestoneFilter> {
  if (parents === undefined || !("workStreamId" in patch || "programId" in patch)) return patch;
  const next = { ...filter, ...patch };
  const out = { ...patch };
  const streamOfProgram = (id: number) => parents.programStream.get(id);
  const programOfProject = (id: number) => parents.projectProgram.get(id);
  const streamOfProject = (id: number) => {
    const program = programOfProject(id);
    return program === undefined ? undefined : streamOfProgram(program);
  };
  if (next.workStreamId !== undefined) {
    if (next.programId !== undefined && differs(streamOfProgram(next.programId), next.workStreamId)) {
      out.programId = undefined;
      next.programId = undefined;
    }
    if (next.projectId !== undefined && differs(streamOfProject(next.projectId), next.workStreamId)) {
      out.projectId = undefined;
      next.projectId = undefined;
    }
  }
  if (next.programId !== undefined && next.projectId !== undefined && differs(programOfProject(next.projectId), next.programId)) out.projectId = undefined;
  return out;
}

/** The fields the Milestones table sorts by. */
export type MilestoneSortField = "name" | "projectName" | "teamName" | "rankPosition";

/**
 * The `sort` parameter for a header's field and direction. The Rank header sends the project's rank and then the project name, start and milestone name
 * (`rankPosition,projectName,startDate,name`): only the first key flips when descending, and the server puts a project without a rank last either way,
 * so those come in project-name order in both directions. Every other header sends its own field.
 */
export function milestoneSortParam(field: MilestoneSortField, dir: "asc" | "desc"): string {
  const prefix = dir === "desc" ? "-" : "";
  return field === "rankPosition" ? `${prefix}rankPosition,projectName,startDate,name` : `${prefix}${field}`;
}
