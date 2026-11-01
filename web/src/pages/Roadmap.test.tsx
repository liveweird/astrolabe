import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { QueryClient } from "@tanstack/react-query";
import { act, screen, waitFor, within } from "@testing-library/react";
import { DndContext } from "@dnd-kit/core";
import Roadmap from "./Roadmap";
import type { PlanFlag, RoadmapLink, RoadmapProject, RoadmapView } from "../api/roadmap";
import { applyRanking } from "../utils/roadmapOrder";
import { headingOutline } from "../test/headings";
import { jsonResponse } from "../test/http";
import { renderWithProviders } from "../test/render";

type FetchMock = ReturnType<typeof vi.fn>;

const PICK_KEY = "astrolabe.viewSettings.planning.programPick";
const ZOOM_KEY = "astrolabe.viewSettings.timeline.planZoom";

// happy-dom has no layout, so a pointer drag cannot run here (e2e drives the real one): the context is wrapped to hand the test its
// drag handlers. What the page does WHEN dnd-kit reports a drop is ours to pin.
let dndProps: ComponentProps<typeof DndContext> | null = null;
vi.mock("@dnd-kit/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dnd-kit/core")>();
  return {
    ...actual,
    DndContext: (props: ComponentProps<typeof actual.DndContext>) => {
      dndProps = props;
      return <actual.DndContext {...props} />;
    },
  };
});

/**
 * A row dragged by its handle and released in the gap `slot` of the displayed rows: the row zone starts at client y = 100 (36 px rows), so the
 * pointer at `100 + 36 * slot` is on that gap. `count` is the number of displayed rows (the divider included).
 */
const dropRow = (project: RoadmapProject, position: number, slot: number, count = 5) => {
  const dragged = { id: `row:${project.id}`, data: { current: { kind: "row", barId: project.id, label: project.name, position, count } } };
  const zone = {
    id: "timeline-rows",
    data: { current: { zoneTop: () => 100, rowBounds: () => ({ left: 0, right: 900, top: 100, bottom: 700 }), rowCount: count } },
  };
  const event = { active: dragged, delta: { x: 0, y: 0 }, over: zone, activatorEvent: { clientX: 40, clientY: 100 + 36 * slot } };
  act(() => dndProps?.onDragStart?.(event as never));
  act(() => dndProps?.onDragEnd?.(event as never));
};

const flag = (kind: PlanFlag["kind"], severity: PlanFlag["severity"], days: number | null, over: Partial<PlanFlag> = {}): PlanFlag => ({
  kind,
  severity,
  days,
  teamId: null,
  otherProjectId: null,
  ...over,
});

const project = (id: number, name: string, over: Partial<RoadmapProject> = {}): RoadmapProject => ({
  id,
  name,
  programId: 10,
  programName: "Billing",
  workStreamId: 1,
  workStreamName: "Platform",
  ownerPersonId: 5,
  ownerName: "Ola Owner",
  targetStart: null,
  targetEnd: null,
  rankPosition: null,
  teamIds: [],
  span: null,
  drift: null,
  flags: [],
  can: { editTargetWindow: false },
  ...over,
});

const INVOICES = project(1, "Invoices", {
  rankPosition: 1,
  targetStart: "2026-02-01",
  targetEnd: "2026-03-31",
  span: { start: "2026-03-02", end: "2026-04-10" },
  drift: { startDays: 29, endDays: 10 },
  teamIds: [1],
  flags: [flag("DRIFT_END_LATE", "WARNING", 10), flag("DRIFT_START_LATE", "INFO", 29)],
});
const TAXES = project(2, "Taxes", {
  rankPosition: 2,
  programId: 11,
  programName: "Compliance",
  workStreamId: 2,
  workStreamName: "Finance",
  ownerPersonId: 6,
  ownerName: "Tania Tax",
  span: { start: "2026-03-09", end: "2026-05-01" },
  teamIds: [1, 2],
  flags: [flag("RANK_INVERSION", "WARNING", 7, { teamId: 1, otherProjectId: 1 })],
});
const AUDIT = project(3, "Audit", { rankPosition: 3, span: { start: "2026-05-04", end: "2026-06-05" }, flags: [flag("RANK_INVERSION", "INFO", 1, { otherProjectId: 2 })] });
const LEDGER = project(4, "Ledger", { programId: 11, programName: "Compliance", workStreamId: 2, workStreamName: "Finance", ownerPersonId: 6, ownerName: "Tania Tax" });

