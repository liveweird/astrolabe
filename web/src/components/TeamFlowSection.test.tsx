import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { QueryClient } from "@tanstack/react-query";
import { renderWithProviders, screen, waitFor, within } from "../test/render";
import { jsonResponse } from "../test/http";
import { headingOutline } from "../test/headings";
import { APPLIED, GONE_ROW, PREVIEW, UNLINKED_PANEL, capacityItem, capacityView, differsRow, flowTeam, linkedPanel, missingRow, panelBinding } from "../test/flow";
import type { CapacityDeviationView } from "../api/capacityDeviations";
import type { FlowTeamPanel } from "../api/flow";
import TeamFlowSection from "./TeamFlowSection";

const PANEL_URL = "/api/v1/teams/1/flow";
type FetchMock = ReturnType<typeof vi.fn>;
type World = { panel: FlowTeamPanel; panelStatus: number; capacity: CapacityDeviationView; capacityStatus: number; respond: Record<string, () => Response> };
const CAPACITY_URL = "/api/v1/views/capacity-deviations?teamId=1";
// What the remedy line promises: a preview of the changes, hand-entered periods untouched, a Flow 0 ticked by hand (never "brings the plan in line").
const REMEDY = "Import capacity… shows what an import would change. Hand-entered periods are left as they are, and a sprint where Flow has 0 must be ticked by hand.";

