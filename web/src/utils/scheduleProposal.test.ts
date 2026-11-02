import { describe, expect, test } from "vitest";
import i18n from "../i18n";
import type { ScheduleProposal, ScheduleProposalMove, TeamMilestone } from "../api/teams";
import {
  acceptItems,
  changeSentence,
  noteOf,
  outcomeOf,
  outcomeSentence,
  proposalBars,
  proposalDays,
  proposalRows,
} from "./scheduleProposal";

const t = i18n.getFixedT("en");
const tPl = i18n.getFixedT("pl");

const move = (milestoneId: number, over: Partial<ScheduleProposalMove> = {}): ScheduleProposalMove => ({
  milestoneId,
  name: `m${milestoneId}`,
  projectId: 7,
  projectName: "Invoices",
  estimateMd: 4,
  from: null,
  to: { start: "2042-01-07", end: "2042-01-10" },
  workingDays: 4,
  shiftDays: null,
  ...over,
});

const milestone = (id: number): TeamMilestone =>
  ({ id, name: `m${id}`, projectId: 7, projectName: "Invoices", startDate: null, endDate: null }) as TeamMilestone;

const proposal = (over: Partial<ScheduleProposal> = {}): Pick<ScheduleProposal, "moves" | "unchanged" | "unplaced" | "asOf"> => ({
  moves: [],
  unchanged: [],
  unplaced: [],
  asOf: "2042-01-05",
  ...over,
});

describe("proposalBars", () => {
  test("one read-only proposal-toned bar per move, on the proposed span, named in words", () => {
    const bars = proposalBars([move(3), move(5, { to: { start: "2042-02-03", end: "2042-02-04" } })], t);
    expect([...bars.keys()]).toEqual([3, 5]);
    expect(bars.get(3)).toEqual({
      id: "proposal:3",
      start: "2042-01-07",
      end: "2042-01-10",
      label: "m3",
      describe: "Proposed: m3, 2042-01-07 to 2042-01-10",
      editable: false,
      tone: "proposal",
    });
    expect(bars.get(5)?.start).toBe("2042-02-03");
  });
});

describe("proposalRows", () => {
  test("the tray milestones the proposal schedules, in the tray's order (not the moves' order); other moves add nothing", () => {
    const tray = { unscheduled: [milestone(9), milestone(4), milestone(6)] };
    expect(proposalRows(tray, [move(6), move(2), move(9)]).map((m) => m.id)).toEqual([9, 6]);
    expect(proposalRows(tray, [])).toEqual([]);
  });
});

describe("proposalDays", () => {
  test("every proposed first and last day", () => {
    expect(proposalDays([move(1), move(2, { to: { start: "2042-03-03", end: "2042-03-05" } })])).toEqual([
      "2042-01-07",
      "2042-01-10",
      "2042-03-03",
      "2042-03-05",
    ]);
  });
});

describe("changeSentence", () => {
  test("newly scheduled: the dates and the working days, singular and plural", () => {
    expect(changeSentence(move(1), t)).toBe("Unscheduled → 2042-01-07 to 2042-01-10, 4 working days");
    expect(changeSentence(move(1, { workingDays: 1 }), t)).toBe("Unscheduled → 2042-01-07 to 2042-01-10, 1 working day");
  });

  test("moved: how far the start shifts, earlier or later, and the same-start case", () => {
    expect(changeSentence(move(1, { shiftDays: -34 }), t)).toBe("34 working days earlier");
    expect(changeSentence(move(1, { shiftDays: -1 }), t)).toBe("1 working day earlier");
    expect(changeSentence(move(1, { shiftDays: 3 }), t)).toBe("3 working days later");
    expect(changeSentence(move(1, { shiftDays: 1 }), t)).toBe("1 working day later");
    expect(changeSentence(move(1, { shiftDays: 0 }), t)).toBe("Same start, 4 working days long");
  });

  test("Polish plurals use few/many", () => {
    expect(changeSentence(move(1, { shiftDays: -1 }), tPl)).toBe("1 dzień roboczy wcześniej");
    expect(changeSentence(move(1, { shiftDays: -3 }), tPl)).toBe("3 dni robocze wcześniej");
    expect(changeSentence(move(1, { shiftDays: 5 }), tPl)).toBe("5 dni roboczych później");
    expect(changeSentence(move(1, { workingDays: 22 }), tPl)).toBe("Niezaplanowany → od 2042-01-07 do 2042-01-10, 22 dni robocze");
  });
});

describe("noteOf", () => {
  test("a move opens the preview whatever else it says", () => {
    expect(noteOf(proposal({ moves: [move(1)] }))).toBeNull();
    expect(noteOf(proposal({ moves: [move(1)], unplaced: [{ milestoneId: 2, name: "x", projectId: 1, projectName: "p", reason: "NO_CAPACITY" }] }))).toBeNull();
  });

  test("nothing moves and nothing is unplaced: nothing to propose", () => {
    expect(noteOf(proposal())).toBe("nothing");
    expect(noteOf(proposal({ unchanged: [4] }))).toBe("nothing");
  });

  test("nothing moves, nothing stays and every movable milestone lacks capacity: the no-capacity note; anything else opens the preview", () => {
    const unplaced = (reason: "NO_CAPACITY" | "NO_ROOM") => ({ milestoneId: 2, name: "x", projectId: 1, projectName: "p", reason });
    expect(noteOf(proposal({ unplaced: [unplaced("NO_CAPACITY"), unplaced("NO_CAPACITY")] }))).toBe("noCapacity");
    expect(noteOf(proposal({ unplaced: [unplaced("NO_CAPACITY"), unplaced("NO_ROOM")] }))).toBeNull();
    expect(noteOf(proposal({ unplaced: [unplaced("NO_CAPACITY")], unchanged: [9] }))).toBeNull();
  });
});

describe("acceptItems", () => {
  test("the selected moves in the proposal's order, each as proposed", () => {
    const moves = [move(1), move(2, { to: { start: "2042-02-03", end: "2042-02-04" } }), move(3)];
    expect(acceptItems({ moves }, new Set([3, 2]))).toEqual([
      { milestoneId: 2, startDate: "2042-02-03", endDate: "2042-02-04" },
      { milestoneId: 3, startDate: "2042-01-07", endDate: "2042-01-10" },
    ]);
    expect(acceptItems({ moves }, new Set())).toEqual([]);
  });
});

describe("outcomeSentence", () => {
  test("written and skipped, each distinct reason once", () => {
    const outcome = outcomeOf({
      accepted: [1, 2, 3],
      skipped: [
        { milestoneId: 4, reason: "STALE" },
        { milestoneId: 5, reason: "STALE" },
        { milestoneId: 6, reason: "NOT_ON_TEAM" },
      ],
    });
    expect(outcome.accepted).toBe(3);
    expect(outcomeSentence(outcome, t)).toBe("3 scheduled · 3 skipped: rescheduled in the meantime, moved to another team");
  });

  test("all written: only the first part; all skipped: only the second; empty: zero scheduled", () => {
    expect(outcomeSentence({ accepted: 2, skipped: [] }, t)).toBe("2 scheduled");
    expect(outcomeSentence({ accepted: 0, skipped: [{ milestoneId: 4, reason: "GONE" }] }, t)).toBe("1 skipped: no longer exists");
    expect(outcomeSentence({ accepted: 0, skipped: [{ milestoneId: 4, reason: "NO_WORKING_DAY" }] }, t)).toBe("1 skipped: no working day left in the span");
    expect(outcomeSentence({ accepted: 0, skipped: [] }, t)).toBe("0 scheduled");
  });
});
