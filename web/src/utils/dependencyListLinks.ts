import { dependencyListFilterParams, type DependencyListFilter } from "./dependencyListFilters";

/** The ONE place the Dependencies route is spelled out: every dependency of the plan, in the Planning section after Milestones. */
export const dependenciesPath = "/dependencies";

/** A filtered Dependencies URL; no filter = the bare route. Spelled through `dependencyListFilterParams`, so the page reads back exactly what a link wrote. */
export function dependenciesFilteredPath(filter: DependencyListFilter): string {
  const query = dependencyListFilterParams(filter).toString();
  return query === "" ? dependenciesPath : `${dependenciesPath}?${query}`;
}

/** `/dependencies?status=violated`, optionally narrowed to one team or project: the dependencies that do not hold (Home's and the team page's conflict figures). */
export function violatedDependenciesPath({ teamId, projectId }: { teamId?: number; projectId?: number } = {}): string {
  return dependenciesFilteredPath({ status: "violated", teamId, projectId });
}
