// Roadmap API (`/api/v1/views/roadmap`, `/api/v1/roadmap/ranking`, V13) — the ONE global project ranking. Everyone signed in
// reads the view; `can.editRank` says whether this caller may replace the ranking, and the server's guard is the rule.
// Thin endpoint wrappers: transport (authedFetch/ApiError) in ./http, types from ./schema.

import { ApiError, jsonRequest } from "./http";
import type { components } from "./schema";

type Schemas = components["schemas"];

export type RoadmapView = Schemas["RoadmapView"];
export type RoadmapRankedProject = Schemas["RoadmapRankedProject"];
export type RoadmapProject = Schemas["RoadmapProject"];
export type RankingBody = Schemas["RankingUpdateRequest"];

/** The problem `type` of the 409 a ranking PUT answers when its `expectedRevision` is behind the plan's. */
const STALE_REVISION_TYPE = "urn:astrolabe:problem:stale-revision";

export async function getRoadmapView(): Promise<RoadmapView> {
  return jsonRequest<RoadmapView>("/api/v1/views/roadmap");
}

/** Wholesale: the listed projects get positions 1..n in order, every other project becomes unranked. Answers the new revision. */
export async function putRanking(body: RankingBody): Promise<Schemas["RankingResponse"]> {
  return jsonRequest<Schemas["RankingResponse"]>("/api/v1/roadmap/ranking", { method: "PUT", body: JSON.stringify(body) });
}

/** A 409 with the stale-revision problem type — the list changed under the caller (any other 409 is not this). */
export function isStaleRevision(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409 && err.type === STALE_REVISION_TYPE;
}
