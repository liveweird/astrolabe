// Sync API (V21, v1.1.0) — the run registry of the connectors (`/integrations/sync/runs`): the newest runs of a connection, and "Refresh
// now". Listing is open to every signed-in user (a run names no secret); starting one is ADMIN only. Thin endpoint wrappers.

import { ApiError, buildQuery, jsonRequest } from "./http";
import type { components } from "./schema";

type Schemas = components["schemas"];

export type SyncRun = Schemas["SyncRun"];
export type SyncRunList = Schemas["SyncRunList"];
export type SyncRunRequest = Schemas["SyncRunRequest"];
export type SyncKind = SyncRunRequest["kind"];
export type SyncOutcome = NonNullable<SyncRun["outcome"]>;
export type SyncStatus = Schemas["SyncStatus"];
export type SyncState = SyncStatus["state"];

/** The RFC 7807 `type` of the 409 a claim answers while a run of the same connection and kind is unfinished. */
const RUN_IN_PROGRESS_TYPE = "urn:astrolabe:problem:run-in-progress";

/** A 409 with the run-in-progress type: a normal state ("a run is already going"), not a failure. */
export function isRunInProgress(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409 && err.type === RUN_IN_PROGRESS_TYPE;
}

/** The newest runs first, at most 50 (the registry's retention): a bounded `{items}` list, not paged. Without a `connectionId`: the 50 newest over every connection. */
export async function listSyncRuns(kind: SyncKind, connectionId?: number): Promise<SyncRunList> {
  const params = buildQuery({ kind, connectionId });
  return jsonRequest<SyncRunList>(`/api/v1/integrations/sync/runs?${params}`);
}

/** Claims a run and answers `202` with the running row; the page then polls {@link listSyncRuns}. */
export async function requestSyncRun(body: SyncRunRequest): Promise<SyncRun> {
  return jsonRequest<SyncRun>("/api/v1/integrations/sync/runs", { method: "POST", body: JSON.stringify(body) });
}
