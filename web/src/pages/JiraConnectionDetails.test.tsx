import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { Link, Route, Routes } from "react-router-dom";
import { renderWithProviders, screen, waitFor, within } from "../test/render";
import { jsonResponse } from "../test/http";
import { headingOutline } from "../test/headings";
import { CONNECTION, DISCOVERY, FAILING_TEST, MAPPING_DEFAULTS_ONLY, PASSING_TEST, run } from "../test/jira";
import type { JiraConnection } from "../api/jira";
import type { SyncRun } from "../api/sync";
import JiraConnectionDetails from "./JiraConnectionDetails";

const TOKEN_KEY = "astrolabe.auth.token";
const ROLES_KEY = "astrolabe.auth.roles";
const BASE = "/api/v1/integrations/jira/connections/1";
type FetchMock = ReturnType<typeof vi.fn>;

type World = { connection?: JiraConnection; runs: SyncRun[]; claim: () => Response; test: () => Response };

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
    if (url === "/api/v1/integrations/jira/connections/2" && method === "GET") return Promise.resolve(jsonResponse(200, { ...CONNECTION, id: 2, name: "Other Jira" }));
    if (url.startsWith("/api/v1/integrations/jira/connections/2/")) return Promise.resolve(jsonResponse(404, { title: "x", status: 404 }));
    if (url === BASE && method === "GET") return Promise.resolve(world.connection ? jsonResponse(200, world.connection) : jsonResponse(404, { title: "Not Found", status: 404 }));
    if (url === `${BASE}/discovery`) return Promise.resolve(jsonResponse(200, DISCOVERY));
    if (url === `${BASE}/mapping`) return Promise.resolve(jsonResponse(200, MAPPING_DEFAULTS_ONLY));
    if (url === `${BASE}/test` && method === "POST") return Promise.resolve(world.test());
    if (url.startsWith("/api/v1/integrations/sync/runs") && method === "GET") return Promise.resolve(jsonResponse(200, { items: world.runs }));
    if (url === "/api/v1/integrations/sync/runs" && method === "POST") {
      const response = world.claim();
      if (response.status === 202) world.runs = [run({ id: 8, outcome: null, finishedAt: null, startedAt: Date.now(), running: true }), ...world.runs];
      return Promise.resolve(response);
    }
    return Promise.resolve(jsonResponse(404, { title: "x", status: 404 }));
  });
  return world;
}

function renderPage(route = "/integrations/jira/1") {
  return renderWithProviders(
    <Routes>
      <Route
        path="/integrations/jira/:id"
        element={
          <>
            <Link to="/integrations/jira/2">other connection</Link>
            <JiraConnectionDetails />
          </>
        }
      />
      <Route path="/integrations/jira" element={<p>the list</p>} />
    </Routes>,
    { route },
  );
}

