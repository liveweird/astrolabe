import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useProposalRights } from "./useProposalRights";
import { jsonResponse } from "../test/http";
import { TEAMS_URL } from "../test/crossTeamRun";

let client: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  localStorage.setItem("astrolabe.auth.token", "fake-token");
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("useProposalRights", () => {
  test("reads the teams the caller may accept from the shared key: empty and not ready until they arrive, then their ids", async () => {
    const mockFetch = vi.fn((_url: string) => Promise.resolve(jsonResponse(200, { items: [{ id: 2, name: "Payments" }, { id: 5, name: "Search" }], truncated: false })));
    vi.stubGlobal("fetch", mockFetch);
    const { result } = renderHook(() => useProposalRights(), { wrapper });
    expect(result.current.ready).toBe(false);
    expect(result.current.acceptable.size).toBe(0);
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect([...result.current.acceptable]).toEqual([2, 5]);
    expect(result.current.error).toBeNull();
    expect(mockFetch.mock.calls.map(([url]) => url)).toEqual([TEAMS_URL]);
    expect(client.getQueryData(["schedule-proposals", "teams"])).toBeDefined();
  });

  test("a viewer who manages nothing gets an empty set that is ready", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonResponse(200, { items: [], truncated: false }))));
    const { result } = renderHook(() => useProposalRights(), { wrapper });
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.acceptable.size).toBe(0);
  });

  test("the set keeps its identity across renders, so a host's memo does not churn", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonResponse(200, { items: [{ id: 2, name: "Payments" }], truncated: false }))));
    const { result, rerender } = renderHook(() => useProposalRights(), { wrapper });
    await waitFor(() => expect(result.current.ready).toBe(true));
    const first = result.current.acceptable;
    rerender();
    expect(result.current.acceptable).toBe(first);
  });

  test("a FIRST load that fails degrades to a preview: ready, nothing acceptable, the error kept for the host's note", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonResponse(500, { title: "x", status: 500 }))));
    const { result } = renderHook(() => useProposalRights(), { wrapper });
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.ready).toBe(true);
    expect(result.current.acceptable.size).toBe(0);
  });

  test("a failed background refetch keeps the last list and stays ready", async () => {
    let answer: () => Response = () => jsonResponse(200, { items: [{ id: 2, name: "Payments" }], truncated: false });
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(answer())));
    const { result } = renderHook(() => useProposalRights(), { wrapper });
    await waitFor(() => expect(result.current.ready).toBe(true));
    answer = () => jsonResponse(500, { title: "x", status: 500 });
    await act(async () => {
      await client.refetchQueries({ queryKey: ["schedule-proposals", "teams"] });
    });
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.ready).toBe(true);
    expect([...result.current.acceptable]).toEqual([2]);
  });
});
