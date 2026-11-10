import { describe, expect, test } from "vitest";
import type { ProjectMilestone, ProjectView } from "../api/milestones";
import { applySchedule } from "./projectViewUpdate";

const milestone = (id: number, name: string, startDate: string | null = null, endDate: string | null = null): ProjectMilestone => ({
  jira: null,
  flags: [],
  id,
  projectId: 1,
  name,
  description: null,
  teamId: 3,
  teamName: "Team A",
  estimateMd: 2,
  startDate,
  endDate,
  createdAt: 1,
  updatedAt: 2,
  slackDays: null,
  critical: false,
  pinned: false,
  can: { edit: true, delete: true, schedule: true },
});

const VIEW = {
  revision: 7,
  span: { start: "2027-01-11", end: "2027-01-22" },
  drift: null,
  idleGaps: [{ start: "2027-02-01", end: "2027-02-03", workingDays: 3 }],
  scheduled: [milestone(1, "Build", "2027-01-11", "2027-01-15"), milestone(2, "Launch", "2027-01-18", "2027-01-22")],
  unscheduled: [milestone(3, "audit"), milestone(4, "Zeta")],
} as ProjectView;

const CALENDAR = { kind: "NO_WORKING_DAY", severity: "WARNING", days: null, teamId: null, otherProjectId: null, deviation: null, count: null } as const;
const JIRA = { kind: "JIRA_MILESTONES", severity: "WARNING", days: null, teamId: null, otherProjectId: null, deviation: null, count: 1 } as const;
const ids = (list: ProjectMilestone[]) => list.map((m) => m.id);

describe("applySchedule", () => {
  test("keeps the baseline block of the cached view untouched, like the idle gaps (the refetch brings the new movement)", () => {
    const baseline = { id: 5, name: "Q1", planRevision: 4, project: null, milestones: [], removed: [] };
    const next = applySchedule({ ...VIEW, baseline }, 1, "2027-01-25", "2027-01-26");
    expect(next.baseline).toBe(baseline);
    expect(next.idleGaps).toBe(VIEW.idleGaps);
  });

  test("a tray milestone scheduled joins the scheduled list in start order and leaves the tray", () => {
    const next = applySchedule(VIEW, 3, "2027-01-04", "2027-01-10");
    expect(ids(next.scheduled)).toEqual([3, 1, 2]);
    expect(ids(next.unscheduled)).toEqual([4]);
    expect(next.scheduled[0]).toMatchObject({ startDate: "2027-01-04", endDate: "2027-01-10" });
  });

  test("a move keeps the milestone in the scheduled list, re-sorted by start then end then name", () => {
    expect(ids(applySchedule(VIEW, 1, "2027-01-25", "2027-01-26").scheduled)).toEqual([2, 1]);
    expect(ids(applySchedule(VIEW, 1, "2027-01-18", "2027-01-22").scheduled)).toEqual([1, 2]);
  });

  test("the written row drops its NO_WORKING_DAY flag (it described the old dates; the refetch re-derives it) and keeps the others", () => {
    const flagged = { ...VIEW, scheduled: [{ ...milestone(1, "Build", "2027-01-06", "2027-01-06"), flags: [CALENDAR, JIRA] }, VIEW.scheduled[1]] };
    expect(applySchedule(flagged, 1, "2027-01-07", "2027-01-08").scheduled[0].flags).toEqual([JIRA]);
    expect(applySchedule(flagged, 1, null, null).unscheduled.find((m) => m.id === 1)?.flags).toEqual([JIRA]);
    expect(applySchedule(flagged, 2, "2027-02-01", "2027-02-02").scheduled.find((m) => m.id === 1)?.flags).toEqual([CALENDAR, JIRA]);
  });

  test("a null pair unschedules: the milestone returns to the tray in case-insensitive name order", () => {
    const next = applySchedule(VIEW, 2, null, null);
    expect(ids(next.scheduled)).toEqual([1]);
    expect(ids(next.unscheduled)).toEqual([3, 2, 4]);
    expect(next.unscheduled[1]).toMatchObject({ startDate: null, endDate: null });
  });

  test("the revision, span and drift are the server's and stay as they were; the input is not mutated", () => {
    const next = applySchedule(VIEW, 1, "2027-02-01", "2027-02-05");
    expect(next.revision).toBe(7);
    expect(next.span).toEqual(VIEW.span);
    expect(VIEW.scheduled[0].startDate).toBe("2027-01-11");
  });

  test("the idle gaps are the server's too: kept (not dropped, not recomputed) until the refetch brings the new ones", () => {
    const next = applySchedule(VIEW, 2, "2027-03-01", "2027-03-05");
    expect(next.idleGaps).toBe(VIEW.idleGaps);
    expect(applySchedule(VIEW, 1, null, null).idleGaps).toBe(VIEW.idleGaps);
  });

  test("unscheduling clears the pin; a reschedule keeps it (the server's clear rule, mirrored)", () => {
    const view = { ...VIEW, scheduled: [{ ...milestone(1, "Build", "2027-01-11", "2027-01-15"), pinned: true }, VIEW.scheduled[1]] } as ProjectView;
    expect(applySchedule(view, 1, null, null).unscheduled.find((m) => m.id === 1)?.pinned).toBe(false);
    expect(applySchedule(view, 1, "2027-02-01", "2027-02-05").scheduled.find((m) => m.id === 1)?.pinned).toBe(true);
  });

  test("an unknown id answers the view unchanged", () => {
    expect(applySchedule(VIEW, 99, "2027-01-04", "2027-01-10")).toBe(VIEW);
  });
});
