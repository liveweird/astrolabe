import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { jsonResponse } from "../test/http";
import { teamLoadRow, teamLoadView } from "../test/teamLoad";
import { getTeamLoadView, TEAM_LOAD_KEY } from "./teamLoad";

beforeEach(() => {
  localStorage.setItem("astrolabe.auth.token", "fake-token");
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

test("getTeamLoadView GETs the view without a query", async () => {
  const mockFetch = vi.fn().mockResolvedValue(jsonResponse(200, teamLoadView([teamLoadRow()], { revision: 9 })));
  vi.stubGlobal("fetch", mockFetch);
  const view = await getTeamLoadView();
  expect(view.revision).toBe(9);
  expect(view.teams).toHaveLength(1);
  expect(mockFetch.mock.calls.at(-1)?.[0]).toBe("/api/v1/views/team-load");
});

test("the view is cached under the plan prefix", () => {
  expect(TEAM_LOAD_KEY).toEqual(["plan", "teamLoad"]);
});
