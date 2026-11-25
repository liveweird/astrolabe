import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { jsonResponse } from "../test/http";
import {
  createCapacityPeriod,
  deleteCapacityPeriod,
  getTeamView,
  listEveryTeam,
  MAX_TEAM_OPTION_PAGES,
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

  test("getTeamView asks for the picked baseline with ?baseline= (none, null: the plain view)", async () => {
    mockFetch.mockImplementation(() => Promise.resolve(jsonResponse(200, { revision: 4, scheduled: [], unscheduled: [] })));
    await getTeamView(9, 5);
    expect(lastCall()[0]).toBe("/api/v1/views/team/9?baseline=5");
    await getTeamView(9, null);
    expect(lastCall()[0]).toBe("/api/v1/views/team/9");
  });

  test("getTeamView asks for the critical chain with ?criticalChain=true, after the baseline; false sends nothing (the request the plain page always made)", async () => {
    mockFetch.mockImplementation(() => Promise.resolve(jsonResponse(200, { revision: 4, scheduled: [], unscheduled: [] })));
    await getTeamView(9, null, true);
    expect(lastCall()[0]).toBe("/api/v1/views/team/9?criticalChain=true");
    await getTeamView(9, 5, true);
    expect(lastCall()[0]).toBe("/api/v1/views/team/9?baseline=5&criticalChain=true");
    await getTeamView(9, 5, false);
    expect(lastCall()[0]).toBe("/api/v1/views/team/9?baseline=5");
    await getTeamView(9, null, false);
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

describe("listEveryTeam", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  const team = (id: number) => ({ id, name: `Team ${id}` });
  const pageOf = (items: { id: number; name: string }[], total: number, page = 1) => jsonResponse(200, { items, page, pageSize: 100, total });
  const urls = () => mockFetch.mock.calls.map(([url]) => String(url));

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    localStorage.setItem("astrolabe.auth.token", "fake-token");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  test("one request when the total fits a page, by name", async () => {
    mockFetch.mockResolvedValue(pageOf([team(1), team(2)], 2));
    expect((await listEveryTeam()).map((t) => t.id)).toEqual([1, 2]);
    expect(urls()).toEqual(["/api/v1/teams?page=1&pageSize=100&sort=name"]);
  });

  test("a second page when the total does not fit, the pages joined in order", async () => {
    const first = Array.from({ length: 100 }, (_, i) => team(i + 1));
    mockFetch.mockImplementation((url: string) => Promise.resolve(url.includes("page=2") ? pageOf([team(101)], 101, 2) : pageOf(first, 101)));
    const all = await listEveryTeam();
    expect(all).toHaveLength(101);
    expect(all.at(-1)?.id).toBe(101);
    expect(urls()).toEqual(["/api/v1/teams?page=1&pageSize=100&sort=name", "/api/v1/teams?page=2&pageSize=100&sort=name"]);
  });

  test("an empty page ends the read even when the total says more", async () => {
    mockFetch.mockImplementation((url: string) => Promise.resolve(url.includes("page=2") ? pageOf([], 500, 2) : pageOf([team(1)], 500)));
    expect(await listEveryTeam()).toHaveLength(1);
    expect(urls()).toHaveLength(2);
  });

  test("the read stops at the page bound", async () => {
    let next = 0;
    mockFetch.mockImplementation(() => Promise.resolve(pageOf([team(++next)], 100000)));
    expect(await listEveryTeam()).toHaveLength(MAX_TEAM_OPTION_PAGES);
    expect(urls()).toHaveLength(MAX_TEAM_OPTION_PAGES);
  });

  test("a team answered twice (a page shifted by a new team) is listed once", async () => {
    mockFetch.mockImplementation((url: string) => Promise.resolve(url.includes("page=2") ? pageOf([team(2), team(3)], 3, 2) : pageOf([team(1), team(2)], 3)));
    expect((await listEveryTeam()).map((t) => t.id)).toEqual([1, 2, 3]);
  });
});
