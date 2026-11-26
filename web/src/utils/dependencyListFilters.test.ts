import { describe, expect, test } from "vitest";
import { dependencyRow, milestoneEnd, projectEnd, unscheduledRow, violatedRow } from "../test/dependencyList";
import {
  dependencyListFilterParams,
  matchesDependencyFilter,
  namesPanel,
  narrowingCount,
  PANEL_PARAMS,
  parseDependencyListFilter,
  withoutPanelWord,
  withPanelFilter,
  type DependencyListFilter,
} from "./dependencyListFilters";

const parse = (query: string) => parseDependencyListFilter(new URLSearchParams(query));

describe("parseDependencyListFilter", () => {
  test("reads every filter", () => {
    expect(parse("status=violated&teamId=4&projectId=5")).toEqual({ status: "violated", teamId: 4, projectId: 5 });
    expect(parse("status=ok")).toEqual({ status: "ok" });
    expect(parse("status=unscheduled")).toEqual({ status: "unscheduled" });
    expect(parse("")).toEqual({});
  });

  test("drops an unknown status, `status=all` and malformed ids", () => {
    expect(parse("status=bogus&teamId=abc&projectId=0")).toEqual({});
    expect(parse("status=all")).toEqual({});
    expect(parse("status=VIOLATED")).toEqual({});
    expect(parse("teamId=-2&projectId=1e3")).toEqual({});
    expect(parse("teamId=99999999999")).toEqual({});
    expect(parse("teamId=4&teamId=5")).toEqual({ teamId: 4 });
  });

  test("round-trips every combination", () => {
    for (const status of [undefined, "violated", "ok", "unscheduled"] as const) {
      for (const teamId of [undefined, 4]) {
        for (const projectId of [undefined, 5]) {
          const filter: DependencyListFilter = {};
          if (status !== undefined) filter.status = status;
          if (teamId !== undefined) filter.teamId = teamId;
          if (projectId !== undefined) filter.projectId = projectId;
          expect(parseDependencyListFilter(dependencyListFilterParams(filter))).toEqual(filter);
        }
      }
    }
  });

  test("writes only the set ones, in one stable order", () => {
    expect(dependencyListFilterParams({}).toString()).toBe("");
    expect(dependencyListFilterParams({ projectId: 5, teamId: 4, status: "ok" }).toString()).toBe("status=ok&teamId=4&projectId=5");
  });

  test("counts the narrowing filters", () => {
    expect(narrowingCount({})).toBe(0);
    expect(narrowingCount({ status: "ok", projectId: 5 })).toBe(2);
    expect(narrowingCount({ status: undefined, teamId: 4 })).toBe(1);
  });
});

describe("matchesDependencyFilter", () => {
  const held = dependencyRow();
  const broken = violatedRow();
  const open = unscheduledRow();
  // A whole-project successor: no team, its project id is its own.
  const wholeProject = dependencyRow({ id: 90, predecessor: milestoneEnd({ projectId: 3, teamId: 4 }), successor: projectEnd({ id: 6, projectId: 6, name: "Billing", projectName: "Billing" }) });

  test("no filter keeps every row", () => {
    for (const row of [held, broken, open, wholeProject]) expect(matchesDependencyFilter(row, {})).toBe(true);
  });

  test("the status equals the row's check", () => {
    expect(matchesDependencyFilter(broken, { status: "violated" })).toBe(true);
    expect(matchesDependencyFilter(held, { status: "violated" })).toBe(false);
    expect(matchesDependencyFilter(held, { status: "ok" })).toBe(true);
    expect(matchesDependencyFilter(open, { status: "ok" })).toBe(false);
    expect(matchesDependencyFilter(open, { status: "unscheduled" })).toBe(true);
  });

  test("a team keeps a row when either end is a milestone of it; a project end has none", () => {
    expect(matchesDependencyFilter(held, { teamId: 4 })).toBe(true);
    expect(matchesDependencyFilter(held, { teamId: 7 })).toBe(true);
    expect(matchesDependencyFilter(held, { teamId: 9 })).toBe(false);
    expect(matchesDependencyFilter(wholeProject, { teamId: 4 })).toBe(true);
    expect(matchesDependencyFilter(wholeProject, { teamId: 7 })).toBe(false);
  });

  test("a project keeps a row when either end belongs to it, a project end by its own id", () => {
    expect(matchesDependencyFilter(held, { projectId: 3 })).toBe(true);
    expect(matchesDependencyFilter(held, { projectId: 6 })).toBe(true);
    expect(matchesDependencyFilter(held, { projectId: 5 })).toBe(false);
    expect(matchesDependencyFilter(wholeProject, { projectId: 6 })).toBe(true);
  });

  test("the three combine with AND", () => {
    expect(matchesDependencyFilter(broken, { status: "violated", teamId: 4, projectId: 3 })).toBe(true);
    expect(matchesDependencyFilter(held, { status: "violated", teamId: 4 })).toBe(false);
    expect(matchesDependencyFilter(broken, { status: "violated", teamId: 9 })).toBe(false);
    expect(matchesDependencyFilter(broken, { teamId: 4, projectId: 5 })).toBe(false);
  });
});

describe("the panel's prefixed names (1.29)", () => {
  const panel = (query: string) => parseDependencyListFilter(new URLSearchParams(query), PANEL_PARAMS);

  test("reads the three filters under their own names and ignores the page's", () => {
    expect(panel("dependencies=violated&dependencyTeamId=4&dependencyProjectId=5")).toEqual({ status: "violated", teamId: 4, projectId: 5 });
    expect(panel("status=violated&teamId=4&projectId=5")).toEqual({});
    expect(panel("dependencies=all")).toEqual({});
    expect(panel("dependencies=bogus&dependencyTeamId=abc&dependencyProjectId=0")).toEqual({});
  });

  test("the word names the panel only when it is one of the four", () => {
    for (const word of ["all", "violated", "ok", "unscheduled"]) expect(namesPanel(new URLSearchParams(`dependencies=${word}`))).toBe(true);
    for (const query of ["", "dependencies=", "dependencies=bogus", "dependencies=VIOLATED", "dependencyTeamId=4", "status=violated"]) {
      expect(namesPanel(new URLSearchParams(query))).toBe(false);
    }
  });

  test("withPanelFilter always writes the word, keeps foreign parameters and drops what the filter no longer names", () => {
    const current = new URLSearchParams("programId=3&dependencies=ok&dependencyTeamId=4&dependencyProjectId=5&teamId=9");
    expect(withPanelFilter(current, {}).toString()).toBe("programId=3&teamId=9&dependencies=all");
    expect(withPanelFilter(current, { status: "violated", teamId: 7 }).toString()).toBe("programId=3&teamId=9&dependencies=violated&dependencyTeamId=7");
    expect(withPanelFilter(new URLSearchParams(), { projectId: 2 }).toString()).toBe("dependencies=all&dependencyProjectId=2");
    expect(current.toString()).toContain("dependencyTeamId=4");
  });

  test("withoutPanelWord removes only the word", () => {
    expect(withoutPanelWord(new URLSearchParams("programId=3&dependencies=ok&dependencyTeamId=4")).toString()).toBe("programId=3&dependencyTeamId=4");
  });
});
