import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { jsonResponse } from "../test/http";
import { run } from "../test/jira";
import { IDLE_REFRESH_MS, RUN_POLL_MAX_MS, RUN_POLL_MS } from "../utils/syncRuns";
import { syncRunsKey, useSyncRuns } from "./useSyncRuns";

/** Advances the fake clock inside `act`, so the hook's state updates are flushed like in the browser. */
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

const RUNS_URL = "/api/v1/integrations/sync/runs?kind=JIRA&connectionId=1";

describe("useSyncRuns polling", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  const calls = () => mockFetch.mock.calls.filter(([url]) => url === RUNS_URL).length;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  /** A run the SERVER calls running: its start is whatever, this browser's clock has no say. */
  const live = (id = 7) => run({ id, outcome: null, finishedAt: null, startedAt: 1, running: true });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    client.clear();
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    localStorage.setItem("astrolabe.auth.token", "fake-token");
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  test("polls while the server says a run is running and stops by itself when it ends", async () => {
    let finished = false;
    mockFetch.mockImplementation(() => Promise.resolve(jsonResponse(200, { items: [finished ? run() : live()] })));
    const { result } = renderHook(() => useSyncRuns("JIRA", 1, true), { wrapper });
    await advance(0);
    expect(result.current.live).toBe(true);
    expect(calls()).toBe(1);
    await advance(RUN_POLL_MS);
    await advance(RUN_POLL_MS);
    expect(calls()).toBe(3);

    finished = true;
    await advance(RUN_POLL_MS);
    expect(calls()).toBe(4);
    // The answer needs a few more ticks to be parsed and published.
    await advance(50);
    expect(result.current.live).toBe(false);
    expect(result.current.runs?.[0].outcome).toBe("SUCCEEDED");
    await advance(RUN_POLL_MS * 5);
    expect(calls()).toBe(4);
  });

  test("never polls when nothing is running", async () => {
    mockFetch.mockImplementation(() => Promise.resolve(jsonResponse(200, { items: [run()] })));
    renderHook(() => useSyncRuns("JIRA", 1, true), { wrapper });
    await advance(RUN_POLL_MS * 4);
    expect(calls()).toBe(1);
  });

  test("an unfinished run the server calls interrupted (running: false) is not polled, however recent it looks here", async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve(jsonResponse(200, { items: [run({ outcome: null, finishedAt: null, startedAt: Date.now(), running: false })] })),
    );
    const { result } = renderHook(() => useSyncRuns("JIRA", 1, true), { wrapper });
    await advance(RUN_POLL_MS * 4);
    expect(calls()).toBe(1);
    expect(result.current.live).toBe(false);
  });

  test("stops when the page unmounts", async () => {
    mockFetch.mockImplementation(() => Promise.resolve(jsonResponse(200, { items: [live()] })));
    const { unmount } = renderHook(() => useSyncRuns("JIRA", 1, true), { wrapper });
    await advance(RUN_POLL_MS);
    const before = calls();
    expect(before).toBeGreaterThanOrEqual(2);
    unmount();
    await advance(RUN_POLL_MS * 5);
    expect(calls()).toBe(before);
  });

  test("a run the server keeps calling running does not poll for ever: the safety net stops the poll", async () => {
    mockFetch.mockImplementation(() => Promise.resolve(jsonResponse(200, { items: [live()] })));
    renderHook(() => useSyncRuns("JIRA", 1, true), { wrapper });
    await advance(RUN_POLL_MAX_MS + 2 * RUN_POLL_MS);
    const stopped = calls();
    expect(stopped).toBeLessThanOrEqual(RUN_POLL_MAX_MS / RUN_POLL_MS + 3);
    await advance(RUN_POLL_MAX_MS);
    expect(calls()).toBe(stopped);
  });

  test("with an idle period the list is also re-read when nothing is running (a scheduled run starts on its own), at the slow period", async () => {
    let items = [run()];
    mockFetch.mockImplementation(() => Promise.resolve(jsonResponse(200, { items })));
    const { result } = renderHook(() => useSyncRuns("JIRA", 1, true, IDLE_REFRESH_MS), { wrapper });
    await advance(0);
    expect(calls()).toBe(1);
    await advance(IDLE_REFRESH_MS - 1);
    expect(calls()).toBe(1);
    // The scheduler started a run meanwhile: the next idle read finds it and the fast poll takes over.
    items = [live(8), ...items];
    await advance(1);
    await advance(50);
    expect(calls()).toBe(2);
    expect(result.current.live).toBe(true);
    await advance(RUN_POLL_MS);
    expect(calls()).toBe(3);
  });

  test("after the safety net stopped the fast poll the idle period still follows the server, so a run it stops calling running frees the page", async () => {
    let current = live();
    mockFetch.mockImplementation(() => Promise.resolve(jsonResponse(200, { items: [current] })));
    const { result } = renderHook(() => useSyncRuns("JIRA", 1, true, IDLE_REFRESH_MS), { wrapper });
    await advance(RUN_POLL_MAX_MS + 2 * RUN_POLL_MS);
    expect(result.current.live).toBe(true);
    const stopped = calls();
    // The fast poll is over; one idle period later the list is read again, and the server no longer says running.
    current = run({ id: 7, outcome: "ABANDONED", running: false });
    await advance(IDLE_REFRESH_MS + 50);
    expect(calls()).toBeGreaterThan(stopped);
    expect(result.current.live).toBe(false);
  });

  test("a NEW claim after the bound polls again: the safety net is latched on the newest running run's id", async () => {
    let current = live(7);
    mockFetch.mockImplementation(() => Promise.resolve(jsonResponse(200, { items: [current] })));
    const { result } = renderHook(() => useSyncRuns("JIRA", 1, true), { wrapper });
    await advance(RUN_POLL_MAX_MS + 2 * RUN_POLL_MS);
    const stopped = calls();
    await advance(RUN_POLL_MS * 5);
    expect(calls()).toBe(stopped);

    // Refresh now claims run 8: the page re-reads once (the connection section's invalidation) and the poll starts over.
    current = live(8);
    await act(async () => { await client.invalidateQueries({ queryKey: ["jira", "runs", "JIRA", 1] }); });
    await advance(0);
    const afterClaim = calls();
    expect(afterClaim).toBe(stopped + 1);
    await advance(RUN_POLL_MS * 3);
    expect(calls()).toBeGreaterThanOrEqual(afterClaim + 3);
    expect(result.current.runs?.[0].id).toBe(8);
  });

  test("a Flow connection's runs are read with kind=FLOW and cached under the Flow prefix, so a Flow write never refreshes Jira's runs", async () => {
    mockFetch.mockImplementation(() => Promise.resolve(jsonResponse(200, { items: [run({ kind: "FLOW" })] })));
    const { result } = renderHook(() => useSyncRuns("FLOW", 3, true), { wrapper });
    await advance(0);
    expect(mockFetch.mock.calls.some(([url]) => url === "/api/v1/integrations/sync/runs?kind=FLOW&connectionId=3")).toBe(true);
    expect(result.current.runs).toHaveLength(1);
    expect(syncRunsKey("FLOW", 3)).toEqual(["flow", "runs", "FLOW", 3]);
    expect(syncRunsKey("JIRA", 3)).toEqual(["jira", "runs", "JIRA", 3]);
  });
});
