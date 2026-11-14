import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { jsonResponse } from "../test/http";
import { homeView } from "../test/home";
import { getHomeView, HOME_VIEW_KEY } from "./home";

beforeEach(() => {
  localStorage.setItem("astrolabe.auth.token", "fake-token");
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

test("getHomeView GETs the view without a query", async () => {
  const mockFetch = vi.fn().mockResolvedValue(jsonResponse(200, homeView({ revision: 7 })));
  vi.stubGlobal("fetch", mockFetch);
  expect((await getHomeView()).revision).toBe(7);
  expect(mockFetch.mock.calls.at(-1)?.[0]).toBe("/api/v1/views/home");
});

test("the view is cached under the plan prefix", () => {
  expect(HOME_VIEW_KEY).toEqual(["plan", "home"]);
});
