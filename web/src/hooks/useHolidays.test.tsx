import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HOLIDAYS_QUERY_KEY, useHolidays } from "./useHolidays";
import { jsonResponse } from "../test/http";

describe("useHolidays", () => {
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

  test("answers the dictionary's rows once loaded, with nothing failed", async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, { items: [{ id: 1, date: "2027-01-06", name: "Epiphany" }] }));
    const { result } = renderHook(() => useHolidays(), { wrapper: wrapper(newClient()) });
    expect(result.current).toEqual({ holidays: [], failed: false });
    await waitFor(() => expect(result.current.holidays).toHaveLength(1));
    expect(result.current.failed).toBe(false);
  });

  test("a failed load answers no rows and failed: true, so a page can say the days off are not marked", async () => {
    mockFetch.mockResolvedValue(jsonResponse(500, { title: "x", status: 500 }));
    const { result } = renderHook(() => useHolidays(), { wrapper: wrapper(newClient()) });
    await waitFor(() => expect(result.current.failed).toBe(true));
    expect(result.current.holidays).toEqual([]);
  });

  test("a failed refetch keeps the last copy and is not reported as failed", async () => {
    const client = newClient();
    client.setQueryData(HOLIDAYS_QUERY_KEY, [{ id: 1, date: "2027-01-06", name: "Epiphany" }]);
    mockFetch.mockResolvedValue(jsonResponse(500, { title: "x", status: 500 }));
    const { result } = renderHook(() => useHolidays(), { wrapper: wrapper(client) });
    await client.invalidateQueries({ queryKey: HOLIDAYS_QUERY_KEY });
    expect(result.current.holidays).toHaveLength(1);
    expect(result.current.failed).toBe(false);
  });
});
