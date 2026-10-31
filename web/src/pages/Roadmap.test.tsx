import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { act, screen, waitFor, within } from "@testing-library/react";
import { DndContext } from "@dnd-kit/core";
import Roadmap from "./Roadmap";
import type { RoadmapProject, RoadmapView } from "../api/roadmap";
import { applyRanking } from "../utils/roadmapOrder";
import { headingOutline } from "../test/headings";
import { jsonResponse } from "../test/http";
import { renderWithProviders } from "../test/render";

type FetchMock = ReturnType<typeof vi.fn>;

// happy-dom has no layout, so a pointer or keyboard drag cannot run here (e2e drives the real thing). The context is wrapped to
// hand the test its drag-end handler: what happens WHEN dnd-kit reports a drop is ours to pin.
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
const drop = (activeId: number, overId: number | null) =>
  act(() => dndProps?.onDragEnd?.({ active: { id: activeId }, over: overId === null ? null : { id: overId } } as never));

const project = (id: number, name: string, over: Partial<RoadmapProject> = {}): RoadmapProject => ({
  id,
  name,
  programId: 10,
  programName: "Billing",
  workStreamId: 1,
  workStreamName: "Platform",
  ownerName: "Ola Owner",
  targetStart: null,
  targetEnd: null,
  ...over,
});

const INVOICES = project(1, "Invoices", { targetStart: "2026-02-01", targetEnd: "2026-03-31" });
const TAXES = project(2, "Taxes", { programName: "Compliance", ownerName: "Tania Tax" });
const AUDIT = project(3, "Audit");
const LEDGER = project(4, "Ledger");

const viewOf = (over: Partial<RoadmapView> = {}): RoadmapView => ({
  revision: 7,
  can: { editRank: true },
  ranked: [
    { position: 1, project: INVOICES },
    { position: 2, project: TAXES },
    { position: 3, project: AUDIT },
  ],
  unranked: [LEDGER],
  ...over,
});

const STALE = { type: "urn:astrolabe:problem:stale-revision", title: "Conflict", status: 409, detail: "stale" };

let view: RoadmapView;
let putStatus: { status: number; body?: unknown };

