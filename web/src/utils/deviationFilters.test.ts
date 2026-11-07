import { describe, expect, test } from "vitest";
import { deviationFilterParams, deviationStatus, deviationStatusPatch, keepStatus, narrowingCount, parseDeviationFilter } from "./deviationFilters";

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

  test("acknowledged is a strict boolean, kept in order before all, and counts as a narrowing filter", () => {
    expect(parse("acknowledged=true&all=true")).toEqual({ acknowledged: true, all: true });
    // `false` means nothing the page can say (with `all` it would list never-acknowledged clean bindings under an "Open" label), so it is dropped.
    expect(parse("acknowledged=false")).toEqual({});
    expect(parse("acknowledged=false&all=true")).toEqual({ all: true });
    expect(parse("acknowledged=1&all=yes")).toEqual({});
    expect(deviationFilterParams({ all: true, acknowledged: true, severity: "INFO" }).toString()).toBe("severity=INFO&acknowledged=true&all=true");
    expect(narrowingCount({ acknowledged: true })).toBe(1);
  });
});

describe("the Status select over the filters", () => {
  test("it reads the filters as the server does: acknowledged wins, then whether `all` is in force (given, or implied by a project or team scope)", () => {
    expect(deviationStatus({})).toBe("open");
    expect(deviationStatus({ severity: "INFO" })).toBe("open");
    expect(deviationStatus({ acknowledged: true })).toBe("acknowledged");
    expect(deviationStatus({ acknowledged: true, all: true })).toBe("acknowledged");
    expect(deviationStatus({ all: true })).toBe("all");
    expect(deviationStatus({ projectId: 7 })).toBe("all");
    expect(deviationStatus({ teamId: 3 })).toBe("all");
    expect(deviationStatus({ projectId: 7, all: false })).toBe("open");
    expect(deviationStatus({ projectId: 7, acknowledged: true })).toBe("acknowledged");
  });

  test("Open sends nothing, but under a project or team scope the override all=false; Acknowledged sends acknowledged=true; All sends all=true", () => {
    expect(deviationStatusPatch("open", {})).toEqual({ acknowledged: undefined, all: undefined });
    expect(deviationStatusPatch("open", { all: true })).toEqual({ acknowledged: undefined, all: undefined });
    expect(deviationStatusPatch("open", { projectId: 7 })).toEqual({ acknowledged: undefined, all: false });
    expect(deviationStatusPatch("open", { teamId: 3, acknowledged: true })).toEqual({ acknowledged: undefined, all: false });
    expect(deviationStatusPatch("acknowledged", { projectId: 7 })).toEqual({ acknowledged: true, all: undefined });
    expect(deviationStatusPatch("acknowledged", { projectId: 7, all: false })).toEqual({ acknowledged: true, all: undefined });
    expect(deviationStatusPatch("acknowledged", { all: true })).toEqual({ acknowledged: true, all: true });
    expect(deviationStatusPatch("all", { acknowledged: true })).toEqual({ acknowledged: undefined, all: true });
  });

  test("each choice, applied to the filters, reads back as itself and produces the parameters the server expects", () => {
    const apply = (filter: Parameters<typeof deviationStatusPatch>[1], status: Parameters<typeof deviationStatusPatch>[0]) => ({ ...filter, ...deviationStatusPatch(status, filter) });
    for (const scope of [{}, { projectId: 7 }, { teamId: 3 }]) {
      for (const status of ["open", "acknowledged", "all"] as const) expect(deviationStatus(apply(scope, status))).toBe(status);
    }
    expect(deviationFilterParams(apply({}, "open")).toString()).toBe("");
    expect(deviationFilterParams(apply({ projectId: 7 }, "open")).toString()).toBe("projectId=7&all=false");
    expect(deviationFilterParams(apply({ projectId: 7 }, "acknowledged")).toString()).toBe("projectId=7&acknowledged=true");
    expect(deviationFilterParams(apply({}, "all")).toString()).toBe("all=true");
  });
});

describe("a filter change must not flip the chosen Status (the server implies `all` under a project or team scope)", () => {
  test("Open: adding a scope sends the all=false override, removing the last one drops it again, a second scope changes nothing", () => {
    expect(keepStatus({}, { teamId: 3 })).toEqual({ teamId: 3, all: false });
    expect(keepStatus({ severity: "INFO" }, { projectId: 7 })).toEqual({ projectId: 7, all: false });
    expect(keepStatus({ projectId: 7, all: false }, { projectId: undefined })).toEqual({ projectId: undefined, all: undefined });
    expect(keepStatus({ projectId: 7, all: false }, { teamId: 3 })).toEqual({ teamId: 3 });
    expect(keepStatus({ projectId: 7, teamId: 3, all: false }, { teamId: undefined })).toEqual({ teamId: undefined });
  });

  test("All that only the scope implied goes with the scope (back to the default Open list); an explicit one and a second scope need nothing", () => {
    expect(keepStatus({ projectId: 7 }, { projectId: undefined })).toEqual({ projectId: undefined });
    expect(deviationStatus({ ...{ projectId: 7 }, ...keepStatus({ projectId: 7 }, { projectId: undefined }) })).toBe("open");
    expect(keepStatus({ projectId: 7, teamId: 3 }, { projectId: undefined })).toEqual({ projectId: undefined });
    expect(keepStatus({ projectId: 7, all: true }, { projectId: undefined })).toEqual({ projectId: undefined });
    expect(keepStatus({ all: true }, { teamId: 3 })).toEqual({ teamId: 3 });
  });

  test("Acknowledged is not touched by a scope, and a patch that names all or acknowledged is the caller's own word", () => {
    expect(keepStatus({ acknowledged: true }, { teamId: 3 })).toEqual({ teamId: 3 });
    expect(keepStatus({ acknowledged: true, projectId: 7 }, { projectId: undefined })).toEqual({ projectId: undefined });
    expect(keepStatus({}, { teamId: 3, all: undefined })).toEqual({ teamId: 3, all: undefined });
    expect(keepStatus({ projectId: 7 }, { acknowledged: true })).toEqual({ acknowledged: true });
    expect(keepStatus({}, { severity: "INFO" })).toEqual({ severity: "INFO" });
  });
});
