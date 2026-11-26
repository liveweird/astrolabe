import { describe, expect, test } from "vitest";
import { NO_FILTER } from "./planTree";
import { activeFilterCount, MAX_QUERY, parseFoci, parsePlanFilter, planFilterPath, withPlanFilter } from "./planTreeParams";

const parse = (query: string) => parsePlanFilter(new URLSearchParams(query));

describe("parsePlanFilter", () => {
  test("a bare address is no filter", () => {
    expect(parse("")).toEqual(NO_FILTER);
  });

  test("reads the three parameters", () => {
    expect(parse("q=tax&ownerPersonId=8&hideClosed=true")).toEqual({ q: "tax", ownerPersonId: 8, hideClosed: true, focus: null });
  });

  test("the search is trimmed and cut at one name's length", () => {
    expect(parse("q=%20%20tax%20").q).toBe("tax");
    expect(parse(`q=${"x".repeat(MAX_QUERY + 50)}`).q).toHaveLength(MAX_QUERY);
  });

  test("a malformed value is dropped and never breaks the page", () => {
    expect(parse("ownerPersonId=abc").ownerPersonId).toBeNull();
    expect(parse("ownerPersonId=0").ownerPersonId).toBeNull();
    expect(parse("ownerPersonId=-3").ownerPersonId).toBeNull();
    expect(parse("ownerPersonId=99999999999").ownerPersonId).toBeNull();
    expect(parse("hideClosed=1").hideClosed).toBe(false);
    expect(parse("hideClosed=TRUE").hideClosed).toBe(false);
    expect(parse("hideClosed=false").hideClosed).toBe(false);
  });
});

describe("withPlanFilter", () => {
  test("writes only what is set, in one stable order", () => {
    expect(withPlanFilter(new URLSearchParams(), { ...NO_FILTER, q: " tax ", ownerPersonId: 8, hideClosed: true }).toString()).toBe("q=tax&ownerPersonId=8&hideClosed=true");
    expect(withPlanFilter(new URLSearchParams(), NO_FILTER).toString()).toBe("");
    expect(withPlanFilter(new URLSearchParams(), { ...NO_FILTER, q: "   " }).toString()).toBe("");
  });

  test("replaces its own parameters and keeps every other one", () => {
    const current = new URLSearchParams("view=wide&q=old&ownerPersonId=4&hideClosed=true&programId=9&workStreamId=3");
    expect(withPlanFilter(current, { ...NO_FILTER, q: "new" }).toString()).toBe("view=wide&q=new");
    expect(current.get("q")).toBe("old");
  });

  test("a written filter reads back the same", () => {
    const filter = { q: "żółw", ownerPersonId: 12, hideClosed: true, focus: { kind: "program" as const, id: 7 } };
    expect(parsePlanFilter(withPlanFilter(new URLSearchParams(), filter))).toEqual(filter);
  });
});

test("activeFilterCount counts each part that is on", () => {
  expect(activeFilterCount(NO_FILTER)).toBe(0);
  expect(activeFilterCount({ ...NO_FILTER, q: "  " })).toBe(0);
  expect(activeFilterCount({ q: "a", ownerPersonId: 1, hideClosed: true, focus: { kind: "workStream", id: 2 } })).toBe(3);
});

describe("the focus in the address", () => {
  test("parseFoci names every valid focus, the program first", () => {
    expect(parseFoci(new URLSearchParams("workStreamId=2&programId=7"))).toEqual([{ kind: "program", id: 7 }, { kind: "workStream", id: 2 }]);
    expect(parseFoci(new URLSearchParams("programId=x&workStreamId=2"))).toEqual([{ kind: "workStream", id: 2 }]);
    expect(parseFoci(new URLSearchParams(""))).toEqual([]);
  });

  test("a program wins over a work stream; a malformed id is no focus", () => {
    expect(parse("workStreamId=3").focus).toEqual({ kind: "workStream", id: 3 });
    expect(parse("programId=9").focus).toEqual({ kind: "program", id: 9 });
    expect(parse("workStreamId=3&programId=9").focus).toEqual({ kind: "program", id: 9 });
    expect(parse("programId=abc&workStreamId=3").focus).toEqual({ kind: "workStream", id: 3 });
    expect(parse("programId=0").focus).toBeNull();
  });

  test("a focus is written as exactly one parameter, after the filters", () => {
    expect(withPlanFilter(new URLSearchParams("workStreamId=3"), { ...NO_FILTER, q: "a", focus: { kind: "program", id: 7 } }).toString()).toBe("q=a&programId=7");
    expect(withPlanFilter(new URLSearchParams("programId=7"), { ...NO_FILTER, focus: { kind: "workStream", id: 2 } }).toString()).toBe("workStreamId=2");
    expect(withPlanFilter(new URLSearchParams("programId=7&q=x"), NO_FILTER).toString()).toBe("");
  });

  test("planFilterPath is the one spelling of a focused Plan link: the filters kept, other parameters too", () => {
    expect(planFilterPath(new URLSearchParams("q=tax&hideClosed=true"), { q: "tax", ownerPersonId: null, hideClosed: true, focus: { kind: "workStream", id: 4 } })).toBe("/plan?q=tax&hideClosed=true&workStreamId=4");
    expect(planFilterPath(new URLSearchParams("workStreamId=4"), NO_FILTER)).toBe("/plan");
  });
});
