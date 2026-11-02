import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { jsonResponse } from "../test/http";
import {
  createCapacityPeriod,
  deleteCapacityPeriod,
  getTeamView,
  proposeTeamSchedule,
  putTeamOrder,
  scheduleTeamMilestones,
  updateCapacityPeriod,
} from "./teams";

type FetchMock = ReturnType<typeof vi.fn>;

describe("team view and capacity API wrappers", () => {
  let mockFetch: FetchMock;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    localStorage.setItem("astrolabe.auth.token", "fake-token");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  const lastCall = () => mockFetch.mock.calls.at(-1) as [string, RequestInit];
  const BODY = { effectiveFrom: "2027-02-03", mdPerWeek: 8, wipLimit: 3 };

  test("getTeamView GETs the team's view document", async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, { revision: 4, scheduled: [], unscheduled: [] }));
    expect((await getTeamView(9)).revision).toBe(4);
    expect(lastCall()[0]).toBe("/api/v1/views/team/9");
  });

  test("createCapacityPeriod POSTs the period under the team and answers it", async () => {
    mockFetch.mockResolvedValue(jsonResponse(201, { id: 5, teamId: 9, ...BODY }));
    expect((await createCapacityPeriod(9, BODY)).id).toBe(5);
    const [url, init] = lastCall();
    expect(url).toBe("/api/v1/teams/9/capacity");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual(BODY);
  });

  test("updateCapacityPeriod PUTs the full replace (a null limit clears it); deleteCapacityPeriod DELETEs", async () => {
    mockFetch.mockResolvedValue(new Response(null, { status: 204 }));
    await updateCapacityPeriod(5, { ...BODY, wipLimit: null });
    expect(lastCall()[0]).toBe("/api/v1/capacity-periods/5");
    expect(lastCall()[1].method).toBe("PUT");
    expect(JSON.parse(lastCall()[1].body as string)).toEqual({ ...BODY, wipLimit: null });
    await deleteCapacityPeriod(5);
    expect(lastCall()[0]).toBe("/api/v1/capacity-periods/5");
    expect(lastCall()[1].method).toBe("DELETE");
  });

  test("putTeamOrder PUTs the team's order revision and the listed ids and answers the new revision", async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, { revision: 12 }));
    expect(await putTeamOrder(9, { expectedRevision: 11, milestoneIds: [3, 1, 2] })).toEqual({ revision: 12 });
    const [url, init] = lastCall();
    expect(url).toBe("/api/v1/teams/9/milestone-order");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({ expectedRevision: 11, milestoneIds: [3, 1, 2] });
  });

  test("proposeTeamSchedule POSTs the viewer's day to the team's proposal path and answers the proposal", async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, { revision: 7, asOf: "2042-01-05", teamId: 9, moves: [], unchanged: [], unplaced: [] }));
    expect((await proposeTeamSchedule(9, "2042-01-05")).revision).toBe(7);
    const [url, init] = lastCall();
    expect(url).toBe("/api/v1/teams/9/schedule-proposal");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ asOf: "2042-01-05" });
  });

  test("scheduleTeamMilestones POSTs the proposal's revision and the accepted spans and answers accepted and skipped", async () => {
    const answer = { revision: 13, accepted: [3], skipped: [{ milestoneId: 4, reason: "STALE" }] };
    mockFetch.mockResolvedValue(jsonResponse(200, answer));
    const body = {
      expectedRevision: 12,
      items: [
        { milestoneId: 3, startDate: "2042-01-07", endDate: "2042-01-10" },
        { milestoneId: 4, startDate: "2042-01-07", endDate: "2042-01-08" },
      ],
    };
    expect(await scheduleTeamMilestones(9, body)).toEqual(answer);
    const [url, init] = lastCall();
    expect(url).toBe("/api/v1/teams/9/milestone-schedules");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual(body);
  });
});
