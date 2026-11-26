import { describe, expect, test } from "vitest";
import type { ProjectMilestone } from "../api/milestones";
import { filterMilestones, isScheduled, milestoneTeams, narrowingCount, parseScheduleParam, projectMilestones, sortMilestones } from "./projectMilestones";

const milestone = (id: number, name: string, over: Partial<ProjectMilestone> = {}): ProjectMilestone => ({
  jira: null,
  flags: [],
  id,
  projectId: 7,
  name,
  description: null,
  teamId: 3,
  teamName: "Backend",
  estimateMd: 5,
  startDate: null,
  endDate: null,
  createdAt: 1,
  updatedAt: 2,
  slackDays: null,
  critical: false,
  pinned: false,
  can: { edit: true, delete: true, schedule: true },
  ...over,
});

const dated = (start: string, end: string) => ({ startDate: start, endDate: end });
const DESIGN_TEAM = { teamId: 4, teamName: "Design" };
const ALL = [
  milestone(1, "Discovery", dated("2027-01-11", "2027-01-15")),
  milestone(2, "Build", { ...dated("2027-01-04", "2027-01-08"), ...DESIGN_TEAM }),
  milestone(3, "Rollout"),
  milestone(4, "Zażółć", { ...DESIGN_TEAM }),
];
const none = { schedule: "all", teamId: undefined, name: "" } as const;
const names = (rows: ProjectMilestone[]) => rows.map((row) => row.name);

describe("parseScheduleParam", () => {
  test("only the three exact words are a choice; anything else is none", () => {
    expect(["all", "unscheduled", "scheduled"].map(parseScheduleParam)).toEqual(["all", "unscheduled", "scheduled"]);
    for (const value of [null, "", "ALL", "true", "false", "unscheduled ", "other"]) expect(parseScheduleParam(value)).toBeUndefined();
  });
});

describe("projectMilestones, isScheduled, milestoneTeams", () => {
  test("the view's two lists in order, scheduled first; a milestone with one date is not scheduled", () => {
    expect(names(projectMilestones({ scheduled: [ALL[0]], unscheduled: [ALL[2]] }))).toEqual(["Discovery", "Rollout"]);
    expect(isScheduled(ALL[0])).toBe(true);
    expect(isScheduled(ALL[2])).toBe(false);
    expect(isScheduled(milestone(9, "Half", { startDate: "2027-01-04" }))).toBe(false);
  });

  test("one entry per team, by name then id", () => {
    expect(milestoneTeams(ALL)).toEqual([
      { id: 3, name: "Backend" },
      { id: 4, name: "Design" },
    ]);
    expect(milestoneTeams([])).toEqual([]);
  });
});

describe("filterMilestones and narrowingCount", () => {
  test("no narrowing keeps every milestone in the given order", () => {
    expect(names(filterMilestones(ALL, none))).toEqual(["Discovery", "Build", "Rollout", "Zażółć"]);
    expect(narrowingCount(none)).toBe(0);
  });

  test("the Schedule choice splits scheduled from not scheduled", () => {
    expect(names(filterMilestones(ALL, { ...none, schedule: "unscheduled" }))).toEqual(["Rollout", "Zażółć"]);
    expect(names(filterMilestones(ALL, { ...none, schedule: "scheduled" }))).toEqual(["Discovery", "Build"]);
  });

  test("the team keeps its own milestones; the name is a case- and accent-insensitive substring of the milestone name", () => {
    expect(names(filterMilestones(ALL, { ...none, teamId: 4 }))).toEqual(["Build", "Zażółć"]);
    expect(names(filterMilestones(ALL, { ...none, name: "  DISC " }))).toEqual(["Discovery"]);
    expect(names(filterMilestones(ALL, { ...none, name: "zazolc" }))).toEqual(["Zażółć"]);
    expect(names(filterMilestones(ALL, { ...none, name: "Design" }))).toEqual([]);
  });

  test("the controls narrow together, and each counts once (a blank name does not count)", () => {
    const all = { schedule: "unscheduled", teamId: 4, name: "z" } as const;
    expect(names(filterMilestones(ALL, all))).toEqual(["Zażółć"]);
    expect(narrowingCount(all)).toBe(3);
    expect(narrowingCount({ ...none, name: "   " })).toBe(0);
  });
});

describe("sortMilestones", () => {
  test("by start: earliest first, descending latest first, without dates LAST in both directions", () => {
    expect(names(sortMilestones(ALL, "start", "asc"))).toEqual(["Build", "Discovery", "Rollout", "Zażółć"]);
    expect(names(sortMilestones(ALL, "start", "desc"))).toEqual(["Discovery", "Build", "Rollout", "Zażółć"]);
  });

  test("a milestone with only one date counts as undated here too (the rule of isScheduled): last in both directions", () => {
    const half = milestone(5, "Half", { startDate: "2027-01-01" });
    const rows = [half, ALL[0], ALL[1]];
    expect(names(sortMilestones(rows, "start", "asc"))).toEqual(["Build", "Discovery", "Half"]);
    expect(names(sortMilestones(rows, "start", "desc"))).toEqual(["Discovery", "Build", "Half"]);
    expect(names(filterMilestones(rows, { ...none, schedule: "unscheduled" }))).toEqual(["Half"]);
  });

  test("by milestone name, ignoring case and accents, numbers in numeric order", () => {
    const rows = [milestone(1, "step 10"), milestone(2, "Step 9"), milestone(3, "érable"), milestone(4, "Zeta")];
    expect(names(sortMilestones(rows, "name", "asc"))).toEqual(["érable", "Step 9", "step 10", "Zeta"]);
    expect(names(sortMilestones(rows, "name", "desc"))).toEqual(["Zeta", "step 10", "Step 9", "érable"]);
  });

  test("by team name, ties by milestone name whichever the direction", () => {
    expect(names(sortMilestones(ALL, "team", "asc"))).toEqual(["Discovery", "Rollout", "Build", "Zażółć"]);
    expect(names(sortMilestones(ALL, "team", "desc"))).toEqual(["Build", "Zażółć", "Discovery", "Rollout"]);
  });

  test("equal starts fall back to the name, then the id; the input is never mutated", () => {
    const rows = [milestone(2, "Same", dated("2027-01-04", "2027-01-05")), milestone(1, "Same", dated("2027-01-04", "2027-01-05")), milestone(3, "Alpha", dated("2027-01-04", "2027-01-05"))];
    const before = [...rows];
    expect(sortMilestones(rows, "start", "asc").map((row) => row.id)).toEqual([3, 1, 2]);
    expect(sortMilestones(rows, "name", "asc").map((row) => row.id)).toEqual([3, 1, 2]);
    expect(rows).toEqual(before);
  });
});
