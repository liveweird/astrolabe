// Fixtures for the roadmap view and its project rows (also the rows of the Programs view), typed over the schema.
import type { RoadmapProject, RoadmapView } from "../api/roadmap";

/** A project row with nothing scheduled, ranked or flagged, read-only. Override any member (`can`, `flags` and the like are replaced whole). */
export function roadmapProject(over: Partial<RoadmapProject> = {}): RoadmapProject {
  return {
    jira: null,
    id: 1,
    name: "Project",
    programId: 10,
    programName: "Billing",
    workStreamId: 1,
    workStreamName: "Platform",
    ownerPersonId: 5,
    ownerName: "Ola Owner",
    targetStart: null,
    targetEnd: null,
    rankPosition: null,
    teamIds: [],
    span: null,
    drift: null,
    flags: [],
    can: { editTargetWindow: false },
    ...over,
  };
}

/** An empty roadmap the caller may re-rank: no team, link, project or Jira site. Override any member. */
export function roadmapView(over: Partial<RoadmapView> = {}): RoadmapView {
  return { revision: 1, can: { editRank: true }, teams: [], ranked: [], unranked: [], links: [], jiraSites: [], ...over };
}
