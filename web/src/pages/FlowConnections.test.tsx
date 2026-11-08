import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { Route, Routes, useLocation } from "react-router-dom";
import { act, renderWithProviders, screen, waitFor, within } from "../test/render";
import { jsonResponse } from "../test/http";
import { headingOutline } from "../test/headings";
import { CONNECTION, TEAMS } from "../test/flow";
import { IDLE_REFRESH_MS } from "../utils/syncRuns";
import FlowConnections from "./FlowConnections";

const TOKEN_KEY = "astrolabe.auth.token";
const ROLES_KEY = "astrolabe.auth.roles";
const LIST = "/api/v1/integrations/flow/connections";
const TOKEN = `flow_int_${"c".repeat(43)}`;
type FetchMock = ReturnType<typeof vi.fn>;

const LAST_RUN = { id: 7, startedAt: Date.UTC(2026, 10, 8, 10, 0), finishedAt: Date.UTC(2026, 10, 8, 10, 1), outcome: "SUCCEEDED" as const, errorCode: null, trigger: "MANUAL" as const, running: false };

const PAGE = {
  items: [
    { ...CONNECTION, lastRun: LAST_RUN },
    { ...CONNECTION, id: 2, name: "Beta Flow", baseUrl: "http://flow-stub:8080", timeZone: "UTC", enabled: false, lastTestedAt: null, lastTestOk: null, teamsAt: null },
    // An edit cleared the verdict of a connection that had been read: it reads as changed, not as never tested.
    { ...CONNECTION, id: 3, name: "Gamma Flow", lastTestedAt: null, lastTestOk: null, lastRun: { ...LAST_RUN, id: 9, outcome: null, finishedAt: null, running: false } },
  ],
  page: 1,
  pageSize: 20,
  total: 3,
};