const viewOf = (over: Partial<RoadmapView> = {}): RoadmapView => ({
  revision: 7,
  can: { editRank: true },
  teams: [
    { id: 1, name: "Payments" },
    { id: 2, name: "Web" },
  ],
  links: [],
  ranked: [
    { position: 1, project: INVOICES },
    { position: 2, project: TAXES },
    { position: 3, project: AUDIT },
  ],
  unranked: [LEDGER],
  ...over,
});

const okCheck = { status: "OK", shortfallDays: null, requiredDate: null, actualDate: null } as const;
const LINKS: RoadmapLink[] = [
  { predecessorProjectId: 1, successorProjectId: 2, direct: { id: 31, type: "FS", lagDays: 0, check: { ...okCheck, status: "VIOLATED", shortfallDays: 3 } }, milestoneLinks: { count: 0, violated: 0, unscheduled: 0 } },
  { predecessorProjectId: 2, successorProjectId: 3, direct: null, milestoneLinks: { count: 2, violated: 1, unscheduled: 0 } },
];

const STALE = { type: "urn:astrolabe:problem:stale-revision", title: "Conflict", status: 409, detail: "stale" };

let view: RoadmapView;
let putStatus: { status: number; body?: unknown };

/** A tiny server: GET answers the current view; an accepted PUT applies the list and bumps the ranking revision. */
function serve(mockFetch: FetchMock) {
  mockFetch.mockImplementation((url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "GET" && url === "/api/v1/views/roadmap") return Promise.resolve(jsonResponse(200, view));
    if (method === "GET" && url === "/api/v1/public-holidays") return Promise.resolve(jsonResponse(200, { items: [{ id: 1, date: "2026-03-18", name: "Founders' Day" }] }));
    if (method === "PUT" && url === "/api/v1/roadmap/ranking") {
      if (putStatus.status !== 200) return Promise.resolve(jsonResponse(putStatus.status, putStatus.body ?? { title: "x", status: putStatus.status }));
      const body = JSON.parse(init?.body as string) as { projectIds: number[] };
      view = { ...applyRanking(view, body.projectIds), revision: view.revision + 1 };
      return Promise.resolve(jsonResponse(200, { revision: view.revision }));
    }
    return Promise.resolve(jsonResponse(404, { title: "x", status: 404 }));
  });
}

const puts = (mockFetch: FetchMock) =>
  mockFetch.mock.calls.filter(([u, init]) => u === "/api/v1/roadmap/ranking" && (init as RequestInit).method === "PUT").map(([, init]) => JSON.parse((init as RequestInit).body as string));
const gets = (mockFetch: FetchMock) => mockFetch.mock.calls.filter(([u, init]) => u === "/api/v1/views/roadmap" && ((init as RequestInit | undefined)?.method ?? "GET") === "GET").length;

const grid = () => screen.getByRole("grid", { name: "Roadmap timeline" });
/** The rows of the grid below the header: a project's name, or the divider's caption. */
const rowLabels = () =>
  within(grid())
    .getAllByRole("row")
    .slice(1)
    .map((row) => row.querySelector("a[href^='/projects/']")?.textContent ?? row.textContent?.trim());
const rowOf = (name: string) => within(grid()).getByRole("link", { name: `Open ${name}` }).closest('[role="row"]') as HTMLElement;
const liveText = () => screen.getAllByRole("status").map((region) => region.textContent).join(" | ");

async function openMenu(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole("button", { name: `Operations for ${name}` }));
}

let mockFetch: FetchMock;

