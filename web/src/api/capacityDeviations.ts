// Capacity deviations API (1.6.0) — `GET /views/capacity-deviations`: where a linked team's capacity in the plan differs from what Flow would make it
// carry, per current or future sprint. Open to every signed-in user. One purpose-built document (the view endpoints' exception to the paged
// envelope); the per-sprint acknowledge (1.9) is the team's manager's or an ADMIN's. Thin wrappers, types from ./schema.

import { buildQuery, jsonRequest, voidRequest } from "./http";
import type { components } from "./schema";

type Schemas = components["schemas"];

export type CapacityDeviationView = Schemas["CapacityDeviationView"];
export type CapacityDeviationItem = Schemas["CapacityDeviationItem"];
export type CapacityDeviation = Schemas["CapacityDeviation"];
export type CapacityDeviationKind = Schemas["CapacityDeviationKind"];
export type CapacityDeviationConnection = Schemas["CapacityDeviationConnection"];
export type CapacityDeviationCan = Schemas["CapacityDeviationCan"];
export type CapacityAcknowledgement = Schemas["CapacityAcknowledgement"];

/**
 * The view's equality filters (a repeated key is a 400, so each is one value). `severity` and `kind` narrow a team's ROWS, not only the team
 * list, so "warnings only" lists the warning sprints; `teamId` is the team page's own question (and, as on the Jira view, implies `all`).
 * `acknowledged` and `all` are sent only when set, `false` too: absent, the list is the OPEN rows; `acknowledged=true` the currently acknowledged
 * ones; `all=true` both.
 */
export type CapacityDeviationFilter = {
  connectionId?: number;
  teamId?: number;
  severity?: CapacityDeviation["severity"];
  kind?: CapacityDeviationKind;
  acknowledged?: boolean;
  all?: boolean;
};

export async function getCapacityDeviations(filter: CapacityDeviationFilter = {}): Promise<CapacityDeviationView> {
  const params = buildQuery({ ...filter });
  return jsonRequest<CapacityDeviationView>(`/api/v1/views/capacity-deviations${params === "" ? "" : `?${params}`}`);
}

const acknowledgePath = (bindingId: number) => `/api/v1/integrations/flow/team-bindings/${bindingId}/acknowledge`;

/**
 * Acknowledges ONE sprint's deviation until its figures change. `sprintId` is the row's `detail.sprintId` (null = the team's own `TEAM_GONE` row, always
 * sent: an absent key is a 400) and `fingerprint` the row's own, as the client read it (the server refuses a difference with the shared 409
 * `stale-deviations`; see `isStaleDeviations` in `./deviations`).
 */
export async function acknowledgeCapacityDeviation(bindingId: number, body: { sprintId: number | null; fingerprint: string }): Promise<CapacityAcknowledgement> {
  return jsonRequest<CapacityAcknowledgement>(acknowledgePath(bindingId), { method: "POST", body: JSON.stringify(body) });
}

/**
 * Acknowledges SEVERAL sprints of one team in one call (`POST …/acknowledge-all`): the rows the client lists as open, each with the fingerprint it read.
 * All or nothing - a row that is not listed now or has another fingerprint is the shared 409 `stale-deviations` and nothing is stored. The `sprintId`
 * keys follow the single acknowledge's rule (null = the team's own row, always sent); a row is named once.
 */
export async function acknowledgeCapacityDeviations(bindingId: number, items: readonly { sprintId: number | null; fingerprint: string }[]): Promise<Schemas["CapacityAcknowledgeBatch"]> {
  return jsonRequest<Schemas["CapacityAcknowledgeBatch"]>(`${acknowledgePath(bindingId)}-all`, { method: "POST", body: JSON.stringify({ items }) });
}

/**
 * Withdraws the acknowledgement of SEVERAL sprints of one team in one call (`POST …/unacknowledge-all`, 1.11): the rows the client lists as acknowledged,
 * each by its `sprintId` (null = the team's own row, always sent). All or nothing - a row with no stored acknowledgement is the shared 409
 * `stale-deviations` and nothing is deleted. Answers 204.
 */
export async function unacknowledgeCapacityDeviations(bindingId: number, items: readonly { sprintId: number | null }[]): Promise<void> {
  await voidRequest(`/api/v1/integrations/flow/team-bindings/${bindingId}/unacknowledge-all`, { method: "POST", body: JSON.stringify({ items }) });
}

/** Withdraws one sprint's acknowledgement, current or stale (`sprintId` null = the team's own row, sent as no parameter; a 404 when none is stored). */
export async function unacknowledgeCapacityDeviation(bindingId: number, sprintId: number | null): Promise<void> {
  const params = buildQuery({ sprintId });
  await voidRequest(`${acknowledgePath(bindingId)}${params === "" ? "" : `?${params}`}`, { method: "DELETE" });
}
