import type { TFunction } from "i18next";
import type { ScheduleCheckTeam } from "../api/scheduleProposals";
import type { ScheduleProposal, ScheduleProposalEnd, ScheduleProposalLink, ScheduleProposalMove, SkippedSchedule, TeamMilestone, TeamScheduleBatchResponse, TeamView } from "../api/teams";
import type { TimelineBarData } from "./timelineModel";

/**
 * Pure derivations of the schedule proposal (v0.8): what the team timeline draws beside the current bars, the sentences the page says,
 * and the batch body of an accept. The SERVER decides every date and figure; nothing here recomputes a schedule.
 */

/**
 * The part of a proposal the team timeline draws: the moved milestones' proposed spans and the weekly load AFTER accepting the ticked
 * ones. `weeks` is absent when nothing is ticked: the strip then keeps the current load.
 */
export type TeamProposalView = Pick<ScheduleProposal, "moves"> & Partial<Pick<ScheduleProposal, "weeks">>;

/** What the proposal table reads: the figures, the moves, the unplaced rows and the link verdicts - never the revision, hash, team or weeks. */
export type ProposalContent = Pick<ScheduleProposal, "asOf" | "moves" | "unchanged" | "unplaced" | "pinned" | "dependencies">;

/** What the notes under the timeline header read of the proposal flow (structural, so the team page's hook and the cross-team page's both fit). */
export type ProposalFlow = {
  /** The open preview, or `null`; the notes only ask whether one is open. */
  proposal: object | null;
  note: ProposalNote | null;
  noteDate: string;
  outcome: ProposalOutcome | null;
  stale: boolean;
  rescoped: boolean;
  dismiss: () => void;
  error: string | null;
  /** Page-own sentences that replace the team page's for the "no capacity", "stale" and "re-proposed" notes (the cross-team page speaks of several teams). */
  words?: ProposalWords;
};

/** The notes' sentences a page words itself, already translated; `noCapacity` takes the request's `asOf`. */
export type ProposalWords = { noCapacity: (date: string) => string; stale: string; rescoped: string };

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

