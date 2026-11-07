import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DEV_CONNECTION, item, view } from "../test/deviations";
import { jsonResponse } from "../test/http";
import { DEVIATIONS_POLL_MS, RUN_POLL_MAX_MS } from "../utils/syncRuns";
import { useDeviations, useJiraLinks } from "./useDeviations";

const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const URL_ = "/api/v1/views/deviations";

const running = (id = 9) => ({ ...DEV_CONNECTION, lastRun: { id, startedAt: 1, finishedAt: null, outcome: null, errorCode: null, trigger: "MANUAL" as const, running: true } });

describe("useDeviations", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  const chipCalls = () => mockFetch.mock.calls.filter(([url]) => (url as string).startsWith(`${URL_}?projectId=7`)).length;
  const calls = () => mockFetch.mock.calls.filter(([url]) => url === URL_).length;
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

  test("follows a run the SERVER says is running, and the response that reports it finished carries the new data and ends the polling", async () => {
    let finished = false;
    mockFetch.mockImplementation(() => Promise.resolve(jsonResponse(200, finished ? view({ items: [item({ deviations: [] })] }) : view({ connections: [running()] }))));
    const { result } = renderHook(() => useDeviations({}), { wrapper });
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
    mockFetch.mockImplementation(() => Promise.resolve(jsonResponse(200, view())));
    const idle = renderHook(() => useDeviations({}), { wrapper });
    await advance(DEVIATIONS_POLL_MS * 4);
    expect(calls()).toBe(1);
    idle.unmount();

    client.clear();
    mockFetch.mockClear();
    mockFetch.mockImplementation(() => Promise.resolve(jsonResponse(200, view({ connections: [running()] }))));
    renderHook(() => useDeviations({}), { wrapper });
    await advance(RUN_POLL_MAX_MS + DEVIATIONS_POLL_MS * 2);
    const settled = calls();
    await advance(DEVIATIONS_POLL_MS * 5);
    expect(calls()).toBe(settled);
  });

  test("polls every 10 s while a run is running, not every 3 s", async () => {
    mockFetch.mockImplementation(() => Promise.resolve(jsonResponse(200, view({ connections: [running()] }))));
    renderHook(() => useDeviations({}), { wrapper });
    await advance(0);
    await advance(DEVIATIONS_POLL_MS - 1000);
    expect(calls()).toBe(1);
    await advance(1000);
    expect(calls()).toBe(2);
    expect(DEVIATIONS_POLL_MS).toBe(10_000);
  });

  test("the bind dialog's connections are asked for the project, only while enabled, and answered as connections[]", async () => {
    mockFetch.mockImplementation(() => Promise.resolve(jsonResponse(200, view({ items: [item()] }))));
    const links = renderHook(({ enabled }) => useJiraLinks(7, enabled), { wrapper, initialProps: { enabled: false } });
    await advance(0);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(links.result.current).toMatchObject({ connections: null, failed: false });
    links.rerender({ enabled: true });
    await advance(0);
    expect(mockFetch.mock.calls.at(-1)?.[0]).toBe(`${URL_}?projectId=7`);
    expect(links.result.current.connections).toEqual([DEV_CONNECTION]);
    expect(chipCalls()).toBe(1);
  });

  test("a malformed id is never asked, and a failed answer is reported as failed with a retry", async () => {
    mockFetch.mockImplementation(() => Promise.resolve(jsonResponse(500, { title: "x", status: 500 })));
    renderHook(() => useJiraLinks(Number.NaN, true), { wrapper });
    await advance(0);
    expect(mockFetch).not.toHaveBeenCalled();
    const failing = renderHook(() => useJiraLinks(7, true), { wrapper });
    await advance(0);
    expect(failing.result.current).toMatchObject({ connections: null, failed: true });
    failing.result.current.retry();
    await advance(0);
    expect(chipCalls()).toBe(2);
  });
});
