import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { Route, Routes, useLocation } from "react-router-dom";
import { act, renderWithProviders, screen, waitFor, within } from "../test/render";
import { jsonResponse } from "../test/http";
import { headingOutline } from "../test/headings";
import { CONNECTION } from "../test/jira";
import { IDLE_REFRESH_MS } from "../utils/syncRuns";
import JiraConnections from "./JiraConnections";

const TOKEN_KEY = "astrolabe.auth.token";
const ROLES_KEY = "astrolabe.auth.roles";
type FetchMock = ReturnType<typeof vi.fn>;

const LAST_RUN = { id: 7, startedAt: Date.UTC(2026, 10, 6, 10, 0), finishedAt: Date.UTC(2026, 10, 6, 10, 1), outcome: "SUCCEEDED" as const, errorCode: null, trigger: "MANUAL" as const, running: false };

const PAGE = {
  items: [
    { ...CONNECTION, lastRun: LAST_RUN },
    { ...CONNECTION, id: 2, name: "Beta Jira", siteUrl: "https://beta.atlassian.net", projectKeys: ["BETA"], enabled: false, lastTestedAt: null, lastTestOk: null, discoveredAt: null },
    // An edit cleared the verdict of a connection that had been discovered: it reads as changed, not as never tested.
    { ...CONNECTION, id: 3, name: "Gamma Jira", lastTestedAt: null, lastTestOk: null, lastRun: { ...LAST_RUN, id: 9, outcome: null, finishedAt: null, running: false } },
  ],
  page: 1,
  pageSize: 20,
  total: 3,
};

function serve(mockFetch: FetchMock, mutations: Record<string, { status: number; body?: unknown }> = {}, links = 3) {
  mockFetch.mockImplementation((url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const mutation = mutations[`${method} ${url}`];
    if (mutation) return Promise.resolve(mutation.body === undefined ? new Response(null, { status: mutation.status }) : jsonResponse(mutation.status, mutation.body));
    if (method === "GET" && url.startsWith("/api/v1/integrations/jira/connections?")) return Promise.resolve(jsonResponse(200, PAGE));
    if (method === "GET" && url.startsWith("/api/v1/integrations/jira/bindings?")) return Promise.resolve(jsonResponse(200, { items: [], page: 1, pageSize: 1, total: links }));
    return Promise.resolve(jsonResponse(404, { title: "x", status: 404 }));
  });
}

function call(mockFetch: FetchMock, method: string, url: string) {
  return mockFetch.mock.calls.find(([u, init]) => u === url && ((init as RequestInit | undefined)?.method ?? "GET") === method);
}

function Probe() {
  const { pathname } = useLocation();
  return <p>at {pathname}</p>;
}

function renderPage() {
  return renderWithProviders(
    <Routes>
      <Route path="/integrations/jira" element={<JiraConnections />} />
      <Route path="/integrations/jira/:id" element={<Probe />} />
    </Routes>,
    { route: "/integrations/jira" },
  );
}

