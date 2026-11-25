// Teams API — the flat teams (V6) contract ownership is scoped to: any authenticated user
// reads them (the owner pickers, the Teams page), ADMIN curates them and their manager.
// Thin endpoint wrappers: transport (authedFetch/ApiError) in ./http, types from ./schema.

import { ApiError, buildQuery, jsonRequest, voidRequest } from "./http";
import { revalidatedRequest } from "./revalidate";
import type { components, paths } from "./schema";

export type TeamPage = paths["/api/v1/teams"]["get"]["responses"]["200"]["content"]["application/json"];
export type TeamListItem = TeamPage["items"][number];
export type TeamResponse = paths["/api/v1/teams/{id}"]["get"]["responses"]["200"]["content"]["application/json"];
export type TeamCreateBody = paths["/api/v1/teams"]["post"]["requestBody"]["content"]["application/json"];
export type TeamUpdateBody = paths["/api/v1/teams/{id}"]["put"]["requestBody"]["content"]["application/json"];

type TeamListQuery = {
  page: number;
  pageSize: number;
  sort?: string;
  name?: string;
};

export async function listTeams(q: TeamListQuery): Promise<TeamPage> {
  const params = buildQuery({ page: q.page, pageSize: q.pageSize, sort: q.sort, name: q.name });
  return jsonRequest<TeamPage>(`/api/v1/teams?${params}`);
}

/** Teams are read 100 at a time (the page ceiling) and at most this many pages: 2,000 teams, far past a plan's size (about 15). */
export const MAX_TEAM_OPTION_PAGES = 20;
const TEAM_OPTION_PAGE_SIZE = 100;

/**
 * EVERY team by name, for the filter selects (Covenant's `listAllTeams`, bounded): pages of 100 from page 1 until the teams read reach `total` or a
 * page is empty, at most `MAX_TEAM_OPTION_PAGES`. A team created between two reads shifts the next page, so a team answered twice is listed once;
 * a team deleted (or renamed across a page boundary) between two reads can shift one team past the read, until the next refetch - only on a plan of
 * more than 100 teams.
 */
export async function listEveryTeam(): Promise<TeamListItem[]> {
  const byId = new Map<number, TeamListItem>();
  for (let page = 1; page <= MAX_TEAM_OPTION_PAGES; page++) {
    const read = await listTeams({ page, pageSize: TEAM_OPTION_PAGE_SIZE, sort: "name" });
    for (const team of read.items) if (!byId.has(team.id)) byId.set(team.id, team);
    if (read.items.length === 0 || byId.size >= read.total) break;
  }
  return [...byId.values()];
}

export async function getTeam(id: number): Promise<TeamResponse> {
  return jsonRequest<TeamResponse>(`/api/v1/teams/${id}`);
}

export async function createTeam(body: TeamCreateBody): Promise<TeamResponse> {
  return jsonRequest<TeamResponse>("/api/v1/teams", { method: "POST", body: JSON.stringify(body) });
}

export async function updateTeam(id: number, body: TeamUpdateBody): Promise<void> {
  await voidRequest(`/api/v1/teams/${id}`, { method: "PUT", body: JSON.stringify(body) });
}

export async function deleteTeam(id: number): Promise<void> {
  await voidRequest(`/api/v1/teams/${id}`, { method: "DELETE" });
}

// ---- the team view (V16 capacity periods, V17 team order, GET /views/team/{id}) ------------------------------------------------
// Everyone signed in reads the view; its `can` flags say what the caller may do (the team's manager or an ADMIN schedules, edits the
// capacity and the order), and the server's guards are the rule.

type Schemas = components["schemas"];

export type TeamView = Schemas["TeamView"];
export type TeamMilestone = Schemas["TeamMilestone"];
export type WeekLoad = Schemas["WeekLoad"];
export type CapacityPeriod = Schemas["CapacityPeriodResponse"];
export type CapacityPeriodBody = Schemas["CapacityPeriodRequest"];
export type TeamCriticalChain = Schemas["TeamCriticalChain"];
export type TeamChainMember = Schemas["TeamChainMember"];
export type TeamChainLink = Schemas["TeamChainLink"];

