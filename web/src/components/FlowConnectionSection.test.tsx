import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { QueryClient } from "@tanstack/react-query";
import { act, renderWithProviders, screen, waitFor, within } from "../test/render";
import { jsonResponse } from "../test/http";
import { headingOutline } from "../test/headings";
import { CONNECTION, PASSING_TEST, REVOKED_TEST, run } from "../test/flow";
import type { FlowConnection, FlowTestResult } from "../api/flow";
import type { SyncRun } from "../api/sync";
import { IDLE_REFRESH_MS, RUN_POLL_MS } from "../utils/syncRuns";
import FlowConnectionSection from "./FlowConnectionSection";

const TOKEN_KEY = "astrolabe.auth.token";
const RUNS = "/api/v1/integrations/sync/runs";
type FetchMock = ReturnType<typeof vi.fn>;

type World = { connection: FlowConnection; runs: SyncRun[]; claim: () => Response; test: () => Response };

function serve(mockFetch: FetchMock, overrides: Partial<World> = {}) {
  const world: World = {
    connection: CONNECTION,
    runs: [],
    claim: () => jsonResponse(202, run({ id: 8, outcome: null, finishedAt: null, startedAt: Date.now(), running: true })),
    test: () => jsonResponse(200, PASSING_TEST),
    ...overrides,
  };
  mockFetch.mockImplementation((url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url === "/api/v1/integrations/flow/connections/1" && method === "GET") return Promise.resolve(jsonResponse(200, world.connection));
    if (url === "/api/v1/integrations/flow/connections/1/test" && method === "POST") return Promise.resolve(world.test());
    if (url.startsWith(`${RUNS}?`) && method === "GET") return Promise.resolve(jsonResponse(200, { items: world.runs }));
    if (url === RUNS && method === "POST") {
      const response = world.claim();
      if (response.status === 202) world.runs = [run({ id: 8, outcome: null, finishedAt: null, startedAt: Date.now(), running: true }), ...world.runs];
      return Promise.resolve(response);
    }
    return Promise.resolve(jsonResponse(404, { title: "x", status: 404 }));
  });
  return world;
}

/** Advances the fake clock inside `act`, so the hooks' state updates are flushed like in the browser. */
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

