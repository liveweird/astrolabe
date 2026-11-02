import { describe, expect, test } from "vitest";
import i18n from "../i18n";
import type { ScheduleProposal, ScheduleProposalEnd, ScheduleProposalLink, ScheduleProposalMove, TeamMilestone } from "../api/teams";
import {
  acceptItems,
  changeSentence,
  endpointText,
  linksAtMove,
  linkTotals,
  newlyScheduledCount,
  noteOf,
  outcomeOf,
  outcomeSentence,
  proposalBars,
  proposalDays,
  proposalRows,
  requiredEdge,
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

const endpoint = (kind: "MILESTONE" | "PROJECT", id: number, name: string, projectName = "Web"): ScheduleProposalEnd => ({
  kind,
  id,
  name,
  projectName: kind === "PROJECT" ? null : projectName,
});

const linkOf = (id: number, predecessor: ScheduleProposalEnd, successor: ScheduleProposalEnd, before: ScheduleProposalLink["before"], after: ScheduleProposalLink["before"]): ScheduleProposalLink => ({
  id,
  predecessor,
  successor,
  type: "FS",
  lagDays: 0,
  before,
  check: { status: after, shortfallDays: null, requiredDate: null, actualDate: null },
});

describe("newlyScheduledCount", () => {
  test("counts the moves from the tray", () => {
    expect(newlyScheduledCount([move(1), move(2, { from: { start: "2042-01-01", end: "2042-01-02" } }), move(3)])).toBe(2);
    expect(newlyScheduledCount([])).toBe(0);
  });
});

describe("linkTotals", () => {
  test("violated after and not before is new, violated both times is still; fine after counts for neither", () => {
    const e = endpoint("MILESTONE", 1, "a");
    const links = [linkOf(1, e, e, "OK", "VIOLATED"), linkOf(2, e, e, "UNSCHEDULED", "VIOLATED"), linkOf(3, e, e, "VIOLATED", "VIOLATED"), linkOf(4, e, e, "VIOLATED", "OK"), linkOf(5, e, e, "OK", "OK")];
    expect(linkTotals(links)).toEqual({ newlyViolated: 2, stillViolated: 1 });
    expect(linkTotals([])).toEqual({ newlyViolated: 0, stillViolated: 0 });
  });
});

describe("linksAtMove", () => {
  const me = { milestoneId: 1, projectId: 7 };

  test("the links with an end on the milestone, sorted into broken and mended, naming the other end and the side", () => {
    const broken = linkOf(1, endpoint("MILESTONE", 1, "a"), endpoint("MILESTONE", 50, "x"), "OK", "VIOLATED");
    const mended = linkOf(2, endpoint("MILESTONE", 51, "y"), endpoint("MILESTONE", 1, "a"), "VIOLATED", "OK");
    const unchanged = linkOf(3, endpoint("MILESTONE", 1, "a"), endpoint("MILESTONE", 52, "z"), "OK", "OK");
    const elsewhere = linkOf(4, endpoint("MILESTONE", 60, "p"), endpoint("MILESTONE", 61, "q"), "OK", "VIOLATED");
    const result = linksAtMove([broken, mended, unchanged, elsewhere], me);
    expect(result.violates.map((e) => [e.link.id, e.other.name, e.thisIsPredecessor])).toEqual([[1, "x", true]]);
    expect(result.resolves.map((e) => [e.link.id, e.other.name, e.thisIsPredecessor])).toEqual([[2, "y", false]]);
  });

  test("a link on the milestone's project counts as well (its span moves with the milestone); a milestone id never matches a project id", () => {
    const onProject = linkOf(1, endpoint("PROJECT", 7, "Invoices"), endpoint("MILESTONE", 50, "x"), "OK", "VIOLATED");
    const sameNumber = linkOf(2, endpoint("MILESTONE", 7, "other"), endpoint("MILESTONE", 50, "x"), "OK", "VIOLATED");
    expect(linksAtMove([onProject, sameNumber], me).violates.map((e) => e.link.id)).toEqual([1]);
  });

  test("a link that is violated before and after, or unscheduled after, is neither", () => {
    const still = linkOf(1, endpoint("MILESTONE", 1, "a"), endpoint("MILESTONE", 50, "x"), "VIOLATED", "VIOLATED");
    const gone = linkOf(2, endpoint("MILESTONE", 1, "a"), endpoint("MILESTONE", 50, "x"), "VIOLATED", "UNSCHEDULED");
    expect(linksAtMove([still, gone], me)).toEqual({ violates: [], resolves: [] });
  });
});

describe("endpointText", () => {
  test("a milestone reads Project › Milestone, a project by its name", () => {
    expect(endpointText(endpoint("MILESTONE", 1, "Checkout page", "Web"))).toBe("Web › Checkout page");
    expect(endpointText(endpoint("PROJECT", 2, "Web"))).toBe("Web");
  });
});

describe("requiredEdge", () => {
  test("FS and SS constrain the successor's start, FF and SF its end", () => {
    expect((["FS", "SS", "FF", "SF"] as const).map(requiredEdge)).toEqual(["start", "start", "end", "end"]);
  });
});
