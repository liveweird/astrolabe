import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { QueryClient } from "@tanstack/react-query";
import { renderWithProviders, screen, waitFor, within } from "../test/render";
import { jsonResponse } from "../test/http";
import { headingOutline } from "../test/headings";
import { APPLIED, PREVIEW, UNLINKED_PANEL, flowTeam, linkedPanel, panelBinding } from "../test/flow";
import type { FlowTeamPanel } from "../api/flow";
import TeamFlowSection from "./TeamFlowSection";

const PANEL_URL = "/api/v1/teams/1/flow";
type FetchMock = ReturnType<typeof vi.fn>;
type World = { panel: FlowTeamPanel; panelStatus: number; respond: Record<string, () => Response> };

function serve(mockFetch: FetchMock, overrides: Partial<World> = {}) {
  const world: World = { panel: UNLINKED_PANEL, panelStatus: 200, respond: {}, ...overrides };
  mockFetch.mockImplementation((url: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${url}`;
    if (world.respond[key]) return Promise.resolve(world.respond[key]());
    if (key === `GET ${PANEL_URL}`) return Promise.resolve(world.panelStatus === 200 ? jsonResponse(200, world.panel) : jsonResponse(world.panelStatus, { title: "x", status: world.panelStatus }));
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
      expect(queryClient.getQueryState(["plan", "team", 1, { baseline: null }])?.isInvalidated).toBe(true);
    });
  });
});
