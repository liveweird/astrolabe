import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor, within } from "../test/render";
import { jsonResponse } from "../test/http";
import { flowTeam } from "../test/flow";
import type { FlowPanelConnection, FlowTeamList } from "../api/flow";
import FlowTeamLinkDialog from "./FlowTeamLinkDialog";

const BIND_URL = "/api/v1/integrations/flow/team-bindings";
type FetchMock = ReturnType<typeof vi.fn>;

const teamsOf = (connectionId: number, items: FlowTeamList["items"], teamsAt: number | null = Date.UTC(2026, 10, 8, 9, 40)): FlowTeamList => ({ connectionId, teamsAt, items });
const ACME: FlowPanelConnection = { id: 1, name: "Acme Flow", enabled: true };

type World = { teams: Record<number, FlowTeamList>; bind: () => Response };

function serve(mockFetch: FetchMock, overrides: Partial<World> = {}) {
  const world: World = {
    teams: {
      1: teamsOf(1, [
        flowTeam({ flowTeamId: 11, name: "Platform", bindingId: 5, boundTeamId: 3, boundTeamName: "Platform" }),
        flowTeam({ flowTeamId: 12, name: "Payments", suggestedTeamId: 1, suggestedTeamName: "Payments" }),
        flowTeam({ flowTeamId: 13, name: "Design System" }),
      ]),
    },
    bind: () => jsonResponse(201, { id: 9, connectionId: 1, teamId: 1, teamName: "Payments", flowTeamId: 12, flowTeamName: "Payments", createdAt: 1 }),
    ...overrides,
  };
  mockFetch.mockImplementation((url: string, init?: RequestInit) => {
    const teamsMatch = /connectionId=(\d+)$/.exec(url);
    if (url.startsWith("/api/v1/integrations/flow/teams?") && teamsMatch) return Promise.resolve(jsonResponse(200, world.teams[Number(teamsMatch[1])]));
    if (url === BIND_URL && init?.method === "POST") return Promise.resolve(world.bind());
    return Promise.resolve(jsonResponse(404, { title: "x", status: 404 }));
  });
  return world;
}

const requested = (mockFetch: FetchMock) => mockFetch.mock.calls.map(([url]) => url as string);
const bindBodies = (mockFetch: FetchMock) => mockFetch.mock.calls.filter(([url]) => url === BIND_URL).map(([, init]) => JSON.parse((init as RequestInit).body as string) as unknown);

function renderDialog(connections: readonly FlowPanelConnection[] = [ACME]) {
  const onClose = vi.fn();
  const onLinked = vi.fn().mockResolvedValue(undefined);
  renderWithProviders(<FlowTeamLinkDialog team={{ id: 1, name: "Payments" }} connections={connections} onClose={onClose} onLinked={onLinked} />);
  return { onClose, onLinked };
}

