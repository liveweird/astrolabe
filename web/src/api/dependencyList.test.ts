import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { dependencyListView, dependencyRow } from "../test/dependencyList";
import { jsonResponse } from "../test/http";
import { DEPENDENCY_LIST_KEY, getDependencyListView } from "./dependencyList";

beforeEach(() => {
  localStorage.setItem("astrolabe.auth.token", "fake-token");
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

test("getDependencyListView GETs the view without a query", async () => {
  const mockFetch = vi.fn().mockResolvedValue(jsonResponse(200, dependencyListView([dependencyRow()], { revision: 9 })));
  vi.stubGlobal("fetch", mockFetch);
  const view = await getDependencyListView();
  expect(view.revision).toBe(9);
  expect(view.dependencies).toHaveLength(1);
  expect(mockFetch.mock.calls.at(-1)?.[0]).toBe("/api/v1/views/dependencies");
});

test("the view is cached under the plan prefix", () => {
  expect(DEPENDENCY_LIST_KEY).toEqual(["plan", "dependencies"]);
});
