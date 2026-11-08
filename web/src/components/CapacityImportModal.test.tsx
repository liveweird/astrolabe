import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor, within } from "../test/render";
import { jsonResponse } from "../test/http";
import { APPLIED, PREVIEW, previewItem } from "../test/flow";
import type { CapacityApplyResponse, CapacityPreview } from "../api/flow";
import CapacityImportModal from "./CapacityImportModal";

const PREVIEW_URL = "/api/v1/integrations/flow/team-bindings/5/capacity-preview";
const IMPORT_URL = "/api/v1/integrations/flow/team-bindings/5/capacity-import";
type FetchMock = ReturnType<typeof vi.fn>;

type World = { previews: CapacityPreview[]; previewFailure: Response | null; apply: () => Response };

function serve(mockFetch: FetchMock, overrides: Partial<World> = {}) {
  const world: World = { previews: [PREVIEW], previewFailure: null, apply: () => jsonResponse(200, APPLIED), ...overrides };
  let reads = 0;
  mockFetch.mockImplementation((url: string) => {
    if (url === PREVIEW_URL) {
      if (world.previewFailure) return Promise.resolve(world.previewFailure);
      return Promise.resolve(jsonResponse(200, world.previews[Math.min(reads++, world.previews.length - 1)]));
    }
    if (url === IMPORT_URL) return Promise.resolve(world.apply());
    return Promise.resolve(jsonResponse(404, { title: "x", status: 404 }));
  });
  return world;
}

const posts = (mockFetch: FetchMock, url: string) =>
  mockFetch.mock.calls.filter(([u, init]) => u === url && (init as RequestInit | undefined)?.method === "POST").map(([, init]) => JSON.parse((init as RequestInit).body as string) as unknown);

function renderModal(onImported = vi.fn().mockResolvedValue(undefined), onClose = vi.fn()) {
  renderWithProviders(<CapacityImportModal binding={{ id: 5, flowTeamName: "Payments Flow" }} onClose={onClose} onImported={onImported} />);
  return { onImported, onClose };
}
const table = () => screen.findByRole("table", { name: "Capacity import preview" });
const importButton = () => screen.getByRole("button", { name: "Import" });

