import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { QueryClient } from "@tanstack/react-query";
import { renderWithProviders, screen, waitFor, within } from "../test/render";
import { headingOutline } from "../test/headings";
import { jsonResponse } from "../test/http";
import { CAPACITY_CONNECTION, GONE_ROW, NO_FLOW_VIEW, capacityItem, capacityView, differsRow, flowTeam, missingRow } from "../test/flow";
import type { CapacityDeviationView } from "../api/capacityDeviations";
import type { DeviationFilter } from "../api/deviations";
import CapacityDeviationsSection from "./CapacityDeviationsSection";

const VIEW_URL = "/api/v1/views/capacity-deviations";
const TEAMS_URL = "/api/v1/integrations/flow/teams?connectionId=1";
const RUNS_URL = "/api/v1/integrations/sync/runs";
// Five minutes after the connection was read, so "Data as of" reads "5 minutes ago".
const NOW = CAPACITY_CONNECTION.teamsAt! + 5 * 60_000;
type FetchMock = ReturnType<typeof vi.fn>;

let doc: CapacityDeviationView;
let docStatus: number;
let linked: boolean;
let teamsStatus: number;
let claim: Response;

function serve(mockFetch: FetchMock) {
  mockFetch.mockImplementation((url: string, init?: RequestInit) => {
    if (url.startsWith(VIEW_URL)) return Promise.resolve(docStatus === 200 ? jsonResponse(200, doc) : jsonResponse(docStatus, { title: "x", status: docStatus }));
    if (url === TEAMS_URL) {
      const items = [flowTeam({ flowTeamId: 12, name: "Payments Flow", bindingId: linked ? 5 : null }), flowTeam({ flowTeamId: 13, name: "Design System" })];
      return Promise.resolve(teamsStatus === 200 ? jsonResponse(200, { connectionId: 1, teamsAt: CAPACITY_CONNECTION.teamsAt, items }) : jsonResponse(teamsStatus, { title: "x", status: teamsStatus }));
    }
    if (url === RUNS_URL && init?.method === "POST") return Promise.resolve(claim.clone());
    return Promise.resolve(jsonResponse(404, { title: "x", status: 404 }));
  });
}

const renderSection = (filter: DeviationFilter = {}, admin = false) => renderWithProviders(<CapacityDeviationsSection filter={filter} admin={admin} />);

