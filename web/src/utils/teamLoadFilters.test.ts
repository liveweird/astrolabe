import { describe, expect, test } from "vitest";
import { teamLoadRow } from "../test/teamLoad";
import { matchesWarning, parseTeamLoadFilter, teamLoadFilterParams } from "./teamLoadFilters";

const parse = (query: string) => parseTeamLoadFilter(new URLSearchParams(query));

describe("parseTeamLoadFilter / teamLoadFilterParams", () => {
  test("reads each warning and writes it back", () => {
    for (const warning of ["overloaded", "wip", "any"] as const) {
      expect(parse(`warning=${warning}`)).toEqual({ warning });
      expect(teamLoadFilterParams({ warning }).toString()).toBe(`warning=${warning}`);
    }
  });

  test("an unknown, blank, wrongly cased or absent warning reads as every team", () => {
    expect(parse("")).toEqual({});
    expect(parse("warning=all")).toEqual({});
    expect(parse("warning=")).toEqual({});
    expect(parse("warning=OVERLOADED")).toEqual({});
    expect(parse("other=1")).toEqual({});
  });

  test("no filter writes no parameter", () => {
    expect(teamLoadFilterParams({}).toString()).toBe("");
  });
});

describe("matchesWarning", () => {
  const none = teamLoadRow();
  const overloaded = teamLoadRow({ overloadedWeeks: 2 });
  const wip = teamLoadRow({ wipExceededWeeks: 1 });
  const both = teamLoadRow({ overloadedWeeks: 2, wipExceededWeeks: 1 });
  const noCapacityOnly = teamLoadRow({ weeksWithoutCapacity: 4, unscheduledMilestones: 3 });

  test("no warning keeps every row", () => {
    for (const row of [none, overloaded, wip, both, noCapacityOnly]) expect(matchesWarning(row, undefined)).toBe(true);
  });

  test("overloaded keeps the rows with an overloaded week", () => {
    expect([none, overloaded, wip, both].map((row) => matchesWarning(row, "overloaded"))).toEqual([false, true, false, true]);
  });

  test("wip keeps the rows over the WIP limit", () => {
    expect([none, overloaded, wip, both].map((row) => matchesWarning(row, "wip"))).toEqual([false, false, true, true]);
  });

  test("any keeps the rows with either, and weeks without capacity are no warning", () => {
    expect([none, overloaded, wip, both, noCapacityOnly].map((row) => matchesWarning(row, "any"))).toEqual([false, true, true, true, false]);
  });
});
