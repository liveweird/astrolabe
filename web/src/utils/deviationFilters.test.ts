import { describe, expect, test } from "vitest";
import { deviationFilterParams, narrowingCount, parseDeviationFilter } from "./deviationFilters";

const parse = (query: string) => parseDeviationFilter(new URLSearchParams(query));

describe("the Deviations page's filters in the URL", () => {
  test("a valid query round-trips through the parser and the serialiser", () => {
    const filter = parse("projectId=7&teamId=3&severity=WARNING&level=MILESTONE&connectionId=2&workStreamId=5&programId=9&kind=END_DIFFERS&all=true");
    expect(filter).toEqual({ projectId: 7, teamId: 3, severity: "WARNING", level: "MILESTONE", connectionId: 2, workStreamId: 5, programId: 9, kind: "END_DIFFERS", all: true });
    expect(parse(deviationFilterParams(filter).toString())).toEqual(filter);
  });

  test("anything malformed is dropped, so a stale or hand-edited link never breaks the page", () => {
    expect(parse("projectId=abc&teamId=0&workStreamId=-2&programId=1e3&connectionId=7abc&severity=info&level=TEAM&kind=NOPE&all=1")).toEqual({});
    expect(parse("projectId=99999999999")).toEqual({});
  });

  test("all=false is legal (turning 'show everything' off under a project or team scope) and survives the round trip", () => {
    expect(parse("projectId=7&all=false")).toEqual({ projectId: 7, all: false });
    expect(deviationFilterParams({ projectId: 7, all: false }).toString()).toBe("projectId=7&all=false");
  });

  test("a repeated key reads as its first value (the page never sends a repeat, the server would 400 it)", () => {
    expect(parse("projectId=7&projectId=8")).toEqual({ projectId: 7 });
  });

  test("no filter is an empty query", () => {
    expect(deviationFilterParams({}).toString()).toBe("");
  });

  test("narrowing filters are counted, 'show everything' widens and is not", () => {
    expect(narrowingCount({})).toBe(0);
    expect(narrowingCount({ all: true })).toBe(0);
    expect(narrowingCount({ all: false })).toBe(0);
    expect(narrowingCount({ projectId: 7, severity: "INFO", all: true })).toBe(2);
  });
});
