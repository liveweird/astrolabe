import { describe, expect, test } from "vitest";
import type { TeamMilestone, TeamView } from "../api/teams";
import { fullOrderList, placeScheduled } from "./teamOrderList";

const milestone = (id: number, scheduled = true): TeamMilestone => ({
  jira: null,
  flags: [],
  id,
  projectId: 7,
  name: `m${id}`,
  description: null,
  teamId: 3,
  teamName: "Backend",
  estimateMd: 5,
  startDate: scheduled ? "2027-02-01" : null,
  endDate: scheduled ? "2027-02-05" : null,
  createdAt: 1,
  updatedAt: 2,
  projectName: "Invoices",
  programName: "Billing",
  workStreamName: "Platform",
  rankPosition: 1,
});

/** A view whose scheduled rows are `scheduled` (in this displayed order), tray `unscheduled`, stored order `stored`. */
const viewOf = (scheduled: number[], unscheduled: number[], stored: number[]): TeamView => ({
  jiraSites: [],
  revision: 10,
  team: { id: 3, name: "Backend", description: null, managerPersonId: 1, managerName: "Mia", createdAt: 1, updatedAt: 2, can: { schedule: true, editCapacity: true, editOrder: true } },
  order: { custom: stored.length > 0, revision: 4, milestoneIds: stored },
  capacity: { periods: [] },
  weeks: [],
  weeksTruncated: false,
  scheduled: scheduled.map((id) => milestone(id)),
  unscheduled: unscheduled.map((id) => milestone(id, false)),
  dependencies: [],
  idleGaps: [],
});

// A=1, B=2, M=3 (unscheduled), C=4, N=5 (a newcomer), U=6 (an unlisted unscheduled)
describe("fullOrderList", () => {
  test("the stored order first, then the scheduled rows it does not list in their displayed order", () => {
    expect(fullOrderList(viewOf([1, 2, 4, 5], [3, 6], [1, 2, 3, 4]))).toEqual([1, 2, 3, 4, 5]);
  });

  test("no custom order: the displayed scheduled ids; the unscheduled stay unlisted", () => {
    expect(fullOrderList(viewOf([1, 2, 4], [3, 6], []))).toEqual([1, 2, 4]);
  });
});

describe("placeScheduled", () => {
  test("the pinned example: stored [A,B,M,C], M unscheduled, Move C to top → [C,A,M,B]", () => {
    const view = viewOf([1, 2, 4], [3], [1, 2, 3, 4]);
    expect(placeScheduled(view, [4, 1, 2])).toEqual([4, 1, 3, 2]);
  });

  test("an unscheduled listed id keeps its INDEX whichever way the scheduled rows move", () => {
    const view = viewOf([1, 2, 4], [3], [1, 2, 3, 4]);
    expect(placeScheduled(view, [2, 1, 4])).toEqual([2, 1, 3, 4]);
    expect(placeScheduled(view, [1, 4, 2])).toEqual([1, 4, 3, 2]);
    expect(placeScheduled(view, [1, 2, 4])).toEqual([1, 2, 3, 4]);
  });

  test("no custom order: the permutation is the list; unscheduled milestones stay unlisted", () => {
    const view = viewOf([1, 2, 4], [3, 6], []);
    expect(placeScheduled(view, [2, 4, 1])).toEqual([2, 4, 1]);
  });

  test("newcomers (scheduled, unlisted) slot in after the stored list and are listed by the write", () => {
    const view = viewOf([1, 2, 4, 5], [3, 6], [1, 2, 3, 4]);
    // N (5) is displayed last; Move N to top.
    expect(placeScheduled(view, [5, 1, 2, 4])).toEqual([5, 1, 3, 2, 4]);
    // Nothing moved: the full list still lists the newcomer at the bottom, and the unlisted unscheduled 6 never appears.
    expect(placeScheduled(view, [1, 2, 4, 5])).toEqual([1, 2, 3, 4, 5]);
  });

  test("a listed unscheduled id in the middle and one in the head and tail all hold their slots", () => {
    const view = viewOf([1, 2], [3, 4, 5], [3, 1, 4, 2, 5]);
    expect(placeScheduled(view, [2, 1])).toEqual([3, 2, 4, 1, 5]);
  });

  test("all listed milestones unscheduled: nothing to permute, the list stays", () => {
    const view = viewOf([], [3, 1], [3, 1]);
    expect(placeScheduled(view, [])).toEqual([3, 1]);
  });

  test("a non-permutation (wrong length, repeated or unknown id) changes nothing", () => {
    const view = viewOf([1, 2, 4], [3], [1, 2, 3, 4]);
    expect(placeScheduled(view, [4, 1])).toBeNull();
    expect(placeScheduled(view, [4, 4, 1])).toBeNull();
    expect(placeScheduled(view, [4, 1, 9])).toBeNull();
  });
});
