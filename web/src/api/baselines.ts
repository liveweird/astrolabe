// Baselines API (V20, v0.9.0) — the registry of named, immutable copies of the plan (`/baselines`) and the comparison of one with the plan
// now (`/views/baseline/{id}`). Everyone signed in reads both; ADMIN or a ROADMAP_EDITOR takes, renames and deletes (`can.manage`, which the
// server computes with the guard's own arithmetic). Thin endpoint wrappers: transport (authedFetch/ApiError) in ./http, types from ./schema.

import { ApiError, jsonRequest, voidRequest } from "./http";
import type { components } from "./schema";

type Schemas = components["schemas"];

export type Baseline = Schemas["BaselineResponse"];
export type BaselineList = Schemas["BaselineList"];
export type BaselineCreateBody = Schemas["BaselineCreateRequest"];
export type BaselineUpdateBody = Schemas["BaselineUpdateRequest"];
export type BaselineView = Schemas["BaselineView"];
export type BaselineViewProject = Schemas["BaselineViewProject"];
export type BaselineViewMilestone = Schemas["BaselineViewMilestone"];
export type BaselineFigures = Schemas["BaselineFigures"];
export type Movement = Schemas["Movement"];
export type MovementTotals = Schemas["MovementTotals"];

/** The most active baselines there can be (the server's cap; a create at the cap is a 409, delete one first). */
export const BASELINE_CAP = 100;

/** The problem `type` of the 409 a create answers when {@link BASELINE_CAP} baselines are already active. */
const BASELINE_LIMIT_TYPE = "urn:astrolabe:problem:baseline-limit";

/** A 409 with the baseline-limit problem type (a 409 without it is a name clash). */
export function isBaselineLimit(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409 && err.type === BASELINE_LIMIT_TYPE;
}

/** The active baselines, newest first, with the caller's `can.manage` — a bounded set (≤ 100), unpaged. */
export async function listBaselines(): Promise<BaselineList> {
  return jsonRequest<BaselineList>("/api/v1/baselines");
}

export async function getBaseline(id: number): Promise<Baseline> {
  return jsonRequest<Baseline>(`/api/v1/baselines/${id}`);
}

/** Copies the plan as it is now (under the plan lock); a name clash and the cap are both `409`. */
export async function createBaseline(body: BaselineCreateBody): Promise<Baseline> {
  return jsonRequest<Baseline>("/api/v1/baselines", { method: "POST", body: JSON.stringify(body) });
}

/** A full replace of the name and description (the copy itself is immutable). */
export async function updateBaseline(id: number, body: BaselineUpdateBody): Promise<void> {
  await voidRequest(`/api/v1/baselines/${id}`, { method: "PUT", body: JSON.stringify(body) });
}

/** A soft delete: the name is free again and the baseline reads as `404` everywhere. */
export async function deleteBaseline(id: number): Promise<void> {
  await voidRequest(`/api/v1/baselines/${id}`, { method: "DELETE" });
}

/** The comparison document: the totals, the union of projects and ONLY the changed milestone rows (≤ 1,000), one snapshot. */
export async function getBaselineView(id: number): Promise<BaselineView> {
  return jsonRequest<BaselineView>(`/api/v1/views/baseline/${id}`);
}