/** A tiny server: GET answers the current view; an accepted PUT applies the list and bumps the revision. */
function serve(mockFetch: FetchMock) {
  mockFetch.mockImplementation((url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "GET" && url === "/api/v1/views/roadmap") return Promise.resolve(jsonResponse(200, view));
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

const rankedOrder = () =>
  within(screen.getByRole("table", { name: "Ranked projects" }))
    .getAllByRole("row")
    .slice(1)
    .map((row) => within(row).getAllByRole("cell")[1].textContent);

describe("Roadmap page", () => {
  let mockFetch: FetchMock;

  beforeEach(() => {
    view = viewOf();
    putStatus = { status: 200 };
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    localStorage.setItem("astrolabe.auth.token", "fake-token");
    serve(mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  test("renders the ranked list and the Unranked group, the heading outline pinned", async () => {
    renderWithProviders(<Roadmap />);
    await screen.findByRole("table", { name: "Ranked projects" });
    expect(headingOutline()).toEqual([
      [2, "Roadmap"],
      [3, "Ranked"],
      [3, "Unranked"],
    ]);
    const ranked = screen.getByRole("table", { name: "Ranked projects" });
    const first = within(ranked).getByRole("row", { name: /Invoices/ });
    expect(within(first).getAllByRole("cell").map((c) => c.textContent?.replace(/\s+/g, " "))).toEqual(
      expect.arrayContaining(["1", "Invoices", "Billing", "Platform", "Ola Owner", "2026-02-01 – 2026-03-31"]),
    );
    expect(within(within(ranked).getByRole("row", { name: /Taxes/ })).getByText("Not set")).toBeInTheDocument();
    expect(rankedOrder()).toEqual(["Invoices", "Taxes", "Audit"]);
    expect(within(screen.getByRole("table", { name: "Unranked projects" })).getByText("Ledger")).toBeInTheDocument();
  });

  test("an editor gets a labelled handle, Move up / Move down and Unrank per ranked row, and the screen-reader instructions", async () => {
    renderWithProviders(<Roadmap />);
    await screen.findByRole("table", { name: "Ranked projects" });
    expect(screen.getByRole("button", { name: "Drag Taxes" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Move up Taxes" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Move down Taxes" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Unrank Taxes" })).toBeInTheDocument();
    // The ends cannot move past themselves.
    expect(screen.getByRole("button", { name: "Move up Invoices" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Move down Audit" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Rank Ledger" })).toBeInTheDocument();
    // dnd-kit's hidden instructions (the handle's aria-describedby) are in the page, in the UI language.
    expect(await screen.findByText(/To pick up a project, press Space or Enter on its drag handle/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Drag Taxes" })).toHaveAttribute("aria-roledescription", "sortable");
  });

  test("Move up PUTs the complete new order with the view's revision, reorders at once and announces it", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Roadmap />);
    await screen.findByRole("table", { name: "Ranked projects" });
    await user.click(screen.getByRole("button", { name: "Move up Audit" }));
    expect(rankedOrder()).toEqual(["Invoices", "Audit", "Taxes"]);
    await waitFor(() => expect(puts(mockFetch)).toEqual([{ expectedRevision: 7, projectIds: [1, 3, 2] }]));
    expect(screen.getByText("Audit moved to position 2 of 3")).toBeInTheDocument();
    await waitFor(() => expect(gets(mockFetch)).toBeGreaterThan(1));
  });

  test("the revision from a successful save is the next save's expectedRevision", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Roadmap />);
    await screen.findByRole("table", { name: "Ranked projects" });
    await user.click(screen.getByRole("button", { name: "Move down Invoices" }));
    await waitFor(() => expect(puts(mockFetch)).toHaveLength(1));
    // The refetch after the save has landed (the mutation is no longer pending) before the next change.
    await waitFor(() => expect(screen.getByRole("table", { name: "Ranked projects" })).toHaveAttribute("aria-busy", "false"));
    await user.click(screen.getByRole("button", { name: "Move down Invoices" }));
    await waitFor(() => expect(puts(mockFetch)).toHaveLength(2));
    expect(puts(mockFetch)[1]).toEqual({ expectedRevision: 8, projectIds: [2, 3, 1] });
  });

  test("Rank appends an unranked project at the end of the list", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Roadmap />);
    await screen.findByRole("table", { name: "Ranked projects" });
    await user.click(screen.getByRole("button", { name: "Rank Ledger" }));
    expect(rankedOrder()).toEqual(["Invoices", "Taxes", "Audit", "Ledger"]);
    await waitFor(() => expect(puts(mockFetch)).toEqual([{ expectedRevision: 7, projectIds: [1, 2, 3, 4] }]));
    expect(screen.getByText("Ledger ranked at position 4 of 4")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Every project is ranked.")).toBeInTheDocument());
  });

  test("Unrank removes the project from the list and puts it in the Unranked group", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Roadmap />);
    await screen.findByRole("table", { name: "Ranked projects" });
    await user.click(screen.getByRole("button", { name: "Unrank Taxes" }));
    expect(rankedOrder()).toEqual(["Invoices", "Audit"]);
    expect(within(screen.getByRole("table", { name: "Unranked projects" })).getByText("Taxes")).toBeInTheDocument();
    await waitFor(() => expect(puts(mockFetch)).toEqual([{ expectedRevision: 7, projectIds: [1, 3] }]));
    expect(screen.getByText("Taxes removed from the ranking")).toBeInTheDocument();
  });

  test("a stale 409 says the roadmap changed, rolls the list back and reloads the view", async () => {
    putStatus = { status: 409, body: STALE };
    const user = userEvent.setup();
    renderWithProviders(<Roadmap />);
    await screen.findByRole("table", { name: "Ranked projects" });
    const before = gets(mockFetch);
    // Someone else's change lands before the reload.
    view = viewOf({ revision: 9, ranked: [{ position: 1, project: AUDIT }, { position: 2, project: INVOICES }], unranked: [TAXES, LEDGER] });
    await user.click(screen.getByRole("button", { name: "Move down Invoices" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The roadmap changed in the meantime — the list was reloaded");
    await waitFor(() => expect(gets(mockFetch)).toBeGreaterThan(before));
    await waitFor(() => expect(rankedOrder()).toEqual(["Audit", "Invoices"]));
  });

  test("any other failure rolls the optimistic order back with an inline alert (and a 403 says it is not allowed)", async () => {
    putStatus = { status: 403 };
    const user = userEvent.setup();
    renderWithProviders(<Roadmap />);
    await screen.findByRole("table", { name: "Ranked projects" });
    await user.click(screen.getByRole("button", { name: "Move up Audit" }));
    expect(await screen.findByText("You are not allowed to change the roadmap")).toBeInTheDocument();
    await waitFor(() => expect(rankedOrder()).toEqual(["Invoices", "Taxes", "Audit"]));
    expect(screen.queryByText(/changed in the meantime/)).not.toBeInTheDocument();
  });

  test("a 400 (a project vanished) and a generic failure each have their own sentence", async () => {
    putStatus = { status: 400 };
    const user = userEvent.setup();
    renderWithProviders(<Roadmap />);
    await screen.findByRole("table", { name: "Ranked projects" });
    await user.click(screen.getByRole("button", { name: "Move up Audit" }));
    expect(await screen.findByText("A project in the list no longer exists — the list was reloaded")).toBeInTheDocument();
    putStatus = { status: 500 };
    await waitFor(() => expect(screen.getByRole("table", { name: "Ranked projects" })).toHaveAttribute("aria-busy", "false"));
    await user.click(screen.getByRole("button", { name: "Move up Audit" }));
    expect(await screen.findByText("Action failed (500)")).toBeInTheDocument();
  });

  test("while a save is in flight, a further change is ignored", async () => {
    const resolvers: Array<(response: Response) => void> = [];
    mockFetch.mockImplementation((_url: string, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "PUT") return new Promise<Response>((resolve) => resolvers.push(resolve));
      return Promise.resolve(jsonResponse(200, view));
    });
    const user = userEvent.setup();
    renderWithProviders(<Roadmap />);
    await screen.findByRole("table", { name: "Ranked projects" });
    await user.click(screen.getByRole("button", { name: "Move up Audit" }));
    await waitFor(() => expect(screen.getByRole("table", { name: "Ranked projects" })).toHaveAttribute("aria-busy", "true"));
    await user.click(screen.getByRole("button", { name: "Move up Taxes" }));
    await user.click(screen.getByRole("button", { name: "Rank Ledger" }));
    expect(puts(mockFetch)).toHaveLength(1);
    resolvers[0](jsonResponse(200, { revision: 8 }));
    await waitFor(() => expect(screen.getByRole("table", { name: "Ranked projects" })).toHaveAttribute("aria-busy", "false"));
  });

  test("a drop on another row saves that order; a drop on itself or outside any row saves nothing", async () => {
    renderWithProviders(<Roadmap />);
    await screen.findByRole("table", { name: "Ranked projects" });
    drop(3, 3);
    drop(3, null);
    expect(puts(mockFetch)).toEqual([]);
    drop(3, 1);
    await waitFor(() => expect(rankedOrder()).toEqual(["Audit", "Invoices", "Taxes"]));
    await waitFor(() => expect(puts(mockFetch)).toEqual([{ expectedRevision: 7, projectIds: [3, 1, 2] }]));
  });

  test("without can.editRank the list is read-only: no handles, no buttons, no Rank", async () => {
    view = viewOf({ can: { editRank: false } });
    renderWithProviders(<Roadmap />);
    await screen.findByRole("table", { name: "Ranked projects" });
    expect(rankedOrder()).toEqual(["Invoices", "Taxes", "Audit"]);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByText(/To pick up a project/)).not.toBeInTheDocument();
    expect(screen.getByText("Ledger")).toBeInTheDocument();
    expect(screen.getByText(/Everyone can read it/)).toBeInTheDocument();
  });

  test("empty states: nothing ranked, everything ranked, no projects at all", async () => {
    view = viewOf({ ranked: [], unranked: [LEDGER] });
    const { unmount } = renderWithProviders(<Roadmap />);
    expect(await screen.findByText(/Use Rank on a project below/)).toBeInTheDocument();
    unmount();

    view = viewOf({ can: { editRank: false }, ranked: [], unranked: [LEDGER] });
    const second = renderWithProviders(<Roadmap />);
    expect(await screen.findByText("No project is ranked yet.")).toBeInTheDocument();
    second.unmount();

    view = viewOf({ ranked: [], unranked: [] });
    renderWithProviders(<Roadmap />);
    expect(await screen.findByText("No projects yet")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 3 })).not.toBeInTheDocument();
  });

  test("a failed load shows the load-failure alert", async () => {
    mockFetch.mockResolvedValue(jsonResponse(500, { title: "x", status: 500 }));
    renderWithProviders(<Roadmap />);
    expect(await screen.findByText("Could not load the roadmap")).toBeInTheDocument();
  });
});
