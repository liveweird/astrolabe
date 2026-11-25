import { describe, expect, test } from "vitest";
import { cascadePatch, milestoneFilterParams, milestoneSortParam, narrowingCount, parseMilestoneFilter, scheduleChoice, scheduledOf } from "./milestoneFilters";
import type { PlanParents } from "./planNames";

const parse = (query: string) => parseMilestoneFilter(new URLSearchParams(query));

describe("parseMilestoneFilter", () => {
  test("reads every filter", () => {
    expect(parse("scheduled=false&teamId=3&projectId=7&name=design")).toEqual({ scheduled: false, teamId: 3, projectId: 7, name: "design" });
  });

  test("a work stream and a program are read like the other ids", () => {
    expect(parse("workStreamId=700&programId=70")).toEqual({ workStreamId: 700, programId: 70 });
    expect(parse("workStreamId=0&programId=x")).toEqual({});
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

  test("a work stream and a program sit between the team and the project", () => {
    expect(milestoneFilterParams({ projectId: 7, programId: 70, workStreamId: 700, teamId: 3 }).toString()).toBe("teamId=3&workStreamId=700&programId=70&projectId=7");
  });

  test("round-trips every combination", () => {
    for (const scheduled of [undefined, true, false]) {
      for (const teamId of [undefined, 3]) {
        for (const scope of [{}, { workStreamId: 700 }, { programId: 70 }, { workStreamId: 700, programId: 70, projectId: 7 }]) {
          for (const name of [undefined, "design"]) {
            const filter = Object.fromEntries(Object.entries({ scheduled, teamId, ...scope, name }).filter(([, value]) => value !== undefined));
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

  test("a work stream and a program count like any other narrowing", () => {
    expect(narrowingCount({ workStreamId: 700, programId: 70, projectId: 7 })).toBe(3);
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

// Platform (700): Billing (70: Invoices 7, Payments 8), Search (71: Indexing 9); Growth (701): Onboarding (72: Signup 10).
const PARENTS: PlanParents = {
  programStream: new Map([[70, 700], [71, 700], [72, 701]]),
  projectProgram: new Map([[7, 70], [8, 70], [9, 71], [10, 72]]),
};

describe("cascadePatch", () => {
  test("a work stream pick drops a program and a project outside it, keeps the ones inside", () => {
    expect(cascadePatch({ programId: 70, projectId: 7 }, { workStreamId: 701 }, PARENTS)).toEqual({ workStreamId: 701, programId: undefined, projectId: undefined });
    expect(cascadePatch({ programId: 70, projectId: 7 }, { workStreamId: 700 }, PARENTS)).toEqual({ workStreamId: 700 });
  });

  test("a work stream pick drops a project outside it even when no program is picked", () => {
    expect(cascadePatch({ projectId: 10 }, { workStreamId: 700 }, PARENTS)).toEqual({ workStreamId: 700, projectId: undefined });
    expect(cascadePatch({ projectId: 9 }, { workStreamId: 700 }, PARENTS)).toEqual({ workStreamId: 700 });
  });

  test("a program pick drops a project outside it, and keeps the work stream", () => {
    expect(cascadePatch({ workStreamId: 700, projectId: 7 }, { programId: 71 }, PARENTS)).toEqual({ programId: 71, projectId: undefined });
    expect(cascadePatch({ workStreamId: 700, projectId: 9 }, { programId: 71 }, PARENTS)).toEqual({ programId: 71 });
  });

  test("a work stream pick that keeps the program still checks the project against that program", () => {
    expect(cascadePatch({ programId: 70, projectId: 9 }, { workStreamId: 700 }, PARENTS)).toEqual({ workStreamId: 700, projectId: undefined });
  });

  test("clearing a level drops nothing", () => {
    expect(cascadePatch({ workStreamId: 700, programId: 70, projectId: 7 }, { workStreamId: undefined }, PARENTS)).toEqual({ workStreamId: undefined });
    expect(cascadePatch({ workStreamId: 700, programId: 70, projectId: 7 }, { programId: undefined }, PARENTS)).toEqual({ programId: undefined });
  });

  test("a project, team, schedule or name patch is returned as it is, whatever the filter holds", () => {
    expect(cascadePatch({ workStreamId: 701, programId: 70 }, { projectId: 7 }, PARENTS)).toEqual({ projectId: 7 });
    expect(cascadePatch({ workStreamId: 701, projectId: 7 }, { teamId: 3 }, PARENTS)).toEqual({ teamId: 3 });
  });

  test("an id the plan does not know is never judged, and no plan at all drops nothing", () => {
    expect(cascadePatch({ programId: 99, projectId: 98 }, { workStreamId: 700 }, PARENTS)).toEqual({ workStreamId: 700 });
    expect(cascadePatch({ programId: 70, projectId: 7 }, { workStreamId: 701 }, undefined)).toEqual({ workStreamId: 701 });
  });
});

describe("milestoneSortParam", () => {
  test("the Rank header sends the rank and then the project name, start and name; only the first key flips", () => {
    expect(milestoneSortParam("rankPosition", "asc")).toBe("rankPosition,projectName,startDate,name");
    expect(milestoneSortParam("rankPosition", "desc")).toBe("-rankPosition,projectName,startDate,name");
  });

  test("every other header sends its own field, prefixed when descending", () => {
    expect(milestoneSortParam("projectName", "asc")).toBe("projectName");
    expect(milestoneSortParam("teamName", "desc")).toBe("-teamName");
    expect(milestoneSortParam("name", "asc")).toBe("name");
  });
});
