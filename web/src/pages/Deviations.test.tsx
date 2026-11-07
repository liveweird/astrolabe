import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { Route, Routes, useLocation } from "react-router-dom";
import { renderWithProviders, screen, waitFor, within } from "../test/render";
import { headingOutline } from "../test/headings";
import { jsonResponse } from "../test/http";
import { DEV_CONNECTION, detail, item, NOW, view } from "../test/deviations";
import type { DeviationView } from "../api/deviations";
import Deviations from "./Deviations";

const ROLES_KEY = "astrolabe.auth.roles";
type FetchMock = ReturnType<typeof vi.fn>;

const PLAN = {
  revision: 1,
  workStreams: [{ id: 700, name: "Platform", programs: [{ id: 70, name: "Billing", projects: [{ id: 7, name: "Invoices" }] }] }],
};
const TEAMS = { items: [{ id: 3, name: "Backend" }], page: 1, pageSize: 100, total: 1 };

let doc: DeviationView;
let bindingsTotal: number;
let claim: Response;

function serve(mockFetch: FetchMock) {
  mockFetch.mockImplementation((url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url.startsWith("/api/v1/views/deviations")) return Promise.resolve(jsonResponse(200, doc));
    if (url === "/api/v1/views/plan") return Promise.resolve(jsonResponse(200, PLAN));
    if (url.startsWith("/api/v1/teams?")) return Promise.resolve(jsonResponse(200, TEAMS));
    if (url.startsWith("/api/v1/integrations/jira/bindings?")) return Promise.resolve(jsonResponse(200, { items: [], page: 1, pageSize: 1, total: bindingsTotal }));
    if (url === "/api/v1/integrations/sync/runs" && method === "POST") return Promise.resolve(claim.clone());
    return Promise.resolve(jsonResponse(404, { title: "x", status: 404 }));
  });
}

function Where() {
  const location = useLocation();
  return <p data-testid="where">{location.pathname + location.search}</p>;
}

function renderPage(route = "/deviations") {
  return renderWithProviders(
    <Routes>
      <Route
        path="/deviations"
        element={
          <>
            <Deviations />
            <Where />
          </>
        }
      />
    </Routes>,
    { route },
  );
}

