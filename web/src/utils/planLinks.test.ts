import { describe, expect, test } from "vitest";
import { planPath } from "./planLinks";

describe("planLinks", () => {
  test("the plan page lives at /plan", () => {
    expect(planPath).toBe("/plan");
  });
});
