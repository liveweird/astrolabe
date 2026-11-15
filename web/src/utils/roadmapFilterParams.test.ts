import { describe, expect, test } from "vitest";
import {
  hasRoadmapFilterParams,
  isRoadmapFilterEmpty,
  parseProgramPick,
  parseRoadmapFilter,
  roadmapFilterParams,
  withProgramPick,
  withRoadmapFilterParams,
} from "./roadmapFilterParams";
import type { RoadmapFilters } from "./roadmapRows";

const NONE: RoadmapFilters = { workStreamId: null, teamId: null, ownerPersonId: null, flaggedOnly: false };
const parse = (query: string) => parseRoadmapFilter(new URLSearchParams(query));

describe("roadmapFilterParams", () => {
  test("every combination of the five names survives a round trip", () => {
    for (let mask = 0; mask < 32; mask++) {
      const state = {
        filters: {
          workStreamId: mask & 1 ? 3 : null,
          teamId: mask & 2 ? 4 : null,
          ownerPersonId: mask & 4 ? 5 : null,
          flaggedOnly: (mask & 8) !== 0,
        },
        pick: mask & 16 ? [11, 12] : [],
      };
      expect(parseRoadmapFilter(roadmapFilterParams(state))).toEqual(state);
    }
  });

  test("the output has one stable order: programId ascending, work stream, team, owner, flagged", () => {
    const params = roadmapFilterParams({
      filters: { workStreamId: 3, teamId: 4, ownerPersonId: 5, flaggedOnly: true },
      pick: [12, 11],
    });
    expect(params.toString()).toBe("programId=11&programId=12&workStreamId=3&teamId=4&ownerPersonId=5&flagged=true");
  });

  test("only the set ones are written, a partial link is accepted and nothing set is an empty query", () => {
    expect(roadmapFilterParams({ filters: { flaggedOnly: true } }).toString()).toBe("flagged=true");
    expect(roadmapFilterParams({ pick: [7] }).toString()).toBe("programId=7");
    expect(roadmapFilterParams({ filters: NONE, pick: [] }).toString()).toBe("");
    expect(roadmapFilterParams({}).toString()).toBe("");
  });

  test("a malformed id, flagged=false, flagged=1 and an unknown name are dropped", () => {
    const parsed = parse("workStreamId=0&teamId=abc&ownerPersonId=-2&flagged=false&colour=red&programId=x&programId=");
    expect(parsed).toEqual({ filters: NONE, pick: [] });
    expect(parse("flagged=1").filters.flaggedOnly).toBe(false);
    expect(parse("flagged=true").filters.flaggedOnly).toBe(true);
    expect(parse("workStreamId=1e3&teamId=2147483648").filters).toEqual(NONE);
  });

  test("a repeated programId is the pick: de-duplicated, ascending, capped at 100", () => {
    expect(parse("programId=12&programId=11&programId=12&programId=zzz").pick).toEqual([11, 12]);
    const many = Array.from({ length: 150 }, (_, i) => `programId=${150 - i}`).join("&");
    const pick = parse(many).pick;
    expect(pick).toHaveLength(100);
    expect(pick[0]).toBe(1);
    expect(pick[99]).toBe(100);
    expect(roadmapFilterParams({ pick: Array.from({ length: 150 }, (_, i) => i + 1) }).getAll("programId")).toHaveLength(100);
  });

  test("a bare URL, and one carrying only a foreign parameter, name no filter; any of the five names does, even malformed", () => {
    expect(hasRoadmapFilterParams(new URLSearchParams(""))).toBe(false);
    expect(hasRoadmapFilterParams(new URLSearchParams("colour=red&page=2"))).toBe(false);
    for (const name of ["programId", "workStreamId", "teamId", "ownerPersonId", "flagged"]) {
      expect(hasRoadmapFilterParams(new URLSearchParams(`${name}=zzz`))).toBe(true);
    }
  });

  test("the five names are replaced in a URL and a foreign parameter is kept", () => {
    const next = withRoadmapFilterParams(new URLSearchParams("colour=red&teamId=9&programId=1&programId=2"), {
      filters: { flaggedOnly: true },
      pick: [5],
    });
    expect(next.toString()).toBe("colour=red&programId=5&flagged=true");
    expect(withRoadmapFilterParams(new URLSearchParams("flagged=true"), {}).toString()).toBe("");
  });

  test("isRoadmapFilterEmpty is true only when nothing narrows", () => {
    expect(isRoadmapFilterEmpty({ filters: NONE, pick: [] })).toBe(true);
    expect(isRoadmapFilterEmpty({ filters: { ...NONE, flaggedOnly: true }, pick: [] })).toBe(false);
    expect(isRoadmapFilterEmpty({ filters: NONE, pick: [1] })).toBe(false);
  });
});

describe("the program pick alone (the Programs page's)", () => {
  test("parseProgramPick drops malformed values, de-duplicates, sorts ascending and ignores every other parameter", () => {
    expect(parseProgramPick(new URLSearchParams("programId=12&programId=x&programId=11&programId=12&programId=-3&teamId=4"))).toEqual([11, 12]);
    expect(parseProgramPick(new URLSearchParams("flagged=true"))).toEqual([]);
  });

  test("parseProgramPick cuts the pick at 100 programs", () => {
    const query = Array.from({ length: 120 }, (_, i) => `programId=${i + 1}`).join("&");
    const pick = parseProgramPick(new URLSearchParams(query));
    expect(pick).toHaveLength(100);
    expect(pick.at(-1)).toBe(100);
  });

  test("withProgramPick writes the canonical pick, keeps every other parameter and leaves no programId for an empty pick", () => {
    expect(withProgramPick(new URLSearchParams("x=1&programId=9"), [12, 11, 12]).toString()).toBe("x=1&programId=11&programId=12");
    expect(withProgramPick(new URLSearchParams("x=1&programId=9&programId=8"), []).toString()).toBe("x=1");
    expect(withProgramPick(new URLSearchParams(), Array.from({ length: 120 }, (_, i) => i + 1)).getAll("programId")).toHaveLength(100);
  });

  test("the Roadmap's and the pick's own spelling agree", () => {
    const state = { filters: NONE, pick: [12, 11] };
    expect(roadmapFilterParams(state).getAll("programId")).toEqual(withProgramPick(new URLSearchParams(), [12, 11]).getAll("programId"));
  });
});