beforeEach(() => {
  view = viewOf();
  putStatus = { status: 200 };
  dndProps = null;
  mockFetch = vi.fn();
  vi.stubGlobal("fetch", mockFetch);
  localStorage.setItem("astrolabe.auth.token", "fake-token");
  serve(mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("Roadmap page", () => {
  test("the page reads the public-holiday dictionary, and at the default Quarter zoom (3 px a day) draws and lists nothing", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderWithProviders(<Roadmap />, { queryClient });
    await screen.findByRole("grid", { name: "Roadmap timeline" });
    // Wait for the dictionary to LAND in the cache, so the negative assertion below is not just "not yet".
    await waitFor(() => expect(queryClient.getQueryData(["calendar", "holidays"])).toHaveLength(1));
    expect(screen.queryByText(/Public holidays shown/)).not.toBeInTheDocument();
  });

  test("at Month zoom the dictionary's holidays are listed for assistive technology", async () => {
    localStorage.setItem(ZOOM_KEY, JSON.stringify("month"));
    renderWithProviders(<Roadmap />);
    expect(await screen.findByText(/Public holidays shown: 2026-03-18 Founders' Day/)).toBeInTheDocument();
  });

  test("renders the rows in rank order, the divider, the facts, the flag icons and the bars; the heading outline is pinned", async () => {
    renderWithProviders(<Roadmap />);
    await screen.findByRole("grid", { name: "Roadmap timeline" });
    expect(headingOutline()).toEqual([
      [2, "Roadmap"],
      [3, "Timeline"],
      [3, "Flags"],
    ]);
    expect(rowLabels()).toEqual(["Invoices", "Taxes", "Audit", "Unranked", "Ledger"]);
    const facts = screen.getByRole("group", { name: "Roadmap facts" });
    expect(within(facts).getByText("3 ranked")).toBeInTheDocument();
    expect(within(facts).getByText("1 unranked")).toBeInTheDocument();
    expect(within(facts).getByText("2 warnings")).toBeInTheDocument();
    expect(within(facts).getByText("2 infos")).toBeInTheDocument();
    // `#` is the server's position ("—" when unranked); the program is dimmed after the name; flags are icons with a sentence for assistive technology.
    const invoices = rowOf("Invoices");
    expect(within(invoices).getAllByRole("gridcell")[0]).toHaveTextContent("Billing");
    expect(within(invoices).getByRole("rowheader")).toHaveTextContent("1");
    expect(within(rowOf("Ledger")).getByRole("rowheader")).toHaveTextContent("—");
    expect(invoices.querySelector("[data-flags]")).toHaveAttribute("data-flags", "1,1");
    expect(within(invoices).getByText("1 warning, 1 info")).toBeInTheDocument();
    expect(rowOf("Ledger").querySelector("[data-flags]")).toBeNull();
    // The span bar over the target window's band, the drift band past the window.
    expect(within(invoices).getByRole("img", { name: "Invoices, 2026-03-02 to 2026-04-10, read-only" })).toHaveAttribute("data-tone", "summary");
    expect(within(invoices).getByRole("img", { name: "Invoices, target window 2026-02-01 to 2026-03-31, read-only" })).toHaveAttribute("data-tone", "window");
    expect(invoices.querySelector('[title="10 days past the target end"]')).not.toBeNull();
    expect(within(rowOf("Ledger")).queryByRole("img")).toBeNull();
    // Month / Quarter / Year, no Week; Quarter by default.
    const zoom = screen.getByRole("radiogroup", { name: "Zoom" });
    expect(within(zoom).getAllByRole("radio").map((radio) => radio.getAttribute("value"))).toEqual(["month", "quarter", "year"]);
    expect(within(zoom).getByRole("radio", { name: "Quarter" })).toBeChecked();
  });

  test("the zoom is remembered under its own key", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Roadmap />);
    await screen.findByRole("grid", { name: "Roadmap timeline" });
    await user.click(screen.getByText("Year"));
    expect(JSON.parse(localStorage.getItem(ZOOM_KEY) ?? "null")).toBe("year");
    expect(localStorage.getItem("astrolabe.viewSettings.timeline.zoom")).toBeNull();
  });

  test("an editor gets a drag handle on every project row and the full menu per ranked row", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Roadmap />);
    await screen.findByRole("grid", { name: "Roadmap timeline" });
    expect(document.querySelectorAll("[data-row-handle]")).toHaveLength(4);
    await openMenu(user, "Taxes");
    for (const name of ["Move up Taxes", "Move down Taxes", "Move Taxes to top", "Move Taxes to bottom", "Unrank Taxes", "Open project Taxes"]) {
      expect(await screen.findByRole("menuitem", { name })).toBeInTheDocument();
    }
    expect(screen.queryByRole("menuitem", { name: /^Rank / })).toBeNull();
  });

  test("Move up PUTs the complete new order with the view's revision, reorders at once, announces it and the menu keeps focus", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Roadmap />);
    await screen.findByRole("grid", { name: "Roadmap timeline" });
    await openMenu(user, "Audit");
    await user.click(await screen.findByRole("menuitem", { name: "Move up Audit" }));
    expect(rowLabels()).toEqual(["Invoices", "Audit", "Taxes", "Unranked", "Ledger"]);
    await waitFor(() => expect(puts(mockFetch)).toEqual([{ expectedRevision: 7, projectIds: [1, 3, 2] }]));
    expect(liveText()).toContain("Audit moved to position 2 of 3");
    await waitFor(() => expect(gets(mockFetch)).toBeGreaterThan(1));
    await waitFor(() => expect(grid()).toHaveAttribute("aria-busy", "false"));
    expect(screen.getByRole("button", { name: "Operations for Audit" })).toHaveFocus();
    // The row's `#` follows the new order, in the optimistic cache and after the refetch alike.
    expect(within(rowOf("Audit")).getByRole("rowheader")).toHaveTextContent("2");
  });

  test("the revision from a successful save is the next save's expectedRevision", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Roadmap />);
    await screen.findByRole("grid", { name: "Roadmap timeline" });
    await openMenu(user, "Invoices");
    await user.click(await screen.findByRole("menuitem", { name: "Move down Invoices" }));
    await waitFor(() => expect(puts(mockFetch)).toHaveLength(1));
    await waitFor(() => expect(grid()).toHaveAttribute("aria-busy", "false"));
    await openMenu(user, "Invoices");
    await user.click(await screen.findByRole("menuitem", { name: "Move down Invoices" }));
    await waitFor(() => expect(puts(mockFetch)).toHaveLength(2));
    expect(puts(mockFetch)[1]).toEqual({ expectedRevision: 8, projectIds: [2, 3, 1] });
  });

  test("Move to top and Move to bottom, and the ends of the ranked block disable what cannot move", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Roadmap />);
    await screen.findByRole("grid", { name: "Roadmap timeline" });
    await openMenu(user, "Invoices");
    expect(await screen.findByRole("menuitem", { name: "Move up Invoices" })).toHaveAttribute("data-disabled", "true");
    expect(screen.getByRole("menuitem", { name: "Move Invoices to top" })).toHaveAttribute("data-disabled", "true");
    await user.click(screen.getByRole("menuitem", { name: "Move Invoices to bottom" }));
    await waitFor(() => expect(puts(mockFetch)).toEqual([{ expectedRevision: 7, projectIds: [2, 3, 1] }]));
    await waitFor(() => expect(rowLabels()).toEqual(["Taxes", "Audit", "Invoices", "Unranked", "Ledger"]));
    await waitFor(() => expect(grid()).toHaveAttribute("aria-busy", "false"));
    await openMenu(user, "Invoices");
    expect(await screen.findByRole("menuitem", { name: "Move down Invoices" })).toHaveAttribute("data-disabled", "true");
    await user.click(screen.getByRole("menuitem", { name: "Move Invoices to top" }));
    await waitFor(() => expect(puts(mockFetch)).toHaveLength(2));
    expect(puts(mockFetch)[1]).toEqual({ expectedRevision: 8, projectIds: [1, 2, 3] });
  });

  test("Rank appends an unranked project at the end; Unrank takes a ranked one out", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Roadmap />);
    await screen.findByRole("grid", { name: "Roadmap timeline" });
    await openMenu(user, "Ledger");
    expect(screen.queryByRole("menuitem", { name: /^Move / })).toBeNull();
    await user.click(await screen.findByRole("menuitem", { name: "Rank Ledger" }));
    expect(rowLabels()).toEqual(["Invoices", "Taxes", "Audit", "Ledger"]);
    await waitFor(() => expect(puts(mockFetch)).toEqual([{ expectedRevision: 7, projectIds: [1, 2, 3, 4] }]));
    expect(liveText()).toContain("Ledger ranked at position 4 of 4");
    await waitFor(() => expect(grid()).toHaveAttribute("aria-busy", "false"));
    await openMenu(user, "Taxes");
    await user.click(await screen.findByRole("menuitem", { name: "Unrank Taxes" }));
    expect(rowLabels()).toEqual(["Invoices", "Audit", "Ledger", "Unranked", "Taxes"]);
    await waitFor(() => expect(puts(mockFetch)).toHaveLength(2));
    expect(puts(mockFetch)[1]).toEqual({ expectedRevision: 8, projectIds: [1, 3, 4] });
    expect(liveText()).toContain("Taxes removed from the ranking");
  });

  test("a stale 409 says the roadmap changed, rolls the list back and reloads the view", async () => {
    putStatus = { status: 409, body: STALE };
    const user = userEvent.setup();
    renderWithProviders(<Roadmap />);
    await screen.findByRole("grid", { name: "Roadmap timeline" });
    const before = gets(mockFetch);
    // Someone else's change lands before the reload.
    view = viewOf({ revision: 9, ranked: [{ position: 1, project: AUDIT }, { position: 2, project: INVOICES }], unranked: [TAXES, LEDGER] });
    await openMenu(user, "Invoices");
    await user.click(await screen.findByRole("menuitem", { name: "Move down Invoices" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The roadmap changed in the meantime — the list was reloaded");
    await waitFor(() => expect(gets(mockFetch)).toBeGreaterThan(before));
    await waitFor(() => expect(rowLabels()).toEqual(["Audit", "Invoices", "Unranked", "Taxes", "Ledger"]));
  });

  test("any other failure rolls the optimistic order back with an inline alert (403 says it is not allowed; 400 and 500 have their own words)", async () => {
    putStatus = { status: 403 };
    const user = userEvent.setup();
    renderWithProviders(<Roadmap />);
    await screen.findByRole("grid", { name: "Roadmap timeline" });
    await openMenu(user, "Audit");
    await user.click(await screen.findByRole("menuitem", { name: "Move up Audit" }));
    expect(await screen.findByText("You are not allowed to change the roadmap")).toBeInTheDocument();
    await waitFor(() => expect(rowLabels()).toEqual(["Invoices", "Taxes", "Audit", "Unranked", "Ledger"]));
    expect(screen.queryByText(/changed in the meantime/)).not.toBeInTheDocument();

    putStatus = { status: 400 };
    await waitFor(() => expect(grid()).toHaveAttribute("aria-busy", "false"));
    await openMenu(user, "Audit");
    await user.click(await screen.findByRole("menuitem", { name: "Move up Audit" }));
    expect(await screen.findByText("A project in the list no longer exists — the list was reloaded")).toBeInTheDocument();

    putStatus = { status: 500 };
    await waitFor(() => expect(grid()).toHaveAttribute("aria-busy", "false"));
    await openMenu(user, "Audit");
    await user.click(await screen.findByRole("menuitem", { name: "Move up Audit" }));
    expect(await screen.findByText("Action failed (500)")).toBeInTheDocument();
  });

  test("a change made while a save is in flight is refused out loud: the note, the announcement, one PUT", async () => {
    const resolvers: Array<(response: Response) => void> = [];
    const inner = mockFetch.getMockImplementation() as (url: string, init?: RequestInit) => Promise<Response>;
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "PUT") return new Promise<Response>((resolve) => resolvers.push(resolve));
      return inner(url, init);
    });
    const user = userEvent.setup();
    renderWithProviders(<Roadmap />);
    await screen.findByRole("grid", { name: "Roadmap timeline" });
    await openMenu(user, "Audit");
    await user.click(await screen.findByRole("menuitem", { name: "Move up Audit" }));
    await waitFor(() => expect(grid()).toHaveAttribute("aria-busy", "true"));
    expect(screen.getByText("Saving…")).toBeInTheDocument();
    expect(screen.queryByRole("note")).toBeNull();
    await openMenu(user, "Ledger");
    await user.click(await screen.findByRole("menuitem", { name: "Rank Ledger" }));
    expect(await screen.findByRole("note")).toHaveTextContent("A save is still running");
    expect(liveText()).toContain("A save is still running");
    // A drag is refused the same way (the context announces the drop as not changed).
    dropRow(TAXES, 2, 0);
    expect(puts(mockFetch)).toHaveLength(1);
    act(() => resolvers[0](jsonResponse(200, { revision: 8 })));
    await waitFor(() => expect(grid()).toHaveAttribute("aria-busy", "false"));
    // The note goes with the save that caused it.
    await waitFor(() => expect(screen.queryByRole("note")).toBeNull());
  });
});

