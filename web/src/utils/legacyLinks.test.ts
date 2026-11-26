import { describe, expect, test } from "vitest";
import { legacyDependenciesTarget, legacyMilestonesTarget } from "./legacyLinks";

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

describe("legacyDependenciesTarget", () => {
  test("the three filters move to the panel's prefixed names on the Roadmap", () => {
    expect(legacyDependenciesTarget("?status=violated&teamId=4&projectId=5")).toEqual({
      to: "/roadmap",
      params: { dependencies: "violated", dependencyTeamId: "4", dependencyProjectId: "5" },
    });
    expect(legacyDependenciesTarget("?projectId=5")).toEqual({ to: "/roadmap", params: { dependencies: "all", dependencyProjectId: "5" } });
    expect(legacyDependenciesTarget("?status=ok")).toEqual({ to: "/roadmap", params: { dependencies: "ok" } });
  });

  test("the bare address opens the panel unfiltered; an unknown status or a malformed id is dropped", () => {
    expect(legacyDependenciesTarget("")).toEqual({ to: "/roadmap", params: { dependencies: "all" } });
    expect(legacyDependenciesTarget("?status=bogus&teamId=abc&projectId=0")).toEqual({ to: "/roadmap", params: { dependencies: "all" } });
    expect(legacyDependenciesTarget("?status=all")).toEqual({ to: "/roadmap", params: { dependencies: "all" } });
  });
});
