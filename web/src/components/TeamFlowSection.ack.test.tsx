import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor, within } from "../test/render";
import { jsonResponse } from "../test/http";
import { GONE_ROW, acknowledgedRow, capacityItem, capacityView, differsRow, linkedPanel, panelBinding, staleAcknowledgedRow } from "../test/flow";
import type { CapacityDeviationView } from "../api/capacityDeviations";
import type { FlowTeamPanel } from "../api/flow";
import TeamFlowSection from "./TeamFlowSection";

// The per-sprint acknowledge (1.9) from the team page's Flow section; the section's other mechanics are in TeamFlowSection.test.tsx.
const PANEL_URL = "/api/v1/teams/1/flow";
const CAPACITY_URL = "/api/v1/views/capacity-deviations?teamId=1";
type FetchMock = ReturnType<typeof vi.fn>;
type World = { panel: FlowTeamPanel; capacity: CapacityDeviationView; respond: Record<string, () => Response> };

function serve(mockFetch: FetchMock, overrides: Partial<World>) {
  const world: World = { panel: linkedPanel(), capacity: capacityView({ items: [] }), respond: {}, ...overrides };
  mockFetch.mockImplementation((url: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${url}`;
    if (world.respond[key]) return Promise.resolve(world.respond[key]());
    if (key === `GET ${PANEL_URL}`) return Promise.resolve(jsonResponse(200, world.panel));
    if (key === `GET ${CAPACITY_URL}`) return Promise.resolve(jsonResponse(200, world.capacity));
    return Promise.resolve(jsonResponse(404, { title: "x", status: 404 }));
  });
  return world;
}
const count = (mockFetch: FetchMock, key: string) => mockFetch.mock.calls.filter(([url, init]) => `${(init as RequestInit | undefined)?.method ?? "GET"} ${url}` === key).length;

describe("TeamFlowSection: acknowledging a sprint from the team page", () => {
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
  const renderSection = () => renderWithProviders(<TeamFlowSection teamId={1} />);
  const ACK_KEY = "POST /api/v1/integrations/flow/team-bindings/5/acknowledge";
  const sprint3 = () => differsRow({ sprintId: 90003, sprintName: "E2E Flow Sprint 3", start: "2047-02-04", end: "2047-02-15", planMd: 44, flowMd: 48 });
  const itemOf = (deviations: ReturnType<typeof differsRow>[], acknowledge = true) => capacityItem({ can: { acknowledge }, deviations });
  const factsRow = async () => within(await screen.findByRole("table", { name: "Link to Flow" })).findByRole("row", { name: /Capacity vs Flow/ });

  test("the fact counts the OPEN sprints and adds a dimmed '· N acknowledged'; the lines carry each sprint's state and button", async () => {
    serve(mockFetch, { capacity: capacityView({ items: [itemOf([differsRow(), acknowledgedRow(sprint3())])] }) });
    renderSection();
    const row = await factsRow();
    expect(await within(row).findByText("Differs from Flow for 1 sprint")).toBeInTheDocument();
    expect(within(row).getByText("· 1 acknowledged")).toBeInTheDocument();
    const list = await screen.findByRole("list", { name: "Capacity differences from Flow" });
    expect(within(list).getByRole("button", { name: "Acknowledge E2E Flow Sprint 2" })).toBeInTheDocument();
    expect(list).toHaveTextContent("Acknowledged by Ada Manager on 2026-11-08");
    expect(within(list).getByRole("button", { name: "Unacknowledge E2E Flow Sprint 3" })).toBeInTheDocument();
  });

  test("with only acknowledged sprints left the fact says 'No open difference · N acknowledged' - never 'In line with Flow'", async () => {
    serve(mockFetch, { capacity: capacityView({ items: [itemOf([acknowledgedRow(differsRow()), acknowledgedRow(sprint3())])] }) });
    renderSection();
    const row = await factsRow();
    expect(await within(row).findByText("No open difference · 2 acknowledged")).toBeInTheDocument();
    expect(row).not.toHaveTextContent("In line with Flow");
    expect(row.querySelector(".mantine-Badge-root")).toBeNull();
  });

  test("a stale acknowledgement is open again: it counts, reads 'changed since' and can be acknowledged anew", async () => {
    serve(mockFetch, { capacity: capacityView({ items: [itemOf([staleAcknowledgedRow(differsRow())])] }) });
    renderSection();
    expect(await within(await factsRow()).findByText("Differs from Flow for 1 sprint")).toBeInTheDocument();
    expect(await screen.findByText("Acknowledged on 2026-11-08 by Ada Manager · changed since")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Acknowledge E2E Flow Sprint 2" })).toBeInTheDocument();
  });

  test("whoever may not acknowledge (the item's can) sees the lines and the states, but no button", async () => {
    serve(mockFetch, { capacity: capacityView({ items: [itemOf([differsRow(), acknowledgedRow(sprint3())], false)] }) });
    renderSection();
    const list = await screen.findByRole("list", { name: "Capacity differences from Flow" });
    expect(list).toHaveTextContent("Acknowledged by Ada Manager on 2026-11-08");
    expect(within(list).queryByRole("button")).not.toBeInTheDocument();
  });

  test("Acknowledge sends the sprint and the fingerprint read; the panel's capacity is read again and the row reads acknowledged", async () => {
    const world = serve(mockFetch, { capacity: capacityView({ items: [itemOf([differsRow(), sprint3()])] }) });
    world.respond[ACK_KEY] = () => {
      world.capacity = capacityView({ items: [itemOf([differsRow(), acknowledgedRow(sprint3())])] });
      return jsonResponse(200, { bindingId: 5, sprintId: 90003, fingerprint: sprint3().fingerprint, acknowledgedAt: 1, acknowledgedBy: "Ada Manager" });
    };
    renderSection();
    await userEvent.click(await screen.findByRole("button", { name: "Acknowledge E2E Flow Sprint 3" }));
    await waitFor(() => expect(count(mockFetch, ACK_KEY)).toBe(1));
    const post = mockFetch.mock.calls.find(([url, init]) => url === "/api/v1/integrations/flow/team-bindings/5/acknowledge" && (init as RequestInit).method === "POST");
    expect(JSON.parse((post?.[1] as RequestInit).body as string)).toEqual({ sprintId: 90003, fingerprint: sprint3().fingerprint });
    expect(await within(await factsRow()).findByText("· 1 acknowledged")).toBeInTheDocument();
    expect(count(mockFetch, `GET ${CAPACITY_URL}`)).toBe(2);
    expect(await screen.findByRole("button", { name: "Unacknowledge E2E Flow Sprint 3" })).toBeInTheDocument();
  });

  test("Unacknowledge is a DELETE naming the sprint, and the row is open again", async () => {
    const world = serve(mockFetch, { capacity: capacityView({ items: [itemOf([acknowledgedRow(differsRow())])] }) });
    world.respond["DELETE /api/v1/integrations/flow/team-bindings/5/acknowledge?sprintId=90002"] = () => {
      world.capacity = capacityView({ items: [itemOf([differsRow()])] });
      return new Response(null, { status: 204 });
    };
    renderSection();
    await userEvent.click(await screen.findByRole("button", { name: "Unacknowledge E2E Flow Sprint 2" }));
    expect(await within(await factsRow()).findByText("Differs from Flow for 1 sprint")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Acknowledge E2E Flow Sprint 2" })).toBeInTheDocument();
  });

  test("a 409 stale-deviations is the orange note in the row and a re-read, not a failure", async () => {
    const world = serve(mockFetch, { capacity: capacityView({ items: [itemOf([differsRow()])] }) });
    world.respond[ACK_KEY] = () => jsonResponse(409, { type: "urn:astrolabe:problem:stale-deviations", title: "Conflict", status: 409, detail: "changed" });
    renderSection();
    await userEvent.click(await screen.findByRole("button", { name: "Acknowledge E2E Flow Sprint 2" }));
    expect(await screen.findByText(/The deviations changed since you looked/)).toBeInTheDocument();
    await waitFor(() => expect(count(mockFetch, `GET ${CAPACITY_URL}`)).toBe(2));
  });

  test("a gone Flow team's own row is acknowledged and withdrawn from the team page (sprintId null, no query parameter), though its sprint lines stay hidden", async () => {
    const gone = () => linkedPanel({ binding: panelBinding({ gone: true }), roster: null, sprints: null });
    const world = serve(mockFetch, { panel: gone(), capacity: capacityView({ items: [capacityItem({ can: { acknowledge: true }, deviations: [GONE_ROW] })] }) });
    world.respond[ACK_KEY] = () => {
      world.capacity = capacityView({ items: [capacityItem({ can: { acknowledge: true }, deviations: [acknowledgedRow(GONE_ROW)] })] });
      return jsonResponse(200, { bindingId: 5, sprintId: null, fingerprint: GONE_ROW.fingerprint, acknowledgedAt: 1, acknowledgedBy: "Ada Manager" });
    };
    world.respond["DELETE /api/v1/integrations/flow/team-bindings/5/acknowledge"] = () => {
      world.capacity = capacityView({ items: [capacityItem({ can: { acknowledge: true }, deviations: [GONE_ROW] })] });
      return new Response(null, { status: 204 });
    };
    renderSection();
    await userEvent.click(await screen.findByRole("button", { name: "Acknowledge the team's own row" }));
    await waitFor(() => expect(count(mockFetch, ACK_KEY)).toBe(1));
    const post = mockFetch.mock.calls.find(([url, init]) => url === "/api/v1/integrations/flow/team-bindings/5/acknowledge" && (init as RequestInit).method === "POST");
    expect(JSON.parse((post?.[1] as RequestInit).body as string)).toEqual({ sprintId: null, fingerprint: GONE_ROW.fingerprint });
    expect(await screen.findByText("Acknowledged by Ada Manager on 2026-11-08")).toBeInTheDocument();
    await userEvent.click(await screen.findByRole("button", { name: "Unacknowledge the team's own row" }));
    await waitFor(() => expect(count(mockFetch, "DELETE /api/v1/integrations/flow/team-bindings/5/acknowledge")).toBe(1));
    expect(await screen.findByRole("button", { name: "Acknowledge the team's own row" })).toBeInTheDocument();
    // The DELETE named no sprint at all: the team's own row is the route with no parameter.
    expect(mockFetch.mock.calls.some(([url]) => (url as string).includes("sprintId"))).toBe(false);
  });
});
