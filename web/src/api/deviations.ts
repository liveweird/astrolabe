// Deviations API (v1.1.0) — `GET /views/deviations`: where the plan and the bound Jira items disagree. Open to every signed-in user.
// One purpose-built document (the view endpoints' exception to the paged envelope); thin wrapper, types from ./schema.

import { ApiError, buildQuery, jsonRequest, voidRequest } from "./http";
import type { components } from "./schema";

type Schemas = components["schemas"];

export type DeviationView = Schemas["DeviationView"];
export type DeviationItem = Schemas["DeviationItem"];
export type Deviation = Schemas["Deviation"];
/** One listed line of an item: a deviation with the state of its own acknowledgement (1.12). */
export type DeviationLine = Schemas["DeviationLine"];
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

/**
 * Acknowledges deviations until they change; `fingerprint` is the item's own, as the client read it (the server refuses a difference with a 409). With
 * `kind` it is that ONE line; without, every line that has no current acknowledgement (the batch "Acknowledge all").
 */
export async function acknowledgeDeviation(bindingId: number, fingerprint: string, kind?: DeviationKind): Promise<Acknowledgement> {
  const body = kind === undefined ? { fingerprint } : { fingerprint, kind };
  return jsonRequest<Acknowledgement>(`/api/v1/integrations/jira/bindings/${bindingId}/acknowledge`, { method: "POST", body: JSON.stringify(body) });
}

/** Withdraws the acknowledgement of one line (`kind`) or, without it, every stored one of the binding, current or stale (a 404 when none is stored). */
export async function unacknowledgeDeviation(bindingId: number, kind?: DeviationKind): Promise<void> {
  const query = kind === undefined ? "" : `?${buildQuery({ kind })}`;
  await voidRequest(`/api/v1/integrations/jira/bindings/${bindingId}/acknowledge${query}`, { method: "DELETE" });
}
