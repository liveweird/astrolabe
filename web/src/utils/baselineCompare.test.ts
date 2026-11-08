import { describe, expect, test } from "vitest";
import type { BaselineView, BaselineViewMilestone, BaselineViewProject, MovementTotals } from "../api/baselines";
import i18n from "../i18n";
import { compareGroups, compareTeams, estimateText, rankSentence } from "./baselineCompare";

const NONE: MovementTotals = { unchanged: 0, moved: 0, later: 0, earlier: 0, scheduled: 0, unscheduled: 0, added: 0, removed: 0 };
const UNCHANGED = { kind: "UNCHANGED" as const, startDays: 0, endDays: 0, estimateDelta: 0 };

const project = (projectId: number, name: string, over: Partial<BaselineViewProject> = {}): BaselineViewProject => ({
  projectId,
  name,
  programName: "Program",
  workStreamName: "Stream",
  rankThen: null,
  rankNow: null,
  baselineSpan: null,
  span: null,
  movement: UNCHANGED,
  counts: NONE,
  ...over,
});

const FIG = { start: "2043-01-05", end: "2043-01-09", estimateMd: 3 };
const milestone = (milestoneId: number, projectId: number, teamId: number, over: Partial<BaselineViewMilestone> = {}): BaselineViewMilestone => ({
  milestoneId,
  name: `m${milestoneId}`,
  projectId,
  teamId,
  teamName: teamId === 1 ? "Web" : "Äpps",
  frozen: FIG,
  live: FIG,
  movement: { kind: "MOVED", startDays: 1, endDays: 1, estimateDelta: 0 },
  ...over,
});

function view(projects: BaselineViewProject[], milestones: BaselineViewMilestone[]): BaselineView {
  return { revision: 5, baseline: {} as BaselineView["baseline"], totals: { milestones: NONE, projects: NONE }, projects, milestones };
}

const ALL = { teamId: null, text: "", changedOnly: false };

describe("compareGroups", () => {
  const sample = view(
    [project(1, "Checkout", { counts: { ...NONE, moved: 1 } }), project(2, "Żółw"), project(3, "Ledger", { movement: { kind: "MOVED", startDays: 0, endDays: 2, estimateDelta: null } })],
    [milestone(10, 1, 1), milestone(11, 1, 2), milestone(12, 3, 2)],
  );

  test("keeps the server's project order with the rows under each; unchanged projects are included only when asked", () => {
    expect(compareGroups(sample, ALL).map((g) => [g.project.projectId, g.milestones.map((m) => m.milestoneId)])).toEqual([
      [1, [10, 11]],
      [2, []],
      [3, [12]],
    ]);
    expect(compareGroups(sample, { ...ALL, changedOnly: true }).map((g) => g.project.projectId)).toEqual([1, 3]);
  });

  test("a project that changed itself stays under 'changed only' even with no listed row; a counts-only change too", () => {
    const v = view([project(1, "A", { movement: { kind: "ADDED", startDays: null, endDays: null, estimateDelta: null } }), project(2, "B", { counts: { ...NONE, removed: 1 } }), project(3, "C")], []);
    expect(compareGroups(v, { ...ALL, changedOnly: true }).map((g) => g.project.projectId)).toEqual([1, 2]);
  });

  test("an estimate-only row is a listed row, so its project survives 'changed only'", () => {
    const row = milestone(20, 2, 1, { movement: UNCHANGED, live: { ...FIG, estimateMd: 5 } });
    expect(compareGroups(view([project(2, "B")], [row]), { ...ALL, changedOnly: true }).map((g) => g.milestones.length)).toEqual([1]);
  });

  test("a team filter keeps its rows and only the projects that have one", () => {
    expect(compareGroups(sample, { ...ALL, teamId: 2 }).map((g) => [g.project.projectId, g.milestones.map((m) => m.milestoneId)])).toEqual([
      [1, [11]],
      [3, [12]],
    ]);
  });

  test("the project text filter is case- and accent-insensitive", () => {
    expect(compareGroups(sample, { ...ALL, text: " zolw " }).map((g) => g.project.projectId)).toEqual([2]);
    expect(compareGroups(sample, { ...ALL, text: "CHECK" }).map((g) => g.project.projectId)).toEqual([1]);
  });

  test("a row of a project the document does not list is dropped", () => {
    expect(compareGroups(view([project(1, "A")], [milestone(30, 99, 1)]), ALL).map((g) => g.milestones.length)).toEqual([0]);
  });
});

describe("compareTeams", () => {
  test("lists each team of the rows once, by name", () => {
    expect(compareTeams(view([], [milestone(1, 1, 1), milestone(2, 1, 2), milestone(3, 1, 1)]))).toEqual([
      { id: 2, name: "Äpps" },
      { id: 1, name: "Web" },
    ]);
  });
});

describe("estimateText", () => {
  test("one figure when it did not change, then → now, the side that exists, a dash for neither", () => {
    const row = (frozen: number | null, live: number | null) =>
      milestone(1, 1, 1, { frozen: frozen === null ? null : { ...FIG, estimateMd: frozen }, live: live === null ? null : { ...FIG, estimateMd: live } });
    expect(estimateText(row(3, 3))).toBe("3");
    expect(estimateText(row(10, 12.5))).toBe("10 → 12.5");
    expect(estimateText(row(null, 4))).toBe("4");
    expect(estimateText(row(2.25, null))).toBe("2.25");
    expect(estimateText(row(null, null))).toBe("—");
  });
});

describe("rankSentence", () => {
  const t = i18n.getFixedT("en");
  const pl = i18n.getFixedT("pl");
  const ranks = (rankThen: number | null, rankNow: number | null, kind: BaselineViewProject["movement"]["kind"] = "UNCHANGED") => ({ rankThen, rankNow, movement: { ...UNCHANGED, kind } });

  test("says where the rank went, in either direction, from or to unranked; nothing when it did not change", () => {
    expect(rankSentence(ranks(3, 5), t)).toBe("Rank 3 → 5");
    expect(rankSentence(ranks(5, 3), t)).toBe("Rank 5 → 3");
    expect(rankSentence(ranks(null, 5), t)).toBe("Unranked → rank 5");
    expect(rankSentence(ranks(3, null), t)).toBe("Rank 3 → unranked");
    expect(rankSentence(ranks(3, 3), t)).toBeNull();
    expect(rankSentence(ranks(null, null), t)).toBeNull();
    expect(rankSentence(ranks(3, 5), pl)).toBe("Pozycja w rankingu: 3 → 5");
  });

  test("a project that is new or gone on one side has no rank to compare", () => {
    expect(rankSentence(ranks(null, 2, "ADDED"), t)).toBeNull();
    expect(rankSentence(ranks(2, null, "REMOVED"), t)).toBeNull();
  });
});
