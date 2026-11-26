import { roadmapFilterParams, type RoadmapFilterLink } from "./roadmapFilterParams";

/** The ONE place the Plan route is spelled out — never hand-assemble the URL. */
export const planPath = "/plan";

/** The ONE place the Roadmap route is spelled out, bare: it opens in the mode last used in this browser (Prioritization on a first visit). */
export const roadmapPath = "/roadmap";

/** The Roadmap's two modes (1.29), the exact words of `?mode=`: the projects by global rank, and the tree of projects under programs and work streams. */
export const ROADMAP_MODES = ["prioritization", "overview"] as const;
export type RoadmapMode = (typeof ROADMAP_MODES)[number];

/** The ONE place a Roadmap link naming its mode is spelled out (such a link is shown as written and does not change what the browser remembers). */
export const roadmapModePath = (mode: RoadmapMode) => `${roadmapPath}?mode=${mode}`;

/** The Roadmap overview (the tree of projects under programs and work streams): where the former `/programs` leads. */
export const roadmapOverviewPath = roadmapModePath("overview");

/** The ONE place the Projects route is spelled out — the project view without a project yet (it opens the remembered one), after the Roadmap in the Planning section. */
export const projectsPath = "/projects";

/** The ONE place a project's page is spelled out — the project view (its milestones on the timeline). */
export const projectPath = (id: number) => `${projectsPath}/${id}`;

/** A milestone's address: its project's page with `?milestone=<id>` (1.31; the page marks and focuses the row once it reads the parameter - the link may exist before that arrival handling). */
export const milestonePath = (projectId: number, id: number) => `${projectPath(projectId)}?milestone=${id}`;

/** A project's page with its Milestones table narrowed to the milestones without dates (Home's "not scheduled" figure of a project). */
export const projectUnscheduledPath = (id: number) => `${projectPath(id)}?milestones=unscheduled`;

/** A program's address (1.31): the Roadmap overview narrowed to it, written through the same `programId` pick the overview reads (`/roadmap?mode=overview&programId=3`). */
export const programPath = (id: number) => `${roadmapOverviewPath}&${roadmapFilterParams({ pick: [id] })}`;

/**
 * A work stream's address (1.31): the Roadmap overview narrowed to it, `/roadmap?mode=overview&workStreamId=3`.
 * Still to come in 1.31: the overview does not read `workStreamId` yet (it narrows by `programId` alone); the narrowing arrives with the overview commit, the parameter name is fixed here.
 */
export const workStreamPath = (id: number) => `${roadmapOverviewPath}&workStreamId=${id}`;

/**
 * The ONE place a filtered Roadmap URL is spelled out: the Prioritization mode, written first, then the filters and the program pick a link names (an
 * unnamed one is off). Such a link is shown as written and does not change what the browser remembers.
 */
export function roadmapFilteredPath(state: RoadmapFilterLink): string {
  const query = roadmapFilterParams(state).toString();
  return query === "" ? roadmapModePath("prioritization") : `${roadmapModePath("prioritization")}&${query}`;
}

/**
 * Whether a click on a link is the ordinary one the router follows in this tab: the primary button with no modifier. A ctrl / cmd / shift / alt
 * or middle click opens the link elsewhere and leaves this page's address as it is, so nothing may be said or moved for it.
 */
export const isPlainClick = (event: { button: number; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }): boolean =>
  event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey;