/** The batch body's items (and the check's): the SELECTED moves, in the proposal's order, each exactly as proposed. */
export function acceptItems(proposal: { moves: readonly ScheduleProposalMove[] }, selected: ReadonlySet<number>) {
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

// ---- the ticked subset: the check's verdicts over the proposal's ----------------------------------------------------------------

/**
 * Where the ticks stand against the proposal's own lists (which describe EVERY move accepted): `all` - they are exact, no check is asked;
 * `none` - nothing would change; `some` - the server's check describes the subset (`byTeam`, once it has answered for the CURRENT ticks).
 */
export type ScheduleCheckState = {
  mode: "all" | "some" | "none";
  byTeam: ReadonlyMap<number, Pick<ScheduleCheckTeam, "weeks" | "weeksTruncated" | "dependencies">> | null;
  /** The ticks changed (or the answer is on its way): the verdicts shown are the proposal's own. */
  pending: boolean;
  /** The check for the current ticks failed: the verdicts shown are the proposal's own. */
  failed: boolean;
};

const isViolatedBefore = (link: ScheduleProposalLink) => link.before === "VIOLATED";

/** Nothing accepted leaves a link violated before as it was: it counts in the gray "stays violated" figure (its dates are not shown for it). */
const stillViolated = (link: ScheduleProposalLink): ScheduleProposalLink => ({ ...link, check: { ...link.check, status: "VIOLATED" } });

/**
 * What the table and the strip show for one team: every move ticked = the proposal as it is; none ticked = the plan as it is (only the
 * links already violated before, as "stay violated", no new warnings) and the current load (no `weeks`); some ticked = the server's check of exactly those moves once it has answered, the proposal's own verdicts (all moves
 * accepted) while it is on its way or has failed - the table says so. The verdicts are never computed here.
 */
export function overlayCheck<P extends Pick<ScheduleProposal, "dependencies"> & Partial<Pick<ScheduleProposal, "weeks">>>(
  open: P,
  check: ScheduleCheckState,
  teamId: number,
): Omit<P, "weeks"> & Pick<TeamProposalView, "weeks"> {
  if (check.mode === "none") return { ...open, dependencies: open.dependencies.filter(isViolatedBefore).map(stillViolated), weeks: undefined };
  const team = check.mode === "some" ? check.byTeam?.get(teamId) : undefined;
  return team === undefined ? open : { ...open, dependencies: team.dependencies, weeks: team.weeks, weeksTruncated: team.weeksTruncated };
}

// ---- the Proposed schedule section: the figures and the links column ----------------------------------------------------------

/** How many moves schedule a milestone that has no dates yet (the summary line's "newly scheduled"). */
export const newlyScheduledCount = (moves: readonly ScheduleProposalMove[]): number => moves.filter((move) => move.from === null).length;

/**
 * The links the summary badges count: `newlyViolated` are violated AFTER the moves and were not before (the red badge: the proposal would
 * break them), `stillViolated` are violated before and after (a gray badge: the proposal leaves them as they were). The server's `check`
 * is the verdict; nothing is re-checked here. The server lists only the links violated before or after the moves, so these two counts are
 * the whole of what the list holds.
 */
export function linkTotals(links: readonly Pick<ScheduleProposalLink, "before" | "check">[]): { newlyViolated: number; stillViolated: number } {
  const violatedAfter = links.filter((link) => link.check.status === "VIOLATED");
  const stillViolated = violatedAfter.filter((link) => link.before === "VIOLATED").length;
  return { newlyViolated: violatedAfter.length - stillViolated, stillViolated };
}

/** A link at a moved milestone: the other end, and whether THIS milestone is the link's predecessor (else its successor). */
export type LinkAtMove = { link: ScheduleProposalLink; other: ScheduleProposalEnd; thisIsPredecessor: boolean };

const isMoveEnd = (end: ScheduleProposalEnd, move: Pick<ScheduleProposalMove, "milestoneId" | "projectId">) =>
  end.kind === "MILESTONE" ? end.id === move.milestoneId : end.id === move.projectId;

/**
 * The Links column of a move: the links with an end on this milestone (or on its project, whose span the move changes) that the proposal
 * newly breaks (`violates`: violated after, not before) or mends (`resolves`: violated before, fine after). A link that is unchanged
 * (fine both times, or violated both times) is not listed; the summary badges count the violated ones.
 */
export function linksAtMove(
  links: readonly ScheduleProposalLink[],
  move: Pick<ScheduleProposalMove, "milestoneId" | "projectId">,
): { violates: LinkAtMove[]; resolves: LinkAtMove[] } {
  const violates: LinkAtMove[] = [];
  const resolves: LinkAtMove[] = [];
  for (const link of links) {
    const thisIsPredecessor = isMoveEnd(link.predecessor, move);
    if (!thisIsPredecessor && !isMoveEnd(link.successor, move)) continue;
    const entry = { link, other: thisIsPredecessor ? link.successor : link.predecessor, thisIsPredecessor };
    if (link.check.status === "VIOLATED" && link.before !== "VIOLATED") violates.push(entry);
    else if (link.before === "VIOLATED" && link.check.status === "OK") resolves.push(entry);
  }
  return { violates, resolves };
}

/** The server's placement horizon in weeks (the NO_ROOM reason names it); the response does not carry it, so the client mirrors the constant. */
export const PROPOSAL_HORIZON_WEEKS = 520;

/** Which date of the successor a link type constrains: FS and SS its start, FF and SF its end (the check's `requiredDate`). */
export const requiredEdge = (type: ScheduleProposalLink["type"]): "start" | "end" => (type === "FS" || type === "SS" ? "start" : "end");

/** A link end in words: a milestone as "Project › Milestone", a project by its name (the wire's `projectName` is null for a project end). */
export const endpointText = (end: Pick<ScheduleProposalEnd, "name" | "projectName">): string =>
  end.projectName === null ? end.name : `${end.projectName} › ${end.name}`;
