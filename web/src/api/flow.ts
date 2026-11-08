// Flow API (V24, v1.5.0) — the ADMIN-managed Flow connections (`/integrations/flow/connections`): the registry, Test connection, and the team
// links (`/integrations/flow/teams`, `/team-bindings`). Registry routes are ADMIN only; the teams list is open to every signed-in user (the team
// page's link dialog reads it), a link/unlink to the team's manager or ADMIN. Thin endpoint wrappers: transport (authedFetch/ApiError) in ./http,
// types from ./schema. The service token is write-only: it appears in a request body and never in a response.

import { ApiError, buildQuery, jsonRequest, voidRequest } from "./http";
import type { components } from "./schema";

type Schemas = components["schemas"];

export type FlowConnectionPage = Schemas["FlowConnectionPage"];
export type FlowConnection = Schemas["FlowConnection"];
export type FlowConnectionRequest = Schemas["FlowConnectionRequest"];
export type FlowTestResult = Schemas["FlowTestResult"];
export type FlowTeamList = Schemas["FlowTeamList"];
export type FlowTeamListItem = Schemas["FlowTeamListItem"];
export type FlowTeamBinding = Schemas["FlowTeamBinding"];
export type FlowTeamBindRequest = Schemas["FlowTeamBindRequest"];
export type FlowTeamMatch = Schemas["FlowTeamMatch"];
export type FlowTeamPanel = Schemas["FlowTeamPanel"];
export type FlowPanelBinding = Schemas["FlowPanelBinding"];
export type FlowPanelConnection = Schemas["FlowPanelConnection"];
export type FlowRoster = Schemas["FlowRoster"];
export type CapacityPreview = Schemas["CapacityPreview"];
export type CapacityPreviewItem = Schemas["CapacityImportItem"];
export type CapacityPreviewRequest = Schemas["CapacityPreviewRequest"];
export type CapacityApplyItem = Schemas["CapacityApplyItem"];
export type CapacityApplyRequest = Schemas["CapacityApplyRequest"];
export type CapacityApplyResponse = Schemas["CapacityApplyResponse"];

/** The RFC 7807 `type` of the 409 when the team or the Flow team is already linked (1:1 both ways): its `detail` names the other side. */
const ALREADY_BOUND_TYPE = "urn:astrolabe:problem:already-bound";

/** A 409 telling the team, or the Flow team, is already linked to something else. */
export function isFlowAlreadyBound(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409 && err.type === ALREADY_BOUND_TYPE;
}

type FlowConnectionListQuery = { page: number; pageSize: number; sort?: string };

export async function listFlowConnections(q: FlowConnectionListQuery): Promise<FlowConnectionPage> {
  const params = buildQuery({ page: q.page, pageSize: q.pageSize, sort: q.sort });
  return jsonRequest<FlowConnectionPage>(`/api/v1/integrations/flow/connections?${params}`);
}

export async function getFlowConnection(id: number): Promise<FlowConnection> {
  return jsonRequest<FlowConnection>(`/api/v1/integrations/flow/connections/${id}`);
}

export async function createFlowConnection(body: FlowConnectionRequest): Promise<FlowConnection> {
  return jsonRequest<FlowConnection>("/api/v1/integrations/flow/connections", { method: "POST", body: JSON.stringify(body) });
}

/** A full replace; an omitted `apiToken` keeps the stored one, a different `baseUrl` is a 409, an omitted `pollIntervalMinutes` resets it to 60. */
export async function updateFlowConnection(id: number, body: FlowConnectionRequest): Promise<void> {
  await voidRequest(`/api/v1/integrations/flow/connections/${id}`, { method: "PUT", body: JSON.stringify(body) });
}

/** Soft delete; the connection's runs, mirror and team links go with it. */
export async function deleteFlowConnection(id: number): Promise<void> {
  await voidRequest(`/api/v1/integrations/flow/connections/${id}`, { method: "DELETE" });
}

/** The probe for a connection that is not (yet) stored, or an edit with a new token: needs the token in the body; stores nothing. */
export async function testFlowConnectionAdHoc(body: FlowConnectionRequest): Promise<FlowTestResult> {
  return jsonRequest<FlowTestResult>("/api/v1/integrations/flow/connections/test", { method: "POST", body: JSON.stringify(body) });
}

/** The probe with the STORED token (no body); records the verdict on the connection, never the mirror (a run does). */
export async function testFlowConnection(id: number): Promise<FlowTestResult> {
  return jsonRequest<FlowTestResult>(`/api/v1/integrations/flow/connections/${id}/test`, { method: "POST" });
}

/** The connection's mirrored Flow teams with their link and suggestion (unpaged, any signed-in user); an empty `items` and a null `teamsAt` before the first run. */
export async function listFlowTeams(connectionId: number): Promise<FlowTeamList> {
  const params = buildQuery({ connectionId });
  return jsonRequest<FlowTeamList>(`/api/v1/integrations/flow/teams?${params}`);
}

/** Links an Astrolabe team to a Flow team (the team's manager or ADMIN; 1:1 both ways; the link calls Flow never). */
export async function createFlowTeamBinding(body: FlowTeamBindRequest): Promise<FlowTeamBinding> {
  return jsonRequest<FlowTeamBinding>("/api/v1/integrations/flow/team-bindings", { method: "POST", body: JSON.stringify(body) });
}

/** Unlinks (a soft delete: both teams are free again; the capacity periods already imported stay). */
export async function deleteFlowTeamBinding(id: number): Promise<void> {
  await voidRequest(`/api/v1/integrations/flow/team-bindings/${id}`, { method: "DELETE" });
}

/** "Link all suggested": ADMIN only; links every Flow team whose name matches exactly one unbound team, in one transaction. */
export async function matchFlowTeams(connectionId: number): Promise<FlowTeamMatch> {
  return jsonRequest<FlowTeamMatch>(`/api/v1/integrations/flow/connections/${connectionId}/team-bindings/match`, { method: "POST" });
}

/** The team page's Flow panel (any signed-in user): the link, its connection's status, the observed roster and `can` for the caller. Its own read, calls Flow never. */
export async function getTeamFlow(teamId: number): Promise<FlowTeamPanel> {
  return jsonRequest<FlowTeamPanel>(`/api/v1/teams/${teamId}/flow`);
}

/** The capacity import's plan for a link (the team's manager or ADMIN): a POST that stores nothing and calls Flow never. An empty body is today with closed sprints left out. */
export async function previewCapacityImport(bindingId: number, body: CapacityPreviewRequest): Promise<CapacityPreview> {
  return jsonRequest<CapacityPreview>(`/api/v1/integrations/flow/team-bindings/${bindingId}/capacity-preview`, { method: "POST", body: JSON.stringify(body) });
}

/** Applies the ticked rows: the server re-runs the plan under the team lock and skips (`CHANGED`) any row that no longer says what `expected` does. */
export async function applyCapacityImport(bindingId: number, body: CapacityApplyRequest): Promise<CapacityApplyResponse> {
  return jsonRequest<CapacityApplyResponse>(`/api/v1/integrations/flow/team-bindings/${bindingId}/capacity-import`, { method: "POST", body: JSON.stringify(body) });
}