describe("CapacityDeviationsSection", () => {
  let mockFetch: FetchMock;
  const viewCalls = () => mockFetch.mock.calls.map(([url]) => url as string).filter((url) => url.startsWith(VIEW_URL));
  const claims = () => mockFetch.mock.calls.filter(([url, init]) => url === RUNS_URL && (init as RequestInit | undefined)?.method === "POST");
  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    localStorage.setItem("astrolabe.auth.token", "fake-token");
    localStorage.setItem("astrolabe.auth.roles", JSON.stringify(["USER"]));
    doc = capacityView();
    docStatus = 200;
    linked = true;
    teamsStatus = 200;
    claim = jsonResponse(202, { id: 10, kind: "FLOW", connectionId: 1, running: true, outcome: null, finishedAt: null, startedAt: NOW });
    serve(mockFetch);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  describe("when there is nothing to show", () => {
    test("a stack without a Flow connection sees nothing of it: no heading, no table", async () => {
      doc = NO_FLOW_VIEW;
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const { container } = renderWithProviders(<CapacityDeviationsSection filter={{}} admin={false} />, { queryClient });
      // The document has arrived (so this is not the loading state) and the section still draws nothing.
      await waitFor(() => expect(queryClient.getQueryCache().findAll({ queryKey: ["flow", "deviations"] })[0]?.state.status).toBe("success"));
      // Only the theme's own <style> is in the container.
      expect(container.querySelectorAll(":not(style)")).toHaveLength(0);
      expect(screen.queryByRole("heading")).not.toBeInTheDocument();
      expect(screen.queryByRole("table")).not.toBeInTheDocument();
    });

    test("a failed load is the heading and an inline alert, not a silent gap", async () => {
      docStatus = 500;
      renderSection();
      expect(await screen.findByRole("alert")).toHaveTextContent("Could not load the capacity comparison with Flow");
      expect(headingOutline()).toEqual([[3, "Capacity from Flow"]]);
    });

    test("no team is linked to Flow", async () => {
      doc = capacityView({ items: [] });
      linked = false;
      renderSection();
      expect(await screen.findByText("No team is linked to Flow yet.")).toBeInTheDocument();
      expect(screen.getByText("Link a team from its page (Link to Flow team…).")).toBeInTheDocument();
      expect(screen.queryByRole("table", { name: "Capacity differences between the plan and Flow" })).not.toBeInTheDocument();
    });

    test("every linked team is in line: the claim is DATED by the data read, never in the present tense", async () => {
      doc = capacityView({ items: [] });
      renderSection();
      expect(await screen.findByText("In line with Flow in the data read at 2026-11-08 09:40 (UTC).")).toBeInTheDocument();
      expect(screen.getByText("Nothing has been checked since: refresh to read Flow again.")).toBeInTheDocument();
    });

    test("an in-line claim is withheld while a connection has no current refresh behind it", async () => {
      doc = capacityView({ items: [], connections: [{ ...CAPACITY_CONNECTION, status: { ...CAPACITY_CONNECTION.status, state: "FAILED" } }] });
      renderSection();
      expect(await screen.findByText("In line with Flow in the data read so far.")).toBeInTheDocument();
      expect(screen.queryByText(/data read at/)).not.toBeInTheDocument();
    });

    test("a filter that matches nothing says so, without asking which teams are linked", async () => {
      doc = capacityView({ items: [] });
      renderSection({ teamId: 3 });
      expect(await screen.findByText("No capacity difference matches the filters.")).toBeInTheDocument();
      expect(mockFetch.mock.calls.some(([url]) => url === TEAMS_URL)).toBe(false);
    });

    test("when the linked teams cannot be checked, that is an alert and not a claim", async () => {
      doc = capacityView({ items: [] });
      teamsStatus = 500;
      renderSection();
      expect(await screen.findByRole("alert")).toHaveTextContent("Could not check whether any team is linked to Flow");
      expect(screen.queryByText(/In line with Flow/)).not.toBeInTheDocument();
    });
  });

  describe("the teams", () => {
    test("one row per team: the team (a link), its Flow team, the sentences, how long ago Flow was seen; totals count the warnings, infos and gone teams", async () => {
      const worse = differsRow({ sprintId: 90003, sprintName: "E2E Flow Sprint 3", start: "2047-02-04", end: "2047-02-15", planMd: 44, flowMd: 48 });
      doc = capacityView({
        items: [
          capacityItem({ deviations: [differsRow(), worse] }),
          capacityItem({ bindingId: 6, team: { id: 2, name: "Billing" }, flowTeam: { id: 14, name: "Billing Flow" }, observedAt: null, deviations: [GONE_ROW] }),
        ],
      });
      renderSection();
      const table = await screen.findByRole("table", { name: "Capacity differences between the plan and Flow" });
      const group = screen.getByRole("group", { name: "Differences from Flow" });
      expect(group).toHaveTextContent("2 warnings");
      expect(group).toHaveTextContent("1 info");
      // A gone team is one of the warnings, so the badge reads as part of them, and is orange like them.
      const gone = within(group).getByText("of which 1 team gone from Flow");
      expect(gone.closest(".mantine-Badge-root")?.getAttribute("style")).toContain("orange");
      expect(group).toHaveTextContent("2 teams shown");
      const [, payments, billing] = within(table).getAllByRole("row");
      expect(within(payments).getByRole("link", { name: "Open team Payments" })).toHaveAttribute("href", "/teams/1");
      expect(payments).toHaveTextContent("Payments Flow");
      expect(payments).toHaveTextContent("E2E Flow Sprint 2 (2047-01-21 – 2047-02-01): the plan has 36.00 man-days, Flow 30.00 — 6.00 more in the plan");
      expect(payments).toHaveTextContent("E2E Flow Sprint 3 (2047-02-04 – 2047-02-15): the plan has 44.00 man-days, Flow 48.00 — 4.00 less in the plan");
      expect(within(payments).getByText("5 minutes ago")).toHaveAttribute("title", "2026-11-08 09:40");
      expect(billing).toHaveTextContent("The Flow team is no longer in Flow's document");
      expect(within(billing).getByText("—")).toBeInTheDocument();
      // The severity is said in words before each kind badge.
      expect(within(billing).getByText("Warning:", { exact: false })).toBeInTheDocument();
    });

    test("a team's sprints without capacity are ONE line with a disclosure over them; the sentences of the sprints that differ stay in the open", async () => {
      const missing = [0, 1, 2, 3, 4, 5].map((n) => missingRow(90001 + n, `2047-0${n + 1}-07`, `2047-0${n + 1}-18`));
      doc = capacityView({ items: [capacityItem({ deviations: [...missing, differsRow({ sprintId: 90009, sprintName: "E2E Flow Sprint 9", start: "2047-09-02", end: "2047-09-13" })] })] });
      renderSection();
      const table = await screen.findByRole("table", { name: "Capacity differences between the plan and Flow" });
      expect(table).toHaveTextContent("6 sprints without capacity in the plan (from 2047-01-07)");
      expect(table).toHaveTextContent("E2E Flow Sprint 9 (2047-09-02 – 2047-09-13): the plan has 36.00 man-days");
      // 6 sprints are not 6 sentences: only the header and the one team row.
      expect(within(table).getAllByRole("row")).toHaveLength(2);
      expect(screen.queryByRole("table", { name: "Sprints without capacity in the plan" })).not.toBeInTheDocument();
      const toggle = screen.getByRole("button", { name: "Show the sprints" });
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      await userEvent.click(toggle);
      const sprints = await screen.findByRole("table", { name: "Sprints without capacity in the plan" });
      expect(within(sprints).getAllByRole("row")).toHaveLength(7);
      expect(sprints).toHaveTextContent("2047-01-07 – 2047-01-18");
      expect(sprints).toHaveTextContent("40.00");
      await userEvent.click(screen.getByRole("button", { name: "Hide the sprints" }));
      expect(screen.queryByRole("table", { name: "Sprints without capacity in the plan" })).not.toBeInTheDocument();
    });

    test("a single sprint without capacity is its sentence, with no disclosure", async () => {
      doc = capacityView({ items: [capacityItem({ deviations: [missingRow(90001, "2047-01-07", "2047-01-18")] })] });
      renderSection();
      expect(await screen.findByText("E2E Flow Sprint 1 (2047-01-07 – 2047-01-18): no capacity in the plan, Flow has 40.00 man-days")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Show the sprints" })).not.toBeInTheDocument();
    });

    test("with several connections the Flow team names its connection; with one it does not", async () => {
      const second = { ...CAPACITY_CONNECTION, id: 2, name: "Beta Flow" };
      doc = capacityView({ connections: [CAPACITY_CONNECTION, second], items: [capacityItem({ connectionId: 2 })] });
      renderSection();
      const table = await screen.findByRole("table", { name: "Capacity differences between the plan and Flow" });
      expect(within(table).getByText("Beta Flow")).toBeInTheDocument();
      expect(within(table).queryByText("Acme Flow")).not.toBeInTheDocument();
    });

    test("a list cut by the server says how many teams matched", async () => {
      doc = capacityView({ truncated: true, totals: { warnings: 1200, infos: 0, gone: 0, teams: 1200 } });
      renderSection();
      expect(await screen.findByText("1 of 1200 teams shown")).toBeInTheDocument();
    });

    test("a row of a disabled or not-current connection is marked stale like the Jira table's; a current one is not", async () => {
      const second = { ...CAPACITY_CONNECTION, id: 2, name: "Beta Flow", enabled: false, status: { ...CAPACITY_CONNECTION.status, state: "DISABLED" as const } };
      doc = capacityView({
        connections: [CAPACITY_CONNECTION, second],
        items: [capacityItem(), capacityItem({ bindingId: 6, connectionId: 2, team: { id: 2, name: "Billing" }, flowTeam: { id: 14, name: "Billing Flow" } })],
      });
      renderSection();
      const table = await screen.findByRole("table", { name: "Capacity differences between the plan and Flow" });
      const [, payments, billing] = within(table).getAllByRole("row");
      expect(payments).not.toHaveTextContent("stale");
      expect(billing).toHaveTextContent("5 minutes ago");
      expect(billing).toHaveTextContent("stale");
    });

    test("a failed re-read keeps the last answer on screen under an alert", async () => {
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      renderWithProviders(<CapacityDeviationsSection filter={{}} admin={false} />, { queryClient });
      await screen.findByRole("table", { name: "Capacity differences between the plan and Flow" });
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      docStatus = 500;
      await queryClient.refetchQueries({ queryKey: ["flow", "deviations"] });
      expect(await screen.findByRole("alert")).toHaveTextContent("Could not load the capacity comparison with Flow");
      expect(screen.getByRole("table", { name: "Capacity differences between the plan and Flow" })).toHaveTextContent("E2E Flow Sprint 2");
      expect(screen.getByRole("table", { name: "Data from Flow" })).toBeInTheDocument();
    });

    test("the linked-teams check is not polled for ever: it re-reads on focus and on a link or unlink, nothing more", async () => {
      doc = capacityView({ items: [] });
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      renderWithProviders(<CapacityDeviationsSection filter={{}} admin={false} />, { queryClient });
      await screen.findByText(/In line with Flow in the data read at/);
      expect(queryClient.getQueryCache().find({ queryKey: ["flow", "teams", 1] })?.observers[0].options.refetchInterval).toBeUndefined();
    });

    test("a cut list says it was cut, and the heading outline is h3, then the two h4 blocks", async () => {
      doc = capacityView({ truncated: true });
      renderSection();
      expect(await screen.findByText("Only the first 1 teams are listed. The warning and info counts cover every match; narrow the filters to see the rest.")).toBeInTheDocument();
      expect(headingOutline()).toEqual([
        [3, "Capacity from Flow"],
        [4, "Data from Flow"],
        [4, "Differences from Flow"],
      ]);
    });
  });

  describe("the filters", () => {
    test("it asks for the page's team and severity only; the Jira list's other filters are named as not applying", async () => {
      doc = capacityView({ items: [] });
      renderSection({ teamId: 3, severity: "WARNING", projectId: 7, level: "MILESTONE", acknowledged: true });
      await screen.findByText("No capacity difference matches the filters.");
      expect(viewCalls()).toEqual([`${VIEW_URL}?teamId=3&severity=WARNING`]);
      expect(screen.getByText(/filters do not apply to this section; the team and severity filters do/)).toBeInTheDocument();
    });

    test("with only the shared filters, or none, the note is absent", async () => {
      renderSection({ teamId: 3, severity: "INFO" });
      await screen.findByRole("table", { name: "Capacity differences between the plan and Flow" });
      expect(screen.queryByText(/filters do not apply/)).not.toBeInTheDocument();
    });

    test("while the answer for a new filter is on its way the kept one makes no empty-state claim", async () => {
      doc = capacityView({ items: [] });
      const view = renderSection({ teamId: 3 });
      await screen.findByText("No capacity difference matches the filters.");
      mockFetch.mockImplementation((url: string) => (url.startsWith(VIEW_URL) ? new Promise<Response>(() => {}) : Promise.resolve(jsonResponse(404, { title: "x", status: 404 }))));
      view.rerender(<CapacityDeviationsSection filter={{ teamId: 4 }} admin={false} />);
      expect(await screen.findByText("Updating the list…")).toBeInTheDocument();
      expect(screen.queryByText("No capacity difference matches the filters.")).not.toBeInTheDocument();
    });
  });

  describe("Data from Flow", () => {
    test("one row per connection: its state, when its document was read, and nothing to refresh for a plain viewer", async () => {
      renderSection();
      const sources = await screen.findByRole("table", { name: "Data from Flow" });
      const row = within(sources).getByRole("row", { name: /Acme Flow/ });
      expect(row).toHaveTextContent("Current");
      expect(row).toHaveTextContent("2026-11-08 09:40");
      expect(within(sources).queryByRole("link")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Refresh now/ })).not.toBeInTheDocument();
      expect(screen.queryByText(/may be out of date/)).not.toBeInTheDocument();
    });

    test("an administrator gets the connection's page and Refresh now, which claims a FLOW run and re-reads the Flow queries only", async () => {
      localStorage.setItem("astrolabe.auth.roles", JSON.stringify(["ADMIN"]));
      renderSection({}, true);
      expect(await screen.findByRole("link", { name: "Open connection Acme Flow" })).toHaveAttribute("href", "/integrations/flow/1");
      await userEvent.click(screen.getByRole("button", { name: "Refresh now: Acme Flow" }));
      await waitFor(() => expect(claims()).toHaveLength(1));
      expect(JSON.parse((claims()[0][1] as RequestInit).body as string)).toEqual({ kind: "FLOW", connectionId: 1 });
      await waitFor(() => expect(viewCalls().length).toBeGreaterThan(1));
      expect(mockFetch.mock.calls.some(([url]) => /\/api\/v1\/views\/(plan|project|team|roadmap|programs|deviations)/.test(url as string))).toBe(false);
    });

    test("a 409 run-in-progress is a normal state; a 403 is an inline message", async () => {
      localStorage.setItem("astrolabe.auth.roles", JSON.stringify(["ADMIN"]));
      claim = jsonResponse(409, { type: "urn:astrolabe:problem:run-in-progress", title: "Conflict", status: 409, detail: "running" });
      renderSection({}, true);
      await userEvent.click(await screen.findByRole("button", { name: "Refresh now: Acme Flow" }));
      await waitFor(() => expect(claims()).toHaveLength(1));
      expect(screen.queryByText("The refresh could not be started")).not.toBeInTheDocument();
      claim = jsonResponse(403, { title: "Forbidden", status: 403 });
      await userEvent.click(screen.getByRole("button", { name: "Refresh now: Acme Flow" }));
      expect(await screen.findByText("Only administrators can refresh")).toBeInTheDocument();
    });

    test("a run the server says is running is told, and Refresh now waits for it", async () => {
      localStorage.setItem("astrolabe.auth.roles", JSON.stringify(["ADMIN"]));
      doc = capacityView({ connections: [{ ...CAPACITY_CONNECTION, status: { ...CAPACITY_CONNECTION.status, lastRun: { ...CAPACITY_CONNECTION.status.lastRun!, outcome: null, finishedAt: null, running: true } } }] });
      renderSection({}, true);
      expect(await screen.findByText("A refresh is running. This page updates by itself.")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Refresh now: Acme Flow" })).toBeDisabled();
    });

    test("a failed refresh is told with its reason and warns that the list may be out of date", async () => {
      doc = capacityView({
        connections: [
          {
            ...CAPACITY_CONNECTION,
            status: { ...CAPACITY_CONNECTION.status, state: "FAILED", consecutiveFailures: 1, lastRun: { ...CAPACITY_CONNECTION.status.lastRun!, outcome: "FAILED", errorCode: "AUTHENTICATION_FAILED" } },
          },
        ],
      });
      renderSection();
      const sources = await screen.findByRole("table", { name: "Data from Flow" });
      expect(sources).toHaveTextContent("The last refresh failed: Flow rejected the token");
      // The code stays visible beside the sentence.
      expect(sources).toHaveTextContent("(AUTHENTICATION_FAILED)");
      expect(screen.getByText(/the list below may be out of date/)).toBeInTheDocument();
    });

    test("a connection that never read Flow says so, and one that is disabled is marked and its refresh is off", async () => {
      localStorage.setItem("astrolabe.auth.roles", JSON.stringify(["ADMIN"]));
      doc = capacityView({
        connections: [{ ...CAPACITY_CONNECTION, enabled: false, teamsAt: null, status: { state: "DISABLED", lastRun: null, lastSucceededAt: null, consecutiveFailures: 0, nextPollAt: null } }],
      });
      renderSection({}, true);
      const sources = await screen.findByRole("table", { name: "Data from Flow" });
      expect(sources).toHaveTextContent("Disabled");
      expect(sources).toHaveTextContent("Not read yet");
      expect(sources).toHaveTextContent("No refresh has finished yet: Flow has not been read, so there is nothing to compare with.");
      expect(sources).toHaveTextContent("The connection is disabled: Flow is not read again and its teams show what was last read.");
      expect(screen.getByRole("button", { name: "Refresh now: Acme Flow" })).toBeDisabled();
      // A disabled connection has its own note; the banner is for the enabled ones.
      expect(screen.queryByText(/the list below may be out of date/)).not.toBeInTheDocument();
    });

    test("a connection whose last success is older than expected is stale, in orange words and in the banner", async () => {
      doc = capacityView({ connections: [{ ...CAPACITY_CONNECTION, status: { ...CAPACITY_CONNECTION.status, state: "STALE" } }] });
      renderSection();
      expect(await screen.findByText("The last successful refresh is older than expected: the figures may be out of date.")).toBeInTheDocument();
      expect(screen.getByText(/the list below may be out of date/)).toBeInTheDocument();
    });
  });
});