describe("Roadmap page: the row drag", () => {
  test("a drop in the ranked block saves that order; a drop beside the row itself saves nothing", async () => {
    renderWithProviders(<Roadmap />);
    await screen.findByRole("grid", { name: "Roadmap timeline" });
    dropRow(TAXES, 2, 1);
    dropRow(TAXES, 2, 2);
    expect(puts(mockFetch)).toEqual([]);
    dropRow(TAXES, 2, 3);
    await waitFor(() => expect(rowLabels()).toEqual(["Invoices", "Audit", "Taxes", "Unranked", "Ledger"]));
    await waitFor(() => expect(puts(mockFetch)).toEqual([{ expectedRevision: 7, projectIds: [1, 3, 2] }]));
    // dnd-kit's region announces a drag; the page does not repeat a plain move.
    expect(liveText()).not.toContain("moved to position");
  });

  test("a ranked row dropped below the divider is unranked; an unranked row dropped above it is ranked at that slot", async () => {
    renderWithProviders(<Roadmap />);
    await screen.findByRole("grid", { name: "Roadmap timeline" });
    dropRow(AUDIT, 3, 5);
    await waitFor(() => expect(rowLabels()).toEqual(["Invoices", "Taxes", "Unranked", "Audit", "Ledger"]));
    await waitFor(() => expect(puts(mockFetch)).toEqual([{ expectedRevision: 7, projectIds: [1, 2] }]));
    // dnd-kit's region announces a drag; the page's own stays silent for it.
    expect(liveText()).not.toContain("removed from the ranking");
    await waitFor(() => expect(screen.getByRole("grid", { name: "Roadmap timeline" })).toHaveAttribute("aria-busy", "false"));
    // The unranked rows are by name now (Audit, Ledger): drop Ledger between the two ranked rows.
    dropRow(LEDGER, 0, 1, 5);
    await waitFor(() => expect(puts(mockFetch)).toHaveLength(2));
    expect(puts(mockFetch)[1]).toEqual({ expectedRevision: 8, projectIds: [1, 4, 2] });
  });

  test("an unranked row dropped among the unranked rows changes nothing", async () => {
    renderWithProviders(<Roadmap />);
    await screen.findByRole("grid", { name: "Roadmap timeline" });
    dropRow(LEDGER, 0, 5);
    dropRow(LEDGER, 0, 4);
    expect(puts(mockFetch)).toEqual([]);
  });
});

