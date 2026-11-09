import type { components } from "./schema";
import { jsonRequest } from "./http";
import type { TeamScheduleBatchResponse } from "./teams";

type Schemas = components["schemas"];

// ---- the plan-scoped schedule proposals (1.8) -----------------------------------------------------------------------------------
// The cross-team run (the teams it may include, the proposal, the one accept) and the ticked-subset check. The proposal and the check are
// computations: nothing is written or stored; only the accept writes.

type CrossTeamProposalRequest = Schemas["CrossTeamProposalRequest"];
type CrossTeamAcceptRequest = Schemas["CrossTeamAcceptRequest"];
type ProposalTeamList = Schemas["ProposalTeamList"];
export type CrossTeamProposal = Schemas["CrossTeamProposal"];
export type CrossTeamProposalTeam = Schemas["CrossTeamProposalTeam"];
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

/** The teams the caller may include in a run (ADMIN: every active team; otherwise the ones they manage; none = an empty list). A bounded list, not paged. */
export async function listProposalTeams(): Promise<ProposalTeamList> {
  return jsonRequest<ProposalTeamList>("/api/v1/schedule-proposals/teams");
}

/** One proposal over a set of teams (`asOf` the viewer's local day): the teams in placement order, each in the per-team proposal's shape. Nothing is stored. */
export async function proposeCrossTeamSchedule(body: CrossTeamProposalRequest): Promise<CrossTeamProposal> {
  return jsonRequest<CrossTeamProposal>("/api/v1/schedule-proposals", { method: "POST", body: JSON.stringify(body) });
}

/**
 * The ticked moves of every team of a run as ONE plan write. A moved milestone is skipped (`STALE`), never overwritten; the whole accept is
 * refused (409 `stale-revision` / `stale-scope`) when the plan the run read changed. The answer is the per-team batch's.
 */
export async function acceptCrossTeamSchedule(body: CrossTeamAcceptRequest): Promise<TeamScheduleBatchResponse> {
  return jsonRequest<TeamScheduleBatchResponse>("/api/v1/schedule-proposals/accept", { method: "POST", body: JSON.stringify(body) });
}
