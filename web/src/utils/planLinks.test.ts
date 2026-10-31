import { describe, expect, test } from "vitest";
import { planPath, roadmapPath } from "./planLinks";

describe("planLinks", () => {
  test("the plan page lives at /plan", () => {
    expect(planPath).toBe("/plan");
  });

  test("the roadmap page lives at /roadmap", () => {
    expect(roadmapPath).toBe("/roadmap");
  });
});