describe("FlowConnectionSection", () => {
  let mockFetch: FetchMock;
  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    localStorage.setItem(TOKEN_KEY, "fake-token");
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  function renderSection(connection: FlowConnection = CONNECTION, queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
    return renderWithProviders(<FlowConnectionSection connection={connection} readAt={Date.now()} />, { queryClient });
  }

  /** The query keys the section invalidated: the page (which owns the connection and the registry) re-reads exactly these. */
  function invalidated(queryClient: QueryClient) {
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    return () => spy.mock.calls.map(([filters]) => filters?.queryKey);
  }

  test("the facts never show the token, only that one is stored; the runs table follows", async () => {
    serve(mockFetch, { runs: [run()] });
    renderSection();
    const facts = await screen.findByRole("table", { name: "Connection facts" });
    expect(headingOutline()).toEqual([
      [3, "Connection"],
      [4, "Recent runs"],
    ]);
    const base = within(facts).getByRole("link", { name: "https://flow.acme.example" });
    expect(base).toHaveAttribute("href", "https://flow.acme.example");
    expect(base.getAttribute("rel")).toContain("noopener");
    expect(within(facts).getByText("Europe/Warsaw")).toBeInTheDocument();
    expect(within(facts).getByText("A token is stored")).toBeInTheDocument();
    expect(within(facts).getByText("Passed")).toBeInTheDocument();
    expect(within(facts).getByRole("rowheader", { name: "Polling" }).closest("tr")).toHaveTextContent("every 60 min");
    expect(within(facts).getByRole("rowheader", { name: "Teams observed (UTC)" }).closest("tr")).toHaveTextContent("2026-11-08 09:40");
    const runs = await screen.findByRole("table", { name: "Recent runs" });
    expect(within(runs).getByRole("columnheader", { name: "Teams" })).toBeInTheDocument();
    expect(await within(runs).findByText("Succeeded")).toBeInTheDocument();
  });

  test("an address that is not http(s) is plain text, never a link; no token and no run read honestly", async () => {
    serve(mockFetch);
    renderSection({ ...CONNECTION, baseUrl: "flow.internal", hasApiToken: false, enabled: false, lastTestedAt: null, lastTestOk: null, teamsAt: null });
    const facts = await screen.findByRole("table", { name: "Connection facts" });
    expect(within(facts).queryByRole("link")).not.toBeInTheDocument();
    expect(within(facts).getByText("flow.internal")).toBeInTheDocument();
    expect(within(facts).getByText("No token is stored")).toBeInTheDocument();
    expect(within(facts).getByText("Never tested")).toBeInTheDocument();
    expect(within(facts).getByText("No")).toBeInTheDocument();
  });

  test("after an edit cleared the verdict of a connection that had already been read, the facts say it was not tested since the change", async () => {
    serve(mockFetch);
    renderSection({ ...CONNECTION, lastTestedAt: null, lastTestOk: null });
    expect(await screen.findByText("Not tested since the connection was last changed")).toBeInTheDocument();
  });

  test("Test connection runs the stored probe and lists the rows with the document's size; a revoked token reads in Flow's words", async () => {
    const world = serve(mockFetch);
    const user = userEvent.setup();
    renderSection();
    await user.click(await screen.findByRole("button", { name: "Test connection" }));
    const table = await screen.findByRole("table", { name: "Connection test results" });
    expect(within(table).getAllByText("OK")).toHaveLength(2);
    expect(screen.getByRole("heading", { level: 4, name: "Test result" })).toBeInTheDocument();
    expect(screen.getByText("Flow's document · teams: 18 · sprints: 640")).toBeInTheDocument();
    expect(screen.getByText("Test passed. OK: 2 of 2.").closest('[role="status"]')).toHaveAttribute("aria-live", "polite");

    world.test = () => jsonResponse(200, REVOKED_TEST);
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByText(/Flow rejected the token: it was revoked or expired - issue a new one in Flow and update the connection \(AUTHENTICATION_FAILED\)/)).toBeInTheDocument();
    expect(screen.getByText("Test failed. Required probes that failed: 1 of 2.")).toBeInTheDocument();
    expect(screen.queryByText(/Flow's document:/)).not.toBeInTheDocument();
  });

  test("a test whose result was not recorded says to test again; a 429 reads in words and takes the old result away", async () => {
    const world = serve(mockFetch, { test: () => jsonResponse(200, { ...PASSING_TEST, recorded: false } satisfies FlowTestResult) });
    const user = userEvent.setup();
    renderSection();
    await user.click(await screen.findByRole("button", { name: "Test connection" }));
    expect(await screen.findByText(/this result was not recorded/)).toBeInTheDocument();
    world.test = () => jsonResponse(429, { title: "Too Many Requests", status: 429 });
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Too many tests in a minute");
    expect(screen.queryByRole("table", { name: "Connection test results" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Test passed/)).not.toBeInTheDocument();
  });

  test("a stored test re-reads the connection and the registry, so the verdict and 'ready' move", async () => {
    serve(mockFetch);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const keys = invalidated(queryClient);
    const user = userEvent.setup();
    renderSection(CONNECTION, queryClient);
    await user.click(await screen.findByRole("button", { name: "Test connection" }));
    await screen.findByRole("table", { name: "Connection test results" });
    expect(keys()).toEqual(expect.arrayContaining([["flow", "connection", 1], ["flow", "list"]]));
    // A test writes no mirror: the Teams section is not refreshed by it.
    expect(keys()).not.toContainEqual(["flow", "teams", 1]);
  });

  test("Refresh now claims a FLOW run (202), says it is running and shows the new row, with no error", async () => {
    const world = serve(mockFetch);
    const user = userEvent.setup();
    renderSection();
    await user.click(await screen.findByRole("button", { name: "Refresh now" }));
    await waitFor(() => expect(mockFetch.mock.calls.some(([url, init]) => url === RUNS && (init as RequestInit).method === "POST")).toBe(true));
    const post = mockFetch.mock.calls.find(([url, init]) => url === RUNS && (init as RequestInit).method === "POST")!;
    expect(JSON.parse((post[1] as RequestInit).body as string)).toEqual({ kind: "FLOW", connectionId: 1 });
    expect(await screen.findByText(/A refresh is running/)).toBeInTheDocument();
    expect(within(screen.getByRole("table", { name: "Recent runs" })).getByText("Running")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(world.runs).toHaveLength(1);
    expect(mockFetch.mock.calls.some(([url]) => url === `${RUNS}?kind=FLOW&connectionId=1`)).toBe(true);
  });

  test("a 409 run-in-progress is a normal state: told as a note, never an error", async () => {
    const world = serve(mockFetch, {
      claim: () => {
        world.runs = [run({ id: 5, trigger: "SCHEDULED", requestedByUserId: null, outcome: null, finishedAt: null, startedAt: Date.now() - 5_000, running: true })];
        return jsonResponse(409, { title: "Conflict", status: 409, type: "urn:astrolabe:problem:run-in-progress" });
      },
    });
    const user = userEvent.setup();
    renderSection();
    await user.click(await screen.findByRole("button", { name: "Refresh now" }));
    expect(await screen.findByText(/A refresh is already running for this connection/)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(await within(screen.getByRole("table", { name: "Recent runs" })).findByText("Scheduled")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh now" })).toBeDisabled();
  });

  test("a refresh the server refuses reads in words (400: disabled or gone)", async () => {
    serve(mockFetch, { claim: () => jsonResponse(400, { title: "Bad Request", status: 400 }) });
    const user = userEvent.setup();
    renderSection();
    await user.click(await screen.findByRole("button", { name: "Refresh now" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This connection cannot be refreshed (it is disabled or gone)");
  });

  test("a refresh past the per-user bucket (429) reads in words, not as a bare status", async () => {
    serve(mockFetch, { claim: () => jsonResponse(429, { title: "Too Many Requests", status: 429 }) });
    const user = userEvent.setup();
    renderSection();
    await user.click(await screen.findByRole("button", { name: "Refresh now" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Too many requests. Wait a minute and try again.");
  });

  test("Refresh now is disabled while a run is running (the polled list's verdict) and comes back when it ends", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const world = serve(mockFetch, { runs: [run({ id: 5, outcome: null, finishedAt: null, running: true })] });
    renderSection();
    const button = await screen.findByRole("button", { name: "Refresh now" });
    await waitFor(() => expect(button).toBeDisabled());
    world.runs = [run({ id: 5, outcome: "SUCCEEDED", running: false })];
    // The poll (RUN_POLL_MS) reads the list again and the server no longer says running.
    await advance(RUN_POLL_MS + 100);
    await waitFor(() => expect(button).toBeEnabled());
  });

  test("a disabled connection cannot be refreshed, and says why", async () => {
    serve(mockFetch);
    renderSection({ ...CONNECTION, enabled: false });
    expect(await screen.findByRole("button", { name: "Refresh now" })).toBeDisabled();
    expect(screen.getByText("The connection is disabled.")).toBeInTheDocument();
  });

  test("a failed run reads its typed error in Flow's words; an unfinished one the server does not call running is interrupted", async () => {
    serve(mockFetch, {
      runs: [
        run({ id: 9, outcome: "FAILED", errorCode: "UPSTREAM_UNAVAILABLE", errorDetail: "Flow answered 500", observedCount: 0, goneCount: 0 }),
        run({ id: 8, outcome: null, finishedAt: null, running: false }),
        run({ id: 7, outcome: "FAILED", errorCode: "TIME_ZONE_INVALID" }),
      ],
    });
    renderSection();
    const runs = await screen.findByRole("table", { name: "Recent runs" });
    expect(await within(runs).findByText("Flow is unavailable (UPSTREAM_UNAVAILABLE)")).toBeInTheDocument();
    expect(within(runs).getByText("Flow answered 500")).toBeInTheDocument();
    expect(within(runs).getByText("Interrupted")).toBeInTheDocument();
    expect(within(runs).getByText("No result was recorded and nothing is running it now.")).toBeInTheDocument();
    expect(within(runs).getByText(/The connection's time zone is not known to this server; correct it \(TIME_ZONE_INVALID\)/)).toBeInTheDocument();
  });

  test("the sync facts: the state with its next poll, the last success (dated and aged) and the interval; manual only says so", async () => {
    const NOW = Date.UTC(2026, 10, 8, 11, 0);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    serve(mockFetch);
    const lastRun = { id: 7, startedAt: NOW - 3 * 60_000, finishedAt: NOW - 2 * 60_000, outcome: "SUCCEEDED" as const, errorCode: null, trigger: "SCHEDULED" as const, running: false };
    const current: FlowConnection = { ...CONNECTION, lastRun, status: { state: "CURRENT", lastRun, lastSucceededAt: lastRun.startedAt, consecutiveFailures: 0, nextPollAt: NOW + 57 * 60_000 } };
    const { unmount } = renderSection(current);
    const facts = await screen.findByRole("table", { name: "Connection facts" });
    const row = (name: string) => within(facts).getByRole("rowheader", { name }).closest("tr")!;
    expect(row("Status")).toHaveTextContent("Currentnext poll in 57 min");
    expect(row("Last success (UTC)")).toHaveTextContent("2026-11-08 10:57");
    expect(row("Last success (UTC)")).toHaveTextContent("ago");
    expect(row("Next poll (UTC)")).toHaveTextContent("2026-11-08 11:57");
    unmount();
    renderSection({ ...current, pollIntervalMinutes: null, status: { ...current.status, nextPollAt: null } });
    const manual = await screen.findByRole("table", { name: "Connection facts" });
    expect(within(manual).getByRole("rowheader", { name: "Polling" }).closest("tr")).toHaveTextContent("Manual only");
    expect(within(manual).getByRole("rowheader", { name: "Status" }).closest("tr")).toHaveTextContent("Currentmanual only");
  });

  test("a failing connection counts its streak with the code; an untested one says to test first", async () => {
    const failed = { id: 7, startedAt: 5, finishedAt: 6, outcome: "FAILED" as const, errorCode: "AUTHENTICATION_FAILED", trigger: "SCHEDULED" as const, running: false };
    serve(mockFetch);
    const { unmount } = renderSection({ ...CONNECTION, status: { state: "FAILED", lastRun: failed, lastSucceededAt: null, consecutiveFailures: 3, nextPollAt: null } });
    const facts = await screen.findByRole("table", { name: "Connection facts" });
    expect(within(facts).getByRole("rowheader", { name: "Status" }).closest("tr")).toHaveTextContent("Failed3 failures in a row · AUTHENTICATION_FAILED");
    unmount();
    renderSection({ ...CONNECTION, lastTestOk: null, teamsAt: null, lastTestedAt: null });
    const untested = await screen.findByRole("table", { name: "Connection facts" });
    expect(within(untested).getByRole("rowheader", { name: "Status" }).closest("tr")).toHaveTextContent("Never syncednot polled: test the connection first");
  });

  describe("an open page follows the server without a reload", () => {
    test("a scheduled run that started and finished while the page was open reaches the runs table at the next slow refresh", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const world = serve(mockFetch);
      renderSection();
      await screen.findByRole("table", { name: "Recent runs" });
      expect(within(screen.getByRole("table", { name: "Recent runs" })).queryByText("Scheduled")).not.toBeInTheDocument();
      world.runs = [run({ id: 7, trigger: "SCHEDULED", requestedByUserId: null })];
      await advance(IDLE_REFRESH_MS + 100);
      expect(await within(screen.getByRole("table", { name: "Recent runs" })).findByText("Scheduled")).toBeInTheDocument();
    });

    test("when the run that was going ends the connection, the registry and the mirrored teams are read again", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const world = serve(mockFetch, { runs: [run({ id: 5, outcome: null, finishedAt: null, running: true })] });
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const keys = invalidated(queryClient);
      renderSection(CONNECTION, queryClient);
      await waitFor(() => expect(screen.getByRole("button", { name: "Refresh now" })).toBeDisabled());
      expect(keys()).not.toContainEqual(["flow", "teams", 1]);
      world.runs = [run({ id: 5, outcome: "SUCCEEDED", running: false })];
      await advance(RUN_POLL_MS + 100);
      await waitFor(() => expect(screen.getByRole("button", { name: "Refresh now" })).toBeEnabled());
      await waitFor(() => expect(keys()).toEqual(expect.arrayContaining([["flow", "connection", 1], ["flow", "list"], ["flow", "teams", 1]])));
    });
  });
});
