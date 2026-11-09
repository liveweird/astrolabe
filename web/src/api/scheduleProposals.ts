import type { components } from "./schema";
import { jsonRequest } from "./http";

type Schemas = components["schemas"];

// ---- the plan-scoped schedule proposals (1.8) -----------------------------------------------------------------------------------
// The ticked-subset check (a computation: nothing is written or stored); the cross-team run's own wrappers join it in the page's commit.

type ScheduleCheckRequest = Schemas["ScheduleCheckRequest"];
type ScheduleCheckResponse = Schemas["ScheduleCheckResponse"];
export type ScheduleCheckTeam = Schemas["ScheduleCheckTeam"];

/**
 * The link verdicts and the weekly load of each listed team if ONLY the given moves were accepted (`items`: the ticked moves, both dates
 * each). The team page asks with its one team; the answer is one block per team, in the request's order. A read, whatever the verb.
 */
export async function checkSchedule(body: ScheduleCheckRequest): Promise<ScheduleCheckResponse> {
  return jsonRequest<ScheduleCheckResponse>("/api/v1/schedule-proposals/check", { method: "POST", body: JSON.stringify(body) });
}
