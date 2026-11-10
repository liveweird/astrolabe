import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { QueryClient } from "@tanstack/react-query";
import { renderWithProviders, screen, waitFor, within } from "../test/render";
import { jsonResponse } from "../test/http";
import { CAPACITY_CONNECTION, acknowledgedRow, capacityItem, capacityView, differsRow, staleAcknowledgedRow } from "../test/flow";
import type { CapacityDeviationView } from "../api/capacityDeviations";
import type { DeviationFilter } from "../api/deviations";
import CapacityDeviationsSection from "./CapacityDeviationsSection";

// The per-sprint acknowledge (1.9) on the Deviations page's Capacity from Flow section; the section's other mechanics are in CapacityDeviationsSection.test.tsx.
const VIEW_URL = "/api/v1/views/capacity-deviations";
const TEAMS_URL = "/api/v1/integrations/flow/teams?connectionId=1";
const ACK_URL = "/api/v1/integrations/flow/team-bindings/5/acknowledge";
const NOW = CAPACITY_CONNECTION.teamsAt! + 5 * 60_000;
type FetchMock = ReturnType<typeof vi.fn>;

let doc: CapacityDeviationView;
let ackResponse: Response;

const renderSection = (filter: DeviationFilter = {}) => renderWithProviders(<CapacityDeviationsSection filter={filter} admin={false} />);

