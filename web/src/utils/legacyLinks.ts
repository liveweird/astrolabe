import { LEGACY_PARAMS, parseDependencyListFilter, withPanelFilter } from "./dependencyListFilters";
import { idOf } from "./deviationFilters";
import { projectPath, projectsPath, roadmapPath } from "./planLinks";
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

/**
 * Where the retired `/dependencies` page's address leads (1.29): the Roadmap, its dependency panel open with the three filters the old address held, under
 * the panel's prefixed names (`status` -> `dependencies`, `teamId` -> `dependencyTeamId`, `projectId` -> `dependencyProjectId`; an unknown or malformed value is
 * dropped as the page dropped it). The bare address opens the panel unfiltered (`dependencies=all`). No mode is named: the Roadmap opens in the one last used.
 */
export function legacyDependenciesTarget(search: string): LegacyTarget {
  const filter = parseDependencyListFilter(new URLSearchParams(search), LEGACY_PARAMS);
  return { to: roadmapPath, params: Object.fromEntries(withPanelFilter(new URLSearchParams(), filter)) };
}

/**
 * Where the retired `/schedule-proposals/saved/:id` page's address leads (1.33): the Roadmap overview with `proposal=<id>` (a malformed id leads to the overview alone; a proposal
 * that is gone says so there). The old query had none of its own.
 */
export function legacySavedProposalTarget(id: string | undefined): LegacyTarget {
  const proposal = idOf(id ?? null);
  return { to: roadmapPath, params: proposal === undefined ? { mode: "overview" } : { mode: "overview", proposal: String(proposal) } };
}
