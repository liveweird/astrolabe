// Roadmap API (`/api/v1/views/roadmap`, `/api/v1/roadmap/ranking`, V13) — the ONE global project ranking. Everyone signed in
// reads the view; `can.editRank` says whether this caller may replace the ranking, and the server's guard is the rule.
// Thin endpoint wrappers: transport (authedFetch/ApiError) in ./http, types from ./schema.

import { ApiError, buildQuery, jsonRequest } from "./http";
import type { components } from "./schema";

type Schemas = components["schemas"];

export type RoadmapView = Schemas["RoadmapView"];
export type RoadmapRankedProject = Schemas["RoadmapRankedProject"];
export type RoadmapProject = Schemas["RoadmapProject"];
export type RoadmapLink = Schemas["RoadmapLink"];
export type RemovedProject = Schemas["RemovedProject"];
/** 1.7: the chain toward the picked project (`?criticalPath=N`), rolled up to projects and ordered project pairs. */
export type RoadmapCriticalPath = Schemas["RoadmapCriticalPath"];
export type RoadmapCriticalProject = Schemas["RoadmapCriticalProject"];
export type PlanFlag = Schemas["PlanFlag"];
/** A plan node's Jira item (1.3): the key, the dates Jira was last observed to hold and the connection (its site is in the document's `jiraSites`). */
export type JiraLink = Schemas["JiraLink"];
export type JiraSite = Schemas["JiraSite"];
export type RankingBody = Schemas["RankingUpdateRequest"];

/** The problem `type` of the 409 a ranking PUT answers when its `expectedRevision` is behind the plan's. */
const STALE_REVISION_TYPE = "urn:astrolabe:problem:stale-revision";

/**
 * `baseline` (v0.9) is the id of the baseline to compare with: the document then gains its `baseline` blocks. `criticalPath` (1.7) is the id of the
 * project to show the critical chain toward: the document then gains its `criticalPath` block. Absent or null = the plain view; both may be combined.
 */
export async function getRoadmapView(baseline?: number | null, criticalPath?: number | null): Promise<RoadmapView> {
  const query = buildQuery({ baseline, criticalPath });
  return jsonRequest<RoadmapView>(`/api/v1/views/roadmap${query === "" ? "" : `?${query}`}`);
}

/**
 * The cached roadmap view's key, under the `["roadmap"]` prefix every plan write refreshes; it carries the baseline pick and the critical-path target
 * (1.7), so another pick or another target is another entry.
 */
export const roadmapViewKey = (baseline: number | null, criticalPath: number | null = null) => ["roadmap", "view", { baseline, criticalPath }] as const;

/** Wholesale: the listed projects get positions 1..n in order, every other project becomes unranked. Answers the new revision. */
export async function putRanking(body: RankingBody): Promise<Schemas["RankingResponse"]> {
  return jsonRequest<Schemas["RankingResponse"]>("/api/v1/roadmap/ranking", { method: "PUT", body: JSON.stringify(body) });
}

/** A 409 with the stale-revision problem type — the list changed under the caller (any other 409 is not this). */
export function isStaleRevision(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409 && err.type === STALE_REVISION_TYPE;
}
