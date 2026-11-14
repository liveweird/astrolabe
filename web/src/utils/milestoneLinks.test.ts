import { describe, expect, test } from "vitest";
import { milestonesPath, unscheduledMilestonesPath } from "./milestoneLinks";

describe("milestone links", () => {
  test("the route", () => {
    expect(milestonesPath).toBe("/milestones");
  });

  test("the unscheduled list, plain or narrowed to a team or a project", () => {
    expect(unscheduledMilestonesPath()).toBe("/milestones?scheduled=false");
    expect(unscheduledMilestonesPath({ teamId: 3 })).toBe("/milestones?scheduled=false&teamId=3");
    expect(unscheduledMilestonesPath({ projectId: 7 })).toBe("/milestones?scheduled=false&projectId=7");
    expect(unscheduledMilestonesPath({ teamId: 3, projectId: 7 })).toBe("/milestones?scheduled=false&teamId=3&projectId=7");
  });
});