describe("Roadmap page: filters and the program pick", () => {
  async function openFilters(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole("button", { name: /^Filters/ }));
  }
  async function choose(user: ReturnType<typeof userEvent.setup>, label: string, option: string) {
    await user.click(screen.getByRole("combobox", { name: label }));
    await user.click(await screen.findByRole("option", { name: option }));
  }

  test("the filters narrow the rows, the facts line and the flag panel together, and are remembered", async () => {
    const user = userEvent.setup();
    const { unmount } = renderWithProviders(<Roadmap />);
    await screen.findByRole("grid", { name: "Roadmap timeline" });
    await openFilters(user);
    await choose(user, "Work stream", "Finance");
    expect(rowLabels()).toEqual(["Taxes", "Unranked", "Ledger"]);
    expect(within(screen.getByRole("group", { name: "Roadmap facts" })).getByText("1 ranked")).toBeInTheDocument();
    // The `#` column keeps the server's position under a filter.
    expect(within(rowOf("Taxes")).getByRole("rowheader")).toHaveTextContent("2");
    expect(JSON.parse(localStorage.getItem("astrolabe.viewSettings.roadmap.filter.workStream") ?? "null")).toBe(2);
    unmount();
    // A fresh page starts from the remembered filter.
    renderWithProviders(<Roadmap />);
    await screen.findByRole("grid", { name: "Roadmap timeline" });
    expect(rowLabels()).toEqual(["Taxes", "Unranked", "Ledger"]);
  });

  test("team, owner and flagged-only: a team matches projects with milestones on it", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Roadmap />);
    await screen.findByRole("grid", { name: "Roadmap timeline" });
    await openFilters(user);
    await choose(user, "Team", "Web");
    expect(rowLabels()).toEqual(["Taxes"]);
    await user.click(screen.getByLabelText("Clear team filter"));
    await choose(user, "Owner", "Tania Tax");
    expect(rowLabels()).toEqual(["Taxes", "Unranked", "Ledger"]);
    await user.click(screen.getByLabelText("Clear owner filter"));
    await user.click(screen.getByRole("switch", { name: "Flagged projects only" }));
    expect(rowLabels()).toEqual(["Invoices", "Taxes", "Audit"]);
    // A filter that leaves nothing says so instead of drawing an empty grid.
    await choose(user, "Owner", "Tania Tax");
    await choose(user, "Team", "Payments");
    await user.click(screen.getByRole("switch", { name: "Flagged projects only" }));
    expect(rowLabels()).toEqual(["Taxes"]);
    await choose(user, "Work stream", "Platform");
    expect(await screen.findByText("No project matches the filters")).toBeInTheDocument();
    expect(screen.queryByRole("grid", { name: "Roadmap timeline" })).toBeNull();
  });

  test("the program pick narrows the rows and is stored under the ONE shared key; an unknown stored id is ignored", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Roadmap />);
    await screen.findByRole("grid", { name: "Roadmap timeline" });
    await openFilters(user);
    await user.click(screen.getByRole("combobox", { name: "Programs" }));
    await user.click(await screen.findByRole("option", { name: "Compliance" }));
    expect(rowLabels()).toEqual(["Taxes", "Unranked", "Ledger"]);
    expect(JSON.parse(localStorage.getItem(PICK_KEY) ?? "null")).toEqual([11]);
  });

  test("a remembered pick of a program that is gone filters nothing", async () => {
    localStorage.setItem(PICK_KEY, JSON.stringify([99]));
    renderWithProviders(<Roadmap />);
    await screen.findByRole("grid", { name: "Roadmap timeline" });
    expect(rowLabels()).toEqual(["Invoices", "Taxes", "Audit", "Unranked", "Ledger"]);
  });

  test("a move under a filter is relative to the VISIBLE ranked rows: the hidden rows keep their order", async () => {
    // Only Platform's projects show: Invoices and Audit (Taxes is hidden between them). Move Audit up = above Invoices.
    localStorage.setItem("astrolabe.viewSettings.roadmap.filter.workStream", "1");
    const user = userEvent.setup();
    renderWithProviders(<Roadmap />);
    await screen.findByRole("grid", { name: "Roadmap timeline" });
    expect(rowLabels()).toEqual(["Invoices", "Audit"]);
    await openMenu(user, "Audit");
    await user.click(await screen.findByRole("menuitem", { name: "Move up Audit" }));
    await waitFor(() => expect(puts(mockFetch)).toEqual([{ expectedRevision: 7, projectIds: [3, 1, 2] }]));
    expect(liveText()).toContain("Audit moved to position 1 of 3");
  });
});