function serve(mockFetch: FetchMock, overrides: Partial<World> = {}) {
  const world: World = { panel: UNLINKED_PANEL, panelStatus: 200, capacity: capacityView({ items: [] }), capacityStatus: 200, respond: {}, ...overrides };
  mockFetch.mockImplementation((url: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${url}`;
    if (world.respond[key]) return Promise.resolve(world.respond[key]());
    if (key === `GET ${PANEL_URL}`) return Promise.resolve(world.panelStatus === 200 ? jsonResponse(200, world.panel) : jsonResponse(world.panelStatus, { title: "x", status: world.panelStatus }));
    if (key === `GET ${CAPACITY_URL}`) return Promise.resolve(world.capacityStatus === 200 ? jsonResponse(200, world.capacity) : jsonResponse(world.capacityStatus, { title: "x", status: world.capacityStatus }));
    return Promise.resolve(jsonResponse(404, { title: "x", status: 404 }));
  });
  return world;
}
const count = (mockFetch: FetchMock, key: string) => mockFetch.mock.calls.filter(([url, init]) => `${(init as RequestInit | undefined)?.method ?? "GET"} ${url}` === key).length;

const renderSection = (props: { importBlocked?: boolean; queryClient?: QueryClient } = {}) =>
  renderWithProviders(<TeamFlowSection teamId={1} importBlocked={props.importBlocked} />, { queryClient: props.queryClient });

describe("TeamFlowSection", () => {
  let mockFetch: FetchMock;
  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    localStorage.setItem("astrolabe.auth.token", "fake-token");
    localStorage.setItem("astrolabe.auth.roles", JSON.stringify(["ADMIN"]));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  describe("an unlinked team", () => {
    test("says so and offers the link to whoever may link it; the section is an h3", async () => {
      serve(mockFetch);
      renderSection();
      expect(await screen.findByText("Not linked to a Flow team")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Link to Flow team…" })).toBeInTheDocument();
      expect(headingOutline()).toEqual([[3, "Flow"]]);
      expect(screen.queryByRole("button", { name: "Import capacity…" })).not.toBeInTheDocument();
    });

    test("for anyone else it only says who can link it", async () => {
      serve(mockFetch, { panel: { ...UNLINKED_PANEL, can: { link: false, unlink: false, importCapacity: false } } });
      renderSection();
      expect(await screen.findByText("The team's manager or an administrator can link it to its Flow team.")).toBeInTheDocument();
      expect(screen.queryByRole("button")).not.toBeInTheDocument();
    });

    test("Link opens the dialog; a link re-reads the panel and shows the linked state", async () => {
      const world = serve(mockFetch);
      // A team manager, not an administrator: the dialog's connections come from the panel.
      localStorage.setItem("astrolabe.auth.roles", JSON.stringify(["USER"]));
      world.respond["GET /api/v1/integrations/flow/teams?connectionId=1"] = () =>
        jsonResponse(200, { connectionId: 1, teamsAt: 1, items: [flowTeam({ flowTeamId: 12, name: "Payments Flow", suggestedTeamId: 1, suggestedTeamName: "Payments" })] });
      world.respond["POST /api/v1/integrations/flow/team-bindings"] = () => {
        world.panel = linkedPanel();
        return jsonResponse(201, { id: 5, connectionId: 1, teamId: 1, teamName: "Payments", flowTeamId: 12, flowTeamName: "Payments Flow", createdAt: 1 });
      };
      renderSection();
      await userEvent.click(await screen.findByRole("button", { name: "Link to Flow team…" }));
      const dialog = await screen.findByRole("dialog", { name: "Link to a Flow team" });
      await waitFor(() => expect(within(dialog).getByRole("combobox", { name: "Flow team" })).toHaveValue("Payments Flow (suggested)"));
      await userEvent.click(within(dialog).getByRole("button", { name: "Link" }));
      expect(await screen.findByRole("table", { name: "Link to Flow" })).toBeInTheDocument();
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(count(mockFetch, `GET ${PANEL_URL}`)).toBe(2);
      // The focus rests on the section's heading, not on the body.
      await waitFor(() => expect(screen.getByRole("heading", { name: "Flow" })).toHaveFocus());
    });
  });

  describe("a linked team", () => {
    test("shows the Flow team, its connection, the status, when it was observed, the sprints and the roster", async () => {
      serve(mockFetch, { panel: linkedPanel() });
      renderSection();
      const facts = await screen.findByRole("table", { name: "Link to Flow" });
      expect(within(facts).getByRole("row", { name: /Flow team/ })).toHaveTextContent("Payments Flow");
      expect(within(facts).getByRole("row", { name: /Connection/ })).toHaveTextContent("Acme Flow");
      expect(within(facts).getByRole("row", { name: /Status/ })).toHaveTextContent("Current");
      expect(within(facts).getByRole("row", { name: /Observed/ })).toHaveTextContent("2026-11-08 09:40");
      expect(screen.getByText("Sprints read from Flow: 33 · the next starts 2026-11-09")).toBeInTheDocument();
      expect(screen.queryByText("No longer in Flow")).not.toBeInTheDocument();
      expect(screen.getByRole("table", { name: "Current members of the Flow team" })).toHaveTextContent("Ada Lovelace");
      expect(screen.getByRole("table", { name: "Current members of the Flow team" })).toHaveTextContent("Unknown account");
      expect(screen.getByRole("button", { name: "1 former member" })).toBeInTheDocument();
      expect(headingOutline()).toEqual([[3, "Flow"], [4, "Roster"]]);
    });

    test("without a next sprint the sprint line gives the count alone; an empty roster says so", async () => {
      serve(mockFetch, { panel: linkedPanel({ sprints: { count: 4, nextStart: null }, roster: { current: [], former: [] } }) });
      renderSection();
      expect(await screen.findByText("Sprints read from Flow: 4")).toBeInTheDocument();
      expect(screen.getByText("Flow lists no current members for this team.")).toBeInTheDocument();
    });

    test("a team that left Flow says so in orange, keeps the link, cannot import and has no roster", async () => {
      serve(mockFetch, { panel: linkedPanel({ binding: panelBinding({ gone: true }), roster: null, sprints: null }) });
      renderSection();
      const badge = await screen.findByText("No longer in Flow");
      expect(badge.closest(".mantine-Badge-root")).toHaveAttribute("data-variant", "light");
      expect(badge.closest(".mantine-Badge-root")?.getAttribute("style") ?? "").toContain("orange");
      expect(screen.getByText(/this team is not in it any more/)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Import capacity…" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Unlink" })).toBeEnabled();
      expect(screen.getByText("The roster is not available: the Flow team is gone from the last read.")).toBeInTheDocument();
    });

    test("a disabled connection is noted and the last data stays", async () => {
      serve(mockFetch, { panel: linkedPanel({ binding: panelBinding({ connectionEnabled: false, status: { state: "DISABLED", lastRun: null, lastSucceededAt: null, consecutiveFailures: 0, nextPollAt: null } }) }) });
      renderSection();
      expect(await screen.findByText(/The connection is disabled: Flow is not read again/)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Import capacity…" })).toBeEnabled();
    });

    test.each([
      [{ link: false, unlink: false, importCapacity: false }, [], ["Import capacity…", "Unlink"]],
      [{ link: false, unlink: true, importCapacity: false }, ["Unlink"], ["Import capacity…"]],
      [{ link: false, unlink: false, importCapacity: true }, ["Import capacity…"], ["Unlink"]],
    ])("the controls follow the panel's can %j", async (can, shown, hidden) => {
      serve(mockFetch, { panel: linkedPanel({ can }) });
      renderSection();
      await screen.findByRole("table", { name: "Link to Flow" });
      for (const name of shown) expect(screen.getByRole("button", { name })).toBeInTheDocument();
      for (const name of hidden) expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
      // The roster is for everyone.
      expect(screen.getByRole("table", { name: "Current members of the Flow team" })).toBeInTheDocument();
    });

    test("while a schedule proposal is open the import is disabled and says why", async () => {
      serve(mockFetch, { panel: linkedPanel() });
      renderSection({ importBlocked: true });
      expect(await screen.findByText("Capacity cannot be imported while a schedule proposal is open.")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Import capacity…" })).toBeDisabled();
    });

    test("an open import closes when a proposal opens", async () => {
      const world = serve(mockFetch, { panel: linkedPanel() });
      world.respond["POST /api/v1/integrations/flow/team-bindings/5/capacity-preview"] = () => jsonResponse(200, PREVIEW);
      const view = renderSection();
      await userEvent.click(await screen.findByRole("button", { name: "Import capacity…" }));
      expect(await screen.findByRole("dialog", { name: "Import capacity from Flow" })).toBeInTheDocument();
      view.rerender(<TeamFlowSection teamId={1} importBlocked />);
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    });

    test("a background re-read that fails keeps the data on screen with a small note, and no error alert", async () => {
      const world = serve(mockFetch, { panel: linkedPanel() });
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      renderSection({ queryClient });
      await screen.findByRole("table", { name: "Link to Flow" });
      world.panelStatus = 500;
      await queryClient.refetchQueries({ queryKey: ["flow", "team", 1] });
      expect(await screen.findByText("Could not refresh the Flow link; the last data read is shown.")).toBeInTheDocument();
      expect(screen.getByRole("table", { name: "Link to Flow" })).toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    test("a failed panel load is an alert", async () => {
      serve(mockFetch, { panelStatus: 404 });
      renderSection();
      expect(await screen.findByRole("alert")).toHaveTextContent("Could not load the Flow link");
    });
  });

  describe("Unlink", () => {
    test("asks in the page, then unlinks and re-reads the panel", async () => {
      const world = serve(mockFetch, { panel: linkedPanel() });
      world.respond["DELETE /api/v1/integrations/flow/team-bindings/5"] = () => {
        world.panel = UNLINKED_PANEL;
        return new Response(null, { status: 204 });
      };
      renderSection();
      await userEvent.click(await screen.findByRole("button", { name: "Unlink" }));
      const dialog = await screen.findByRole("dialog", { name: "Unlink the Flow team?" });
      expect(dialog).toHaveTextContent("This team will no longer be linked to Flow team “Payments Flow” (connection “Acme Flow”). Capacity already imported stays.");
      expect(count(mockFetch, "DELETE /api/v1/integrations/flow/team-bindings/5")).toBe(0);
      await userEvent.click(within(dialog).getByRole("button", { name: "Unlink" }));
      expect(await screen.findByText("Not linked to a Flow team")).toBeInTheDocument();
      expect(count(mockFetch, "DELETE /api/v1/integrations/flow/team-bindings/5")).toBe(1);
    });

    test.each([
      [403, "Only administrators or the team's manager can unlink it"],
      [404, "This link no longer exists — it was already removed"],
    ])("a %i is shown in the dialog, which stays open", async (status, sentence) => {
      const world = serve(mockFetch, { panel: linkedPanel() });
      world.respond["DELETE /api/v1/integrations/flow/team-bindings/5"] = () => jsonResponse(status, { title: "x", status });
      renderSection();
      await userEvent.click(await screen.findByRole("button", { name: "Unlink" }));
      const dialog = await screen.findByRole("dialog");
      await userEvent.click(within(dialog).getByRole("button", { name: "Unlink" }));
      expect(await within(dialog).findByRole("alert")).toHaveTextContent(sentence);
    });
  });

  describe("capacity against Flow", () => {
    const sprint = (n: number) => differsRow({ sprintId: 90000 + n, sprintName: `E2E Flow Sprint ${n}`, start: `2047-0${n}-01`, end: `2047-0${n}-12`, effectiveFrom: `2047-0${n}-01` });
    const factsRow = async () => within(await screen.findByRole("table", { name: "Link to Flow" })).findByRole("row", { name: /Capacity vs Flow/ });
    const styleOf = (element: HTMLElement) => element.closest(".mantine-Badge-root")?.getAttribute("style") ?? "";

    test("a team in line reads so in green text, with no list, and asks for itself alone", async () => {
      serve(mockFetch, { panel: linkedPanel() });
      renderSection();
      const row = await factsRow();
      await waitFor(() => expect(row).toHaveTextContent("In line with Flow"));
      expect(row.querySelector(".mantine-Badge-root")).toBeNull();
      expect(screen.queryByRole("list", { name: "Capacity differences from Flow" })).not.toBeInTheDocument();
      expect(screen.queryByText(REMEDY)).not.toBeInTheDocument();
      expect(count(mockFetch, `GET ${CAPACITY_URL}`)).toBe(1);
    });

    test("a sprint where the plan has more is an orange count with the sentences under it and the remedy for whoever may import", async () => {
      const worse = differsRow({ sprintId: 90003, sprintName: "E2E Flow Sprint 3", start: "2047-02-04", end: "2047-02-15", planMd: 44, flowMd: 48 });
      serve(mockFetch, { panel: linkedPanel(), capacity: capacityView({ items: [capacityItem({ deviations: [worse, differsRow()] })] }) });
      renderSection();
      const badge = await within(await factsRow()).findByText("Differs from Flow for 2 sprints");
      expect(styleOf(badge)).toContain("orange");
      // Never colour alone: the severity is said in a visually hidden word.
      expect(badge.closest(".mantine-Badge-root")).toHaveTextContent("Warning: Differs from Flow for 2 sprints");
      const list = await screen.findByRole("list", { name: "Capacity differences from Flow" });
      const lines = within(list).getAllByRole("listitem");
      // The warning comes first whatever the date order.
      // The severity is said in words before the kind badge (never colour alone).
      expect(lines[0]).toHaveTextContent(/^Warning: Capacity/);
      expect(lines[0]).toHaveTextContent("E2E Flow Sprint 2 (2047-01-21 – 2047-02-01): the plan has 36.00 man-days, Flow 30.00 — 6.00 more in the plan");
      expect(lines[1]).toHaveTextContent(/^Info: Capacity/);
      expect(lines[1]).toHaveTextContent("E2E Flow Sprint 3 (2047-02-04 – 2047-02-15): the plan has 44.00 man-days, Flow 48.00 — 4.00 less in the plan");
      expect(screen.getByText(REMEDY)).toBeInTheDocument();
    });

    test("a plan that only has less is a gray count, in the singular for one sprint; without the right to import there is no remedy line", async () => {
      serve(mockFetch, {
        panel: linkedPanel({ can: { link: false, unlink: false, importCapacity: false } }),
        capacity: capacityView({ items: [capacityItem({ deviations: [differsRow({ planMd: 26 })] })] }),
      });
      renderSection();
      const badge = await within(await factsRow()).findByText("Differs from Flow for 1 sprint");
      expect(styleOf(badge)).toContain("gray");
      expect(styleOf(badge)).not.toContain("orange");
      expect(badge.closest(".mantine-Badge-root")).toHaveTextContent("Info: Differs from Flow for 1 sprint");
      expect(await screen.findByRole("list", { name: "Capacity differences from Flow" })).toHaveTextContent("4.00 less in the plan");
      expect(screen.queryByText(REMEDY)).not.toBeInTheDocument();
    });

    test("sprints without capacity are a gray count and ONE line behind a disclosure of their own", async () => {
      const missing = [0, 1, 2, 3, 4, 5].map((n) => missingRow(90001 + n, `2047-0${n + 1}-07`, `2047-0${n + 1}-18`));
      serve(mockFetch, { panel: linkedPanel(), capacity: capacityView({ items: [capacityItem({ deviations: missing })] }) });
      renderSection();
      const badge = await within(await factsRow()).findByText("No capacity in the plan for 6 sprints");
      expect(styleOf(badge)).toContain("gray");
      expect(badge.closest(".mantine-Badge-root")).toHaveTextContent("Info: No capacity in the plan for 6 sprints");
      const list = await screen.findByRole("list", { name: "Capacity differences from Flow" });
      expect(within(list).getAllByRole("listitem")).toHaveLength(1);
      expect(list).toHaveTextContent("6 sprints without capacity in the plan (from 2047-01-07)");
      expect(screen.queryByRole("table", { name: "Sprints without capacity in the plan" })).not.toBeInTheDocument();
      await userEvent.click(within(list).getByRole("button", { name: "Show the sprints" }));
      const table = await screen.findByRole("table", { name: "Sprints without capacity in the plan" });
      expect(within(table).getAllByRole("row")).toHaveLength(7);
      expect(table).toHaveTextContent("E2E Flow Sprint 1");
    });

    test("both kinds show both counts; only the first five lines are open, the rest sit behind a disclosure", async () => {
      const rows = [1, 2, 3, 4, 5, 6, 7].map(sprint);
      serve(mockFetch, { panel: linkedPanel(), capacity: capacityView({ items: [capacityItem({ deviations: [...rows, missingRow(90010, "2047-09-07", "2047-09-18")] })] }) });
      renderSection();
      const row = await factsRow();
      expect(await within(row).findByText("Differs from Flow for 7 sprints")).toBeInTheDocument();
      expect(within(row).getByText("No capacity in the plan for 1 sprint")).toBeInTheDocument();
      const list = await screen.findByRole("list", { name: "Capacity differences from Flow" });
      expect(within(list).getAllByRole("listitem")).toHaveLength(5);
      await userEvent.click(screen.getByRole("button", { name: "Show 3 more" }));
      expect(screen.getByRole("button", { name: "Hide 3 more" })).toHaveAttribute("aria-expanded", "true");
      expect(screen.getByText(/E2E Flow Sprint 7 \(/)).toBeInTheDocument();
    });

    test("a team that left Flow adds no second badge and no list: the panel's own badge says it", async () => {
      serve(mockFetch, { panel: linkedPanel({ binding: panelBinding({ gone: true }), roster: null, sprints: null }), capacity: capacityView({ items: [capacityItem({ deviations: [GONE_ROW] })] }) });
      renderSection();
      expect(await screen.findByText("No longer in Flow")).toBeInTheDocument();
      expect(screen.queryByText("Capacity vs Flow")).not.toBeInTheDocument();
      expect(screen.queryByRole("list", { name: "Capacity differences from Flow" })).not.toBeInTheDocument();
    });

    test("a Flow team that left the document before the panel knows it still shows nothing here", async () => {
      serve(mockFetch, { panel: linkedPanel(), capacity: capacityView({ items: [capacityItem({ deviations: [GONE_ROW] })] }) });
      renderSection();
      await screen.findByRole("table", { name: "Link to Flow" });
      await waitFor(() => expect(count(mockFetch, `GET ${CAPACITY_URL}`)).toBe(1));
      expect(screen.queryByText("Capacity vs Flow")).not.toBeInTheDocument();
      expect(screen.queryByRole("list", { name: "Capacity differences from Flow" })).not.toBeInTheDocument();
    });

    test("while the comparison is on its way the row says so; a failed one is an inline alert and the facts stay", async () => {
      serve(mockFetch, { panel: linkedPanel() });
      const inner = mockFetch.getMockImplementation() as (url: string, init?: RequestInit) => Promise<Response>;
      mockFetch.mockImplementation((url: string, init?: RequestInit) => (url === CAPACITY_URL ? new Promise<Response>(() => {}) : inner(url, init)));
      const pending = renderSection();
      expect(await within(await factsRow()).findByText("Comparing with Flow…")).toBeInTheDocument();
      pending.unmount();

      mockFetch.mockClear();
      serve(mockFetch, { panel: linkedPanel(), capacityStatus: 500 });
      renderSection();
      expect(await screen.findByRole("alert")).toHaveTextContent("Could not compare the capacity with Flow");
      expect(screen.getByRole("table", { name: "Link to Flow" })).toBeInTheDocument();
      expect(screen.queryByText("Capacity vs Flow")).not.toBeInTheDocument();
    });

    test.each([
      ["disabled", { connectionEnabled: false, status: { state: "DISABLED", lastRun: null, lastSucceededAt: null, consecutiveFailures: 0, nextPollAt: null } }],
      ["failed", { status: { ...panelBinding().status, state: "FAILED", consecutiveFailures: 2 } }],
      ["stale", { status: { ...panelBinding().status, state: "STALE" } }],
      ["never read", { observedAt: null, status: { state: "NEVER_SYNCED", lastRun: null, lastSucceededAt: null, consecutiveFailures: 0, nextPollAt: null } }],
    ] as const)("a %s connection cannot vouch for agreement: no difference is said neutrally, not in green", async (_name, override) => {
      serve(mockFetch, { panel: linkedPanel({ binding: panelBinding(override) }) });
      renderSection();
      const row = await factsRow();
      await waitFor(() => expect(row).toHaveTextContent("No difference in the data read so far"));
      expect(row).not.toHaveTextContent("In line with Flow");
    });

    test("a failed re-read keeps the last answer on screen under an alert", async () => {
      const worse = differsRow({ sprintId: 90003, sprintName: "E2E Flow Sprint 3", start: "2047-02-04", end: "2047-02-15", planMd: 44, flowMd: 48 });
      const world = serve(mockFetch, { panel: linkedPanel(), capacity: capacityView({ items: [capacityItem({ deviations: [worse] })] }) });
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      renderSection({ queryClient });
      await within(await factsRow()).findByText("Differs from Flow for 1 sprint");
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      world.capacityStatus = 500;
      await queryClient.refetchQueries({ queryKey: ["flow", "deviations"] });
      expect(await screen.findByRole("alert")).toHaveTextContent("Could not compare the capacity with Flow");
      // What was read stays: the badge and the sentence, under the alert.
      expect(within(await factsRow()).getByText("Differs from Flow for 1 sprint")).toBeInTheDocument();
      expect(screen.getByRole("list", { name: "Capacity differences from Flow" })).toHaveTextContent("4.00 less in the plan");
    });

    test("an unlinked team asks for nothing", async () => {
      serve(mockFetch);
      renderSection();
      await screen.findByText("Not linked to a Flow team");
      expect(count(mockFetch, `GET ${CAPACITY_URL}`)).toBe(0);
    });
  });

  describe("Import capacity", () => {
    test("opens the modal on the link's id, and an import refreshes the plan queries (the capacity and the weekly load)", async () => {
      const world = serve(mockFetch, { panel: linkedPanel() });
      world.respond["POST /api/v1/integrations/flow/team-bindings/5/capacity-preview"] = () => jsonResponse(200, PREVIEW);
      world.respond["POST /api/v1/integrations/flow/team-bindings/5/capacity-import"] = () => jsonResponse(200, APPLIED);
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      queryClient.setQueryData(["plan", "team", 1, { baseline: null }], { stale: false });
      const invalidated: unknown[] = [];
      const original = queryClient.invalidateQueries.bind(queryClient);
      queryClient.invalidateQueries = ((filters: { queryKey?: unknown }) => {
        invalidated.push(filters?.queryKey);
        return original(filters as never);
      }) as typeof queryClient.invalidateQueries;
      renderSection({ queryClient });
      await userEvent.click(await screen.findByRole("button", { name: "Import capacity…" }));
      await screen.findByRole("table", { name: "Capacity import preview" });
      await userEvent.click(screen.getByRole("button", { name: "Import" }));
      await screen.findByText("1 created · 1 updated");
      expect(invalidated).toContainEqual(["plan"]);
      // The comparison with Flow moves with the import: the capacity it reads was just rewritten.
      expect(invalidated).toContainEqual(["flow", "deviations"]);
      expect(queryClient.getQueryState(["plan", "team", 1, { baseline: null }])?.isInvalidated).toBe(true);
    });
  });
});
