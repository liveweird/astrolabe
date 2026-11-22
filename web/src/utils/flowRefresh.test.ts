import { describe, expect, test, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { refreshFlowCapacity, refreshFlowConnections, refreshFlowLinks } from "./flowRefresh";

describe("refreshFlowLinks", () => {
  test("re-reads links, capacity deviations and every view that derives Flow flags", async () => {
    const queryClient = new QueryClient();
    const keys = [
      ["flow", "teams", 1],
      ["flow", "team", 3],
      ["flow", "deviations", "view", { teamId: 3 }],
      ["plan", "home"],
      ["plan", "team", 3],
      ["roadmap", "view"],
      ["flow", "list", 1],
    ];
    for (const key of keys) queryClient.setQueryData(key, { stale: false });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    await refreshFlowLinks(queryClient);
    expect(invalidate.mock.calls.map(([filters]) => filters?.queryKey)).toEqual([["flow", "teams"], ["flow", "team"], ["flow", "deviations"], ["plan"], ["roadmap"]]);
    expect(keys.map((key) => queryClient.getQueryState(key)?.isInvalidated)).toEqual([true, true, true, true, true, true, false]);
  });
});

describe("Flow-derived view refreshes", () => {
  test.each([
    ["capacity changes", refreshFlowCapacity, [["flow", "deviations"], ["plan"], ["roadmap"]]],
    ["connection lifecycle changes", refreshFlowConnections, [["flow"], ["plan"], ["roadmap"]]],
  ] as const)("%s re-read the plan, roadmap and programs", async (_name, refresh, expected) => {
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    await refresh(queryClient);
    expect(invalidate.mock.calls.map(([filters]) => filters?.queryKey)).toEqual(expected);
  });
});