describe("CapacityDeviationsSection: the acknowledge", () => {
  let mockFetch: FetchMock;
  const viewCalls = () => mockFetch.mock.calls.map(([url]) => url as string).filter((url) => url.startsWith(VIEW_URL));
  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    localStorage.setItem("astrolabe.auth.token", "fake-token");
    localStorage.setItem("astrolabe.auth.roles", JSON.stringify(["USER"]));
    doc = capacityView();
    ackResponse = jsonResponse(200, { bindingId: 5, sprintId: 90002, fingerprint: differsRow().fingerprint, acknowledgedAt: NOW, acknowledgedBy: "Ada Manager" });
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url.startsWith(VIEW_URL)) return Promise.resolve(jsonResponse(200, doc));
      if (url === TEAMS_URL) return Promise.resolve(jsonResponse(404, { title: "x", status: 404 }));
      if (url.startsWith(ACK_URL) && init?.method !== undefined) return Promise.resolve(ackResponse.clone());
      return Promise.resolve(jsonResponse(404, { title: "x", status: 404 }));
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  const ackedDoc = () =>
    capacityView({
      items: [capacityItem({ can: { acknowledge: true }, deviations: [differsRow(), acknowledgedRow(differsRow({ sprintId: 90003, sprintName: "E2E Flow Sprint 3", start: "2047-02-04", end: "2047-02-15", planMd: 44, flowMd: 48 }))] })],
    });
  const posts = () => mockFetch.mock.calls.filter(([url, init]) => (url as string).startsWith(ACK_URL) && (init as RequestInit | undefined)?.method === "POST");

  test("the totals count the acknowledged rows in a gray badge, beside the open ones", async () => {
    doc = ackedDoc();
    renderSection();
    const group = await screen.findByRole("group", { name: "Differences from Flow" });
    expect(group).toHaveTextContent("1 warning");
    expect(group).toHaveTextContent("0 infos");
    expect(group).toHaveTextContent("1 acknowledged");
    expect(within(group).getByText("1 acknowledged").closest(".mantine-Badge-root")?.getAttribute("style")).toContain("gray");
    // Open (the default) lists open rows, so no "open only" explanation; All and Acknowledged say the figures still count open rows.
    expect(screen.queryByText(/count open items only/)).not.toBeInTheDocument();
  });

  test("under Acknowledged or All the totals say they count the open rows whatever the list shows", async () => {
    doc = ackedDoc();
    renderSection({ all: true });
    expect(await screen.findByText(/count open items only, whatever the list shows/)).toBeInTheDocument();
  });

  test("every line has its cell by the item's `can`: Acknowledge on the open sprint, who and when with Unacknowledge on the acknowledged one", async () => {
    doc = ackedDoc();
    renderSection({ all: true });
    const table = await screen.findByRole("table", { name: "Capacity differences between the plan and Flow" });
    expect(within(table).getByRole("button", { name: "Acknowledge E2E Flow Sprint 2" })).toBeInTheDocument();
    expect(within(table).getByText("Acknowledged by Ada Manager on 2026-11-08")).toBeInTheDocument();
    expect(within(table).getByRole("button", { name: "Unacknowledge E2E Flow Sprint 3" })).toBeInTheDocument();
  });

  test("a row without can.acknowledge shows no button (the state is still told)", async () => {
    doc = capacityView({ items: [capacityItem({ can: { acknowledge: false }, deviations: [differsRow(), acknowledgedRow(differsRow({ sprintId: 90003 }))] })] });
    renderSection({ all: true });
    const table = await screen.findByRole("table", { name: "Capacity differences between the plan and Flow" });
    expect(within(table).getByText("Acknowledged by Ada Manager on 2026-11-08")).toBeInTheDocument();
    expect(within(table).queryByRole("button")).not.toBeInTheDocument();
  });

  test("an acknowledged sprint is sent with its binding, its sprint and the fingerprint read; the document and the plan's views are read again", async () => {
    doc = ackedDoc();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderWithProviders(<CapacityDeviationsSection filter={{ all: true }} admin={false} />, { queryClient });
    await userEvent.click(await screen.findByRole("button", { name: "Acknowledge E2E Flow Sprint 2" }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(JSON.parse((posts()[0][1] as RequestInit).body as string)).toEqual({ sprintId: 90002, fingerprint: differsRow().fingerprint });
    await waitFor(() => expect(viewCalls().length).toBeGreaterThan(1));
  });

  test("an acknowledgement is withdrawn with a DELETE naming the sprint", async () => {
    doc = ackedDoc();
    ackResponse = new Response(null, { status: 204 });
    renderSection({ all: true });
    await userEvent.click(await screen.findByRole("button", { name: "Unacknowledge E2E Flow Sprint 3" }));
    await waitFor(() => expect(mockFetch.mock.calls.some(([url, init]) => url === `${ACK_URL}?sprintId=90003` && (init as RequestInit).method === "DELETE")).toBe(true));
  });

  test("a 409 stale-deviations is the orange note in the row, and the list is read again", async () => {
    doc = ackedDoc();
    ackResponse = jsonResponse(409, { type: "urn:astrolabe:problem:stale-deviations", title: "Conflict", status: 409, detail: "changed" });
    renderSection({ all: true });
    await userEvent.click(await screen.findByRole("button", { name: "Acknowledge E2E Flow Sprint 2" }));
    const note = await screen.findByText(/The deviations changed since you looked/);
    expect(note.closest('[role="status"]')).not.toBeNull();
    // The row is still listed, so the note is in ITS cell, inside the table.
    expect(within(screen.getByRole("table", { name: "Capacity differences between the plan and Flow" })).getByText(/The deviations changed since you looked/)).toBeInTheDocument();
    await waitFor(() => expect(viewCalls().length).toBeGreaterThan(1));
  });

  test("the note of a row the re-read dropped from the list is shown above the list instead", async () => {
    doc = ackedDoc();
    ackResponse = jsonResponse(409, { type: "urn:astrolabe:problem:stale-deviations", title: "Conflict", status: 409, detail: "gone" });
    renderSection({ all: true });
    const button = await screen.findByRole("button", { name: "Acknowledge E2E Flow Sprint 2" });
    // The re-read that follows the 409 no longer lists sprint 2 (its figures changed to nothing).
    doc = capacityView({ items: [capacityItem({ can: { acknowledge: true }, deviations: [differsRow({ sprintId: 90003, sprintName: "E2E Flow Sprint 3" })] })] });
    await userEvent.click(button);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Acknowledge E2E Flow Sprint 2" })).not.toBeInTheDocument());
    const note = await screen.findByText(/The deviations changed since you looked/);
    expect(note.closest('[role="status"]')).not.toBeNull();
    expect(within(screen.getByRole("table", { name: "Capacity differences between the plan and Flow" })).queryByText(/The deviations changed since you looked/)).not.toBeInTheDocument();
  });

  test("a 403 is the red inline refusal in words", async () => {
    doc = ackedDoc();
    ackResponse = jsonResponse(403, { title: "Forbidden", status: 403 });
    renderSection({ all: true });
    await userEvent.click(await screen.findByRole("button", { name: "Acknowledge E2E Flow Sprint 2" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Only the team's manager or an administrator can acknowledge its capacity differences.");
  });

  test("a stale acknowledgement reads 'changed since' and the row counts as open", async () => {
    doc = capacityView({ items: [capacityItem({ can: { acknowledge: true }, deviations: [staleAcknowledgedRow(differsRow())] })] });
    renderSection();
    expect(await screen.findByText("Acknowledged on 2026-11-08 by Ada Manager · changed since")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Differences from Flow" })).toHaveTextContent("1 warning");
  });

  test("with every row acknowledged the Open list is empty - and says so, never 'in line with Flow'", async () => {
    doc = capacityView({ items: [] });
    doc.totals.acknowledged = 2;
    renderSection();
    expect(await screen.findByText("No open capacity difference.")).toBeInTheDocument();
    expect(screen.getByText("2 acknowledged sprints are hidden. Choose Acknowledged or All under Status to see them.")).toBeInTheDocument();
    expect(screen.queryByText(/In line with Flow/)).not.toBeInTheDocument();
  });

  test("an empty Acknowledged list is a filter matching nothing, not an in-line claim", async () => {
    doc = capacityView({ items: [] });
    renderSection({ acknowledged: true });
    expect(await screen.findByText("No capacity difference matches the filters.")).toBeInTheDocument();
  });
});
