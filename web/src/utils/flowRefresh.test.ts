import { describe, expect, test, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { refreshFlowLinks } from "./flowRefresh";

describe("refreshFlowLinks", () => {
  test("re-reads the connection pages' team lists, the team pages' Flow panels and the capacity deviations - nothing of the timeline views", async () => {
    const queryClient = new QueryClient();
    const keys = [
      ["flow", "teams", 1],
      ["flow", "team", 3],
      ["flow", "deviations", "view", { teamId: 3 }],
      ["plan", "team", 3],
      ["flow", "list", 1],
    ];
    for (const key of keys) queryClient.setQueryData(key, { stale: false });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    await refreshFlowLinks(queryClient);
    expect(invalidate.mock.calls.map(([filters]) => filters?.queryKey)).toEqual([["flow", "teams"], ["flow", "team"], ["flow", "deviations"]]);
    expect(keys.map((key) => queryClient.getQueryState(key)?.isInvalidated)).toEqual([true, true, true, false, false]);
  });
});
