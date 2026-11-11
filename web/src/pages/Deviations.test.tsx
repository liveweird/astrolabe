import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { Route, Routes, useLocation } from "react-router-dom";
import { renderWithProviders, screen, waitFor, within } from "../test/render";
import { headingOutline } from "../test/headings";
import { jsonResponse } from "../test/http";
import { DEV_CONNECTION, detail, item, NOW, view } from "../test/deviations";
import { NO_FLOW_VIEW, capacityItem, capacityView, differsRow, missingRow } from "../test/flow";
import type { CapacityDeviationView } from "../api/capacityDeviations";
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
// The capacity deviations document (the page's second section): a Jira-only stack unless a test says otherwise.
let capDoc: CapacityDeviationView;
let capStatus: number;
beforeEach(() => {
  capDoc = NO_FLOW_VIEW;
  capStatus = 200;
});

function serve(mockFetch: FetchMock) {
  mockFetch.mockImplementation((url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url.startsWith("/api/v1/views/deviations")) return Promise.resolve(jsonResponse(200, doc));
    if (url.startsWith("/api/v1/views/capacity-deviations")) return Promise.resolve(capStatus === 200 ? jsonResponse(200, capDoc) : jsonResponse(capStatus, { title: "x", status: capStatus }));
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

  test("the Jira cell shows the epic's roll-up under the summary (name = the sentence); an item without one shows none", async () => {
    const withRollup = item({ jira: { ...item().jira, rollup: { children: 4, done: 2, points: 13, observedAt: NOW - 60_000 } } });
    const plain = item({ bindingId: 2, node: { ...item().node, id: 12, name: "Docs" }, jira: { ...item().jira, key: "E2E-4" } });
    doc = view({ items: [withRollup, plain] });
    renderPage();
    const table = await screen.findByRole("table", { name: "Differences between the plan and Jira" });
    const rows = within(table).getAllByRole("row");
    const first = rows.find((row) => row.textContent?.includes("Checkout page"));
    const second = rows.find((row) => row.textContent?.includes("Docs"));
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(within(first as HTMLElement).getByText("2/4 · 13 pt")).toHaveAttribute("aria-hidden", "true");
    expect(within(first as HTMLElement).getByText("4 child issues in Jira, done: 2, story points: 13")).toBeInTheDocument();
    expect(within(first as HTMLElement).getByTitle("4 child issues in Jira, done: 2, story points: 13")).toHaveTextContent("2/4 · 13 pt");
    expect(second).not.toHaveTextContent("child issues");
    expect(second).not.toHaveTextContent("pt");
  });

  test("the coverage deviations read as their sentences, with the 'and N more' rule", async () => {
    const keys = Array.from({ length: 10 }, (_, i) => `COV-${i + 1}`).join(", ");
    doc = view({
      items: [
        item({
          level: "PROJECT",
          node: { ...item().node, kind: "PROJECT", name: "Cover", teamId: null, teamName: null },
          deviations: [
            { kind: "UNLINKED_IN_JIRA", severity: "WARNING", detail: detail({ jira: keys, count: 12 }), acknowledgement: null },
            { kind: "UNLINKED_IN_PLAN", severity: "INFO", detail: detail({ plan: "Unlinked one", count: 1 }), acknowledgement: null },
          ],
        }),
      ],
    });
    renderPage();
    const table = await screen.findByRole("table", { name: "Differences between the plan and Jira" });
    expect(within(table).getByText(`12 Jira items are not in the plan: ${keys} and 2 more`)).toBeInTheDocument();
    expect(within(table).getByText("1 plan item is not linked to Jira: Unlinked one")).toBeInTheDocument();
    expect(within(table).getByText("Not in plan")).toBeInTheDocument();
    expect(within(table).getByText("Not in Jira")).toBeInTheDocument();
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
        item({ bindingId: 2, connectionId: 2, node: { ...item().node, id: 12, name: "Gone one" }, jira: { ...item().jira, key: "OLD-1", gone: true }, deviations: [{ kind: "GONE", severity: "WARNING", detail: detail({ jira: "OUT_OF_SCOPE" }), acknowledgement: null }] }),
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

  test("a probed-readable gone item reads 'Moved out' or 'Not listed' in its sentence and badge; an unprobed one keeps the wide phrase", async () => {
    const gone = (bindingId: number, key: string, reason: "MOVED_OUT" | "NOT_LISTED" | "OUT_OF_SCOPE") =>
      item({ bindingId, node: { ...item().node, id: 10 + bindingId, name: `Gone ${key}` }, jira: { ...item().jira, key, gone: true }, deviations: [{ kind: "GONE", severity: "WARNING", detail: detail({ jira: reason }), acknowledgement: null }] });
    doc = view({ items: [gone(1, "OLD-1", "MOVED_OUT"), gone(2, "OLD-2", "OUT_OF_SCOPE"), gone(3, "OLD-3", "NOT_LISTED")] });
    renderPage("/deviations?all=true");
    const table = await screen.findByRole("table", { name: "Differences between the plan and Jira" });
    expect(within(table).getByText("Moved out of the connection's projects (Jira still has it)")).toBeInTheDocument();
    expect(within(table).getByText("Moved out of scope")).toBeInTheDocument();
    expect(within(table).getByText("Still in the connection's projects, but Jira no longer lists it (archived, or its type changed)")).toBeInTheDocument();
    expect(within(table).getByText("Not listed by Jira")).toBeInTheDocument();
    expect(within(table).getAllByText("Gone from Jira")).toHaveLength(1);
    expect(within(table).getByText(/No longer readable in Jira: deleted, moved out/)).toBeInTheDocument();
  });

  describe("the gone totals split (1.13)", () => {
    const goneItem = (bindingId: number, reason: "MOVED_OUT" | "NOT_LISTED" | "OUT_OF_SCOPE" | "DELETED") =>
      item({ bindingId, node: { ...item().node, id: 10 + bindingId, name: `Gone ${bindingId}` }, jira: { ...item().jira, key: `OLD-${bindingId}`, gone: true }, deviations: [{ kind: "GONE", severity: "WARNING", detail: detail({ jira: reason }), acknowledgement: null }] });

    test("one badge for the items Jira cannot show, one for the ones still in Jira out of scope", async () => {
      doc = view({ items: [goneItem(1, "MOVED_OUT"), goneItem(2, "NOT_LISTED"), goneItem(3, "OUT_OF_SCOPE"), goneItem(4, "DELETED")] });
      expect(doc.totals).toMatchObject({ gone: 4, stillInJira: 2 });
      renderPage();
      expect(await screen.findByText("2 gone from Jira")).toBeInTheDocument();
      expect(screen.getByText("2 still in Jira, out of scope")).toBeInTheDocument();
    });

    test("the first badge is hidden when every gone item is still in Jira, with the singular form", async () => {
      doc = view({ items: [goneItem(1, "MOVED_OUT")] });
      renderPage();
      expect(await screen.findByText("1 still in Jira, out of scope")).toBeInTheDocument();
      expect(screen.queryByText(/gone from Jira/)).not.toBeInTheDocument();
    });

    test("the second badge is hidden at 0", async () => {
      doc = view({ items: [goneItem(1, "DELETED")] });
      renderPage();
      expect(await screen.findByText("1 gone from Jira")).toBeInTheDocument();
      expect(screen.queryByText(/still in Jira/)).not.toBeInTheDocument();
    });
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

  test("each connection's derived status is a badge in the sources table, with its failure streak or next poll", async () => {
    const failed = { ...run, outcome: "FAILED" as const, errorCode: "TIMEOUT" };
    doc = view({
      connections: [
        { ...DEV_CONNECTION, lastRun: failed, status: { state: "FAILED", lastRun: failed, lastSucceededAt: null, consecutiveFailures: 2, nextPollAt: NOW } },
        { ...DEV_CONNECTION, id: 2, name: "Second Jira", status: { ...DEV_CONNECTION.status, state: "STALE", nextPollAt: Date.now() + 4 * 60_000 - 5_000 } },
      ],
    });
    renderPage();
    const sources = await screen.findByRole("table", { name: "Data from Jira" });
    expect(within(sources).getByRole("columnheader", { name: "Status" })).toBeInTheDocument();
    const first = within(sources).getByText("Acme Jira").closest("tr")!;
    expect(within(first).getByText("2 failures in a row · TIMEOUT")).toBeInTheDocument();
    const second = within(sources).getByText("Second Jira").closest("tr")!;
    expect(within(second).getByText("Stale")).toBeInTheDocument();
    expect(within(second).getByText("next poll in 4 min")).toBeInTheDocument();
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

  test("a refresh past the per-user bucket (429) reads in words, not as a bare status", async () => {
    localStorage.setItem(ROLES_KEY, JSON.stringify(["ADMIN"]));
    claim = jsonResponse(429, { title: "Too Many Requests", status: 429 });
    doc = view({ connections: [{ ...DEV_CONNECTION, lastRun: { ...DEV_CONNECTION.lastRun!, outcome: null, finishedAt: null, running: false } }] });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Refresh now: Acme Jira" }));
    expect(await screen.findByText("Too many requests. Wait a minute and try again.")).toBeInTheDocument();
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
    doc = view({ items: [], totals: { warnings: 0, infos: 0, bindings: 0, gone: 0, stillInJira: 0, acknowledged: 0 } });
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

describe("Deviations page - Capacity from Flow (the second section)", () => {
  let mockFetch: FetchMock;
  const capCalls = () => mockFetch.mock.calls.map(([url]) => url as string).filter((url) => url.startsWith("/api/v1/views/capacity-deviations"));
  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    localStorage.setItem("astrolabe.auth.token", "fake-token");
    localStorage.setItem(ROLES_KEY, JSON.stringify(["USER"]));
    doc = view();
    bindingsTotal = 1;
    claim = jsonResponse(202, {});
    serve(mockFetch);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  test("a stack without a Flow connection shows the page exactly as before: still asks, draws nothing", async () => {
    renderPage();
    await screen.findByRole("table", { name: "Differences between the plan and Jira" });
    await waitFor(() => expect(capCalls()).toHaveLength(1));
    expect(headingOutline()).toEqual([
      [2, "Deviations"],
      [3, "Data from Jira"],
      [3, "Differences"],
    ]);
    expect(screen.queryByText("Capacity from Flow")).not.toBeInTheDocument();
  });

  test("with a Flow connection the section comes after the Jira list, as another h3, with its own sources and teams", async () => {
    capDoc = capacityView();
    renderPage();
    const teams = await screen.findByRole("table", { name: "Capacity differences between the plan and Flow" });
    expect(headingOutline()).toEqual([
      [2, "Deviations"],
      [3, "Data from Jira"],
      [3, "Differences"],
      [3, "Capacity from Flow"],
      [4, "Data from Flow"],
      [4, "Differences from Flow"],
    ]);
    const jira = screen.getByRole("table", { name: "Differences between the plan and Jira" });
    // Document order: the Jira list first, the Flow section after it.
    expect(jira.compareDocumentPosition(teams) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(teams).getByRole("link", { name: "Open team Payments" })).toBeInTheDocument();
    // The Jira totals are still the Jira ones.
    expect(screen.getAllByText("1 warning")).toHaveLength(2);
  });

  test("the team and severity of the URL go to the Flow document; the Jira-only filters do not, and the section says so", async () => {
    capDoc = capacityView();
    renderPage("/deviations?teamId=1&severity=WARNING&projectId=7");
    await screen.findByRole("table", { name: "Capacity differences between the plan and Flow" });
    expect(capCalls()).toEqual(["/api/v1/views/capacity-deviations?teamId=1&severity=WARNING"]);
    expect(screen.getByText(/filters do not apply to this section/)).toBeInTheDocument();
  });

  test("a Flow section that fails leaves the Jira list alone, and a Jira list that fails leaves the Flow section alone", async () => {
    capDoc = capacityView();
    capStatus = 500;
    const failed = renderPage();
    await screen.findByRole("table", { name: "Differences between the plan and Jira" });
    expect(await screen.findByText("Could not load the capacity comparison with Flow")).toBeInTheDocument();
    failed.unmount();

    capStatus = 200;
    mockFetch.mockImplementation((url: string) => {
      if (url.startsWith("/api/v1/views/capacity-deviations")) return Promise.resolve(jsonResponse(200, capDoc));
      return Promise.resolve(jsonResponse(500, { title: "x", status: 500 }));
    });
    renderPage();
    expect(await screen.findByText("Could not load the deviations")).toBeInTheDocument();
    expect(await screen.findByRole("table", { name: "Capacity differences between the plan and Flow" })).toBeInTheDocument();
  });

  test("the sprints without capacity fold into one line on the page too", async () => {
    capDoc = capacityView({ items: [capacityItem({ deviations: [0, 1, 2].map((n) => missingRow(90001 + n, `2047-0${n + 1}-07`, `2047-0${n + 1}-18`)) })] });
    renderPage();
    const teams = await screen.findByRole("table", { name: "Capacity differences between the plan and Flow" });
    expect(teams).toHaveTextContent("3 sprints without capacity in the plan (from 2047-01-07)");
    expect(within(teams).getAllByRole("row")).toHaveLength(2);
    expect(screen.getByRole("group", { name: "Differences from Flow" })).toHaveTextContent("3 infos");
  });

  test("a warning row is orange and an info row gray, with the severity in words", async () => {
    capDoc = capacityView({ items: [capacityItem({ deviations: [differsRow(), differsRow({ sprintId: 90003, sprintName: "E2E Flow Sprint 3", planMd: 20 })] })] });
    renderPage();
    const teams = await screen.findByRole("table", { name: "Capacity differences between the plan and Flow" });
    const [warning, info] = within(teams).getAllByRole("listitem");
    expect(within(warning).getByText("Warning:", { exact: false })).toBeInTheDocument();
    expect(within(info).getByText("Info:", { exact: false })).toBeInTheDocument();
    expect(warning.querySelector(".mantine-Badge-root")?.getAttribute("style")).toContain("orange");
    expect(info.querySelector(".mantine-Badge-root")?.getAttribute("style")).toContain("gray");
  });
});
