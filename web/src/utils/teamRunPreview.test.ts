import { describe, expect, test } from "vitest";
import type { DependencyEndpoint, ProjectDependency } from "../api/dependencies";
import type { CrossTeamProposal } from "../api/scheduleProposals";
import { block, move } from "../test/crossTeamRun";
import { linkedTeamIds, teamRunPreview } from "./teamRunPreview";

const endpoint = (kind: "MILESTONE" | "PROJECT", id: number, teamId: number | null): DependencyEndpoint => ({
  kind,
  id,
  name: `${kind}-${id}`,
  projectId: kind === "PROJECT" ? id : 7,
  projectName: "Invoices",
  teamId,
  teamName: teamId === null ? null : `Team ${teamId}`,
  startDate: null,
  endDate: null,
});

const link = (id: number, from: DependencyEndpoint, to: DependencyEndpoint): ProjectDependency => ({
  id,
  predecessor: from,
  successor: to,
  type: "FS",
  lagDays: 0,
  check: { status: "OK", shortfallDays: null, slackDays: 0, requiredDate: null, actualDate: null },
  critical: false,
  can: { edit: false, delete: false },
});

// Team 1 is the page's own; its milestone 11 is linked to team 2's 21 (a link both ways round) and to the whole project 8; team 3's 31 is moved by the run but linked to nothing.
const OWN = endpoint("MILESTONE", 11, 1);
const DEPENDENCIES = [link(1, endpoint("MILESTONE", 21, 2), OWN), link(2, OWN, endpoint("PROJECT", 8, null)), link(3, OWN, endpoint("MILESTONE", 12, 1))];

const SPAN = (start: string, end: string) => ({ start, end });
const RUN: Pick<CrossTeamProposal, "teams" | "projects"> = {
  teams: [
    block(1, "Team 1", [move(11, "own", "2042-01-12", "2042-01-14", { from: SPAN("2042-01-05", "2042-01-07") })]),
    block(2, "Team 2", [move(21, "linked", "2042-01-20", "2042-01-22", { from: SPAN("2042-01-13", "2042-01-15"), projectId: 9, projectName: "Taxes" }), move(22, "newcomer", "2042-01-16", "2042-01-16", { projectId: 9, projectName: "Taxes" })]),
    block(3, "Team 3", [move(31, "stranger", "2042-02-02", "2042-02-03", { from: SPAN("2042-01-26", "2042-01-27") })]),
  ],
  projects: [
    { projectId: 8, name: "Whole", before: SPAN("2042-01-05", "2042-01-30"), after: SPAN("2042-01-12", "2042-02-06"), endShiftDays: 5 },
    { projectId: 9, name: "Unlinked", before: SPAN("2042-01-13", "2042-01-15"), after: SPAN("2042-01-16", "2042-01-22"), endShiftDays: 5 },
  ],
};

const preview = (over: Partial<Parameters<typeof teamRunPreview>[0]> = {}) =>
  teamRunPreview({ teamId: 1, dependencies: DEPENDENCIES, run: RUN, projects: RUN.projects, selected: new Set([21, 22, 31]), tickable: new Set([11]), chainRows: new Set(), ...over });

describe("linkedTeamIds", () => {
  test("the other teams at the far ends of the links, once each and ascending; the team's own ends and projects are none", () => {
    expect(linkedTeamIds([...DEPENDENCIES, link(4, endpoint("MILESTONE", 51, 5), OWN), link(5, endpoint("MILESTONE", 23, 2), OWN)], 1)).toEqual([2, 5]);
    expect(linkedTeamIds([], 1)).toEqual([]);
  });
});

describe("teamRunPreview", () => {
  test("the rows are the other teams' moved milestones and the run's projects that a link of the team's own work names, by proposed start; an unlinked move or project gets none", () => {
    const { rows } = preview();
    expect(rows.map((row) => [row.rowId, row.name])).toEqual([
      ["ghost:p:8", "Whole"],
      ["ghost:m:21", "linked"],
    ]);
    // the team's own moves are never rows of this preview
    expect(rows.some((row) => row.id === 11)).toBe(false);
  });

  test("a milestone entry reads its team, its current and its proposed dates (null while it has none); a project entry the run's before and after", () => {
    const { byRow } = preview();
    expect(byRow.get("ghost:m:21")).toMatchObject({ kind: "MILESTONE", teamId: 2, teamName: "Team 2", projectName: "Taxes", current: SPAN("2042-01-13", "2042-01-15"), proposed: SPAN("2042-01-20", "2042-01-22") });
    expect(byRow.get("ghost:m:22")?.current).toBeNull();
    expect(byRow.get("ghost:p:8")).toMatchObject({ kind: "PROJECT", teamId: null, current: SPAN("2042-01-05", "2042-01-30"), proposed: SPAN("2042-01-12", "2042-02-06") });
    expect([...byRow.keys()].sort()).toEqual(["ghost:m:21", "ghost:m:22", "ghost:m:31", "ghost:p:8", "ghost:p:9"]);
  });

  test("the dashed bar follows the ticks: a ticked move and a move the viewer cannot tick keep it, an unticked one of theirs loses it (its row stays)", () => {
    const some = preview({ selected: new Set([22]), tickable: new Set([11, 21, 22]) });
    expect(some.rows.find((row) => row.id === 21)?.drawn).toBe(false);
    expect(some.byRow.get("ghost:m:22")?.drawn).toBe(true);
    // 31 is not tickable (another manager's): it keeps its dash whatever is ticked
    expect(some.byRow.get("ghost:m:31")?.drawn).toBe(true);
    expect(preview({ selected: new Set([21]), tickable: new Set([11, 21]) }).byRow.get("ghost:m:21")?.drawn).toBe(true);
  });

  test("a project follows the ticked projects: the check's span replaces the run's, and one the ticked moves no longer move keeps its row with no dashed bar", () => {
    const follows = preview({ projects: [{ projectId: 8, name: "Whole", before: SPAN("2042-01-05", "2042-01-30"), after: SPAN("2042-01-05", "2042-02-02"), endShiftDays: 3 }] });
    expect(follows.byRow.get("ghost:p:8")).toMatchObject({ drawn: true, proposed: SPAN("2042-01-05", "2042-02-02") });
    const none = preview({ projects: [] });
    // the order is the run's own, not the followed span's
    expect(none.rows.map((row) => row.rowId)).toEqual(["ghost:p:8", "ghost:m:21"]);
    const shifted = preview({ projects: [{ projectId: 8, name: "Whole", before: SPAN("2042-01-05", "2042-01-30"), after: SPAN("2042-03-02", "2042-03-06"), endShiftDays: 25 }] });
    expect(shifted.rows.map((row) => row.rowId)).toEqual(["ghost:p:8", "ghost:m:21"]);
    expect(none.byRow.get("ghost:p:8")).toMatchObject({ drawn: false, proposed: SPAN("2042-01-12", "2042-02-06") });
  });

  test("a critical-chain row gets no second row: it is left out of the rows, its dashed bar stays in byRow and its dates in the range", () => {
    const { rows, byRow, days } = preview({ chainRows: new Set(["ghost:m:21", "ghost:m:31"]) });
    expect(rows.map((row) => row.rowId)).toEqual(["ghost:p:8"]);
    expect(byRow.has("ghost:m:21")).toBe(true);
    // the range covers the project row, the chain row linked and the chain row not linked, but not the unlinked, un-chained move
    expect(days).toEqual(expect.arrayContaining(["2042-01-12", "2042-02-06", "2042-01-20", "2042-01-22", "2042-02-02", "2042-02-03"]));
    expect(days).not.toContain("2042-01-16");
  });
});
