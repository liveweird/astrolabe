import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import { renderWithProviders, screen, waitFor, within } from "../test/render";
import { jsonResponse } from "../test/http";
import { headingOutline } from "../test/headings";
import { CONNECTION, TEAMS, flowTeam } from "../test/flow";
import type { FlowTeamList } from "../api/flow";
import FlowTeamsSection from "./FlowTeamsSection";

const TOKEN_KEY = "astrolabe.auth.token";
const LIST = "/api/v1/integrations/flow/teams?connectionId=1";
type FetchMock = ReturnType<typeof vi.fn>;

type World = { teams: FlowTeamList; respond: Record<string, () => Response> };

function serve(mockFetch: FetchMock, overrides: Partial<World> = {}): World {
  const world: World = { teams: TEAMS, respond: {}, ...overrides };
  mockFetch.mockImplementation((url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const custom = world.respond[`${method} ${url}`];
    if (custom) return Promise.resolve(custom());
    if (method === "GET" && url === LIST) return Promise.resolve(jsonResponse(200, world.teams));
    return Promise.resolve(jsonResponse(404, { title: "x", status: 404 }));
  });
  return world;
}

function call(mockFetch: FetchMock, method: string, url: string) {
  return mockFetch.mock.calls.find(([u, init]) => u === url && ((init as RequestInit | undefined)?.method ?? "GET") === method);
}
function listReads(mockFetch: FetchMock) {
  return mockFetch.mock.calls.filter(([u, init]) => u === LIST && ((init as RequestInit | undefined)?.method ?? "GET") === "GET").length;
}

function renderSection(connection = CONNECTION) {
  return renderWithProviders(
    <Routes>
      <Route path="/" element={<FlowTeamsSection connection={connection} />} />
      <Route path="/teams/:id" element={<p>team page</p>} />
    </Routes>,
  );
}

