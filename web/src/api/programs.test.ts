import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { jsonResponse } from "../test/http";
import { getProgramsView, programsViewKey } from "./programs";

beforeEach(() => {
  localStorage.setItem("astrolabe.auth.token", "fake-token");
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

test("getProgramsView GETs the view", async () => {
  const mockFetch = vi.fn().mockResolvedValue(jsonResponse(200, { revision: 4, teams: [], links: [], workStreams: [] }));
  vi.stubGlobal("fetch", mockFetch);
  expect((await getProgramsView()).revision).toBe(4);
  expect(mockFetch.mock.calls.at(-1)?.[0]).toBe("/api/v1/views/programs");
});

test("getProgramsView asks for the picked baseline with ?baseline= (none, null: the plain view)", async () => {
  const mockFetch = vi.fn<(url: string) => Promise<Response>>(() => Promise.resolve(jsonResponse(200, { revision: 4, teams: [], links: [], workStreams: [] })));
  vi.stubGlobal("fetch", mockFetch);
  await getProgramsView(5);
  expect(mockFetch.mock.calls.at(-1)?.[0]).toBe("/api/v1/views/programs?baseline=5");
  await getProgramsView(null);
  expect(mockFetch.mock.calls.at(-1)?.[0]).toBe("/api/v1/views/programs");
});

test("the cached view sits under the roadmap prefix, which the plan and project pages already refresh", () => {
  expect(programsViewKey(null)[0]).toBe("roadmap");
  expect(programsViewKey(7)).not.toEqual(programsViewKey(null));
});
