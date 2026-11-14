// Jira API (V21, v1.1.0) — the ADMIN-managed Jira Cloud connections (`/integrations/jira/connections`): the registry, Test connection,
// the stored field discovery, the field mapping and Peek. Every route here is ADMIN only except the bindings list (any signed-in user).
// Thin endpoint wrappers: transport (authedFetch/ApiError) in ./http, types from ./schema. The API token is write-only: it appears in a
// request body and never in a response.

import { ApiError, buildQuery, jsonRequest, voidRequest } from "./http";
import type { components } from "./schema";

type Schemas = components["schemas"];

export type JiraConnectionPage = Schemas["JiraConnectionPage"];
export type JiraConnection = Schemas["JiraConnection"];
export type JiraConnectionRequest = Schemas["JiraConnectionRequest"];
export type JiraTestResult = Schemas["JiraTestResult"];
export type JiraDiscovery = Schemas["JiraDiscovery"];
export type JiraDiscoveredField = Schemas["JiraDiscoveredField"];
export type JiraMapping = Schemas["JiraMapping"];
export type JiraLevelMapping = Schemas["JiraLevelMapping"];
export type JiraMappingResponse = Schemas["JiraMappingResponse"];
export type JiraPeekResponse = Schemas["JiraPeekResponse"];
export type JiraCoverage = Schemas["JiraCoverageResponse"];
export type JiraBindingPage = Schemas["JiraBindingPage"];
export type JiraBinding = Schemas["JiraBinding"];
export type JiraBindRequest = Schemas["JiraBindRequest"];
export type JiraLevel = JiraBindRequest["level"];
export type JiraLinksView = Schemas["JiraLinksView"];
export type JiraNodeLink = Schemas["JiraNodeLink"];
export type JiraImportScope = Schemas["JiraImportScope"];
export type JiraImportRoot = Schemas["JiraImportRoot"];
export type JiraImportMatch = Schemas["JiraImportMatch"];
export type JiraImportPreview = Schemas["JiraImportPreview"];
export type JiraImportItem = Schemas["JiraImportItem"];
export type JiraImportApplyItem = Schemas["JiraImportApplyItem"];
export type JiraImportApplyRequest = Schemas["JiraImportApplyRequest"];
export type JiraImportResult = Schemas["JiraImportResult"];
export type JiraImportSkipReason = JiraImportResult["skipped"][number]["reason"];
export type JiraEstimateUnit = NonNullable<NonNullable<JiraMapping["estimate"]>["unit"]>;
export type JiraAuthScheme = JiraConnection["authScheme"];

/** The RFC 7807 `type` of the 409 a mapping PUT / Peek answers before any Test connection has stored a discovery. */
const NOT_DISCOVERED_TYPE = "urn:astrolabe:problem:jira-not-discovered";
/** … of the 409 when the stored token cannot be decrypted (a changed `DATA_ENCRYPTION_KEY`): enter it again. */
const TOKEN_UNREADABLE_TYPE = "urn:astrolabe:problem:jira-token-unreadable";

/** … of the 409 when the node or the issue is already linked (1:1): its `detail` names the other side. */
const ALREADY_BOUND_TYPE = "urn:astrolabe:problem:already-bound";
/** … of the 409 when the connection's mapping no longer fits the site: an administrator has to fix it. */
const MAPPING_INVALID_TYPE = "urn:astrolabe:problem:jira-mapping-invalid";

/** … of the 409 when a rooted import's linked node cannot be read from (no usable link, the Jira item gone, moved out of the connection's projects or at another level). */
const ROOT_UNUSABLE_TYPE = "urn:astrolabe:problem:jira-root-unusable";

/** A 409 telling the node or the issue is already linked to something else. */
export function isAlreadyBound(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409 && err.type === ALREADY_BOUND_TYPE;
}

/** A 409 telling the connection's mapping no longer fits the site. */
export function isJiraMappingInvalid(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409 && err.type === MAPPING_INVALID_TYPE;
}

/** A 409 telling the connection has no discovery yet: "Test the connection first". */
export function isJiraNotDiscovered(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409 && err.type === NOT_DISCOVERED_TYPE;
}

/** A 409 telling the stored token cannot be decrypted: edit the connection and enter the token again. */
export function isJiraTokenUnreadable(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409 && err.type === TOKEN_UNREADABLE_TYPE;
}

/** A 409 telling a rooted import (1.14) cannot start from the linked node: see the Deviations page. */
export function isJiraRootUnusable(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409 && err.type === ROOT_UNUSABLE_TYPE;
}

type JiraConnectionListQuery = { page: number; pageSize: number; sort?: string };

export async function listJiraConnections(q: JiraConnectionListQuery): Promise<JiraConnectionPage> {
  const params = buildQuery({ page: q.page, pageSize: q.pageSize, sort: q.sort });
  return jsonRequest<JiraConnectionPage>(`/api/v1/integrations/jira/connections?${params}`);
}

export async function getJiraConnection(id: number): Promise<JiraConnection> {
  return jsonRequest<JiraConnection>(`/api/v1/integrations/jira/connections/${id}`);
}

export async function createJiraConnection(body: JiraConnectionRequest): Promise<JiraConnection> {
  return jsonRequest<JiraConnection>("/api/v1/integrations/jira/connections", { method: "POST", body: JSON.stringify(body) });
}

