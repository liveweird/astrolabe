import { describe, expect, test } from "vitest";
import { teamLoadRow, teamLoadWeek } from "../test/teamLoad";
import { matchesWarning, matchesWeek, parseTeamLoadFilter, teamLoadFilterParams } from "./teamLoadFilters";

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

describe("matchesWeek", () => {
  const overloaded = teamLoadWeek();
  const wip = teamLoadWeek({ overloaded: false, overloadMd: null, wipExceeded: true });
  const both = teamLoadWeek({ wipExceeded: true });

  test("no warning and any keep every listed week", () => {
    for (const warning of [undefined, "any"] as const) expect([overloaded, wip, both].map((week) => matchesWeek(week, warning))).toEqual([true, true, true]);
  });

  test("overloaded keeps the weeks carrying that verdict, a week with both included", () => {
    expect([overloaded, wip, both].map((week) => matchesWeek(week, "overloaded"))).toEqual([true, false, true]);
  });

  test("wip keeps the weeks over the limit, a week with both included", () => {
    expect([overloaded, wip, both].map((week) => matchesWeek(week, "wip"))).toEqual([false, true, true]);
  });
});
