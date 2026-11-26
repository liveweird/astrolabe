import { describe, expect, test } from "vitest";
import { planPath, projectPath, roadmapFilteredPath, roadmapModePath, roadmapOverviewPath, roadmapPath } from "./planLinks";

describe("planLinks", () => {
  test("the plan page lives at /plan", () => {
    expect(planPath).toBe("/plan");
  });

  test("the roadmap page lives at /roadmap, bare (it opens in the mode last used)", () => {
    expect(roadmapPath).toBe("/roadmap");
  });

  test("a link names a mode by its exact word", () => {
    expect(roadmapModePath("prioritization")).toBe("/roadmap?mode=prioritization");
    expect(roadmapModePath("overview")).toBe("/roadmap?mode=overview");
    expect(roadmapOverviewPath).toBe("/roadmap?mode=overview");
  });

  test("a project's page lives at /projects/:id", () => {
    expect(projectPath(42)).toBe("/projects/42");
  });
});

describe("roadmapFilteredPath", () => {
  test("no filter still names the Prioritization mode", () => {
    expect(roadmapFilteredPath({})).toBe("/roadmap?mode=prioritization");
    expect(roadmapFilteredPath({ filters: { flaggedOnly: false }, pick: [] })).toBe("/roadmap?mode=prioritization");
  });

  test("a filter and a pick are spelled once, in the stable order", () => {
    expect(roadmapFilteredPath({ filters: { flaggedOnly: true } })).toBe("/roadmap?mode=prioritization&flagged=true");
    expect(roadmapFilteredPath({ filters: { ownerPersonId: 7 } })).toBe("/roadmap?mode=prioritization&ownerPersonId=7");
    expect(roadmapFilteredPath({ filters: { workStreamId: 2 } })).toBe("/roadmap?mode=prioritization&workStreamId=2");
    expect(roadmapFilteredPath({ pick: [9] })).toBe("/roadmap?mode=prioritization&programId=9");
    expect(roadmapFilteredPath({ filters: { teamId: 1, flaggedOnly: true }, pick: [3, 2] })).toBe("/roadmap?mode=prioritization&programId=2&programId=3&teamId=1&flagged=true");
  });

  test("the unranked and severity links Home opens", () => {
    expect(roadmapFilteredPath({ filters: { unrankedOnly: true } })).toBe("/roadmap?mode=prioritization&unranked=true");
    expect(roadmapFilteredPath({ filters: { severity: "WARNING" } })).toBe("/roadmap?mode=prioritization&severity=WARNING");
    expect(roadmapFilteredPath({ filters: { severity: "INFO" } })).toBe("/roadmap?mode=prioritization&severity=INFO");
    expect(roadmapFilteredPath({ filters: { severity: null, unrankedOnly: false } })).toBe("/roadmap?mode=prioritization");
  });
});
