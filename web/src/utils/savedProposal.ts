import type { SavedProposalRecord } from "../api/savedProposals";
import type { CrossTeamProposal } from "../api/scheduleProposals";
import type { ScheduleCheckState } from "./scheduleProposal";

// Pure derivations of a saved cross-team proposal's page (1.26): which run is on screen, and which check describes the ticks. The server decided
// every date and verdict; nothing here recomputes one.

/** The same run: the day, the plan revision and the scope token it was computed for (a fresh run of an unchanged plan on the same day IS the stored one). */
export const sameRun = (a: Pick<CrossTeamProposal, "asOf" | "revision" | "scopeHash">, b: Pick<CrossTeamProposal, "asOf" | "revision" | "scopeHash">): boolean =>
  a.asOf === b.asOf && a.revision === b.revision && a.scopeHash === b.scopeHash;

/** The same set of milestone ids. */
export const sameIds = (ticked: ReadonlySet<number>, ids: readonly number[]): boolean => ticked.size === ids.length && ids.every((id) => ticked.has(id));

/**
 * The check state of the STORED ticks: every move ticked = the run's own verdicts (the server stores no check then); a subset = the check the
 * server stored with the save, already answered (never pending, never failed).
 */
export function storedCheckState(record: Pick<SavedProposalRecord, "check" | "selectedMilestoneIds" | "moveCount">): ScheduleCheckState {
  const all = record.selectedMilestoneIds.length >= record.moveCount;
  return {
    mode: all ? "all" : "some",
    byTeam: all || record.check === null ? null : new Map(record.check.teams.map((team) => [team.teamId, team])),
    pending: false,
    failed: false,
  };
}

/** The address's word for the saved proposal the Roadmap overview has open (`savedProposalPath`: `/roadmap?mode=overview&proposal=5`). */
export const PROPOSAL_PARAM = "proposal";

/** The search with `proposal=<id>` set (the saved list's links: every other parameter - the pick, the narrowing - stays, so the bars the run moves are the ones the viewer was looking at). */
export function withProposal(current: URLSearchParams, id: number): URLSearchParams {
  const next = new URLSearchParams(current);
  next.set(PROPOSAL_PARAM, String(id));
  return next;
}

/** The search without `proposal`. */
export function withoutProposal(current: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(current);
  next.delete(PROPOSAL_PARAM);
  return next;
}
