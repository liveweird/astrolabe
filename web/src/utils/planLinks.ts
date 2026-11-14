import { roadmapFilterParams, type RoadmapFilterLink } from "./roadmapFilterParams";

/** The ONE place the Plan route is spelled out — never hand-assemble the URL. */
export const planPath = "/plan";

/** The ONE place the Roadmap route is spelled out — the global project ranking, next to the Plan in the Planning section. */
export const roadmapPath = "/roadmap";

/** The ONE place the Programs route is spelled out — the plan as a tree on the timeline, after the Roadmap in the Planning section. */
export const programsPath = "/programs";

/** The ONE place a project's page is spelled out — the project view (its milestones on the timeline). */
export const projectPath = (id: number) => `/projects/${id}`;

/**
 * The ONE place a filtered Roadmap URL is spelled out: the filters and the program pick a link names (an unnamed one is off); no filter = the bare
 * `/roadmap`. Such a link is shown as written and does not change what the browser remembers.
 */
export function roadmapFilteredPath(state: RoadmapFilterLink): string {
  const query = roadmapFilterParams(state).toString();
  return query === "" ? roadmapPath : `${roadmapPath}?${query}`;
}
