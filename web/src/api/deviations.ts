// Deviations API (v1.1.0) — `GET /views/deviations`: where the plan and the bound Jira items disagree. Open to every signed-in user.
// One purpose-built document (the view endpoints' exception to the paged envelope); thin wrapper, types from ./schema.

import { buildQuery, jsonRequest } from "./http";
import type { components } from "./schema";

type Schemas = components["schemas"];

export type DeviationView = Schemas["DeviationView"];
export type DeviationItem = Schemas["DeviationItem"];
export type Deviation = Schemas["Deviation"];
export type DeviationKind = Schemas["DeviationKind"];
export type DeviationSeverity = Deviation["severity"];
export type DeviationConnection = Schemas["DeviationConnection"];
export type DeviationLevel = DeviationItem["level"];

/** The view's equality filters (a repeated key is a 400, so each is one value). `all` is sent only when set. */
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
};

export async function getDeviations(filter: DeviationFilter = {}): Promise<DeviationView> {
  const params = buildQuery({ ...filter });
  return jsonRequest<DeviationView>(`/api/v1/views/deviations${params === "" ? "" : `?${params}`}`);
}
