import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { jsonResponse } from "../test/http";
import { useTeamOptions } from "./useTeamOptions";

function clientAndWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, wrapper };
}

describe("useTeamOptions", () => {
  beforeEach(() => {
    localStorage.setItem("astrolabe.auth.token", "fake-token");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  test("is settled only after a successful read, and answers every team by name", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => gate.then(() => jsonResponse(200, { items: [{ id: 3, name: "Backend" }], page: 1, pageSize: 100, total: 1 }))),
    );
    const { wrapper } = clientAndWrapper();
    const { result } = renderHook(() => useTeamOptions(), { wrapper });
    expect(result.current).toEqual({ teams: [], settled: false, failed: false });
    release();
    await waitFor(() => expect(result.current.settled).toBe(true));
    expect(result.current.teams.map((team) => team.name)).toEqual(["Backend"]);
  });

  test("a failed read answers no team and is not settled", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonResponse(500, { title: "x", status: 500 }))));
    const { client, wrapper } = clientAndWrapper();
    const { result } = renderHook(() => useTeamOptions(), { wrapper });
    await waitFor(() => expect(client.getQueryState(["teams", "options"])?.status).toBe("error"));
    expect(result.current).toEqual({ teams: [], settled: false, failed: true });
  });
});
