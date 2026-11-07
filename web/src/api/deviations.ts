// Deviations API (v1.1.0) — `GET /views/deviations`: where the plan and the bound Jira items disagree. Open to every signed-in user.
// One purpose-built document (the view endpoints' exception to the paged envelope); thin wrapper, types from ./schema.

import { ApiError, buildQuery, jsonRequest, voidRequest } from "./http";
import type { components } from "./schema";

type Schemas = components["schemas"];

export type DeviationView = Schemas["DeviationView"];
export type DeviationItem = Schemas["DeviationItem"];
export type Deviation = Schemas["Deviation"];
export type DeviationKind = Schemas["DeviationKind"];
export type DeviationSeverity = Deviation["severity"];
export type DeviationConnection = Schemas["DeviationConnection"];
export type DeviationLevel = DeviationItem["level"];
export type Acknowledgement = Schemas["Acknowledgement"];

/**
 * The view's equality filters (a repeated key is a 400, so each is one value). `all` and `acknowledged` are sent only when set (`false` too):
 * absent, the list is the OPEN items; `acknowledged=true` the currently acknowledged ones; `all=true` everything (`projectId`/`teamId` imply it).
 */
export type DeviationFilter = {
  connectionId?: number;
  level?: DeviationLevel;
  severity?: DeviationSeverity;
  kind?: DeviationKind;
  workStreamId?: number;
  programId?: number;
  projectId?: number;
  teamId?: number;
  all?: boolean;
  acknowledged?: boolean;
};

export async function getDeviations(filter: DeviationFilter = {}): Promise<DeviationView> {
  const params = buildQuery({ ...filter });
  return jsonRequest<DeviationView>(`/api/v1/views/deviations${params === "" ? "" : `?${params}`}`);
}

/** The RFC 7807 `type` of the 409 an acknowledge answers when the deviations are not the ones the client read (or there are none). */
const STALE_DEVIATIONS_TYPE = "urn:astrolabe:problem:stale-deviations";

/** A 409 with the stale-deviations type: the plan or Jira moved since the page was read - a normal state, answered with a re-read, not a failure. */
export function isStaleDeviations(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409 && err.type === STALE_DEVIATIONS_TYPE;
}

/** Acknowledges the binding's deviations until they change; `fingerprint` is the item's own, as the client read it (the server refuses a difference with a 409). */
export async function acknowledgeDeviation(bindingId: number, fingerprint: string): Promise<Acknowledgement> {
  return jsonRequest<Acknowledgement>(`/api/v1/integrations/jira/bindings/${bindingId}/acknowledge`, { method: "POST", body: JSON.stringify({ fingerprint }) });
}

/** Withdraws the binding's acknowledgement, current or stale (a 404 when none is stored). */
export async function unacknowledgeDeviation(bindingId: number): Promise<void> {
  await voidRequest(`/api/v1/integrations/jira/bindings/${bindingId}/acknowledge`, { method: "DELETE" });
}