describe("CapacityImportModal", () => {
  let mockFetch: FetchMock;
  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    localStorage.setItem("astrolabe.auth.token", "fake-token");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  test("asks for today's plan with closed sprints left out, and ticks exactly the rows the server ticked", async () => {
    serve(mockFetch);
    renderModal();
    const grid = await table();
    expect(posts(mockFetch, PREVIEW_URL)).toEqual([{ includeClosed: false }]);
    expect(within(grid).getAllByRole("columnheader").map((header) => header.textContent)).toEqual(["Import", "Sprint", "Dates", "Working days", "Sprint total in Flow (man-days)", "Man-days per week", "Action", "Note"]);
    // A CREATE and an UPDATE are ticked; the zero-capacity CREATE is tickable but starts unticked.
    expect(within(grid).getByRole("checkbox", { name: "Import Sprint 101" })).toBeChecked();
    expect(within(grid).getByRole("checkbox", { name: "Import Sprint 102" })).toBeChecked();
    expect(within(grid).getByRole("checkbox", { name: "Import Sprint 103" })).not.toBeChecked();
    // MANUAL_PERIOD, SKIP and UNCHANGED rows have no tick at all.
    expect(within(grid).getAllByRole("checkbox")).toHaveLength(3);
    expect(screen.getByText("Selected: 2 · to create: 1 · to update: 1 · to remove: 0")).toBeInTheDocument();
  });

  test("says in words what each row would do, why it is left alone and what to watch", async () => {
    serve(mockFetch);
    renderModal();
    const grid = await table();
    const row = (name: string) => within(grid).getByRole("row", { name: new RegExp(name) });
    expect(row("Sprint 101")).toHaveTextContent("2026-11-09 – 2026-11-20104020.00Create");
    expect(row("Sprint 102")).toHaveTextContent("Update");
    expect(row("Sprint 102")).toHaveTextContent("was 16.00");
    expect(row("Sprint 102")).toHaveTextContent("A hand-entered period starts on 2026-11-30, inside the sprint: the sprint's figure will not hold from then.");
    expect(row("Sprint 103")).toHaveTextContent("Flow's figure is 0 man-days: not selected by default.");
    expect(row("Sprint 104")).toHaveTextContent("Kept");
    expect(row("Sprint 104")).toHaveTextContent("A hand-entered period starts on this date and is never changed.");
    expect(row("Sprint 105")).toHaveTextContent("Skipped");
    expect(row("Sprint 105")).toHaveTextContent("Flow has no usable dates for this sprint.");
    expect(row("Sprint 106")).toHaveTextContent("Unchanged");
    expect(row("Sprint 106")).toHaveTextContent("Already imported.");
    expect(screen.getByText(/Each imported period holds until the next one starts/)).toBeInTheDocument();
  });

  test("a closed sprint is listed unticked with its own note, and the toggle asks for the closed ones", async () => {
    const closed = { ...PREVIEW, includeClosed: true, items: [previewItem({ sprintId: 90, name: "Sprint 90", start: "2026-10-12", end: "2026-10-23", effectiveFrom: "2026-10-12", state: "closed", ticked: false })], removals: [] };
    serve(mockFetch, { previews: [PREVIEW, closed] });
    renderModal();
    await table();
    await userEvent.click(screen.getByRole("switch", { name: "Include closed sprints" }));
    const grid = await table();
    await waitFor(() => expect(within(grid).getByRole("row", { name: /Sprint 90/ })).toBeInTheDocument());
    expect(posts(mockFetch, PREVIEW_URL)).toEqual([{ includeClosed: false }, { includeClosed: true }]);
    expect(within(grid).getByRole("checkbox", { name: "Import Sprint 90" })).not.toBeChecked();
    expect(within(grid).getByRole("row", { name: /Sprint 90/ })).toHaveTextContent("Ended before 2026-11-08: not selected by default.");
    expect(screen.getByText("Selected: 0 · to create: 0 · to update: 0 · to remove: 0")).toBeInTheDocument();
    expect(importButton()).toBeDisabled();
  });

  test("removals are listed unticked and nothing is removed unless the person ticks it", async () => {
    serve(mockFetch);
    renderModal();
    await table();
    const removals = screen.getByRole("table", { name: "Flow periods that would be removed" });
    expect(within(removals).getByRole("row", { name: /2026-10-12/ })).toHaveTextContent("15.00Sprint 90");
    const box = within(removals).getByRole("checkbox", { name: "Remove the period from 2026-10-12" });
    expect(box).not.toBeChecked();
    // Import with the defaults: no removal travels.
    await userEvent.click(importButton());
    await waitFor(() => expect(posts(mockFetch, IMPORT_URL)).toHaveLength(1));
    expect((posts(mockFetch, IMPORT_URL)[0] as { removals: number[] }).removals).toEqual([]);
  });

  test("Import sends exactly the ticked rows with their expected values, the ticked removals and the echoed from / includeClosed - never a forged field", async () => {
    serve(mockFetch);
    renderModal();
    const grid = await table();
    await userEvent.click(within(grid).getByRole("checkbox", { name: "Import Sprint 101" })); // untick
    await userEvent.click(within(grid).getByRole("checkbox", { name: "Import Sprint 103" })); // tick the zero-capacity row
    await userEvent.click(screen.getByRole("checkbox", { name: "Remove the period from 2026-10-12" }));
    expect(screen.getByText("Selected: 3 · to create: 1 · to update: 1 · to remove: 1")).toBeInTheDocument();
    await userEvent.click(importButton());
    await waitFor(() => expect(posts(mockFetch, IMPORT_URL)).toHaveLength(1));
    expect(posts(mockFetch, IMPORT_URL)[0]).toEqual({
      from: "2026-11-08",
      includeClosed: false,
      items: [
        { sprintId: 102, expected: { action: "UPDATE", effectiveFrom: "2026-11-23", mdPerWeek: 18 } },
        { sprintId: 103, expected: { action: "CREATE", effectiveFrom: "2026-12-07", mdPerWeek: 0 } },
      ],
      removals: [34],
    });
  });

  test("the outcome names what was created, updated, removed and skipped as changed; the capacity is refreshed and a fresh plan is read", async () => {
    const applied: CapacityApplyResponse = {
      created: [{ periodId: 40, sprintId: 101 }, { periodId: 41, sprintId: 103 }, { periodId: 42, sprintId: 107 }],
      updated: [{ periodId: 31, sprintId: 102 }],
      deleted: [34],
      skipped: [{ sprintId: 108, periodId: null, reason: "CHANGED" }],
    };
    const after: CapacityPreview = { ...PREVIEW, items: PREVIEW.items.map((item) => ({ ...item, action: "UNCHANGED" as const, ticked: false })), removals: [] };
    serve(mockFetch, { previews: [PREVIEW, after], apply: () => jsonResponse(200, applied) });
    const { onImported } = renderModal();
    await table();
    await userEvent.click(importButton());
    const note = await screen.findByText("3 created · 1 updated · 1 removed · 1 skipped: changed in the meantime");
    expect(note.closest('[role="status"]')).not.toBeNull();
    expect(onImported).toHaveBeenCalledTimes(1);
    // The plan is read again: every row is now unchanged, nothing is left to tick, the removal list is gone.
    await waitFor(() => expect(posts(mockFetch, PREVIEW_URL)).toHaveLength(2));
    await waitFor(() => expect(screen.queryByRole("checkbox")).not.toBeInTheDocument());
    expect(importButton()).toBeDisabled();
    expect(screen.getByText("3 created · 1 updated · 1 removed · 1 skipped: changed in the meantime")).toBeInTheDocument();
  });

  test.each([
    [403, undefined, "Only the team's manager or an administrator can import capacity"],
    [404, undefined, "This link or team no longer exists — reload the page"],
    [400, "A sprint is listed twice", "The import was refused"],
  ])("a %i from the apply is an inline alert, the ticks are kept and the preview is not re-read", async (status, detail, lead) => {
    serve(mockFetch, { apply: () => jsonResponse(status, { title: "x", status, detail }) });
    const { onImported } = renderModal();
    const grid = await table();
    await userEvent.click(within(grid).getByRole("checkbox", { name: "Import Sprint 101" }));
    await userEvent.click(importButton());
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(lead);
    if (detail) expect(alert).toHaveTextContent(detail);
    expect(within(grid).getByRole("checkbox", { name: "Import Sprint 102" })).toBeChecked();
    expect(within(grid).getByRole("checkbox", { name: "Import Sprint 101" })).not.toBeChecked();
    expect(onImported).not.toHaveBeenCalled();
    expect(posts(mockFetch, PREVIEW_URL)).toHaveLength(1);
  });

  test.each([
    [403, "Only the team's manager or an administrator can import capacity"],
    [404, "This link or team no longer exists — reload the page"],
  ])("a %i from the preview is an alert with no table", async (status, lead) => {
    serve(mockFetch, { previewFailure: jsonResponse(status, { title: "x", status }) });
    renderModal();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Could not load the import preview");
    expect(alert).toHaveTextContent(lead);
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(importButton).toThrow();
  });

  test("a team that is not in the mirror has nothing to import", async () => {
    serve(mockFetch, { previews: [{ ...PREVIEW, observedAt: null, items: [], removals: [], totals: { create: 0, update: 0, unchanged: 0, skip: 0, removals: 0 } }] });
    renderModal();
    expect(await screen.findByText("Nothing to import: Flow lists no sprints for this team in this range.")).toBeInTheDocument();
    expect(importButton()).toBeDisabled();
  });

  test("the status region exists before any import, and after one the focus lands on the outcome note instead of falling to the page", async () => {
    const after: CapacityPreview = { ...PREVIEW, items: PREVIEW.items.map((item) => ({ ...item, action: "UNCHANGED" as const, ticked: false })), removals: [] };
    serve(mockFetch, { previews: [PREVIEW, after] });
    renderModal();
    await table();
    // The summary line is a status too; the outcome's region is the empty one.
    const status = screen.getAllByRole("status").find((region) => region.textContent === "")!;
    expect(status).toBeEmptyDOMElement();
    const button = importButton();
    button.focus();
    await userEvent.click(button);
    const note = await screen.findByText("1 created · 1 updated");
    // The same region, now holding the text (an always-mounted live region announces reliably).
    expect(status).toContainElement(note);
    await waitFor(() => expect(posts(mockFetch, PREVIEW_URL)).toHaveLength(2));
    await waitFor(() => expect(note.closest('[role="note"]')).toHaveFocus());
    expect(document.body).not.toHaveFocus();
  });

  test("a refresh of the page behind that fails after the import still shows the outcome", async () => {
    serve(mockFetch);
    const { onImported } = renderModal(vi.fn().mockRejectedValue(new Error("refresh failed")));
    await table();
    await userEvent.click(importButton());
    expect(await screen.findByText("1 created · 1 updated")).toBeInTheDocument();
    expect(onImported).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  test("an import after the closed sprints were included sends includeClosed true and the closed plan's own from", async () => {
    const closed: CapacityPreview = {
      ...PREVIEW,
      from: "2026-10-01",
      includeClosed: true,
      items: [previewItem({ sprintId: 90, name: "Sprint 90", start: "2026-09-14", end: "2026-09-25", effectiveFrom: "2026-09-14", state: "closed", ticked: false })],
      removals: [],
    };
    serve(mockFetch, { previews: [PREVIEW, closed] });
    renderModal();
    await table();
    await userEvent.click(screen.getByRole("switch", { name: "Include closed sprints" }));
    const grid = await table();
    await userEvent.click(await within(grid).findByRole("checkbox", { name: "Import Sprint 90" }));
    await userEvent.click(importButton());
    await waitFor(() => expect(posts(mockFetch, IMPORT_URL)).toHaveLength(1));
    expect(posts(mockFetch, IMPORT_URL)[0]).toEqual({
      from: "2026-10-01",
      includeClosed: true,
      items: [{ sprintId: 90, expected: { action: "CREATE", effectiveFrom: "2026-09-14", mdPerWeek: 20 } }],
      removals: [],
    });
  });

  test("Close dismisses the modal", async () => {
    serve(mockFetch);
    const { onClose } = renderModal();
    await table();
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });
});
