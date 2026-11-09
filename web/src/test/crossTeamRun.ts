// Shared fixtures for the cross-team schedule proposal tests (the page, its section, its hook): a run over two linked teams, X before Y.
import type { CrossTeamProposal, CrossTeamProposalTeam } from "../api/scheduleProposals";
import type { ScheduleProposalLink, ScheduleProposalMove } from "../api/teams";

export const RUN_URL = "/api/v1/schedule-proposals";
export const ACCEPT_URL = "/api/v1/schedule-proposals/accept";
export const CHECK_URL = "/api/v1/schedule-proposals/check";
export const TEAMS_URL = "/api/v1/schedule-proposals/teams";

export const STALE_SCOPE = { type: "urn:astrolabe:problem:stale-scope", title: "Conflict", status: 409, detail: "scope" };
export const STALE_REVISION = { type: "urn:astrolabe:problem:stale-revision", title: "Conflict", status: 409, detail: "stale" };

export const move = (milestoneId: number, name: string, start: string, end: string, over: Partial<ScheduleProposalMove> = {}): ScheduleProposalMove => ({
  milestoneId,
  name,
  projectId: 7,
  projectName: "Invoices",
  estimateMd: 4,
  from: null,
  to: { start, end },
  workingDays: 3,
  shiftDays: null,
  ...over,
});

export const week = (weekStart: string, load: number) => ({ weekStart, load, capacity: 10, overloaded: false, overloadMd: null, maxWip: 1, wipExceeded: false });

export const block = (teamId: number, name: string, moves: ScheduleProposalMove[], over: Partial<CrossTeamProposalTeam> = {}): CrossTeamProposalTeam => ({
  teamId,
  name,
  moves,
  unchanged: [],
  unplaced: [],
  pinned: [],
  weeks: [week("2042-01-05", 6)],
  weeksTruncated: false,
  dependencies: [],
  ...over,
});

/** `x1 -> y1` finish-to-start, violated after the run when `x1` is not placed (the conflict a check against the ticked subset can show). */
export const violatedLink = (): ScheduleProposalLink => ({
  id: 3,
  type: "FS",
  predecessor: { kind: "MILESTONE", id: 11, name: "x1", projectName: "Invoices" },
  successor: { kind: "MILESTONE", id: 21, name: "y1", projectName: "Invoices" },
  lagDays: 0,
  before: "OK",
  check: { status: "VIOLATED", requiredDate: "2042-03-04" },
} as ScheduleProposalLink);

export const RUN: CrossTeamProposal = {
  revision: 12,
  asOf: "2042-01-05",
  passes: 1,
  settled: true,
  scopeHash: "b".repeat(64),
  teams: [
    block(1, "Platform", [move(11, "x1", "2042-01-06", "2042-01-08"), move(12, "x2", "2042-01-09", "2042-01-09")]),
    block(2, "Payments", [move(21, "y1", "2042-01-12", "2042-01-14")], { weeks: [week("2042-01-12", 8)] }),
  ],
};

export const ids = (body: unknown) => (body as { items: { milestoneId: number }[] }).items.map((item) => item.milestoneId);
