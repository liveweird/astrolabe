import { describe, expect, test } from "vitest";
import { NO_FILTER } from "./planTree";
import { activeFilterCount, MAX_QUERY, parsePlanFilter, withPlanFilter } from "./planTreeParams";

const parse = (query: string) => parsePlanFilter(new URLSearchParams(query));

describe("parsePlanFilter", () => {
  test("a bare address is no filter", () => {
    expect(parse("")).toEqual(NO_FILTER);
  });

  test("reads the three parameters", () => {
    expect(parse("q=tax&ownerPersonId=8&hideClosed=true")).toEqual({ q: "tax", ownerPersonId: 8, hideClosed: true });
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
    expect(withPlanFilter(new URLSearchParams(), { q: " tax ", ownerPersonId: 8, hideClosed: true }).toString()).toBe("q=tax&ownerPersonId=8&hideClosed=true");
    expect(withPlanFilter(new URLSearchParams(), NO_FILTER).toString()).toBe("");
    expect(withPlanFilter(new URLSearchParams(), { ...NO_FILTER, q: "   " }).toString()).toBe("");
  });

  test("replaces its own three parameters and keeps every other one", () => {
    const current = new URLSearchParams("workStreamId=3&q=old&ownerPersonId=4&hideClosed=true&programId=9");
    expect(withPlanFilter(current, { q: "new", ownerPersonId: null, hideClosed: false }).toString()).toBe("workStreamId=3&programId=9&q=new");
    expect(current.get("q")).toBe("old");
  });

  test("a written filter reads back the same", () => {
    const filter = { q: "żółw", ownerPersonId: 12, hideClosed: true };
    expect(parsePlanFilter(withPlanFilter(new URLSearchParams(), filter))).toEqual(filter);
  });
});

test("activeFilterCount counts each part that is on", () => {
  expect(activeFilterCount(NO_FILTER)).toBe(0);
  expect(activeFilterCount({ q: "  ", ownerPersonId: null, hideClosed: false })).toBe(0);
  expect(activeFilterCount({ q: "a", ownerPersonId: 1, hideClosed: true })).toBe(3);
});
