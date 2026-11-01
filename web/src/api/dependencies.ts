// Dependencies API (`POST /api/v1/projects/{id}/dependencies`, `DELETE /api/v1/dependencies/{id}`, V15) — a link between two time
// points of the plan, each a milestone or a project. The SUCCESSOR is the constrained side, so the successor's project chain (or
// ADMIN) creates and deletes the link; the project view's `dependencies[]` is the read surface (each with its `can.delete`). A
// violated link only warns. Thin endpoint wrappers: transport (authedFetch/ApiError) in ./http, types from ./schema.

import { ApiError, jsonRequest, voidRequest } from "./http";
import type { components } from "./schema";

type Schemas = components["schemas"];

export type DependencyBody = Schemas["DependencyCreateRequest"];
export type DependencyType = Schemas["DependencyType"];
export type EndpointKind = Schemas["EndpointKind"];
export type EndpointRef = Schemas["EndpointRef"];
export type DependencyEndpoint = Schemas["DependencyEndpoint"];
export type ProjectDependency = Schemas["ProjectDependency"];

/** The problem `type` of the 409 a link answers when it would close a cycle (the `cycle` member then names the path). */
const DEPENDENCY_CYCLE_TYPE = "urn:astrolabe:problem:dependency-cycle";

/** Create a link whose SUCCESSOR is the project or one of its milestones (`201`; no revision travels — a link is set, not merged). */
export async function createDependency(projectId: number, body: DependencyBody): Promise<Schemas["DependencyResponse"]> {
  return jsonRequest<Schemas["DependencyResponse"]>(`/api/v1/projects/${projectId}/dependencies`, { method: "POST", body: JSON.stringify(body) });
}

export async function deleteDependency(id: number): Promise<void> {
  await voidRequest(`/api/v1/dependencies/${id}`, { method: "DELETE" });
}

/** A 409 with the dependency-cycle problem type — the link would close a loop (any other 409 is a duplicate pair). */
export function isDependencyCycle(err: unknown): err is ApiError {
  return err instanceof ApiError && err.status === 409 && err.type === DEPENDENCY_CYCLE_TYPE;
}
