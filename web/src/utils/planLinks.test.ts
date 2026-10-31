import { describe, expect, test } from "vitest";
import { planPath, projectPath, roadmapPath } from "./planLinks";

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
