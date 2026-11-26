// Plan API (`/api/v1/work-streams`, `/programs`, `/projects`, `/views/plan`, V12) — the hierarchy work stream → program →
// project, every node owned by a person. Everyone signed in reads the plan view; the `can` flags inside it say what the
// caller may do, and the server's guards are the rule. Thin endpoint wrappers: transport (authedFetch/ApiError) in ./http,
// types from ./schema.

import { buildQuery, jsonRequest, voidRequest } from "./http";
import { revalidatedRequest } from "./revalidate";
import type { components } from "./schema";

type Schemas = components["schemas"];

export type PlanView = Schemas["PlanView"];
export type PlanWorkStream = Schemas["PlanWorkStream"];
export type PlanProgram = Schemas["PlanProgram"];
export type PlanProject = Schemas["PlanProject"];
export type WorkStreamBody = Schemas["WorkStreamCreateRequest"] & Schemas["WorkStreamUpdateRequest"];
export type ProgramBody = Schemas["ProgramCreateRequest"] & Schemas["ProgramUpdateRequest"];
export type ProjectCreateBody = Schemas["ProjectCreateRequest"];
export type ProjectUpdateBody = Schemas["ProjectUpdateRequest"];
export type TargetWindowBody = Schemas["TargetWindowRequest"];
type ProjectPage = Schemas["ProjectPage"];
type ProgramPage = Schemas["ProgramPage"];

/** The plan view's query key (`["plan", "view"]`), shared by every reader of `getPlanView`; a write refreshes it under the `["plan"]` prefix. */
export const planViewKey = ["plan", "view"] as const;

/** The plan levels below a work stream, in hierarchy order (the Jira level choices of the filters and lists). */
export const LEVELS: readonly Schemas["PlanLevel"][] = ["PROGRAM", "PROJECT", "MILESTONE"];

type ProjectListQuery = { page: number; pageSize: number; sort?: string; name?: string };

/** The paged project list (each row carries `programName` and `workStreamName`) - the dependency pickers' search; `name` is a case- and accent-insensitive substring. */
export async function listProjects(q: ProjectListQuery): Promise<ProjectPage> {
  const params = buildQuery({ page: q.page, pageSize: q.pageSize, sort: q.sort, name: q.name });
  return jsonRequest<ProjectPage>(`/api/v1/projects?${params}`);
}

/** The paged program list (each row carries `workStreamName`) - the Jira bind dialog's search; `name` is a case- and accent-insensitive substring. */
export async function listPrograms(q: ProjectListQuery): Promise<ProgramPage> {
  const params = buildQuery({ page: q.page, pageSize: q.pageSize, sort: q.sort, name: q.name });
  return jsonRequest<ProgramPage>(`/api/v1/programs?${params}`);
}

export async function getPlanView(): Promise<PlanView> {
  return revalidatedRequest<PlanView>("/api/v1/views/plan");
}

export async function createWorkStream(body: WorkStreamBody): Promise<Schemas["WorkStreamResponse"]> {
  return jsonRequest<Schemas["WorkStreamResponse"]>("/api/v1/work-streams", { method: "POST", body: JSON.stringify(body) });
}

export async function updateWorkStream(id: number, body: WorkStreamBody): Promise<void> {
  await voidRequest(`/api/v1/work-streams/${id}`, { method: "PUT", body: JSON.stringify(body) });
}

export async function deleteWorkStream(id: number): Promise<void> {
  await voidRequest(`/api/v1/work-streams/${id}`, { method: "DELETE" });
}

export async function createProgram(workStreamId: number, body: ProgramBody): Promise<Schemas["ProgramResponse"]> {
  return jsonRequest<Schemas["ProgramResponse"]>(`/api/v1/work-streams/${workStreamId}/programs`, { method: "POST", body: JSON.stringify(body) });
}

export async function updateProgram(id: number, body: ProgramBody): Promise<void> {
  await voidRequest(`/api/v1/programs/${id}`, { method: "PUT", body: JSON.stringify(body) });
}

export async function deleteProgram(id: number): Promise<void> {
  await voidRequest(`/api/v1/programs/${id}`, { method: "DELETE" });
}

export async function createProject(programId: number, body: ProjectCreateBody): Promise<Schemas["ProjectResponse"]> {
  return jsonRequest<Schemas["ProjectResponse"]>(`/api/v1/programs/${programId}/projects`, { method: "POST", body: JSON.stringify(body) });
}

export async function updateProject(id: number, body: ProjectUpdateBody): Promise<void> {
  await voidRequest(`/api/v1/projects/${id}`, { method: "PUT", body: JSON.stringify(body) });
}

export async function updateProjectDetails(id: number, body: Schemas["ProjectDetailsRequest"]): Promise<void> {
  await voidRequest(`/api/v1/projects/${id}/details`, { method: "PUT", body: JSON.stringify(body) });
}

/** The target window is its own PUT (its own guard): both dates or neither — a null pair clears it. */
export async function setProjectTargetWindow(id: number, body: TargetWindowBody): Promise<void> {
  await voidRequest(`/api/v1/projects/${id}/target-window`, { method: "PUT", body: JSON.stringify(body) });
}

/** Reparent a project under another program (`POST /projects/{id}/move`, 204); the milestones and the global rank travel with it. */
export async function moveProject(id: number, programId: number): Promise<void> {
  const body: Schemas["ProjectMoveRequest"] = { programId };
  await voidRequest(`/api/v1/projects/${id}/move`, { method: "POST", body: JSON.stringify(body) });
}

/** Reparent a program under another work stream (`POST /programs/{id}/move`, 204); its projects travel with it. */
export async function moveProgram(id: number, workStreamId: number): Promise<void> {
  const body: Schemas["ProgramMoveRequest"] = { workStreamId };
  await voidRequest(`/api/v1/programs/${id}/move`, { method: "POST", body: JSON.stringify(body) });
}

/**
 * Wholesale: the listed work streams take positions 1..n in order, every other one becomes unlisted (by name after them), `[]` resets (ADMIN).
 * `expectedRevision` is the view's `workStreamOrderRevision`. Answers the new revision of that list; a stale one is a 409.
 */
export async function putWorkStreamOrder(body: Schemas["WorkStreamOrderUpdateRequest"]): Promise<Schemas["PlanOrderResponse"]> {
  return jsonRequest<Schemas["PlanOrderResponse"]>("/api/v1/work-stream-order", { method: "PUT", body: JSON.stringify(body) });
}

/** The same for one work stream's programs (its owner or ADMIN); `expectedRevision` is that stream's `programOrderRevision`. */
export async function putProgramOrder(workStreamId: number, body: Schemas["ProgramOrderUpdateRequest"]): Promise<Schemas["PlanOrderResponse"]> {
  return jsonRequest<Schemas["PlanOrderResponse"]>(`/api/v1/work-streams/${workStreamId}/program-order`, { method: "PUT", body: JSON.stringify(body) });
}

export async function deleteProject(id: number): Promise<void> {
  await voidRequest(`/api/v1/projects/${id}`, { method: "DELETE" });
}
