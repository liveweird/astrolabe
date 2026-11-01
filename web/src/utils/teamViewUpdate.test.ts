import { describe, expect, test } from "vitest";
import type { TeamMilestone, TeamView } from "../api/teams";
import { applyTeamOrder, applyTeamSchedule } from "./teamViewUpdate";

const milestone = (id: number, name: string, over: Partial<TeamMilestone> = {}): TeamMilestone => ({
  id,
  projectId: 7,
  name,
  description: null,
  teamId: 3,
  teamName: "Backend",
  estimateMd: 5,
  startDate: "2027-02-01",
  endDate: "2027-02-05",
  createdAt: 1,
  updatedAt: 2,
  projectName: "Invoices",
  programName: "Billing",
  workStreamName: "Platform",
  rankPosition: 1,
  ...over,
});

const viewOf = (scheduled: TeamMilestone[], unscheduled: TeamMilestone[] = []): TeamView => ({
  revision: 10,
  team: { id: 3, name: "Backend", description: null, managerPersonId: 1, managerName: "Mia", createdAt: 1, updatedAt: 2, can: { schedule: true, editCapacity: true, editOrder: true } },
  order: { custom: false, revision: 4, milestoneIds: [] },
  capacity: { periods: [] },
  weeks: [],
  weeksTruncated: false,
  scheduled,
  unscheduled,
  dependencies: [],
});

const ids = (list: TeamMilestone[]) => list.map((m) => m.id);

describe("applyTeamSchedule", () => {
  test("a newly scheduled row is appended after the server's order; the tray loses it", () => {
    const view = viewOf([milestone(1, "A"), milestone(2, "B")], [milestone(3, "C", { startDate: null, endDate: null })]);
    const next = applyTeamSchedule(view, 3, "2027-03-01", "2027-03-05");
    expect(ids(next.scheduled)).toEqual([1, 2, 3]);
    expect(next.scheduled[2]).toMatchObject({ startDate: "2027-03-01", endDate: "2027-03-05" });
    expect(next.unscheduled).toEqual([]);
  });

  test("a rescheduled row keeps its place; the weeks and the revisions stay the view's", () => {
    const view = viewOf([milestone(1, "A"), milestone(2, "B"), milestone(3, "C")]);
    const next = applyTeamSchedule(view, 2, "2027-04-05", "2027-04-09");
    expect(ids(next.scheduled)).toEqual([1, 2, 3]);
    expect(next.scheduled[1].startDate).toBe("2027-04-05");
    expect(next.weeks).toBe(view.weeks);
    expect(next.order).toBe(view.order);
    expect(next.revision).toBe(10);
  });

  test("unscheduling moves the row into the tray in the default order (rank, then project, then name)", () => {
    const view = viewOf(
      [milestone(1, "A"), milestone(2, "B", { rankPosition: 2 })],
      [milestone(5, "Late", { startDate: null, endDate: null, rankPosition: null }), milestone(6, "Early", { startDate: null, endDate: null, rankPosition: 1 })],
    );
    const next = applyTeamSchedule(view, 2, null, null);
    expect(ids(next.scheduled)).toEqual([1]);
    expect(ids(next.unscheduled)).toEqual([6, 2, 5]);
    expect(next.unscheduled[1]).toMatchObject({ startDate: null, endDate: null });
  });

  test("an unknown id changes nothing", () => {
    const view = viewOf([milestone(1, "A")]);
    expect(applyTeamSchedule(view, 99, null, null)).toBe(view);
  });
});

describe("applyTeamOrder", () => {
  const view = viewOf([milestone(1, "A"), milestone(2, "B"), milestone(3, "C")]);

  test("the listed rows come first in that order and the order becomes custom; the order revision is left alone", () => {
    const next = applyTeamOrder(view, [3, 1, 2]);
    expect(ids(next.scheduled)).toEqual([3, 1, 2]);
    expect(next.order).toEqual({ custom: true, revision: 4, milestoneIds: [3, 1, 2] });
  });

  test("the full list is stored as is: an unscheduled listed id keeps its entry, an unknown id is dropped", () => {
    const withTray = viewOf([milestone(1, "A"), milestone(2, "B")], [milestone(5, "M", { startDate: null, endDate: null })]);
    const next = applyTeamOrder(withTray, [2, 5, 1, 99]);
    expect(ids(next.scheduled)).toEqual([2, 1]);
    expect(next.order.milestoneIds).toEqual([2, 5, 1]);
    expect(ids(next.unscheduled)).toEqual([5]);
  });

  test("an unlisted row follows in the default order; an id that is not scheduled is skipped", () => {
    const next = applyTeamOrder(view, [3, 99]);
    expect(ids(next.scheduled)).toEqual([3, 1, 2]);
  });

  test("the empty list is the reset: the project rank's order again and no custom flag", () => {
    const ranked = viewOf([
      milestone(1, "A", { projectId: 8, projectName: "Zeta", rankPosition: 2 }),
      milestone(2, "B", { projectId: 7, projectName: "Alpha", rankPosition: 1 }),
      milestone(3, "C", { projectId: 9, projectName: "Beta", rankPosition: null }),
    ]);
    const custom = { ...ranked, order: { custom: true, revision: 6, milestoneIds: [1, 3] } };
    const next = applyTeamOrder(custom, []);
    expect(ids(next.scheduled)).toEqual([2, 1, 3]);
    expect(next.order).toEqual({ custom: false, revision: 6, milestoneIds: [] });
  });

  test("inside one project the default order is start, end, name, id", () => {
    const same = viewOf([
      milestone(1, "b", { startDate: "2027-02-08", endDate: "2027-02-12" }),
      milestone(2, "a", { startDate: "2027-02-08", endDate: "2027-02-12" }),
      milestone(3, "z", { startDate: "2027-02-01", endDate: "2027-02-05" }),
    ]);
    expect(ids(applyTeamOrder(same, []).scheduled)).toEqual([3, 2, 1]);
  });
});