describe("FlowTeamLinkDialog", () => {
  let mockFetch: FetchMock;
  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    localStorage.setItem("astrolabe.auth.token", "fake-token");
    // The dialog is for the team's manager as much as an administrator: it reads nothing of the ADMIN-only registry.
    localStorage.setItem("astrolabe.auth.roles", JSON.stringify(["USER"]));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  test("the only enabled connection is preselected and the Flow team of this team's name with it; Link sends exactly those ids", async () => {
    serve(mockFetch);
    const { onLinked } = renderDialog();
    const dialog = await screen.findByRole("dialog", { name: "Link to a Flow team" });
    expect(await within(dialog).findByRole("combobox", { name: "Flow connection" })).toHaveValue("Acme Flow");
    const flowTeamSelect = await within(dialog).findByRole("combobox", { name: "Flow team" });
    expect(flowTeamSelect).toHaveValue("Payments (suggested)");
    await userEvent.click(within(dialog).getByRole("button", { name: "Link" }));
    await waitFor(() => expect(onLinked).toHaveBeenCalledTimes(1));
    expect(bindBodies(mockFetch)).toEqual([{ connectionId: 1, flowTeamId: 12, teamId: 1 }]);
  });

  test("a Flow team that is linked already is not offered", async () => {
    serve(mockFetch);
    renderDialog();
    const select = await screen.findByRole("combobox", { name: "Flow team" });
    await userEvent.click(select);
    expect(await screen.findByRole("option", { name: "Design System" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Payments (suggested)" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Platform" })).not.toBeInTheDocument();
  });

  test("with no suggestion nothing is preselected and Link waits for a choice; a disabled connection is not offered, a second enabled one must be chosen", async () => {
    serve(mockFetch, { teams: { 3: teamsOf(3, [flowTeam({ flowTeamId: 31, name: "Billing" })]) } });
    renderDialog([ACME, { id: 2, name: "Off Flow", enabled: false }, { id: 3, name: "Second Flow", enabled: true }]);
    const dialog = await screen.findByRole("dialog");
    const connection = await within(dialog).findByRole("combobox", { name: "Flow connection" });
    expect(connection).toHaveValue("");
    await userEvent.click(connection);
    expect(screen.queryByRole("option", { name: "Off Flow" })).not.toBeInTheDocument();
    await userEvent.click(await screen.findByRole("option", { name: "Second Flow" }));
    const flowTeamSelect = await within(dialog).findByRole("combobox", { name: "Flow team" });
    expect(flowTeamSelect).toHaveValue("");
    expect(within(dialog).getByText("No Flow team has this team's name; choose the one that stands for it.")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Link" })).toBeDisabled();
    await userEvent.click(flowTeamSelect);
    await userEvent.click(await screen.findByRole("option", { name: "Billing" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Link" }));
    await waitFor(() => expect(bindBodies(mockFetch)).toEqual([{ connectionId: 3, flowTeamId: 31, teamId: 1 }]));
  });

  test("a connection that has not read Flow yet says to refresh it first", async () => {
    serve(mockFetch, { teams: { 1: teamsOf(1, [], null) } });
    renderDialog();
    expect(await screen.findByText("This connection has not read Flow yet. An administrator refreshes it on the connection page first.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Link" })).toBeDisabled();
  });

  test("with every Flow team linked it says so", async () => {
    serve(mockFetch, { teams: { 1: teamsOf(1, [flowTeam({ flowTeamId: 11, name: "Platform", bindingId: 5, boundTeamId: 3, boundTeamName: "Platform" })]) } });
    renderDialog();
    expect(await screen.findByText("Every Flow team of this connection is linked already.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Link" })).toBeDisabled();
  });

  test.each([
    [[], "No Flow connection exists yet. An administrator adds one under Administration, Flow."],
    [[{ ...ACME, enabled: false }], "Every Flow connection is disabled. An administrator enables one under Administration, Flow."],
  ])("no enabled connection to choose (%#)", async (connections, note) => {
    serve(mockFetch);
    renderDialog(connections);
    expect(await screen.findByText(note)).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Link" })).toBeDisabled();
  });

  test("a team manager who is no administrator links through the panel's connections: the exact POST body, and nothing is asked of the ADMIN-only registry", async () => {
    serve(mockFetch);
    const { onLinked } = renderDialog();
    const dialog = await screen.findByRole("dialog", { name: "Link to a Flow team" });
    await waitFor(() => expect(within(dialog).getByRole("combobox", { name: "Flow team" })).toHaveValue("Payments (suggested)"));
    await userEvent.click(within(dialog).getByRole("button", { name: "Link" }));
    await waitFor(() => expect(onLinked).toHaveBeenCalledTimes(1));
    expect(bindBodies(mockFetch)).toEqual([{ connectionId: 1, flowTeamId: 12, teamId: 1 }]);
    expect(requested(mockFetch).filter((url) => url.includes("/connections"))).toEqual([]);
  });

  test.each([
    [409, { type: "urn:astrolabe:problem:already-bound", detail: "Team Payments is already linked to Flow team Payments EU" }, ["The link conflicts with an existing one", "Team Payments is already linked to Flow team Payments EU"]],
    [400, { detail: "Unknown Flow team: refresh the connection" }, ["The link was refused: refresh the connection and try again", "Unknown Flow team: refresh the connection"]],
    [403, {}, ["Only administrators or the team's manager can link it"]],
    [404, {}, ["This connection no longer exists — reload the page"]],
  ])("a %i is an inline alert with the choice kept and the dialog open", async (status, problem, sentences) => {
    serve(mockFetch, { bind: () => jsonResponse(status, { title: "x", status, ...problem }) });
    const { onLinked, onClose } = renderDialog();
    const select = await screen.findByRole("combobox", { name: "Flow team" });
    await waitFor(() => expect(select).toHaveValue("Payments (suggested)"));
    await userEvent.click(screen.getByRole("button", { name: "Link" }));
    const alert = await screen.findByRole("alert");
    for (const sentence of sentences) expect(alert).toHaveTextContent(sentence);
    expect(select).toHaveValue("Payments (suggested)");
    expect(screen.getByRole("button", { name: "Link" })).toBeEnabled();
    expect(onLinked).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  test("a refused link (409) re-reads the Flow teams, so a team linked meanwhile is no longer offered", async () => {
    const world = serve(mockFetch, { bind: () => jsonResponse(409, { title: "x", status: 409, type: "urn:astrolabe:problem:already-bound", detail: "Flow team Payments is already linked to team Other" }) });
    renderDialog();
    const select = await screen.findByRole("combobox", { name: "Flow team" });
    await waitFor(() => expect(select).toHaveValue("Payments (suggested)"));
    const teamReads = () => requested(mockFetch).filter((url) => url.startsWith("/api/v1/integrations/flow/teams?")).length;
    expect(teamReads()).toBe(1);
    world.teams[1] = teamsOf(1, [flowTeam({ flowTeamId: 12, name: "Payments", bindingId: 8, boundTeamId: 2, boundTeamName: "Other" }), flowTeam({ flowTeamId: 13, name: "Design System" })]);
    await userEvent.click(screen.getByRole("button", { name: "Link" }));
    await screen.findByRole("alert");
    await waitFor(() => expect(teamReads()).toBe(2));
    // The refused choice is gone with its option: nothing is chosen, and Link waits.
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Flow team" })).toHaveValue(""));
    expect(screen.getByRole("button", { name: "Link" })).toBeDisabled();
  });

  test("Cancel closes the dialog", async () => {
    serve(mockFetch);
    const { onClose } = renderDialog();
    await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
  });
});