function serve(mockFetch: FetchMock, mutations: Record<string, { status: number; body?: unknown }> = {}, teams = TEAMS) {
  mockFetch.mockImplementation((url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const mutation = mutations[`${method} ${url}`];
    if (mutation) return Promise.resolve(mutation.body === undefined ? new Response(null, { status: mutation.status }) : jsonResponse(mutation.status, mutation.body));
    if (method === "GET" && url.startsWith(`${LIST}?`)) return Promise.resolve(jsonResponse(200, PAGE));
    if (method === "GET" && url.startsWith("/api/v1/integrations/flow/teams?")) return Promise.resolve(jsonResponse(200, teams));
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
      <Route path="/integrations/flow" element={<FlowConnections />} />
      <Route path="/integrations/flow/:id" element={<Probe />} />
    </Routes>,
    { route: "/integrations/flow" },
  );
}

describe("Flow connections page", () => {
  let mockFetch: FetchMock;
  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    localStorage.setItem(TOKEN_KEY, "fake-token");
    localStorage.setItem(ROLES_KEY, JSON.stringify(["ADMIN"]));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  test("lists the connections: the name opens the page; the base URL, zone, last test and last run are told", async () => {
    serve(mockFetch);
    renderPage();
    const link = await screen.findByRole("link", { name: "Open connection Acme Flow" });
    expect(link).toHaveAttribute("href", "/integrations/flow/1");
    const table = screen.getByRole("table", { name: "Flow connections" });
    const row = link.closest("tr")!;
    // The run column reads the connection's own lastRun - there is no read of the runs across connections.
    expect(mockFetch.mock.calls.some(([url]) => String(url).startsWith("/api/v1/integrations/sync/runs"))).toBe(false);
    const site = within(row).getByRole("link", { name: /flow\.acme\.example/ });
    expect(site).toHaveAttribute("href", "https://flow.acme.example");
    expect(site.getAttribute("rel")).toContain("noopener");
    expect(within(row).getByText("Europe/Warsaw")).toBeInTheDocument();
    expect(within(row).getByText("Passed")).toBeInTheDocument();
    expect(within(row).getByText("Succeeded")).toBeInTheDocument();
    const other = within(table).getByText("Beta Flow").closest("tr")!;
    expect(within(other).getByText("Disabled", { selector: ".mantine-Badge-label" })).toBeInTheDocument();
    expect(within(other).getByRole("link", { name: "flow-stub:8080" })).toHaveAttribute("href", "http://flow-stub:8080");
    expect(within(other).getByText("Never tested")).toBeInTheDocument();
    expect(within(other).getByText("—")).toBeInTheDocument();
    const interrupted = within(table).getByText("Gamma Flow").closest("tr")!;
    expect(within(interrupted).getByText("Not tested since the connection was last changed")).toBeInTheDocument();
    expect(within(interrupted).getByText("Interrupted")).toBeInTheDocument();
    expect(headingOutline()).toEqual([[2, "Flow connections"]]);
  });

  test("the Status column tells each connection's derived state with its secondary line", async () => {
    const NOW = Date.UTC(2026, 10, 8, 11, 0);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const failed = { ...LAST_RUN, outcome: "FAILED" as const, errorCode: "AUTHENTICATION_FAILED", trigger: "SCHEDULED" as const };
    const items = [
      { ...CONNECTION, lastRun: LAST_RUN, status: { state: "CURRENT" as const, lastRun: LAST_RUN, lastSucceededAt: LAST_RUN.startedAt, consecutiveFailures: 0, nextPollAt: NOW + 7 * 60_000 - 5_000 } },
      { ...CONNECTION, id: 2, name: "Beta Flow", enabled: false, status: { ...CONNECTION.status, state: "DISABLED" as const } },
      { ...CONNECTION, id: 3, name: "Gamma Flow", lastRun: failed, status: { state: "FAILED" as const, lastRun: failed, lastSucceededAt: null, consecutiveFailures: 3, nextPollAt: NOW + 60 * 60_000 } },
      { ...CONNECTION, id: 4, name: "Delta Flow", pollIntervalMinutes: null, status: { ...CONNECTION.status, state: "CURRENT" as const, lastSucceededAt: 1 } },
      { ...CONNECTION, id: 5, name: "Echo Flow", lastTestOk: null, teamsAt: null, status: { ...CONNECTION.status, state: "NEVER_SYNCED" as const } },
      { ...CONNECTION, id: 6, name: "Foxtrot Flow", status: { state: "STALE" as const, lastRun: LAST_RUN, lastSucceededAt: 1, consecutiveFailures: 0, nextPollAt: NOW - 1_000 } },
    ];
    mockFetch.mockImplementation((url: string) =>
      Promise.resolve(url.startsWith(`${LIST}?`) ? jsonResponse(200, { items, page: 1, pageSize: 20, total: items.length }) : jsonResponse(404, { title: "x", status: 404 })),
    );
    renderPage();
    await screen.findByRole("link", { name: "Open connection Acme Flow" });
    const table = screen.getByRole("table", { name: "Flow connections" });
    expect(within(table).getByRole("columnheader", { name: "Status" })).toBeInTheDocument();
    const row = (name: string) => within(table).getByText(name).closest("tr")!;
    expect(row("Acme Flow")).toHaveTextContent("Currentnext poll in 7 min");
    expect(row("Beta Flow")).toHaveTextContent("Disabled");
    expect(row("Gamma Flow")).toHaveTextContent("Failed3 failures in a row · AUTHENTICATION_FAILED");
    expect(row("Delta Flow")).toHaveTextContent("Currentmanual only");
    expect(row("Echo Flow")).toHaveTextContent("Never syncednot polled: test the connection first");
    expect(row("Foxtrot Flow")).toHaveTextContent("Staledue now");
  });

  test("an open list re-reads slowly: a connection the scheduler polled meanwhile shows its new status without a reload", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let status: (typeof CONNECTION)["status"] = { ...CONNECTION.status };
    mockFetch.mockImplementation((url: string) =>
      Promise.resolve(url.startsWith(`${LIST}?`) ? jsonResponse(200, { items: [{ ...CONNECTION, status }], page: 1, pageSize: 20, total: 1 }) : jsonResponse(404, { title: "x", status: 404 })),
    );
    renderPage();
    const row = (await screen.findByRole("link", { name: "Open connection Acme Flow" })).closest("tr")!;
    expect(row).toHaveTextContent("Never synced");
    status = { state: "CURRENT", lastRun: null, lastSucceededAt: 1, consecutiveFailures: 0, nextPollAt: null };
    await act(async () => { await vi.advanceTimersByTimeAsync(IDLE_REFRESH_MS + 100); });
    await waitFor(() => expect(screen.getByRole("link", { name: "Open connection Acme Flow" }).closest("tr")).toHaveTextContent("Current"));
  });

  test("the empty state spans every column", async () => {
    mockFetch.mockImplementation(() => Promise.resolve(jsonResponse(200, { ...PAGE, items: [], total: 0 })));
    renderPage();
    const empty = await screen.findByText("No Flow connections yet");
    expect(empty.closest("td")).toHaveAttribute("colspan", String(screen.getAllByRole("columnheader").length));
  });

  test("a failed load shows the alert", async () => {
    mockFetch.mockResolvedValue(jsonResponse(500, { title: "x", status: 500 }));
    renderPage();
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load the Flow connections");
  });

  test("create: the modal POSTs the canonical body and the new connection's page opens", async () => {
    serve(mockFetch, { [`POST ${LIST}`]: { status: 201, body: { ...CONNECTION, id: 9 } } });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: /new connection/i }));
    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByLabelText("Name"), "Acme Flow 2");
    await user.type(within(dialog).getByLabelText("Base URL"), "https://flow2.acme.example/");
    await user.type(within(dialog).getByLabelText("Service token"), TOKEN);
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(await screen.findByText("at /integrations/flow/9")).toBeInTheDocument();
    expect(JSON.parse((call(mockFetch, "POST", LIST)![1] as RequestInit).body as string)).toMatchObject({ baseUrl: "https://flow2.acme.example", timeZone: "Europe/Warsaw", enabled: true, pollIntervalMinutes: 60 });
  });

  test("Cancel closes the editor and writes nothing", async () => {
    serve(mockFetch);
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: /new connection/i }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(mockFetch.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "POST")).toBe(false);
  });

  test("edit PUTs a full replace without the token", async () => {
    serve(mockFetch, { [`PUT ${LIST}/1`]: { status: 204 } });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Operations for Acme Flow" }));
    await user.click(await screen.findByRole("menuitem", { name: "Edit Acme Flow" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByLabelText("Name")).toHaveValue("Acme Flow");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(call(mockFetch, "PUT", `${LIST}/1`)).toBeDefined());
    const sent = JSON.parse((call(mockFetch, "PUT", `${LIST}/1`)![1] as RequestInit).body as string);
    expect(sent).not.toHaveProperty("apiToken");
    expect(sent).toMatchObject({ name: "Acme Flow", baseUrl: "https://flow.acme.example", enabled: true, pollIntervalMinutes: 60 });
  });

  test("delete says what it takes with it, counts the connection's team links, and does not use a browser confirm", async () => {
    serve(mockFetch, { [`DELETE ${LIST}/1`]: { status: 204 } });
    const confirmSpy = vi.fn();
    vi.stubGlobal("confirm", confirmSpy);
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Operations for Acme Flow" }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete Acme Flow" }));
    const dialog = await screen.findByRole("dialog");
    // The fixture has one linked Flow team (Platform): "1 team link".
    expect(await within(dialog).findByText(/its 1 team link will be unlinked\. Capacity already imported stays\. Nothing is changed in Flow\./)).toBeInTheDocument();
    expect(call(mockFetch, "GET", "/api/v1/integrations/flow/teams?connectionId=1")).toBeDefined();
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(call(mockFetch, "DELETE", `${LIST}/1`)).toBeDefined());
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  test("delete still states the consequence when its last read had no links, and before the count arrives", async () => {
    serve(mockFetch, {}, { ...TEAMS, items: TEAMS.items.map((team) => ({ ...team, bindingId: null, boundTeamId: null, boundTeamName: null })) });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Operations for Acme Flow" }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete Acme Flow" }));
    expect(await within(await screen.findByRole("dialog")).findByText(/No team was linked in its last read/)).toBeInTheDocument();
  });

  test("the count-less sentence shows while the teams are not known (the read failed)", async () => {
    mockFetch.mockImplementation((url: string) =>
      Promise.resolve(url.startsWith(`${LIST}?`) ? jsonResponse(200, PAGE) : jsonResponse(500, { title: "x", status: 500 })),
    );
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Operations for Acme Flow" }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete Acme Flow" }));
    expect(await within(await screen.findByRole("dialog")).findByText(/every link between an Astrolabe team and a Flow team made through it will be unlinked/)).toBeInTheDocument();
  });

  test("while a listed connection's run is running (the server's verdict) the list is re-read by itself, so its badge moves", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    let finished = false;
    mockFetch.mockImplementation((url: string) => {
      if (!url.startsWith(`${LIST}?`)) return Promise.resolve(jsonResponse(404, { title: "x", status: 404 }));
      const lastRun = finished ? LAST_RUN : { ...LAST_RUN, outcome: null, finishedAt: null, running: true };
      return Promise.resolve(jsonResponse(200, { ...PAGE, items: [{ ...CONNECTION, lastRun }], total: 1 }));
    });
    renderPage();
    const listCalls = () => mockFetch.mock.calls.filter(([url]) => String(url).startsWith(`${LIST}?`)).length;
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
    await act(async () => { await vi.advanceTimersByTimeAsync(IDLE_REFRESH_MS - 5_000); });
    expect(listCalls(), "the fast polling has stopped").toBe(settled);
    await act(async () => { await vi.advanceTimersByTimeAsync(5_100); });
    expect(listCalls(), "one slow refresh").toBe(settled + 1);
  });
});
