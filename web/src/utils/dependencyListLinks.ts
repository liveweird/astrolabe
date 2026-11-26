import { withPanelFilter, type DependencyListFilter } from "./dependencyListFilters";
import { roadmapPath } from "./planLinks";

/**
 * A link that opens the Roadmap's dependency panel (1.29; the Dependencies page is gone) with its filters: `/roadmap?dependencies=<status|all>[&dependencyTeamId=…][&dependencyProjectId=…]`.
 * The Roadmap's mode is not named, the panel is the same in both: the Roadmap opens in the mode last used. Spelled through `withPanelFilter`, so the panel reads back exactly
 * what a link wrote (the status word is always written: it is what opens the panel).
 */
export function dependenciesFilteredPath(filter: DependencyListFilter): string {
  return `${roadmapPath}?${withPanelFilter(new URLSearchParams(), filter)}`;
}

/** `/roadmap?dependencies=violated`, optionally narrowed to one team or project: the dependencies that do not hold (Home's and the team page's conflict figures). */
export function violatedDependenciesPath({ teamId, projectId }: { teamId?: number; projectId?: number } = {}): string {
  return dependenciesFilteredPath({ status: "violated", teamId, projectId });
}

/**
 * The navigation state that asks the dependency panel to take the focus to its heading when this location arrives (the row menu's "Dependencies" action,
 * which opens the panel on the page's own address): a link names the panel in the address and the panel focuses it on arrival; an action on the page
 * has no arrival, so it asks by state. Per history entry, so a later filter change (no state) never takes the focus again.
 */
export const OPEN_DEPENDENCIES_STATE = { focusDependencies: true } as const;

/** Whether a location's state is {@link OPEN_DEPENDENCIES_STATE}. */
export function asksForDependenciesFocus(state: unknown): boolean {
  return typeof state === "object" && state !== null && "focusDependencies" in state && state.focusDependencies === true;
}
