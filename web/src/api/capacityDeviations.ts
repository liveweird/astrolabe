// Capacity deviations API (1.6.0) — `GET /views/capacity-deviations`: where a linked team's capacity in the plan differs from what Flow would make it
// carry, per current or future sprint. Open to every signed-in user. One purpose-built document (the view endpoints' exception to the paged
// envelope), a read only; thin wrapper, types from ./schema.

import { buildQuery, jsonRequest } from "./http";
import type { components } from "./schema";

type Schemas = components["schemas"];

export type CapacityDeviationView = Schemas["CapacityDeviationView"];
export type CapacityDeviationItem = Schemas["CapacityDeviationItem"];
export type CapacityDeviation = Schemas["CapacityDeviation"];
export type CapacityDeviationKind = Schemas["CapacityDeviationKind"];
export type CapacityDeviationConnection = Schemas["CapacityDeviationConnection"];

/**
 * The view's equality filters (a repeated key is a 400, so each is one value). `severity` and `kind` narrow a team's ROWS, not only the team
 * list, so "warnings only" lists the warning sprints; `teamId` is the team page's own question.
 */
export type CapacityDeviationFilter = {
  connectionId?: number;
  teamId?: number;
  severity?: CapacityDeviation["severity"];
  kind?: CapacityDeviationKind;
};

export async function getCapacityDeviations(filter: CapacityDeviationFilter = {}): Promise<CapacityDeviationView> {
  const params = buildQuery({ ...filter });
  return jsonRequest<CapacityDeviationView>(`/api/v1/views/capacity-deviations${params === "" ? "" : `?${params}`}`);
}