/** A full replace; an omitted `apiToken` keeps the stored one, a different `siteUrl` is a 409. */
export async function updateJiraConnection(id: number, body: JiraConnectionRequest): Promise<void> {
  await voidRequest(`/api/v1/integrations/jira/connections/${id}`, { method: "PUT", body: JSON.stringify(body) });
}

/** Soft delete; the connection's links are unbound with it. */
export async function deleteJiraConnection(id: number): Promise<void> {
  await voidRequest(`/api/v1/integrations/jira/connections/${id}`, { method: "DELETE" });
}

/** The probe for a connection that is not (yet) stored, or an edit with a new token: needs the token in the body; stores nothing. */
export async function testJiraConnectionAdHoc(body: JiraConnectionRequest): Promise<JiraTestResult> {
  return jsonRequest<JiraTestResult>("/api/v1/integrations/jira/connections/test", { method: "POST", body: JSON.stringify(body) });
}

/** The probe with the STORED token (no body); records the verdict and stores the discovery. */
export async function testJiraConnection(id: number): Promise<JiraTestResult> {
  return jsonRequest<JiraTestResult>(`/api/v1/integrations/jira/connections/${id}/test`, { method: "POST" });
}

/** 409 `jira-not-discovered` until a stored Test connection has answered the `field` and `issuetype` reads. */
export async function getJiraDiscovery(id: number): Promise<JiraDiscovery> {
  return jsonRequest<JiraDiscovery>(`/api/v1/integrations/jira/connections/${id}/discovery`);
}

/** Never 409: before a discovery the defaults and the effective mapping are null. */
export async function getJiraMapping(id: number): Promise<JiraMappingResponse> {
  return jsonRequest<JiraMappingResponse>(`/api/v1/integrations/jira/connections/${id}/mapping`);
}

/** The per-level coverage counts over the census mirror (1.14, ADMIN only): `state` says whether there are any (`READY`). */
export async function getJiraCoverage(id: number): Promise<JiraCoverage> {
  return jsonRequest<JiraCoverage>(`/api/v1/integrations/jira/connections/${id}/coverage`);
}

/** A full replace of the document; the server checks it against the stored discovery (400 per violation, 409 `jira-not-discovered`). */
export async function putJiraMapping(id: number, body: JiraMapping): Promise<void> {
  await voidRequest(`/api/v1/integrations/jira/connections/${id}/mapping`, { method: "PUT", body: JSON.stringify(body) });
}

/** One issue read through the mapping; shares the Test connection's rate-limit bucket. */
export async function peekJiraIssue(id: number, key: string): Promise<JiraPeekResponse> {
  const params = buildQuery({ key });
  return jsonRequest<JiraPeekResponse>(`/api/v1/integrations/jira/connections/${id}/peek?${params}`);
}

type JiraBindingListQuery = { page: number; pageSize: number; connectionId?: number; level?: JiraLevel; q?: string; sort?: string };

/** The active bindings of live nodes (any signed-in user reads them). The connection page also asks for one row only to know how many links a delete unbinds. */
export async function listJiraBindings(q: JiraBindingListQuery): Promise<JiraBindingPage> {
  const params = buildQuery({ page: q.page, pageSize: q.pageSize, connectionId: q.connectionId, level: q.level, q: q.q, sort: q.sort });
  return jsonRequest<JiraBindingPage>(`/api/v1/integrations/jira/bindings?${params}`);
}

/** Links a plan node to a Jira issue (the owner chain of the node or ADMIN; 1:1; the server reads the issue once). */
export async function createJiraBinding(body: JiraBindRequest): Promise<JiraBinding> {
  return jsonRequest<JiraBinding>("/api/v1/integrations/jira/bindings", { method: "POST", body: JSON.stringify(body) });
}

/** Unlinks (a soft delete: both the node and the issue are free again). */
export async function deleteJiraBinding(id: number): Promise<void> {
  await voidRequest(`/api/v1/integrations/jira/bindings/${id}`, { method: "DELETE" });
}

/**
 * The client's deadline for the two import calls: a browse can take the server up to 170 s (its own deadline, a 502 `TIMEOUT`), so the
 * transport's 30 s default is far too short. The caller owns the AbortController (it also cancels a preview) and aborts at this mark.
 */
export const IMPORT_TIMEOUT_MS = 180_000;

/** What importing the scope would do, per Jira item (read-only: nothing stored, no lock). Browses Jira once; the per-user `jira-import` bucket is 5/min, shared with the apply. */
export async function previewJiraImport(id: number, body: JiraImportScope, signal: AbortSignal): Promise<JiraImportPreview> {
  return jsonRequest<JiraImportPreview>(`/api/v1/integrations/jira/connections/${id}/import-preview`, { method: "POST", body: JSON.stringify(body), signal });
}

/** Writes the ticked rows in ONE plan write (the one Jira call that moves the plan). The body is strict: `expected.parent` takes only `{kind, nodeId}`. */
export async function applyJiraImport(id: number, body: JiraImportApplyRequest, signal: AbortSignal): Promise<JiraImportResult> {
  return jsonRequest<JiraImportResult>(`/api/v1/integrations/jira/connections/${id}/import`, { method: "POST", body: JSON.stringify(body), signal });
}

/**
 * Every link of a live program or project and the connections (1.15, any signed-in user; two statements on the server, no deviation computation).
 * Milestone links are not listed; `truncated` = the server's 2,000-link cap dropped some.
 */
export async function getJiraLinks(): Promise<JiraLinksView> {
  return jsonRequest<JiraLinksView>("/api/v1/views/jira-links");
}
