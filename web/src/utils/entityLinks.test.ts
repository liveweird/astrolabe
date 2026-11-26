import { describe, expect, test } from "vitest";
import { entityPath } from "./entityLinks";

describe("entityPath", () => {
  test("each kind goes to its own path helper's address", () => {
    expect(entityPath({ kind: "project", id: 7 })).toBe("/projects/7");
    expect(entityPath({ kind: "team", id: 3 })).toBe("/teams/3");
    expect(entityPath({ kind: "person", id: 5 })).toBe("/people/5");
    expect(entityPath({ kind: "user", id: 9 })).toBe("/users/9/edit");
  });

  test("a milestone is its project's page with the milestone named", () => {
    expect(entityPath({ kind: "milestone", id: 11, projectId: 7 })).toBe("/projects/7?milestone=11");
  });

  test("a program is the Roadmap overview narrowed by the pick the overview reads", () => {
    expect(entityPath({ kind: "program", id: 4 })).toBe("/roadmap?mode=overview&programId=4");
  });

  test("a work stream is the Roadmap overview narrowed by workStreamId (read from the overview commit on)", () => {
    expect(entityPath({ kind: "workStream", id: 2 })).toBe("/roadmap?mode=overview&workStreamId=2");
  });
});