describe("FlowTeamsSection", () => {
  let mockFetch: FetchMock;
  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    localStorage.setItem(TOKEN_KEY, "fake-token");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  test("lists the mirrored teams with their counts: a linked team is a link to its page, a suggestion offers Link, the rest say nothing matches", async () => {
    serve(mockFetch);
    renderSection();
    const table = await screen.findByRole("table", { name: "Flow teams" });
    expect(headingOutline()).toEqual([[3, "Teams"]]);
    const platform = within(table).getByText("Platform", { selector: "p" }).closest("tr")!;
    expect(within(platform).getByRole("link", { name: "Platform" })).toHaveAttribute("href", "/teams/3");
    expect(within(platform).getByText("6")).toBeInTheDocument();
    expect(within(platform).getByText("33")).toBeInTheDocument();
    expect(within(platform).getByRole("button", { name: "Unlink Platform" })).toBeInTheDocument();
    expect(within(platform).queryByRole("button", { name: /^Link / })).not.toBeInTheDocument();
    const payments = within(table).getByText("Payments", { selector: "p" }).closest("tr")!;
    expect(within(payments).getByText("Suggested: Payments")).toBeInTheDocument();
    expect(within(payments).getByRole("button", { name: "Link Payments to Payments" })).toBeEnabled();
    const design = within(table).getByText("Design System", { selector: "p" }).closest("tr")!;
    expect(within(design).getByText("No team of this name")).toBeInTheDocument();
    expect(within(design).queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByText("Flow teams: 3 · linked: 1 · with a suggestion: 1")).toBeInTheDocument();
    expect(screen.getByText("Observed (UTC): 2026-11-08 09:40")).toBeInTheDocument();
  });

  test("before any run it says to refresh the connection first, with no table and no Link all", async () => {
    serve(mockFetch, { teams: { connectionId: 1, teamsAt: null, items: [] } });
    renderSection();
    expect(await screen.findByText("Refresh the connection first")).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "Flow teams" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Link all suggested" })).not.toBeInTheDocument();
  });

  test("a failed load is the alert, not an empty state", async () => {
    mockFetch.mockResolvedValue(jsonResponse(500, { title: "x", status: 500 }));
    renderSection();
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load the Flow teams");
    expect(screen.queryByText("Refresh the connection first")).not.toBeInTheDocument();
  });

  test("Link POSTs the suggestion, toasts, and re-reads so the row reads as linked", async () => {
    const world = serve(mockFetch);
    world.respond["POST /api/v1/integrations/flow/team-bindings"] = () => {
      world.teams = { ...TEAMS, items: TEAMS.items.map((team) => (team.flowTeamId === 12 ? { ...team, bindingId: 9, boundTeamId: 4, boundTeamName: "Payments", suggestedTeamId: null, suggestedTeamName: null } : team)) };
      return jsonResponse(201, { id: 9, connectionId: 1, teamId: 4, teamName: "Payments", flowTeamId: 12, flowTeamName: "Payments", createdAt: 1 });
    };
    const user = userEvent.setup();
    renderSection();
    await user.click(await screen.findByRole("button", { name: "Link Payments to Payments" }));
    await waitFor(() => expect(call(mockFetch, "POST", "/api/v1/integrations/flow/team-bindings")).toBeDefined());
    expect(JSON.parse((call(mockFetch, "POST", "/api/v1/integrations/flow/team-bindings")![1] as RequestInit).body as string)).toEqual({ connectionId: 1, flowTeamId: 12, teamId: 4 });
    const row = (await screen.findByRole("link", { name: "Payments" })).closest("tr")!;
    expect(within(row).getByRole("button", { name: "Unlink Payments" })).toBeInTheDocument();
    expect(screen.getByText("Flow teams: 3 · linked: 2 · with a suggestion: 0")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    // The pressed button became Unlink: the focus is on the section's heading, not lost on the document.
    expect(screen.getByRole("heading", { level: 3, name: "Teams" })).toHaveFocus();
  });

  test("a refused link (409) shows the server's sentence under a fixed lead and re-reads the list", async () => {
    const world = serve(mockFetch);
    world.respond["POST /api/v1/integrations/flow/team-bindings"] = () =>
      jsonResponse(409, { title: "Conflict", status: 409, type: "urn:astrolabe:problem:already-bound", detail: "Team Payments is already linked to Flow team Payments EU" });
    const user = userEvent.setup();
    renderSection();
    await user.click(await screen.findByRole("button", { name: "Link Payments to Payments" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The link conflicts with an existing one");
    expect(alert).toHaveTextContent("Team Payments is already linked to Flow team Payments EU");
    await waitFor(() => expect(listReads(mockFetch)).toBeGreaterThan(1));
  });

  test("a link refused for rights, or by a stale list (400), reads in the fixed vocabulary", async () => {
    const world = serve(mockFetch);
    world.respond["POST /api/v1/integrations/flow/team-bindings"] = () => jsonResponse(403, { title: "Forbidden", status: 403 });
    const user = userEvent.setup();
    renderSection();
    await user.click(await screen.findByRole("button", { name: "Link Payments to Payments" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Only administrators or the team's manager can link it");
    world.respond["POST /api/v1/integrations/flow/team-bindings"] = () => jsonResponse(400, { title: "Bad Request", status: 400, detail: "Unknown Flow team: refresh the connection" });
    await user.click(screen.getByRole("button", { name: "Link Payments to Payments" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Unknown Flow team: refresh the connection"));
    expect(screen.getByRole("alert")).toHaveTextContent("The link was refused: refresh the connection and try again");
  });

  test("Link all suggested calls match and tells what was linked and what was left, then re-reads", async () => {
    const world = serve(mockFetch);
    world.respond["POST /api/v1/integrations/flow/connections/1/team-bindings/match"] = () => {
      world.teams = { ...TEAMS, items: TEAMS.items.map((team) => (team.flowTeamId === 12 ? { ...team, bindingId: 9, boundTeamId: 4, boundTeamName: "Payments", suggestedTeamId: null, suggestedTeamName: null } : team)) };
      return jsonResponse(200, {
        bound: [{ bindingId: 9, teamId: 4, flowTeamId: 12 }],
        skipped: [
          { flowTeamId: 13, reason: "NO_MATCH" },
          { flowTeamId: 11, reason: "ALREADY_BOUND" },
        ],
      });
    };
    const user = userEvent.setup();
    renderSection();
    await user.click(await screen.findByRole("button", { name: "Link all suggested" }));
    const note = await screen.findByText("1 linked, 1 without a unique match, 1 linked already.");
    expect(note.closest('[role="status"]')).toHaveAttribute("aria-live", "polite");
    await waitFor(() => expect(screen.getByText("Flow teams: 3 · linked: 2 · with a suggestion: 0")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Link all suggested" })).toBeDisabled();
    expect(screen.getByRole("heading", { level: 3, name: "Teams" })).toHaveFocus();
  });

  test("Link all suggested is off while nothing has a suggestion", async () => {
    serve(mockFetch, { teams: { ...TEAMS, items: [TEAMS.items[0], TEAMS.items[2]] } });
    renderSection();
    expect(await screen.findByRole("button", { name: "Link all suggested" })).toBeDisabled();
  });

  test("a failed match is a red alert in words", async () => {
    const world = serve(mockFetch);
    world.respond["POST /api/v1/integrations/flow/connections/1/team-bindings/match"] = () => jsonResponse(500, { title: "x", status: 500 });
    const user = userEvent.setup();
    renderSection();
    await user.click(await screen.findByRole("button", { name: "Link all suggested" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not link the suggested teams");
  });

  test("a disabled connection cannot link: the buttons are off and a note says why; Unlink still works", async () => {
    serve(mockFetch);
    renderSection({ ...CONNECTION, enabled: false });
    expect(await screen.findByRole("note")).toHaveTextContent("The connection is disabled: teams cannot be linked until it is enabled.");
    expect(screen.getByRole("button", { name: "Link all suggested" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Link Payments to Payments" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Unlink Platform" })).toBeEnabled();
  });

  test("Unlink asks first (an in-page dialog), names both teams, says nothing changes in Flow, and DELETEs the binding", async () => {
    const world = serve(mockFetch);
    world.respond["DELETE /api/v1/integrations/flow/team-bindings/5"] = () => {
      world.teams = { ...TEAMS, items: TEAMS.items.map((team) => (team.flowTeamId === 11 ? { ...team, bindingId: null, boundTeamId: null, boundTeamName: null } : team)) };
      return new Response(null, { status: 204 });
    };
    const confirmSpy = vi.fn();
    vi.stubGlobal("confirm", confirmSpy);
    const user = userEvent.setup();
    renderSection();
    await user.click(await screen.findByRole("button", { name: "Unlink Platform" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Astrolabe team “Platform” will no longer be linked to Flow team “Platform”. Capacity already imported stays. Nothing is changed in Flow.");
    expect(call(mockFetch, "DELETE", "/api/v1/integrations/flow/team-bindings/5")).toBeUndefined();
    await user.click(within(dialog).getByRole("button", { name: "Unlink" }));
    await waitFor(() => expect(call(mockFetch, "DELETE", "/api/v1/integrations/flow/team-bindings/5")).toBeDefined());
    await waitFor(() => expect(screen.getByText("Flow teams: 3 · linked: 0 · with a suggestion: 1")).toBeInTheDocument());
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  test("an unlink clears the outcome line of an earlier Link all", async () => {
    const world = serve(mockFetch);
    world.respond["POST /api/v1/integrations/flow/connections/1/team-bindings/match"] = () => jsonResponse(200, { bound: [], skipped: [{ flowTeamId: 13, reason: "NO_MATCH" }] });
    world.respond["DELETE /api/v1/integrations/flow/team-bindings/5"] = () => new Response(null, { status: 204 });
    const user = userEvent.setup();
    renderSection();
    await user.click(await screen.findByRole("button", { name: "Link all suggested" }));
    expect(await screen.findByText("0 linked, 1 without a unique match, 0 linked already.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Unlink Platform" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Unlink" }));
    await waitFor(() => expect(screen.queryByText(/without a unique match/)).not.toBeInTheDocument());
  });

  test("an unlink refused (403) or already gone (404) keeps the dialog with its reason", async () => {
    const world = serve(mockFetch);
    world.respond["DELETE /api/v1/integrations/flow/team-bindings/5"] = () => jsonResponse(403, { title: "Forbidden", status: 403 });
    const user = userEvent.setup();
    renderSection();
    await user.click(await screen.findByRole("button", { name: "Unlink Platform" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Unlink" }));
    expect(await within(dialog).findByText("Only administrators or the team's manager can unlink it")).toBeInTheDocument();
    world.respond["DELETE /api/v1/integrations/flow/team-bindings/5"] = () => jsonResponse(404, { title: "Not Found", status: 404 });
    await user.click(within(dialog).getByRole("button", { name: "Unlink" }));
    expect(await within(dialog).findByText("This link no longer exists — it was already removed")).toBeInTheDocument();
  });

  test("a team with neither a link nor a suggestion shows no action at all", async () => {
    serve(mockFetch, { teams: { ...TEAMS, items: [flowTeam({ flowTeamId: 20, name: "Solo" })] } });
    renderSection();
    const row = (await screen.findByText("Solo")).closest("tr")!;
    expect(within(row).queryByRole("button")).not.toBeInTheDocument();
    expect(within(row).getByText("No team of this name")).toBeInTheDocument();
  });
});
