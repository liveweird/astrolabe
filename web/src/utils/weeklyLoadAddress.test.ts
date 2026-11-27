import { describe, expect, test } from "vitest";
import type { WeekLoad } from "../api/teams";
import { firstWeekOf, mondayOf, parseWeeklyLoadAddress } from "./weeklyLoadAddress";

const week = (weekStart: string, over: Partial<WeekLoad> = {}): WeekLoad => ({ weekStart, load: 8, capacity: 10, overloaded: false, overloadMd: null, maxWip: 1, wipExceeded: false, ...over });

describe("parseWeeklyLoadAddress", () => {
  test("reads the three kinds and plain weeks; anything else is no address", () => {
    for (const word of ["overloaded", "wip", "nocapacity", "weeks"]) expect(parseWeeklyLoadAddress(word)).toBe(word);
    for (const word of [null, "", "all", "OVERLOADED", "no-capacity"]) expect(parseWeeklyLoadAddress(word)).toBeUndefined();
  });
});

describe("mondayOf", () => {
  test("the Monday of the week: itself, a Wednesday, a Sunday, across a month", () => {
    expect(mondayOf("2027-01-11")).toBe("2027-01-11");
    expect(mondayOf("2027-01-13")).toBe("2027-01-11");
    expect(mondayOf("2027-01-17")).toBe("2027-01-11");
    expect(mondayOf("2027-03-02")).toBe("2027-03-01");
  });
});

describe("firstWeekOf", () => {
  const weeks = [week("2027-01-04", { overloaded: true }), week("2027-01-11", { overloaded: true, wipExceeded: true }), week("2027-01-18", { capacity: null }), week("2027-01-25", { overloaded: true })];

  test("the first week of the kind at or after this week's Monday: a week ON it counts", () => {
    expect(firstWeekOf(weeks, "overloaded", "2027-01-13")).toBe("2027-01-11");
    expect(firstWeekOf(weeks, "overloaded", "2027-01-14")).toBe("2027-01-11");
    expect(firstWeekOf(weeks, "overloaded", "2027-01-18")).toBe("2027-01-25");
    expect(firstWeekOf(weeks, "wip", "2027-01-01")).toBe("2027-01-11");
    expect(firstWeekOf(weeks, "nocapacity", "2027-01-01")).toBe("2027-01-18");
  });

  test("else the LATEST of that kind before it", () => {
    expect(firstWeekOf(weeks, "overloaded", "2027-03-01")).toBe("2027-01-25");
    expect(firstWeekOf(weeks, "nocapacity", "2027-03-01")).toBe("2027-01-18");
  });

  test("none of the kind, no weeks, or plain weeks: undefined", () => {
    expect(firstWeekOf([week("2027-01-04")], "wip", "2027-01-13")).toBeUndefined();
    expect(firstWeekOf([], "overloaded", "2027-01-13")).toBeUndefined();
    expect(firstWeekOf(weeks, "weeks", "2027-01-13")).toBeUndefined();
  });
});
