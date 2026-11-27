import { describe, expect, test } from "vitest";
import { teamLoadRow } from "../test/teamLoad";
import { isNarrowing, matchesWarning, parseTeamLoadFilter, teamLoadFilterParams, teamsKept } from "./teamLoadFilters";

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

  test("a retired past parameter is ignored and never written back", () => {
    expect(parse("past=true")).toEqual({});
    expect(parse("past=true&warning=wip")).toEqual({ warning: "wip" });
    expect(teamLoadFilterParams(parse("past=true&warning=wip")).toString()).toBe("warning=wip");
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

describe("isNarrowing / teamsKept", () => {
  const backend = teamLoadRow({ id: 3, name: "Backend", overloadedWeeks: 2 });
  const data = teamLoadRow({ id: 5, name: "Data", wipExceededWeeks: 1 });
  const lodz = teamLoadRow({ id: 7, name: "Łódź Ops" });
  const rows = [backend, data, lodz];

  test("a warning or a name that is not blank narrows; blanks do not", () => {
    expect(isNarrowing({ name: "" })).toBe(false);
    expect(isNarrowing({ name: "   " })).toBe(false);
    expect(isNarrowing({ name: " a " })).toBe(true);
    expect(isNarrowing({ warning: "any", name: "" })).toBe(true);
  });

  test("no control keeps every row in the order given", () => {
    expect(teamsKept(rows, { name: "" })).toEqual(rows);
    expect(teamsKept(rows, { name: "  " })).toEqual(rows);
  });

  test("the name is a case- and accent-insensitive substring of the team's name", () => {
    expect(teamsKept(rows, { name: "ATA" })).toEqual([data]);
    expect(teamsKept(rows, { name: "lodz" })).toEqual([lodz]);
    expect(teamsKept(rows, { name: "Łó" })).toEqual([lodz]);
    expect(teamsKept(rows, { name: "zzz" })).toEqual([]);
  });

  test("the warning and the name both have to match", () => {
    expect(teamsKept(rows, { warning: "any", name: "" })).toEqual([backend, data]);
    expect(teamsKept(rows, { warning: "wip", name: "a" })).toEqual([data]);
    expect(teamsKept(rows, { warning: "overloaded", name: "data" })).toEqual([]);
  });
});
