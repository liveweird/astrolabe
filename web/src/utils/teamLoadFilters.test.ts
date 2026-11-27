import { describe, expect, test } from "vitest";
import { teamLoadRow, teamLoadWeek } from "../test/teamLoad";
import { earlierWeekCount, isNarrowing, matchesWarning, matchesWeek, parseTeamLoadFilter, teamLoadFilterParams, teamsKept } from "./teamLoadFilters";

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

  test("past reads on only as the exact word true", () => {
    expect(parse("past=true")).toEqual({ past: true });
    for (const query of ["past=1", "past=false", "past=TRUE", "past=", "past"]) expect(parse(query)).toEqual({});
  });

  test("past round-trips with warning, warning first", () => {
    const filter = parse("past=true&warning=wip");
    expect(filter).toEqual({ warning: "wip", past: true });
    expect(teamLoadFilterParams(filter).toString()).toBe("warning=wip&past=true");
    expect(teamLoadFilterParams({ past: true }).toString()).toBe("past=true");
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

describe("matchesWeek with a from date", () => {
  const before = teamLoadWeek({ weekStart: "2027-03-29" });
  const on = teamLoadWeek({ weekStart: "2027-04-05" });
  const after = teamLoadWeek({ weekStart: "2027-04-12", overloaded: false, overloadMd: null, wipExceeded: true });

  test("a week before from is dropped, a week ON from and later ones stay", () => {
    expect([before, on, after].map((week) => matchesWeek(week, undefined, "2027-04-05"))).toEqual([false, true, true]);
  });

  test("from and the warning both apply", () => {
    expect([before, on, after].map((week) => matchesWeek(week, "overloaded", "2027-04-05"))).toEqual([false, true, false]);
    expect([before, on, after].map((week) => matchesWeek(week, "wip", "2027-04-05"))).toEqual([false, false, true]);
  });

  test("without from every week stays", () => {
    expect([before, on, after].map((week) => matchesWeek(week, undefined))).toEqual([true, true, true]);
  });
});

describe("earlierWeekCount", () => {
  const rows = [
    teamLoadRow({ warningWeeks: [teamLoadWeek({ weekStart: "2027-03-29" }), teamLoadWeek({ weekStart: "2027-04-05" })] }),
    teamLoadRow({ id: 4, warningWeeks: [teamLoadWeek({ weekStart: "2027-03-22", overloaded: false, overloadMd: null, wipExceeded: true })] }),
  ];

  test("counts the weeks before from that the warning keeps", () => {
    expect(earlierWeekCount(rows, undefined, "2027-04-05")).toBe(2);
    expect(earlierWeekCount(rows, "overloaded", "2027-04-05")).toBe(1);
    expect(earlierWeekCount(rows, "wip", "2027-04-05")).toBe(1);
  });

  test("a week ON from is not earlier, and nothing before it is zero", () => {
    expect(earlierWeekCount(rows, undefined, "2027-03-22")).toBe(0);
    expect(earlierWeekCount([], undefined, "2027-04-05")).toBe(0);
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
