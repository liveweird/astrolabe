import { describe, expect, test } from "vitest";
import { planPath, projectPath, roadmapFilteredPath, roadmapPath } from "./planLinks";

describe("planLinks", () => {
  test("the plan page lives at /plan", () => {
    expect(planPath).toBe("/plan");
  });

  test("the roadmap page lives at /roadmap", () => {
    expect(roadmapPath).toBe("/roadmap");
  });

  test("a project's page lives at /projects/:id", () => {
    expect(projectPath(42)).toBe("/projects/42");
  });
});

describe("roadmapFilteredPath", () => {
  test("no filter is the bare roadmap", () => {
    expect(roadmapFilteredPath({})).toBe("/roadmap");
    expect(roadmapFilteredPath({ filters: { flaggedOnly: false }, pick: [] })).toBe("/roadmap");
  });

  test("a filter and a pick are spelled once, in the stable order", () => {
    expect(roadmapFilteredPath({ filters: { flaggedOnly: true } })).toBe("/roadmap?flagged=true");
    expect(roadmapFilteredPath({ filters: { ownerPersonId: 7 } })).toBe("/roadmap?ownerPersonId=7");
    expect(roadmapFilteredPath({ filters: { workStreamId: 2 } })).toBe("/roadmap?workStreamId=2");
    expect(roadmapFilteredPath({ pick: [9] })).toBe("/roadmap?programId=9");
    expect(roadmapFilteredPath({ filters: { teamId: 1, flaggedOnly: true }, pick: [3, 2] })).toBe("/roadmap?programId=2&programId=3&teamId=1&flagged=true");
  });
});
