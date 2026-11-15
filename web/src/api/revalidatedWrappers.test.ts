import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { jsonResponse, notModified } from "../test/http";
import { getBaselineView } from "./baselines";
import { getCapacityDeviations } from "./capacityDeviations";
import { getDependencyListView } from "./dependencyList";
import { getDeviations } from "./deviations";
import { getHomeView } from "./home";
import { getJiraLinks } from "./jira";
import { getProjectView } from "./milestones";
import { getPlanView } from "./plan";
import { getProgramsView } from "./programs";
import { forgetRevalidated } from "./revalidate";
import { getRoadmapView } from "./roadmap";
import { getTeamView, listTeams } from "./teams";
import { getTeamLoadView } from "./teamLoad";

const sentTag = (call: unknown[]) => new Headers((call[1] as RequestInit | undefined)?.headers).get("If-None-Match");

const REVALIDATED: [string, string, () => Promise<unknown>][] = [
  ["getPlanView", "/api/v1/views/plan", () => getPlanView()],
  ["getHomeView", "/api/v1/views/home", () => getHomeView()],
  ["getTeamLoadView", "/api/v1/views/team-load", () => getTeamLoadView()],
  ["getDependencyListView", "/api/v1/views/dependencies", () => getDependencyListView()],
  ["getRoadmapView", "/api/v1/views/roadmap?baseline=4&criticalPath=7", () => getRoadmapView(4, 7)],
  ["getProgramsView", "/api/v1/views/programs", () => getProgramsView()],
  ["getProjectView", "/api/v1/views/project/12", () => getProjectView(12)],
  ["getTeamView", "/api/v1/views/team/3", () => getTeamView(3)],
  ["getBaselineView", "/api/v1/views/baseline/5?against=6", () => getBaselineView(5, 6)],
  ["getJiraLinks", "/api/v1/views/jira-links", () => getJiraLinks()],
];

const NEVER: [string, () => Promise<unknown>][] = [
  ["getDeviations", () => getDeviations()],
  ["getCapacityDeviations", () => getCapacityDeviations()],
  ["listTeams", () => listTeams({ page: 1, pageSize: 20 })],
];

describe("the view wrappers revalidate", () => {
  const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    localStorage.setItem("astrolabe.auth.token", "fake-token");
    forgetRevalidated();
  });

  afterEach(() => {
    forgetRevalidated();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  test.each(REVALIDATED)("%s sends the kept tag the second time and resolves the kept document on a 304", async (_name, path, read) => {
    fetchMock.mockImplementationOnce(async () => jsonResponse(200, { marker: path }, { ETag: 'W/"t"' }));
    const first = await read();
    fetchMock.mockImplementationOnce(async () => notModified('W/"t"'));
    const second = await read();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([path, path]);
    expect(sentTag(fetchMock.mock.calls[0])).toBeNull();
    expect(sentTag(fetchMock.mock.calls[1])).toBe('W/"t"');
    expect(second).toEqual(first);
    expect(second).toEqual({ marker: path });
  });

  test.each(NEVER)("%s never sends If-None-Match", async (_name, read) => {
    fetchMock.mockImplementation(async () => jsonResponse(200, { items: [], total: 0, page: 1, pageSize: 20 }, { ETag: 'W/"t"' }));
    await read();
    await read();
    expect(fetchMock.mock.calls.map(sentTag)).toEqual([null, null]);
  });
});