/**
 * `baseline` (v0.9) is the id of the baseline to compare with: the document then gains its `baseline` block; absent or null = the plain view.
 * `chain` (1.27) asks for `?criticalChain=true`: the document then gains its `criticalChain` block; `false` sends nothing, so the plain request is the one it always was.
 */
export async function getTeamView(id: number, baseline?: number | null, chain = false): Promise<TeamView> {
  const query = buildQuery({ baseline, criticalChain: chain ? true : undefined });
  return revalidatedRequest<TeamView>(`/api/v1/views/team/${id}${query === "" ? "" : `?${query}`}`);
}

export async function createCapacityPeriod(teamId: number, body: CapacityPeriodBody): Promise<CapacityPeriod> {
  return jsonRequest<CapacityPeriod>(`/api/v1/teams/${teamId}/capacity`, { method: "POST", body: JSON.stringify(body) });
}

/** A full replace; an absent or null `wipLimit` clears the limit. */
export async function updateCapacityPeriod(id: number, body: CapacityPeriodBody): Promise<void> {
  await voidRequest(`/api/v1/capacity-periods/${id}`, { method: "PUT", body: JSON.stringify(body) });
}

export async function deleteCapacityPeriod(id: number): Promise<void> {
  await voidRequest(`/api/v1/capacity-periods/${id}`, { method: "DELETE" });
}

/**
 * Wholesale: the listed milestones are the team's execution order, first first; the unlisted follow in the project rank's order; an
 * empty list resets to the rank. Answers the revision after the write (the team's order revision from now on).
 */
export async function putTeamOrder(teamId: number, body: Schemas["TeamOrderUpdateRequest"]): Promise<Schemas["TeamOrderResponse"]> {
  return jsonRequest<Schemas["TeamOrderResponse"]>(`/api/v1/teams/${teamId}/milestone-order`, { method: "PUT", body: JSON.stringify(body) });
}

// ---- the schedule proposal (v0.8: a computation) and its batch accept ----------------------------------------------------------
// The team's manager or an ADMIN asks for a proposal (nothing is written, nothing is stored); the page holds it and sends the accepted
// moves back with the proposal's `revision`. The batch is N schedule PUTs under the team's guard with a per-milestone staleness rule.

export type ScheduleProposal = Schemas["ScheduleProposal"];
export type ScheduleProposalMove = Schemas["ScheduleProposalMove"];
export type ScheduleProposalUnplaced = Schemas["ScheduleProposalUnplaced"];
export type ScheduleProposalLink = Schemas["ScheduleProposalLink"];
export type ScheduleProposalEnd = Schemas["ScheduleProposalEnd"];
export type TeamScheduleBatchResponse = Schemas["TeamScheduleBatchResponse"];
export type SkippedSchedule = Schemas["SkippedSchedule"];

/** `asOf` is the viewer's local calendar day (`localIsoDate`): the milestones that start after it, or have no dates, may move. */
export async function proposeTeamSchedule(teamId: number, asOf: string): Promise<ScheduleProposal> {
  return jsonRequest<ScheduleProposal>(`/api/v1/teams/${teamId}/schedule-proposal`, { method: "POST", body: JSON.stringify({ asOf }) });
}

/** The problem `type` of the 409 a batch accept answers when the team's plan changed since its proposal (`scopeHash`). */
const STALE_SCOPE_TYPE = "urn:astrolabe:problem:stale-scope";

/** A 409 with the stale-scope problem type: nothing was written, and the proposal it carried is out of date. */
export function isStaleScope(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409 && err.type === STALE_SCOPE_TYPE;
}

/**
 * Writes the listed spans; a milestone that moved since `expectedRevision` is skipped (`STALE`), never overwritten. With the proposal's
 * `scopeHash` the whole batch is refused (409 `stale-scope`) when the team's plan changed beyond the batch's own milestones.
 */
export async function scheduleTeamMilestones(teamId: number, body: Schemas["TeamScheduleBatchRequest"]): Promise<TeamScheduleBatchResponse> {
  return jsonRequest<TeamScheduleBatchResponse>(`/api/v1/teams/${teamId}/milestone-schedules`, { method: "POST", body: JSON.stringify(body) });
}