describe("Jira connection page", () => {
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

  test("a discovered connection shows its facts (never the token), the runs, and the Mapping section with the report, the editor and Peek", async () => {
    serve(mockFetch, { runs: [run()] });
    renderPage();
    expect(await screen.findByRole("heading", { level: 2, name: "Acme Jira" })).toBeInTheDocument();
    await screen.findByRole("form", { name: "Field mapping" });
    expect(headingOutline()).toEqual([
      [2, "Acme Jira"],
      [3, "Connection"],
      [4, "Recent runs"],
      [3, "Mapping"],
      [4, "Discovery report"],
      [4, "Field mapping"],
      [4, "Peek at an issue"],
    ]);
    const facts = screen.getByRole("table", { name: "Connection facts" });
    const site = within(facts).getByRole("link", { name: "https://acme.atlassian.net" });
    expect(site.getAttribute("rel")).toContain("noopener");
    expect(within(facts).getByText("A token is stored")).toBeInTheDocument();
    // Last test and "fields discovered" are the same instant in the fixture.
    expect(within(facts).getAllByText("2026-11-06 09:30")).toHaveLength(2);
    expect(within(facts).getByText("Passed")).toBeInTheDocument();
    expect(within(screen.getByRole("table", { name: "Recent runs" })).getByText("Succeeded")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "What the defaults rest on" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Peek" })).toBeInTheDocument();
  });

  test("before any test has stored a discovery the Mapping section says to test first, with no empty form", async () => {
    serve(mockFetch, { connection: { ...CONNECTION, discoveredAt: null, lastTestedAt: null, lastTestOk: null, cloudId: null } });
    renderPage();
    expect(await screen.findByText(/Test the connection first/)).toBeInTheDocument();
    expect(screen.queryByRole("form", { name: "Field mapping" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Peek" })).not.toBeInTheDocument();
    expect(mockFetch.mock.calls.some(([url]) => url === `${BASE}/discovery`)).toBe(false);
    expect(headingOutline()).toEqual([
      [2, "Acme Jira"],
      [3, "Connection"],
      [4, "Recent runs"],
      [3, "Mapping"],
    ]);
  });

  test("the first Test connection of a connection that had no discovery opens the mapping on the DEFAULTS, never on an empty form", async () => {
    // The mapping read before any discovery has defaults null; only a read after the test carries them.
    let discovered = false;
    serve(mockFetch, { connection: { ...CONNECTION, discoveredAt: null, lastTestedAt: null, lastTestOk: null } });
    const base = mockFetch.getMockImplementation() as (url: string, init?: RequestInit) => Promise<Response>;
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (url === BASE && method === "GET") return Promise.resolve(jsonResponse(200, discovered ? CONNECTION : { ...CONNECTION, discoveredAt: null, lastTestedAt: null, lastTestOk: null }));
      // After the test the discovery is answered at once and the mapping late: the editor must not open on the copy read before.
      if (url === `${BASE}/mapping`) {
        return discovered
          ? new Promise((resolve) => setTimeout(() => resolve(jsonResponse(200, MAPPING_DEFAULTS_ONLY)), 150))
          : Promise.resolve(jsonResponse(200, { mapping: null, defaults: null, effective: null, discoveredAt: null, problems: [] }));
      }
      if (url === `${BASE}/test` && method === "POST") {
        discovered = true;
        return Promise.resolve(jsonResponse(200, PASSING_TEST));
      }
      return base(url, init);
    });
    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByText(/Test the connection first/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    const form = await screen.findByRole("form", { name: "Field mapping" });
    expect(within(form).getAllByRole("combobox", { name: "Start" })[2]).toHaveValue("Target start — customfield_10020");
    expect(within(form).getAllByRole("combobox", { name: "Jira level" })[2]).toHaveValue("Level 1 — Epic");
  });

  test("Test connection runs the stored probe and lists every row; a missing scope is explained next to the failed row", async () => {
    const world = serve(mockFetch);
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Test connection" }));
    const table = await screen.findByRole("table", { name: "Connection test results" });
    expect(within(table).getAllByText("OK")).toHaveLength(4);
    expect(screen.getByRole("heading", { level: 4, name: "Test result" })).toBeInTheDocument();
    // The verdict is said in a polite status region as well.
    expect(screen.getByText("Test passed. OK: 4 of 4.").closest('[role="status"]')).toHaveAttribute("aria-live", "polite");

    world.test = () => jsonResponse(200, FAILING_TEST);
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByText(/needs scope: read:jql:jira/)).toBeInTheDocument();
    expect(screen.getByText(/missing that probe's scope/)).toBeInTheDocument();
    expect(screen.getByText("Test failed. Required probes that failed: 1 of 4.")).toBeInTheDocument();
  });

  test("a test whose result was not recorded (an edit raced it) says to test again; a 429 reads in words", async () => {
    const world = serve(mockFetch, { test: () => jsonResponse(200, { ...PASSING_TEST, recorded: false }) });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Test connection" }));
    expect(await screen.findByText(/this result was not recorded/)).toBeInTheDocument();
    world.test = () => jsonResponse(429, { title: "Too Many Requests", status: 429 });
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Too many tests in a minute");
    // A stale result must not sit under the new error: the table and its summary are gone.
    expect(screen.queryByRole("table", { name: "Connection test results" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Test passed/)).not.toBeInTheDocument();
  });

  test("Refresh now claims a run (202), says it is running and shows the new row, with no error", async () => {
    const world = serve(mockFetch);
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Refresh now" }));
    await waitFor(() => expect(mockFetch.mock.calls.some(([url, init]) => url === "/api/v1/integrations/sync/runs" && (init as RequestInit).method === "POST")).toBe(true));
    const post = mockFetch.mock.calls.find(([url, init]) => url === "/api/v1/integrations/sync/runs" && (init as RequestInit).method === "POST")!;
    expect(JSON.parse((post[1] as RequestInit).body as string)).toEqual({ kind: "JIRA", connectionId: 1 });
    expect(await screen.findByText(/A refresh is running/)).toBeInTheDocument();
    expect(within(screen.getByRole("table", { name: "Recent runs" })).getByText("Running")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(world.runs).toHaveLength(1);
  });

  test("a 409 run-in-progress is a normal state: told as a note, never an error", async () => {
    serve(mockFetch, {
      runs: [run({ id: 5, outcome: null, finishedAt: null, startedAt: Date.now() - 5_000, running: true })],
      claim: () => jsonResponse(409, { title: "Conflict", status: 409, type: "urn:astrolabe:problem:run-in-progress" }),
    });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Refresh now" }));
    expect(await screen.findByText(/A refresh is already running for this connection/)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  test("an unfinished run the server does not call running reads as interrupted, in words that claim nothing about what happens next", async () => {
    serve(mockFetch, { runs: [run({ id: 5, outcome: null, finishedAt: null, startedAt: Date.now(), running: false })] });
    renderPage();
    const table = await screen.findByRole("table", { name: "Recent runs" });
    expect(await within(table).findByText("Interrupted")).toBeInTheDocument();
    expect(within(table).getByText("No result was recorded and nothing is running it now.")).toBeInTheDocument();
    expect(screen.queryByText(/A refresh is running/)).not.toBeInTheDocument();
  });

  test("the page starts over when the route's id changes in place: a test result of one connection never shows under another", async () => {
    serve(mockFetch);
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Test connection" }));
    expect(await screen.findByRole("table", { name: "Connection test results" })).toBeInTheDocument();
    await user.click(screen.getByRole("link", { name: "other connection" }));
    expect(await screen.findByRole("heading", { level: 2, name: "Other Jira" })).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "Connection test results" })).not.toBeInTheDocument();
  });

  test("after an edit cleared the verdict of a discovered connection the facts say it was not tested since the change", async () => {
    serve(mockFetch, { connection: { ...CONNECTION, lastTestedAt: null, lastTestOk: null } });
    renderPage();
    const facts = await screen.findByRole("table", { name: "Connection facts" });
    expect(within(facts).getByText("Not tested since the connection was last changed")).toBeInTheDocument();
    expect(within(facts).queryByText("Never tested")).not.toBeInTheDocument();
  });

  test("a disabled connection cannot be refreshed, and says why", async () => {
    serve(mockFetch, { connection: { ...CONNECTION, enabled: false } });
    renderPage();
    const button = await screen.findByRole("button", { name: "Refresh now" });
    expect(button).toBeDisabled();
    expect(screen.getByText("The connection is disabled.")).toBeInTheDocument();
  });

  test("a failed run reads its typed error honestly in the table", async () => {
    serve(mockFetch, { runs: [run({ outcome: "FAILED", errorCode: "NOT_DISCOVERED", errorDetail: "The connection has not been tested yet" })] });
    renderPage();
    const table = await screen.findByRole("table", { name: "Recent runs" });
    expect(await within(table).findByText("Failed")).toBeInTheDocument();
    expect(within(table).getByText("No discovery yet; test the connection first (NOT_DISCOVERED)")).toBeInTheDocument();
  });

  test("an unknown connection (404) and a malformed id are the not-found alert under the page's title", async () => {
    serve(mockFetch, { connection: undefined });
    renderPage();
    expect(await screen.findByRole("alert")).toHaveTextContent("This Jira connection does not exist");
    expect(screen.getByRole("heading", { level: 2, name: "Jira connections" })).toBeInTheDocument();
  });

  test("Edit opens the editor on the connection", async () => {
    serve(mockFetch);
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByLabelText("Name")).toHaveValue("Acme Jira");
    expect(within(dialog).getByLabelText("API token")).toHaveValue("");
  });
});
