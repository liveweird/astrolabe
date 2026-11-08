import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CAPACITY_CONNECTION, capacityItem, capacityView } from "../test/flow";
import { jsonResponse } from "../test/http";
import { DEVIATIONS_POLL_MS, IDLE_REFRESH_MS, RUN_POLL_MAX_MS } from "../utils/syncRuns";
import { useCapacityDeviations } from "./useCapacityDeviations";

const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const URL_ = "/api/v1/views/capacity-deviations";

/** The connection as the server reports it while a refresh is going (the derived status carries the newest run). */
const running = (id = 9) => ({
  ...CAPACITY_CONNECTION,
  status: { ...CAPACITY_CONNECTION.status, lastRun: { id, startedAt: 1, finishedAt: null, outcome: null, errorCode: null, trigger: "MANUAL" as const, running: true } },
});

describe("useCapacityDeviations", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  const calls = () => mockFetch.mock.calls.filter(([url]) => (url as string).startsWith(URL_)).length;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;

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

  test("asks for the filter it was given, under the [flow, deviations] prefix", async () => {
    mockFetch.mockImplementation(() => Promise.resolve(jsonResponse(200, capacityView())));
    renderHook(() => useCapacityDeviations({ teamId: 3, severity: "WARNING" }), { wrapper });
    await advance(0);
    expect(mockFetch.mock.calls.at(-1)?.[0]).toBe(`${URL_}?teamId=3&severity=WARNING`);
    expect(client.getQueryCache().findAll({ queryKey: ["flow", "deviations"] })).toHaveLength(1);
    // No filter, no query string.
    renderHook(() => useCapacityDeviations({}), { wrapper });
    await advance(0);
    expect(mockFetch.mock.calls.at(-1)?.[0]).toBe(URL_);
  });

  test("follows a run the SERVER says is running, and the response that reports it finished carries the new data and ends the polling", async () => {
    let finished = false;
    mockFetch.mockImplementation(() => Promise.resolve(jsonResponse(200, finished ? capacityView({ items: [capacityItem({ deviations: [] })] }) : capacityView({ connections: [running()] }))));
    const { result } = renderHook(() => useCapacityDeviations({}), { wrapper });
    await advance(0);
    expect(calls()).toBe(1);
    await advance(DEVIATIONS_POLL_MS);
    expect(calls()).toBe(2);
    finished = true;
    await advance(DEVIATIONS_POLL_MS);
    await advance(50);
    expect(calls()).toBe(3);
    expect(result.current.data?.items[0].deviations).toEqual([]);
    await advance(DEVIATIONS_POLL_MS * 5);
    expect(calls()).toBe(3);
  });

  test("never polls when nothing is running, and stops RUN_POLL_MAX_MS after first seeing a run the server keeps calling running", async () => {
    mockFetch.mockImplementation(() => Promise.resolve(jsonResponse(200, capacityView())));
    const idle = renderHook(() => useCapacityDeviations({}), { wrapper });
    await advance(DEVIATIONS_POLL_MS * 4);
    expect(calls()).toBe(1);
    idle.unmount();

    client.clear();
    mockFetch.mockClear();
    mockFetch.mockImplementation(() => Promise.resolve(jsonResponse(200, capacityView({ connections: [running()] }))));
    renderHook(() => useCapacityDeviations({}), { wrapper });
    await advance(RUN_POLL_MAX_MS + DEVIATIONS_POLL_MS * 2);
    const settled = calls();
    await advance(DEVIATIONS_POLL_MS * 5);
    expect(calls()).toBe(settled);
  });

  test("the team page's slow idle re-read only when asked for, and a disabled query asks for nothing", async () => {
    mockFetch.mockImplementation(() => Promise.resolve(jsonResponse(200, capacityView())));
    const plain = renderHook(() => useCapacityDeviations({ teamId: 1 }), { wrapper });
    await advance(IDLE_REFRESH_MS * 3);
    expect(calls()).toBe(1);
    plain.unmount();

    client.clear();
    mockFetch.mockClear();
    const slow = renderHook(() => useCapacityDeviations({ teamId: 1 }, { idleRefresh: true }), { wrapper });
    await advance(0);
    await advance(IDLE_REFRESH_MS);
    expect(calls()).toBe(2);
    slow.unmount();

    client.clear();
    mockFetch.mockClear();
    const off = renderHook(({ enabled }) => useCapacityDeviations({ teamId: 1 }, { enabled }), { wrapper, initialProps: { enabled: false } });
    await advance(IDLE_REFRESH_MS);
    expect(mockFetch).not.toHaveBeenCalled();
    off.rerender({ enabled: true });
    await advance(0);
    expect(calls()).toBe(1);
  });
});