describe("Roadmap page: flags", () => {
  test("the panel lists every flag in words, warnings first, behind a disclosure; Show in timeline focuses the row", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Roadmap />);
    await screen.findByRole("grid", { name: "Roadmap timeline" });
    expect(screen.queryByRole("table", { name: "Flags of the projects shown" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Show the 4 flags" }));
    const table = await screen.findByRole("table", { name: "Flags of the projects shown" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((row) => within(row).getAllByRole("cell").slice(0, 3).map((cell) => cell.textContent))).toEqual([
      ["Warning", "Invoices", "Ends 10 days after the target"],
      ["Warning", "Taxes", "Ranked below Invoices, but starts 7 days earlier on Payments"],
      ["Info", "Invoices", "Starts 29 days after the target"],
      ["Info", "Audit", "Ranked below Taxes, but starts 1 day earlier (no shared team)"],
    ]);
    await user.click(within(rows[1]).getByRole("button", { name: "Show in timeline: Taxes" }));
    const focused = document.activeElement as HTMLElement;
    expect(focused.closest('[role="row"]')).toBe(rowOf("Taxes"));
    expect(focused).toHaveAttribute("data-grid-pos");
  });

  test("a project with no flags anywhere says so, and the heading stays", async () => {
    view = viewOf({ ranked: [{ position: 1, project: LEDGER }], unranked: [] });
    renderWithProviders(<Roadmap />);
    await screen.findByRole("grid", { name: "Roadmap timeline" });
    expect(screen.getByText("No flags on the projects shown.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Show the/ })).toBeNull();
  });
});

describe("Roadmap page: arrows", () => {
  test("a direct link and a bundled pair of milestone links are drawn, red when violated, and the span bars say the conflicts", async () => {
    view = viewOf({ links: LINKS });
    renderWithProviders(<Roadmap />);
    await screen.findByRole("grid", { name: "Roadmap timeline" });
    await waitFor(() => expect(document.querySelectorAll("[data-arrow]")).toHaveLength(2));
    expect(document.querySelector('[data-arrow="31"]')).toHaveAttribute("data-violated", "true");
    expect(document.querySelector('[data-arrow="bundle:2-3"]')).toHaveAttribute("data-violated", "true");
    expect(document.querySelector('[data-arrow="bundle:2-3"] title')).toHaveTextContent("Taxes → Audit, 2 milestone links (1 violated)");
    expect(within(rowOf("Taxes")).getByRole("img", { name: "Taxes, 2026-03-09 to 2026-05-01, 2 conflicts, read-only" })).toBeInTheDocument();
    expect(within(rowOf("Invoices")).getByRole("img", { name: "Invoices, 2026-03-02 to 2026-04-10, 1 conflict, read-only" })).toBeInTheDocument();
  });

  test("an arrow whose other end is hidden by a stored filter is left out", async () => {
    // Work stream 1 (Platform) hides Taxes (Finance), the other end of both links of the pair 1 -> 2 -> 3 that touch it.
    localStorage.setItem("astrolabe.viewSettings.roadmap.filter.workStream", "1");
    view = viewOf({ links: LINKS });
    renderWithProviders(<Roadmap />);
    await screen.findByRole("grid", { name: "Roadmap timeline" });
    expect(rowLabels()).toEqual(["Invoices", "Audit"]);
    expect(document.querySelectorAll("[data-arrow]")).toHaveLength(0);
  });

  test("an arrow whose project is filtered out or has no span is left out", async () => {
    view = viewOf({ links: LINKS, ranked: [{ position: 1, project: INVOICES }, { position: 2, project: { ...TAXES, span: null } }, { position: 3, project: AUDIT }] });
    renderWithProviders(<Roadmap />);
    await screen.findByRole("grid", { name: "Roadmap timeline" });
    expect(document.querySelectorAll("[data-arrow]")).toHaveLength(0);
  });
});

describe("Roadmap page: without rights and the empty states", () => {
  test("without can.editRank the page reads: no handles, no ranking items in the menu, read-only bars", async () => {
    view = viewOf({ can: { editRank: false } });
    const user = userEvent.setup();
    renderWithProviders(<Roadmap />);
    await screen.findByRole("grid", { name: "Roadmap timeline" });
    expect(rowLabels()).toEqual(["Invoices", "Taxes", "Audit", "Unranked", "Ledger"]);
    expect(document.querySelectorAll("[data-row-handle]")).toHaveLength(0);
    expect(within(rowOf("Invoices")).getAllByRole("img").length).toBeGreaterThan(0);
    await openMenu(user, "Taxes");
    expect(await screen.findByRole("menuitem", { name: "Open project Taxes" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /Move|Rank/ })).toBeNull();
    expect(screen.getByText(/Everyone can read it/)).toBeInTheDocument();
  });

  test("no projects at all, and a nothing-ranked plan whose divider leads", async () => {
    view = viewOf({ ranked: [], unranked: [] });
    const { unmount } = renderWithProviders(<Roadmap />);
    expect(await screen.findByText("No projects yet")).toBeInTheDocument();
    expect(screen.queryByRole("grid")).toBeNull();
    unmount();

    view = viewOf({ ranked: [], unranked: [LEDGER] });
    renderWithProviders(<Roadmap />);
    await screen.findByRole("grid", { name: "Roadmap timeline" });
    expect(rowLabels()).toEqual(["Unranked", "Ledger"]);
  });

  test("a failed load shows the load-failure alert", async () => {
    mockFetch.mockResolvedValue(jsonResponse(500, { title: "x", status: 500 }));
    renderWithProviders(<Roadmap />);
    expect(await screen.findByText("Could not load the roadmap")).toBeInTheDocument();
  });
});
