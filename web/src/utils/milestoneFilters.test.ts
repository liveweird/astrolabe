import { describe, expect, test } from "vitest";
import { milestoneFilterParams, narrowingCount, parseMilestoneFilter, scheduleChoice, scheduledOf } from "./milestoneFilters";

const parse = (query: string) => parseMilestoneFilter(new URLSearchParams(query));

describe("parseMilestoneFilter", () => {
  test("reads every filter", () => {
    expect(parse("scheduled=false&teamId=3&projectId=7&name=design")).toEqual({ scheduled: false, teamId: 3, projectId: 7, name: "design" });
  });

  test("scheduled=false is a state, true too; any other word is dropped", () => {
    expect(parse("scheduled=false")).toEqual({ scheduled: false });
    expect(parse("scheduled=true")).toEqual({ scheduled: true });
    expect(parse("scheduled=yes")).toEqual({});
    expect(parse("scheduled=")).toEqual({});
  });

  test("a malformed id or a blank name is dropped", () => {
    expect(parse("teamId=abc&projectId=-1&name=%20%20")).toEqual({});
    expect(parse("teamId=0&projectId=1e3")).toEqual({});
  });

  test("a name is trimmed", () => {
    expect(parse("name=%20design%20")).toEqual({ name: "design" });
  });
});

describe("milestoneFilterParams", () => {
  test("writes only the set ones, in one stable order, and keeps scheduled=false", () => {
    expect(milestoneFilterParams({ name: "x", projectId: 7, teamId: 3, scheduled: false }).toString()).toBe("scheduled=false&teamId=3&projectId=7&name=x");
    expect(milestoneFilterParams({}).toString()).toBe("");
    expect(milestoneFilterParams({ scheduled: undefined, name: "  " }).toString()).toBe("");
  });

  test("round-trips every combination", () => {
    for (const scheduled of [undefined, true, false]) {
      for (const teamId of [undefined, 3]) {
        for (const projectId of [undefined, 7]) {
          for (const name of [undefined, "design"]) {
            const filter = Object.fromEntries(Object.entries({ scheduled, teamId, projectId, name }).filter(([, value]) => value !== undefined));
            expect(parseMilestoneFilter(milestoneFilterParams(filter))).toEqual(filter);
          }
        }
      }
    }
  });
});

describe("narrowingCount and the Schedule choice", () => {
  test("counts the set filters, undefined keys excluded", () => {
    expect(narrowingCount({})).toBe(0);
    expect(narrowingCount({ scheduled: false, teamId: undefined, name: "x" })).toBe(2);
  });

  test("the choice and the filter map onto each other", () => {
    expect(scheduleChoice({})).toBe("all");
    expect(scheduleChoice({ scheduled: false })).toBe("unscheduled");
    expect(scheduleChoice({ scheduled: true })).toBe("scheduled");
    expect(scheduledOf("all")).toBeUndefined();
    expect(scheduledOf("unscheduled")).toBe(false);
    expect(scheduledOf("scheduled")).toBe(true);
  });
});
