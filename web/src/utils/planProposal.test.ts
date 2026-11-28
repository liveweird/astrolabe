import { describe, expect, test } from "vitest";
import { acceptTeamIdsOf, overlayProjects, projectSlice, tickableMoveIds, warningWeekCount } from "./planProposal";
import { block, move, RUN, week } from "../test/crossTeamRun";

// Platform (1): x1 (project 7), x2 (project 9); Payments (2): y1 (project 7), y3 (project 9) + one unplaced of project 9; Billing (3): nothing of project 7.
const RICH = {
  teams: [
    block(1, "Platform", [move(11, "x1", "2042-01-06", "2042-01-08"), move(12, "x2", "2042-01-09", "2042-01-09", { projectId: 9, projectName: "Other" })], { unchanged: [13], pinned: [14] }),
    block(2, "Payments", [move(21, "y1", "2042-01-12", "2042-01-14"), move(23, "y3", "2042-01-15", "2042-01-16", { projectId: 9, projectName: "Other" })], {
      unplaced: [{ milestoneId: 24, name: "y4", projectId: 9, projectName: "Other", reason: "NO_CAPACITY" }],
    }),
    block(3, "Billing", [move(31, "z1", "2042-01-19", "2042-01-20", { projectId: 9, projectName: "Other" })]),
  ],
};

describe("tickableMoveIds", () => {
  test("no rights given: every move of the run; a null run: none", () => {
    expect([...tickableMoveIds(RUN)].sort()).toEqual([11, 12, 21]);
    expect(tickableMoveIds(null, new Set([1])).size).toBe(0);
  });

  test("only the moves of acceptable teams", () => {
    expect([...tickableMoveIds(RICH, new Set([2]))].sort()).toEqual([21, 23]);
    expect(tickableMoveIds(RICH, new Set()).size).toBe(0);
    expect(tickableMoveIds(RICH, new Set([99])).size).toBe(0);
  });

  test("a project slice keeps that project's moves of the acceptable teams", () => {
    expect([...tickableMoveIds(RICH, new Set([1, 2]), 7)].sort()).toEqual([11, 21]);
    expect([...tickableMoveIds(RICH, undefined, 9)].sort()).toEqual([12, 23, 31]);
    expect(tickableMoveIds(RICH, new Set([3]), 7).size).toBe(0);
  });
});

describe("acceptTeamIdsOf", () => {
  test("the teams of the ticked moves, ascending and once each, whatever the placement order", () => {
    const placed = { teams: [RICH.teams[2], RICH.teams[1], RICH.teams[0]] };
    expect(acceptTeamIdsOf(placed, new Set([31, 11, 12]))).toEqual([1, 3]);
    expect(acceptTeamIdsOf(RICH, new Set([21, 23]))).toEqual([2]);
  });

  test("no tick, or a tick no block holds: no team", () => {
    expect(acceptTeamIdsOf(RICH, new Set())).toEqual([]);
    expect(acceptTeamIdsOf(RICH, new Set([999]))).toEqual([]);
  });
});

describe("projectSlice", () => {
  test("without a project every block stays, numbered in placement order", () => {
    expect(projectSlice(RICH).map(({ team, position }) => [team.teamId, position])).toEqual([[1, 1], [2, 2], [3, 3]]);
    expect(projectSlice(RICH)[0].team).toBe(RICH.teams[0]);
  });

  test("with a project only the teams holding its moves or unplaced milestones, reduced to them, keep their place in the full run", () => {
    const slice = projectSlice(RICH, 9);
    expect(slice.map(({ team, position }) => [team.teamId, position])).toEqual([[1, 1], [2, 2], [3, 3]]);
    expect(slice[0].team.moves.map((m) => m.milestoneId)).toEqual([12]);
    expect(slice[1].team.moves.map((m) => m.milestoneId)).toEqual([23]);
    expect(slice[1].team.unplaced.map((u) => u.milestoneId)).toEqual([24]);
    // ids of every project: they cannot be attributed to the project, so a slice does not carry them
    expect(slice[0].team.unchanged).toEqual([]);
    expect(slice[0].team.pinned).toEqual([]);
    const seven = projectSlice(RICH, 7);
    expect(seven.map(({ team, position }) => [team.teamId, position])).toEqual([[1, 1], [2, 2]]);
    expect(seven[1].team.unplaced).toEqual([]);
  });

  test("with the project's own milestone ids the unchanged and pinned ids are kept for those only", () => {
    const slice = projectSlice(RICH, 7, new Set([13, 77]));
    expect(slice[0].team.unchanged).toEqual([13]);
    expect(slice[0].team.pinned).toEqual([]);
    expect(projectSlice(RICH, 7, new Set([14]))[0].team.pinned).toEqual([14]);
  });

  test("a project the run does not touch: no section; the block's weeks and verdicts stay the team's", () => {
    expect(projectSlice(RICH, 1234)).toEqual([]);
    expect(projectSlice(RICH, 7)[0].team.weeks).toBe(RICH.teams[0].weeks);
  });
});

describe("warningWeekCount", () => {
  test("counts a week once whether it is overloaded, over the WIP limit or both", () => {
    const weeks = [week("2042-01-05", 6), { ...week("2042-01-12", 12), overloaded: true }, { ...week("2042-01-19", 6), wipExceeded: true }, { ...week("2042-01-26", 12), overloaded: true, wipExceeded: true }];
    expect(warningWeekCount(weeks)).toBe(3);
  });

  test("none, empty or absent weeks: zero", () => {
    expect(warningWeekCount([week("2042-01-05", 6)])).toBe(0);
    expect(warningWeekCount([])).toBe(0);
    expect(warningWeekCount(undefined)).toBe(0);
  });
});

describe("overlayProjects", () => {
  const span = (start: string, end: string) => ({ start, end });
  const project = (projectId: number, after: { start: string; end: string }) => ({ projectId, name: `p${projectId}`, before: span("2042-01-01", "2042-01-02"), after, endShiftDays: 1 });
  const own = { projects: [project(1, span("2042-02-01", "2042-02-05")), project(2, span("2042-03-01", "2042-03-05"))] };
  const checked = [project(2, span("2042-03-01", "2042-03-02"))];

  test("nothing the viewer may accept (a preview), or every move ticked: the run's own projects", () => {
    expect(overlayProjects(own, { mode: "some", projects: checked }, false)).toBe(own.projects);
    expect(overlayProjects(own, { mode: "none", projects: null }, false)).toBe(own.projects);
    expect(overlayProjects(own, { mode: "all", projects: null }, true)).toBe(own.projects);
  });

  test("some ticked: the check's projects - the run's while the check is pending or failed", () => {
    expect(overlayProjects(own, { mode: "some", projects: checked }, true)).toBe(checked);
    expect(overlayProjects(own, { mode: "some", projects: [] }, true)).toEqual([]);
    expect(overlayProjects(own, { mode: "some", projects: null }, true)).toBe(own.projects);
  });

  test("none ticked: no project moves; no run: none", () => {
    expect(overlayProjects(own, { mode: "none", projects: null }, true)).toEqual([]);
    expect(overlayProjects(null, { mode: "some", projects: null }, true)).toEqual([]);
  });
});
