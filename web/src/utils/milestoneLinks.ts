import { milestoneFilterParams, type MilestoneFilter } from "./milestoneFilters";

/** The ONE place the Milestones route is spelled out: every milestone of the plan, in the Planning section after Programs. */
export const milestonesPath = "/milestones";

/** A filtered Milestones URL; no filter = the bare route. Spelled through `milestoneFilterParams`, so the page reads back exactly what a link wrote. */
function filteredPath(filter: MilestoneFilter): string {
  const query = milestoneFilterParams(filter).toString();
  return query === "" ? milestonesPath : `${milestonesPath}?${query}`;
}

/** `/milestones?scheduled=false`, optionally narrowed to one team or project: the milestones without dates (Home's "not scheduled" figures). */
export function unscheduledMilestonesPath({ teamId, projectId }: { teamId?: number; projectId?: number } = {}): string {
  return filteredPath({ scheduled: false, teamId, projectId });
}
