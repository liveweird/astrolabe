import { describe, expect, test } from "vitest";
import i18n from "../i18n";
import type { ProjectMilestone } from "../api/milestones";
import { ApiError } from "../api/http";
import {
  EMPTY_MILESTONE_FORM,
  hasWorkingDay,
  milestoneFormValidation,
  milestoneSaveErrorMessage,
  scheduleFormValidation,
  toMilestoneBody,
  toMilestoneFormValues,
} from "./milestoneForm";

const t = i18n.t.bind(i18n);
const rules = milestoneFormValidation(t);
const schedule = scheduleFormValidation(t);

const MILESTONE = {
  id: 5,
  projectId: 1,
  name: "Discovery",
  description: "Interviews",
  teamId: 3,
  teamName: "Team A",
  estimateMd: 12.25,
  startDate: "2027-01-04",
  endDate: "2027-01-10",
} as ProjectMilestone;

describe("milestoneForm", () => {
  test("a milestone maps onto the form and back to the exact PUT body (never carrying dates)", () => {
    const values = toMilestoneFormValues(MILESTONE);
    expect(values).toEqual({ name: "Discovery", description: "Interviews", teamId: "3", teamLabel: "Team A", estimate: 12.25 });
    expect(toMilestoneBody(values)).toEqual({ name: "Discovery", description: "Interviews", teamId: 3, estimateMd: 12.25 });
  });

  test("names are trimmed and a blank description travels as null", () => {
    const body = toMilestoneBody({ ...EMPTY_MILESTONE_FORM, name: "  Plan  ", description: "   ", teamId: "2", estimate: "0.5" });
    expect(body).toEqual({ name: "Plan", description: null, teamId: 2, estimateMd: 0.5 });
  });

  test("name, description and team follow the server's limits", () => {
    expect(rules.name("")).not.toBeNull();
    expect(rules.name("x".repeat(101))).not.toBeNull();
    expect(rules.name("x".repeat(100))).toBeNull();
    expect(rules.description("x".repeat(501))).not.toBeNull();
    expect(rules.description("x".repeat(500))).toBeNull();
    expect(rules.teamId(null)).toBe("Pick a team");
    expect(rules.teamId("3")).toBeNull();
  });

  test.each([
    ["", false],
    [0, true],
    [0.25, true],
    [12.25, true],
    ["12.25", true],
    [999999.99, true],
    [-1, false],
    [0.125, false],
    [1000000, false],
    ["abc", false],
  ])("the estimate %j is %s", (value, ok) => {
    expect(rules.estimate(value) === null).toBe(ok);
  });

  test("an empty estimate asks for one, an invalid one names the rule", () => {
    expect(rules.estimate("")).toBe("Enter the estimate in man-days");
    expect(rules.estimate(-1)).toBe("Enter man-days from 0, with at most two decimals");
  });

  test("a span with a weekday has a working day; a Saturday–Sunday-only one has none", () => {
    expect(hasWorkingDay("2027-01-04", "2027-01-04")).toBe(true);
    expect(hasWorkingDay("2027-01-09", "2027-01-10")).toBe(false);
    expect(hasWorkingDay("2027-01-09", "2027-01-11")).toBe(true);
    expect(hasWorkingDay("2027-01-09", "2027-03-01")).toBe(true);
  });

  test("the schedule rules: both dates, real, ordered, with a working day", () => {
    expect(schedule.startDate(null)).toBe("Enter a start date");
    expect(schedule.startDate("2027-02-30")).toBe("Enter a valid date (YYYY-MM-DD)");
    expect(schedule.endDate(null, { startDate: "2027-01-04", endDate: null })).toBe("Enter an end date");
    expect(schedule.endDate("2027-01-03", { startDate: "2027-01-04", endDate: "2027-01-03" })).toBe("The end must not be before the start");
    expect(schedule.endDate("2027-01-10", { startDate: "2027-01-09", endDate: "2027-01-10" })).toBe("A milestone must cover at least one working day (Monday to Friday)");
    expect(schedule.endDate("2027-01-10", { startDate: "2027-01-04", endDate: "2027-01-10" })).toBeNull();
  });

  test("save errors map to the project vocabulary, never to the raw message", () => {
    expect(milestoneSaveErrorMessage(new ApiError(403, {}), t)).toBe("You are not allowed to change this");
    expect(milestoneSaveErrorMessage(new ApiError(404, {}), t)).toBe("This no longer exists — reload the page");
    expect(milestoneSaveErrorMessage(new ApiError(400, {}), t)).toContain("team");
    expect(milestoneSaveErrorMessage(new ApiError(500, {}), t)).toBe("Save failed (500)");
    expect(milestoneSaveErrorMessage(new Error("boom"), t)).toBe("Save failed. Check your connection and try again.");
  });
});