describe("Jira connections page", () => {
  let mockFetch: FetchMock;
  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    localStorage.setItem(TOKEN_KEY, "fake-token");
    localStorage.setItem(ROLES_KEY, JSON.stringify(["ADMIN"]));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  test("lists the connections: the name opens the page, the site, keys, last test and last run are told", async () => {
    serve(mockFetch);
    renderPage();
    const link = await screen.findByRole("link", { name: "Open connection Acme Jira" });
    expect(link).toHaveAttribute("href", "/integrations/jira/1");
    const table = screen.getByRole("table", { name: "Jira connections" });
    const row = link.closest("tr")!;
    // The run column reads the connection's own lastRun - there is no read of the runs across connections any more.
    expect(mockFetch.mock.calls.some(([url]) => String(url).startsWith("/api/v1/integrations/sync/runs"))).toBe(false);
    const site = within(row).getByRole("link", { name: /acme\.atlassian\.net/ });
    expect(site).toHaveAttribute("href", "https://acme.atlassian.net");
    expect(site.getAttribute("rel")).toContain("noopener");
    expect(within(row).getByText("E2E, PF")).toBeInTheDocument();
    expect(within(row).getByText("Passed")).toBeInTheDocument();
    expect(within(row).getByText("Succeeded")).toBeInTheDocument();
    const other = within(table).getByText("Beta Jira").closest("tr")!;
    expect(within(other).getByText("Disabled")).toBeInTheDocument();
    expect(within(other).getByText("Never tested")).toBeInTheDocument();
    expect(within(other).getByText("—")).toBeInTheDocument();
    const interrupted = within(table).getByText("Gamma Jira").closest("tr")!;
    expect(within(interrupted).getByText("Not tested since the connection was last changed")).toBeInTheDocument();
    // Unfinished and not running by the SERVER's verdict: interrupted.
    expect(within(interrupted).getByText("Interrupted")).toBeInTheDocument();
    expect(headingOutline()).toEqual([[2, "Jira connections"]]);
  });

  test("the Status column tells each connection's derived state with its secondary line", async () => {
    const NOW = Date.UTC(2026, 10, 6, 11, 0);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    try {
      const failed = { ...LAST_RUN, outcome: "FAILED" as const, errorCode: "TOKEN_UNREADABLE", trigger: "SCHEDULED" as const };
      const items = [
        { ...CONNECTION, lastRun: LAST_RUN, status: { state: "CURRENT" as const, lastRun: LAST_RUN, lastSucceededAt: LAST_RUN.startedAt, consecutiveFailures: 0, nextPollAt: NOW + 7 * 60_000 - 5_000 } },
        { ...CONNECTION, id: 2, name: "Beta Jira", enabled: false, status: { ...CONNECTION.status, state: "DISABLED" as const } },
        { ...CONNECTION, id: 3, name: "Gamma Jira", lastRun: failed, status: { state: "FAILED" as const, lastRun: failed, lastSucceededAt: null, consecutiveFailures: 3, nextPollAt: NOW + 60 * 60_000 } },
        { ...CONNECTION, id: 4, name: "Delta Jira", pollIntervalMinutes: null, status: { ...CONNECTION.status, state: "CURRENT" as const, lastSucceededAt: 1 } },
        { ...CONNECTION, id: 5, name: "Echo Jira", discoveredAt: null, status: { ...CONNECTION.status, state: "NEVER_SYNCED" as const } },
        { ...CONNECTION, id: 6, name: "Foxtrot Jira", status: { state: "STALE" as const, lastRun: LAST_RUN, lastSucceededAt: 1, consecutiveFailures: 0, nextPollAt: NOW - 1_000 } },
      ];
      mockFetch.mockImplementation((url: string) =>
        Promise.resolve(url.startsWith("/api/v1/integrations/jira/connections?") ? jsonResponse(200, { items, page: 1, pageSize: 20, total: items.length }) : jsonResponse(404, { title: "x", status: 404 })),
      );
      renderPage();
      await screen.findByRole("link", { name: "Open connection Acme Jira" });
      const table = screen.getByRole("table", { name: "Jira connections" });
      expect(within(table).getByRole("columnheader", { name: "Status" })).toBeInTheDocument();
      const row = (name: string) => within(table).getByText(name).closest("tr")!;
      expect(row("Acme Jira")).toHaveTextContent("Currentnext poll in 7 min");
      expect(row("Beta Jira")).toHaveTextContent("Disabled");
      expect(row("Gamma Jira")).toHaveTextContent("Failed3 failures in a row · TOKEN_UNREADABLE");
      expect(row("Delta Jira")).toHaveTextContent("Currentmanual only");
      expect(row("Echo Jira")).toHaveTextContent("Never syncednot polled: test the connection first");
      expect(row("Foxtrot Jira")).toHaveTextContent("Staledue now");
    } finally {
      vi.useRealTimers();
    }
  });

  test("an open list re-reads slowly: a connection the scheduler polled meanwhile shows its new status without a reload", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let status: (typeof CONNECTION)["status"] = { ...CONNECTION.status };
      mockFetch.mockImplementation((url: string) =>
        Promise.resolve(url.startsWith("/api/v1/integrations/jira/connections?") ? jsonResponse(200, { items: [{ ...CONNECTION, status }], page: 1, pageSize: 20, total: 1 }) : jsonResponse(404, { title: "x", status: 404 })),
      );
      renderPage();
      const row = (await screen.findByRole("link", { name: "Open connection Acme Jira" })).closest("tr")!;
      expect(row).toHaveTextContent("Never synced");
      status = { state: "CURRENT", lastRun: null, lastSucceededAt: 1, consecutiveFailures: 0, nextPollAt: null };
      await act(async () => { await vi.advanceTimersByTimeAsync(IDLE_REFRESH_MS + 100); });
      await waitFor(() => expect(screen.getByRole("link", { name: "Open connection Acme Jira" }).closest("tr")).toHaveTextContent("Current"));
    } finally {
      vi.useRealTimers();
    }
  });

  test("the empty state spans every column", async () => {
    serve(mockFetch);
    mockFetch.mockImplementation(() =>
      Promise.resolve(jsonResponse(200, { ...PAGE, items: [], total: 0 })),
    );
    renderPage();
    const empty = await screen.findByText("No Jira connections yet");
    expect(empty.closest("td")).toHaveAttribute("colspan", String(screen.getAllByRole("columnheader").length));
  });

  test("a failed load shows the alert", async () => {
    mockFetch.mockResolvedValue(jsonResponse(500, { title: "x", status: 500 }));
    renderPage();
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load the Jira connections");
  });

  test("create: the modal POSTs and the new connection's page opens", async () => {
    serve(mockFetch, { "POST /api/v1/integrations/jira/connections": { status: 201, body: { ...CONNECTION, id: 9 } } });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: /new connection/i }));
    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByLabelText("Name"), "Acme Jira 2");
    await user.type(within(dialog).getByLabelText("Site"), "https://acme2.atlassian.net");
    await user.type(within(dialog).getByLabelText("Account email"), "robot@acme.example");
    await user.type(within(dialog).getByLabelText("API token"), "tok");
    await user.type(within(dialog).getByRole("combobox", { name: "Project keys" }), "E2E,");
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(await screen.findByText("at /integrations/jira/9")).toBeInTheDocument();
    expect(JSON.parse((call(mockFetch, "POST", "/api/v1/integrations/jira/connections")![1] as RequestInit).body as string)).toMatchObject({ siteUrl: "https://acme2.atlassian.net", authScheme: "BASIC", enabled: true });
  });

  test("edit PUTs a full replace without the token", async () => {
    serve(mockFetch, { "PUT /api/v1/integrations/jira/connections/1": { status: 204 } });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Operations for Acme Jira" }));
    await user.click(await screen.findByRole("menuitem", { name: "Edit Acme Jira" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByLabelText("Name")).toHaveValue("Acme Jira");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(call(mockFetch, "PUT", "/api/v1/integrations/jira/connections/1")).toBeDefined());
    const sent = JSON.parse((call(mockFetch, "PUT", "/api/v1/integrations/jira/connections/1")![1] as RequestInit).body as string);
    expect(sent).not.toHaveProperty("apiToken");
    expect(sent).toMatchObject({ name: "Acme Jira", authScheme: "BASIC", enabled: true, projectKeys: ["E2E", "PF"] });
  });

  test("delete says it unlinks the connection's links, with the count, and does not use a browser confirm", async () => {
    serve(mockFetch, { "DELETE /api/v1/integrations/jira/connections/1": { status: 204 } }, 3);
    const confirmSpy = vi.fn();
    vi.stubGlobal("confirm", confirmSpy);
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Operations for Acme Jira" }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete Acme Jira" }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText(/its 3 links between live plan items and Jira items will be unlinked/)).toBeInTheDocument();
    expect(call(mockFetch, "GET", "/api/v1/integrations/jira/bindings?page=1&pageSize=1&connectionId=1")).toBeDefined();
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(call(mockFetch, "DELETE", "/api/v1/integrations/jira/connections/1")).toBeDefined());
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  test("delete still states the consequence when the links count is unavailable or zero", async () => {
    serve(mockFetch, {}, 0);
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Operations for Acme Jira" }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete Acme Jira" }));
    expect(await within(await screen.findByRole("dialog")).findByText(/It has no links to live plan items/)).toBeInTheDocument();
  });

  test("while a listed connection's run is running (the server's verdict) the list is re-read by itself, so its badge moves", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    try {
      let finished = false;
      mockFetch.mockImplementation((url: string) => {
        if (!url.startsWith("/api/v1/integrations/jira/connections?")) return Promise.resolve(jsonResponse(404, { title: "x", status: 404 }));
        const lastRun = finished ? LAST_RUN : { ...LAST_RUN, outcome: null, finishedAt: null, running: true };
        return Promise.resolve(jsonResponse(200, { ...PAGE, items: [{ ...CONNECTION, lastRun }], total: 1 }));
      });
      renderPage();
      const listCalls = () => mockFetch.mock.calls.filter(([url]) => String(url).startsWith("/api/v1/integrations/jira/connections?")).length;
      await act(async () => { await vi.advanceTimersByTimeAsync(50); });
      expect(screen.getByText("Running")).toBeInTheDocument();
      expect(listCalls()).toBe(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
      expect(listCalls()).toBe(2);
      finished = true;
      await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
      await act(async () => { await vi.advanceTimersByTimeAsync(50); });
      expect(screen.getByText("Succeeded")).toBeInTheDocument();
      const settled = listCalls();
      // No run is running: the fast poll has stopped, only the slow refresh remains.
      await act(async () => { await vi.advanceTimersByTimeAsync(IDLE_REFRESH_MS - 5_000); });
      expect(listCalls(), "the fast polling has stopped").toBe(settled);
      await act(async () => { await vi.advanceTimersByTimeAsync(5_100); });
      expect(listCalls(), "one slow refresh").toBe(settled + 1);
    } finally {
      vi.useRealTimers();
    }
  });
});
