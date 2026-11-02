import type { TFunction } from "i18next";
import type { ScheduleProposal, ScheduleProposalMove, SkippedSchedule, TeamMilestone, TeamScheduleBatchResponse, TeamView } from "../api/teams";
import type { TimelineBarData } from "./timelineModel";

/**
 * Pure derivations of the schedule proposal (v0.8): what the team timeline draws beside the current bars, the sentences the page says,
 * and the batch body of an accept. The SERVER decides every date and figure; nothing here recomputes a schedule.
 */

/** The part of a proposal the team timeline draws: the moved milestones' proposed spans and the weekly load AFTER accepting all of them. */
export type TeamProposalView = Pick<ScheduleProposal, "moves" | "weeks">;

/** The id of a proposal bar (unique among the timeline's bars, whose own ids are the milestones' numbers). */
const proposalBarId = (milestoneId: number) => `proposal:${milestoneId}`;

/** The proposal bar of one move: read-only, the `proposal` tone (hollow, dashed), named in words. */
function proposalBar(move: ScheduleProposalMove, t: TFunction): TimelineBarData {
  return {
    id: proposalBarId(move.milestoneId),
    start: move.to.start,
    end: move.to.end,
    label: move.name,
    describe: t("timeline.bar.proposal", { name: move.name, start: move.to.start, end: move.to.end }),
    editable: false,
    tone: "proposal",
  };
}

/** The proposal bars by milestone id (a second bar in the milestone's row). */
export function proposalBars(moves: readonly ScheduleProposalMove[], t: TFunction): Map<number, TimelineBarData> {
  return new Map(moves.map((move) => [move.milestoneId, proposalBar(move, t)]));
}

/**
 * The rows a preview APPENDS after the scheduled ones: the tray's milestones that the proposal schedules, in the tray's own (effective)
 * order. A move whose milestone is not in the tray (it is a row already, or left the team meanwhile) adds nothing here.
 */
export function proposalRows(view: Pick<TeamView, "unscheduled">, moves: readonly ScheduleProposalMove[]): TeamMilestone[] {
  const moved = new Set(moves.map((move) => move.milestoneId));
  return view.unscheduled.filter((milestone) => moved.has(milestone.id));
}

/** Every first and last day of the proposed spans: the page's range grows over them, so no proposed bar sits outside the shown range. */
export function proposalDays(moves: readonly ScheduleProposalMove[]): string[] {
  return moves.flatMap((move) => [move.to.start, move.to.end]);
}

/**
 * "Unscheduled → 2042-01-07 to 2042-01-10, 4 working days" for a newly scheduled milestone, else how far its start moves in working days
 * ("34 working days earlier"); a stored span that starts off the working calendar can differ in dates with `shiftDays` 0.
 */
export function changeSentence(move: ScheduleProposalMove, t: TFunction): string {
  const { shiftDays, workingDays, to } = move;
  if (shiftDays === null) return t("teams.proposal.change.new", { start: to.start, end: to.end, count: workingDays });
  if (shiftDays < 0) return t("teams.proposal.change.earlier", { count: -shiftDays });
  if (shiftDays > 0) return t("teams.proposal.change.later", { count: shiftDays });
  return t("teams.proposal.change.adjusted", { count: workingDays });
}

/**
 * A proposal the page states in a note instead of opening a preview: `nothing` when no milestone would move and none is left unplaced,
 * `noCapacity` when none would move, none stays and every movable milestone lacks capacity ("add a capacity period first"), else `null`.
 */
export type ProposalNote = "nothing" | "noCapacity";

export function noteOf(proposal: Pick<ScheduleProposal, "moves" | "unchanged" | "unplaced">): ProposalNote | null {
  if (proposal.moves.length > 0) return null;
  if (proposal.unplaced.length === 0) return "nothing";
  if (proposal.unchanged.length === 0 && proposal.unplaced.every((unplaced) => unplaced.reason === "NO_CAPACITY")) return "noCapacity";
  return null;
}

/** The batch body's items: the SELECTED moves, in the proposal's order, each exactly as proposed. */
export function acceptItems(proposal: Pick<ScheduleProposal, "moves">, selected: ReadonlySet<number>) {
  return proposal.moves
    .filter((move) => selected.has(move.milestoneId))
    .map((move) => ({ milestoneId: move.milestoneId, startDate: move.to.start, endDate: move.to.end }));
}

/** What an accept came to: how many milestones were written and which were skipped (with the server's reason). */
export type ProposalOutcome = { accepted: number; skipped: SkippedSchedule[] };

export const outcomeOf = (response: Pick<TeamScheduleBatchResponse, "accepted" | "skipped">): ProposalOutcome => ({
  accepted: response.accepted.length,
  skipped: response.skipped,
});

const REASON_KEYS = {
  STALE: "teams.proposal.reason.stale",
  GONE: "teams.proposal.reason.gone",
  NOT_ON_TEAM: "teams.proposal.reason.notOnTeam",
  NO_WORKING_DAY: "teams.proposal.reason.noWorkingDay",
} as const;

/**
 * "3 scheduled · 1 skipped: rescheduled in the meantime". The skipped part names each distinct reason once, in the order the reasons
 * first occur; absent when nothing was skipped, and the scheduled part is absent when nothing was written.
 */
export function outcomeSentence(outcome: ProposalOutcome, t: TFunction): string {
  const parts: string[] = [];
  if (outcome.accepted > 0 || outcome.skipped.length === 0) parts.push(t("teams.proposal.outcome.scheduled", { count: outcome.accepted }));
  if (outcome.skipped.length > 0) {
    const reasons = [...new Set(outcome.skipped.map((skipped) => t(REASON_KEYS[skipped.reason])))].join(", ");
    parts.push(t("teams.proposal.outcome.skipped", { count: outcome.skipped.length, reasons }));
  }
  return parts.join(" · ");
}