describe("Deviations page", () => {
  let mockFetch: FetchMock;
  const viewCalls = () => mockFetch.mock.calls.map(([url]) => url as string).filter((url) => url.startsWith("/api/v1/views/deviations"));
  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    localStorage.setItem("astrolabe.auth.token", "fake-token");
    localStorage.setItem(ROLES_KEY, JSON.stringify(["USER"]));
    doc = view();
    bindingsTotal = 1;
    claim = jsonResponse(202, { id: 10, kind: "JIRA", connectionId: 1, running: true, outcome: null, finishedAt: null, startedAt: NOW });
    serve(mockFetch);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  test("shows the totals, the table with each side's dates, the sentence with its working-day figure, and how long ago the item was READ", async () => {
    renderPage();
    const table = await screen.findByRole("table", { name: "Differences between the plan and Jira" });
    expect(headingOutline()).toEqual([
      [2, "Deviations"],
      [3, "Data from Jira"],
      [3, "Differences"],
    ]);
    expect(within(table).getByRole("link", { name: "Checkout page - open project Invoices" })).toHaveAttribute("href", "/projects/7");
    const key = within(table).getByRole("link", { name: /E2E-3/ });
    expect(key).toHaveAttribute("href", "https://acme.atlassian.net/browse/E2E-3");
    expect(key.getAttribute("rel")).toContain("noopener");
    expect(within(table).getByText("Ends 3 working days later than Jira (plan 2044-03-07, Jira 2044-03-04)")).toBeInTheDocument();
    expect(within(table).getByText(/2044-03-01 → 2044-03-07/)).toBeInTheDocument();
    expect(within(table).getByText(/2044-03-01 → 2044-03-04/)).toBeInTheDocument();
    // The severity is in words, not only in the badge's colour.
    expect(within(table).getByText("Warning:")).toBeInTheDocument();
    expect(within(table).getByText("5 minutes ago")).toBeInTheDocument();
    expect(screen.getByText("1 warning")).toBeInTheDocument();
    expect(screen.getByText("0 infos")).toBeInTheDocument();
    expect(screen.getByText("1 item shown")).toBeInTheDocument();
    expect(screen.getByText("Progress is checked against 2026-11-06 (UTC).")).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Data from Jira" })).toBeInTheDocument();
  });

  test("the filters come from the URL, are sent as such, and a project chip names the project and removes itself", async () => {
    const user = userEvent.setup();
    renderPage("/deviations?projectId=7&severity=WARNING&bogus=1");
    expect(await screen.findByText("Project: Invoices")).toBeInTheDocument();
    expect(viewCalls()[0]).toBe("/api/v1/views/deviations?projectId=7&severity=WARNING");
    await user.click(screen.getByRole("button", { name: "Remove the project filter" }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/deviations?severity=WARNING"));
    expect(screen.queryByText("Project: Invoices")).not.toBeInTheDocument();
    expect(viewCalls().at(-1)).toBe("/api/v1/views/deviations?severity=WARNING");
  });

  test("a select and the 'Show everything' switch write the URL, and 'show everything' sends all=true", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("table", { name: "Differences between the plan and Jira" });
    await user.click(screen.getByRole("button", { name: "Filters" }));
    await user.click(screen.getByRole("combobox", { name: "Severity" }));
    await user.click(await screen.findByRole("option", { name: "Info" }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/deviations?severity=INFO"));
    await user.click(screen.getByRole("switch", { name: /Show everything/ }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/deviations?severity=INFO&all=true"));
    expect(viewCalls().at(-1)).toBe("/api/v1/views/deviations?severity=INFO&all=true");
  });

  test("an item with no deviation (all) reads 'No deviation'; a gone item and a disabled connection are marked stale", async () => {
    doc = view({
      connections: [DEV_CONNECTION, { ...DEV_CONNECTION, id: 2, name: "Old Jira", enabled: false }],
      items: [
        item({ bindingId: 1, deviations: [] }),
        item({ bindingId: 2, connectionId: 2, node: { ...item().node, id: 12, name: "Gone one" }, jira: { ...item().jira, key: "OLD-1", gone: true }, deviations: [{ kind: "GONE", severity: "WARNING", detail: detail({ jira: "OUT_OF_SCOPE" }) }] }),
      ],
    });
    renderPage("/deviations?all=true");
    const table = await screen.findByRole("table", { name: "Differences between the plan and Jira" });
    expect(within(table).getByText("No deviation")).toBeInTheDocument();
    expect(within(table).getByText("Gone from Jira")).toBeInTheDocument();
    expect(within(table).getByText("Connection disabled")).toBeInTheDocument();
    expect(within(table).getByText("5 minutes ago · stale")).toBeInTheDocument();
    expect(within(table).getByText(/No longer readable in Jira: deleted, moved out/)).toBeInTheDocument();
    // The estimate that cannot be compared is only there when asked for.
    expect(viewCalls()[0]).toBe("/api/v1/views/deviations?all=true");
  });

  test("a truncated list says so, and does not claim its totals are the number of links", async () => {
    doc = { ...view(), truncated: true };
    renderPage();
    expect(await screen.findByText(/Only the first 1 items are listed/)).toBeInTheDocument();
    expect(screen.queryByText(/linked items/i)).not.toBeInTheDocument();
  });

  test("a mapping that does not fit says levels and estimates are not compared for that connection", async () => {
    doc = view({ connections: [{ ...DEV_CONNECTION, mappingOk: false }] });
    renderPage();
    expect(await screen.findByText(/levels and estimates are not compared for its items/)).toBeInTheDocument();
  });
});

describe("Deviations page - how current the figures are", () => {
  let mockFetch: FetchMock;
  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    localStorage.setItem("astrolabe.auth.token", "fake-token");
    localStorage.setItem(ROLES_KEY, JSON.stringify(["USER"]));
    bindingsTotal = 1;
    claim = jsonResponse(202, {});
    serve(mockFetch);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  const run = DEV_CONNECTION.lastRun!;

  test("a last run that FAILED is shown honestly, with its code in words, and the list is flagged as possibly out of date", async () => {
    doc = view({ connections: [{ ...DEV_CONNECTION, lastRun: { ...run, outcome: "FAILED", errorCode: "AUTHENTICATION_FAILED" } }] });
    renderPage();
    const sources = await screen.findByRole("table", { name: "Data from Jira" });
    expect(within(sources).getByText("Failed")).toBeInTheDocument();
    expect(within(sources).getByText(/The last refresh failed: Jira refused the credentials \(AUTHENTICATION_FAILED\)\. The figures may be out of date\./)).toBeInTheDocument();
    expect(screen.getByText(/may be out of date\. See Data from Jira/)).toBeInTheDocument();
  });

  test("never refreshed, interrupted (unfinished and not running) and abandoned each read as not current", async () => {
    doc = view({ connections: [{ ...DEV_CONNECTION, lastRun: null }] });
    const first = renderPage();
    expect(await screen.findByText("No refresh has finished yet: the figures are as they were when each item was linked.")).toBeInTheDocument();
    first.unmount();

    doc = view({ connections: [{ ...DEV_CONNECTION, lastRun: { ...run, outcome: null, finishedAt: null, running: false } }] });
    const second = renderPage();
    expect(await screen.findByText("Interrupted")).toBeInTheDocument();
    expect(screen.getByText("The last refresh did not finish. The figures may be out of date.")).toBeInTheDocument();
    second.unmount();

    doc = view({ connections: [{ ...DEV_CONNECTION, lastRun: { ...run, outcome: "ABANDONED" } }] });
    renderPage();
    expect(await screen.findByText("The last refresh was abandoned. The figures may be out of date.")).toBeInTheDocument();
  });

  test("a succeeded last run raises no banner; a running one is announced and not called stale", async () => {
    doc = view();
    const first = renderPage();
    await screen.findByRole("table", { name: "Differences between the plan and Jira" });
    expect(screen.queryByText(/may be out of date/)).not.toBeInTheDocument();
    first.unmount();
    doc = view({ connections: [{ ...DEV_CONNECTION, lastRun: { ...run, outcome: null, finishedAt: null, running: true } }] });
    renderPage();
    expect(await screen.findByText("A refresh is running. This page updates by itself.")).toBeInTheDocument();
    expect(screen.queryByText(/may be out of date/)).not.toBeInTheDocument();
  });

  test("a disabled connection is marked and says its items show what was last read", async () => {
    doc = view({ connections: [{ ...DEV_CONNECTION, enabled: false }] });
    renderPage();
    expect(await screen.findByText(/The connection is disabled: its items are not refreshed/)).toBeInTheDocument();
    expect(screen.getAllByText("Disabled").length).toBeGreaterThan(0);
  });
});

describe("Deviations page - Refresh now (ADMIN only)", () => {
  let mockFetch: FetchMock;
  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    localStorage.setItem("astrolabe.auth.token", "fake-token");
    doc = view();
    bindingsTotal = 1;
    claim = jsonResponse(202, { id: 10 });
    serve(mockFetch);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });
  const claims = () => mockFetch.mock.calls.filter(([url, init]) => url === "/api/v1/integrations/sync/runs" && (init as RequestInit | undefined)?.method === "POST");

  test("a plain user has no Refresh button and no link into the registry", async () => {
    localStorage.setItem(ROLES_KEY, JSON.stringify(["USER"]));
    renderPage();
    const sources = await screen.findByRole("table", { name: "Data from Jira" });
    expect(within(sources).queryByRole("button")).not.toBeInTheDocument();
    expect(within(sources).queryByRole("link")).not.toBeInTheDocument();
  });

  test("an administrator claims a run for that connection and the page re-reads the deviations (and only the jira queries)", async () => {
    localStorage.setItem(ROLES_KEY, JSON.stringify(["ADMIN"]));
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Refresh now: Acme Jira" }));
    await waitFor(() => expect(claims()).toHaveLength(1));
    expect(JSON.parse((claims()[0][1] as RequestInit).body as string)).toEqual({ kind: "JIRA", connectionId: 1 });
    await waitFor(() => expect(mockFetch.mock.calls.filter(([url]) => (url as string).startsWith("/api/v1/views/deviations")).length).toBeGreaterThan(1));
    expect(mockFetch.mock.calls.some(([url]) => /\/api\/v1\/views\/(project|team|roadmap|programs)/.test(url as string))).toBe(false);
  });

  test("a 409 run-in-progress is a normal state, not an error", async () => {
    localStorage.setItem(ROLES_KEY, JSON.stringify(["ADMIN"]));
    claim = jsonResponse(409, { type: "urn:astrolabe:problem:run-in-progress", title: "Conflict", status: 409, detail: "running" });
    doc = view({ connections: [{ ...DEV_CONNECTION, lastRun: { ...DEV_CONNECTION.lastRun!, outcome: null, finishedAt: null, running: false } }] });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Refresh now: Acme Jira" }));
    await waitFor(() => expect(claims()).toHaveLength(1));
    expect(screen.queryByText("The refresh could not be started")).not.toBeInTheDocument();
  });

  test("a disabled connection cannot be refreshed", async () => {
    localStorage.setItem(ROLES_KEY, JSON.stringify(["ADMIN"]));
    doc = view({ connections: [{ ...DEV_CONNECTION, enabled: false }] });
    renderPage();
    expect(await screen.findByRole("button", { name: "Refresh now: Acme Jira" })).toBeDisabled();
  });
});

describe("Deviations page - empty states", () => {
  let mockFetch: FetchMock;
  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    localStorage.setItem("astrolabe.auth.token", "fake-token");
    localStorage.setItem(ROLES_KEY, JSON.stringify(["USER"]));
    bindingsTotal = 0;
    claim = jsonResponse(202, {});
    serve(mockFetch);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  test("no connection at all: says so, and for a plain user that an administrator has to add one", async () => {
    doc = view({ items: [], connections: [] });
    renderPage();
    expect(await screen.findByText("No Jira connection has been set up yet.")).toBeInTheDocument();
    expect(screen.getByText("An administrator has to add one first.")).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "Data from Jira" })).not.toBeInTheDocument();
  });

  test("no connection at all, as an administrator: a link to the registry", async () => {
    localStorage.setItem(ROLES_KEY, JSON.stringify(["ADMIN"]));
    doc = view({ items: [], connections: [] });
    renderPage();
    expect(await screen.findByRole("link", { name: "Add one under Administration, Jira." })).toHaveAttribute("href", "/integrations/jira");
  });

  test("connections but nothing linked: says nothing is linked yet (and does not claim agreement)", async () => {
    doc = view({ items: [] });
    renderPage();
    expect(await screen.findByText("Nothing is linked to Jira yet.")).toBeInTheDocument();
    expect(screen.queryByText("All linked items agree with Jira.")).not.toBeInTheDocument();
  });

  test("links exist and the last run succeeded: the claim is DATED ('No deviations in the data read at …'), never 'agree'", async () => {
    bindingsTotal = 4;
    doc = view({ items: [] });
    renderPage();
    expect(await screen.findByText("No deviations in the data read at 2026-11-06 10:01 (UTC).")).toBeInTheDocument();
    expect(screen.queryByText(/agree with Jira/)).not.toBeInTheDocument();
  });

  test("no dated claim for a mapping that does not fit, a disabled connection, or a failed last run", async () => {
    bindingsTotal = 4;
    const run = DEV_CONNECTION.lastRun!;
    for (const connections of [
      [{ ...DEV_CONNECTION, mappingOk: false }],
      [DEV_CONNECTION, { ...DEV_CONNECTION, id: 2, name: "Old", enabled: false }],
      [{ ...DEV_CONNECTION, lastRun: { ...run, outcome: "FAILED" as const, errorCode: "TIMEOUT" } }],
    ]) {
      doc = view({ items: [], connections });
      const rendered = renderPage();
      expect(await screen.findByText("No deviations in the data read so far.")).toBeInTheDocument();
      expect(screen.queryByText(/No deviations in the data read at/)).not.toBeInTheDocument();
      rendered.unmount();
    }
  });

  test("a failed read of how many items are linked says so - and does not say the deviations failed", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.startsWith("/api/v1/views/deviations")) return Promise.resolve(jsonResponse(200, view({ items: [] })));
      if (url.startsWith("/api/v1/integrations/jira/bindings?")) return Promise.resolve(jsonResponse(500, { title: "x", status: 500 }));
      return Promise.resolve(jsonResponse(404, { title: "x", status: 404 }));
    });
    renderPage();
    expect(await screen.findByText("Could not check whether anything is linked")).toBeInTheDocument();
    expect(screen.queryByText("Could not load the deviations")).not.toBeInTheDocument();
  });

  test("a project scope with nothing linked says 'nothing here is linked', not 'no items match'", async () => {
    doc = view({ items: [], totals: { warnings: 0, infos: 0, bindings: 0, gone: 0, acknowledged: 0 } });
    renderPage("/deviations?projectId=7");
    expect(await screen.findByText("Nothing here is linked to Jira yet.")).toBeInTheDocument();
    expect(screen.queryByText("No items match the filters.")).not.toBeInTheDocument();
  });

  test("links exist but a refresh never succeeded: only 'no deviations in the data read so far', never agreement", async () => {
    bindingsTotal = 4;
    doc = view({ items: [], connections: [{ ...DEV_CONNECTION, lastRun: null }] });
    renderPage();
    expect(await screen.findByText("No deviations in the data read so far.")).toBeInTheDocument();
    expect(screen.queryByText("All linked items agree with Jira.")).not.toBeInTheDocument();
  });

  test("the answer for new filters is on its way: the kept answer may not make an empty-state claim, a busy status stands in", async () => {
    const user = userEvent.setup();
    bindingsTotal = 4;
    doc = view({ items: [], connections: [{ ...DEV_CONNECTION, lastRun: null }] });
    let release!: (response: Response) => void;
    mockFetch.mockImplementation((url: string) => {
      if (url === "/api/v1/views/deviations?severity=INFO") return new Promise<Response>((resolve) => (release = resolve));
      if (url.startsWith("/api/v1/views/deviations")) return Promise.resolve(jsonResponse(200, doc));
      if (url === "/api/v1/views/plan") return Promise.resolve(jsonResponse(200, PLAN));
      if (url.startsWith("/api/v1/teams?")) return Promise.resolve(jsonResponse(200, TEAMS));
      if (url.startsWith("/api/v1/integrations/jira/bindings?")) return Promise.resolve(jsonResponse(200, { items: [], page: 1, pageSize: 1, total: 4 }));
      return Promise.resolve(jsonResponse(404, { title: "x", status: 404 }));
    });
    renderPage();
    expect(await screen.findByText("No deviations in the data read so far.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Filters" }));
    await user.click(screen.getByRole("combobox", { name: "Severity" }));
    await user.click(await screen.findByRole("option", { name: "Info" }));
    expect(await screen.findByText("Updating the list…")).toBeInTheDocument();
    expect(screen.queryByText("No items match the filters.")).not.toBeInTheDocument();
    expect(screen.queryByText("No deviations in the data read so far.")).not.toBeInTheDocument();
    release(jsonResponse(200, view({ items: [] })));
    expect(await screen.findByText("No items match the filters.")).toBeInTheDocument();
    expect(screen.queryByText("Updating the list…")).not.toBeInTheDocument();
  });

  test("a project scope reads 'Show everything' ON, and turning it off sends all=false", async () => {
    const user = userEvent.setup();
    doc = view();
    renderPage("/deviations?projectId=7");
    await screen.findByRole("table", { name: "Differences between the plan and Jira" });
    await user.click(screen.getByRole("button", { name: /Filters/ }));
    const toggle = screen.getByRole("switch", { name: "Show everything" });
    expect(toggle).toBeChecked();
    await user.click(toggle);
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/deviations?projectId=7&all=false"));
    expect(screen.getByRole("switch", { name: "Show everything" })).not.toBeChecked();
    expect(mockFetch.mock.calls.at(-1)?.[0]).toBe("/api/v1/views/deviations?projectId=7&all=false");
    await user.click(screen.getByRole("switch", { name: "Show everything" }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/deviations?projectId=7&all=true"));
  });

  test("filters that match nothing say so and can be cleared in one click", async () => {
    const user = userEvent.setup();
    doc = view({ items: [] });
    renderPage("/deviations?severity=INFO");
    expect(await screen.findByText("No items match the filters.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear the filters" }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(/^\/deviations$/));
  });
});
