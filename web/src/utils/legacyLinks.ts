import { idOf } from "./deviationFilters";
import { projectPath, projectsPath } from "./planLinks";
import { teamPath } from "./teamLinks";

/** Where a retired address leads: the path and the parameters to set on it. */
export type LegacyTarget = { to: string; params?: Record<string, string> };

/**
 * Where the retired `/milestones` page's address leads (1.29). A valid `projectId` goes to that project's page, its Milestones table narrowed by the
 * Schedule filter the old address held (`scheduled=false` -> `unscheduled`, `scheduled=true` -> `scheduled`, none -> no `milestones` parameter);
 * otherwise a valid `teamId` goes to that team's page (its Unscheduled tray and its schedule); anything else goes to `/projects`. The other old
 * filters (work stream, program, name) have no counterpart and are dropped.
 */
export function legacyMilestonesTarget(search: string): LegacyTarget {
  const query = new URLSearchParams(search);
  const projectId = idOf(query.get("projectId"));
  if (projectId !== undefined) {
    const scheduled = query.get("scheduled");
    return scheduled === "false" || scheduled === "true" ? { to: projectPath(projectId), params: { milestones: scheduled === "false" ? "unscheduled" : "scheduled" } } : { to: projectPath(projectId) };
  }
  const teamId = idOf(query.get("teamId"));
  return teamId === undefined ? { to: projectsPath } : { to: teamPath(teamId) };
}
