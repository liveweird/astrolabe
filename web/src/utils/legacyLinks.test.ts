import { describe, expect, test } from "vitest";
import { legacyMilestonesTarget } from "./legacyLinks";

describe("legacyMilestonesTarget", () => {
  test("a project goes to its page, the Schedule filter carried as the table's word", () => {
    expect(legacyMilestonesTarget("?projectId=7")).toEqual({ to: "/projects/7" });
    expect(legacyMilestonesTarget("?scheduled=false&projectId=7")).toEqual({ to: "/projects/7", params: { milestones: "unscheduled" } });
    expect(legacyMilestonesTarget("?scheduled=true&projectId=7")).toEqual({ to: "/projects/7", params: { milestones: "scheduled" } });
    expect(legacyMilestonesTarget("?scheduled=other&projectId=7")).toEqual({ to: "/projects/7" });
  });

  test("a project wins over a team; a team alone goes to its page", () => {
    expect(legacyMilestonesTarget("?scheduled=false&teamId=3&projectId=7")).toEqual({ to: "/projects/7", params: { milestones: "unscheduled" } });
    expect(legacyMilestonesTarget("?scheduled=false&teamId=3")).toEqual({ to: "/teams/3" });
  });

  test("anything else, or a malformed id, goes to the Projects page", () => {
    expect(legacyMilestonesTarget("")).toEqual({ to: "/projects" });
    expect(legacyMilestonesTarget("?workStreamId=2&programId=3&name=x")).toEqual({ to: "/projects" });
    expect(legacyMilestonesTarget("?projectId=abc&teamId=0")).toEqual({ to: "/projects" });
    expect(legacyMilestonesTarget("?projectId=abc&teamId=4")).toEqual({ to: "/teams/4" });
  });
});
