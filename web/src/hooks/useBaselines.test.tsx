import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BASELINES_LIST_KEY, useBaselines } from "./useBaselines";
import { jsonResponse } from "../test/http";

const ITEM = { id: 3, name: "Q1", description: null, planRevision: 7, createdAt: 1, createdBy: null, milestoneCount: 2, projectCount: 1 };

describe("useBaselines", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  const wrapper = (client: QueryClient) =>
    function Wrapper({ children }: { children: ReactNode }) {
      return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    };
  const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    localStorage.setItem("astrolabe.auth.token", "fake-token");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  test("answers the rows and the caller's right once loaded; until then nothing, and nobody manages", async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, { items: [ITEM], can: { manage: true } }));
    const { result } = renderHook(() => useBaselines(), { wrapper: wrapper(newClient()) });
    expect(result.current).toMatchObject({ items: [], can: { manage: false }, loading: true, failed: false, error: null });
    await waitFor(() => expect(result.current.items).toHaveLength(1));
    expect(result.current).toMatchObject({ can: { manage: true }, loading: false, failed: false, error: null });
  });

  test("a failed load answers no rows, failed: true and the error", async () => {
    mockFetch.mockResolvedValue(jsonResponse(500, { title: "x", status: 500 }));
    const { result } = renderHook(() => useBaselines(), { wrapper: wrapper(newClient()) });
    await waitFor(() => expect(result.current.failed).toBe(true));
    expect(result.current.items).toEqual([]);
    expect(result.current.error).not.toBeNull();
  });

  test("a failed refetch keeps the last copy and is not reported as failed (the error is still there)", async () => {
    const client = newClient();
    client.setQueryData(BASELINES_LIST_KEY, { items: [ITEM], can: { manage: false } });
    mockFetch.mockResolvedValue(jsonResponse(500, { title: "x", status: 500 }));
    const { result } = renderHook(() => useBaselines(), { wrapper: wrapper(client) });
    await client.invalidateQueries({ queryKey: ["baselines"] });
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.items).toHaveLength(1);
    expect(result.current.failed).toBe(false);
  });
});
