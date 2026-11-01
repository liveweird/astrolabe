import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { act, screen, waitFor, within } from "@testing-library/react";
import { DndContext } from "@dnd-kit/core";
import Roadmap from "./Roadmap";
import type { PlanFlag, RoadmapProject, RoadmapView } from "../api/roadmap";
import { applyRanking } from "../utils/roadmapOrder";
import { applyRoadmapWindow } from "../utils/targetWindowUpdate";
import { jsonResponse } from "../test/http";
import { renderWithProviders } from "../test/render";

// The target window on the roadmap page (v0.6): the band is editable only where the project's own `can.editTargetWindow` says so, a drop on it
// (move, resize, draw) and the row menu's dialog and Clear are ONE write path (`useTargetWindow`), shared with the ranking by one mutation key.
// happy-dom has no layout, so a pointer drag cannot run here (e2e drives the real one): the context is wrapped to hand the test its handlers.

type FetchMock = ReturnType<typeof vi.fn>;

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

const emit = (name: "onDragStart" | "onDragMove" | "onDragEnd", event: unknown) => act(() => (dndProps?.[name] as ((e: unknown) => void) | undefined)?.(event));

/** The Quarter zoom (the default) is 3 px a day. */
const DAY = 3;

/** A window bar moved or resized by `days`, released: the context proposes `onSchedule("window:<id>", …)`. */
function dragBand(project: RoadmapProject, kind: "move" | "resize-start" | "resize-end", days: number) {
  const active = {
    id: `bar:window:${project.id}:${kind}`,
    data: { current: { kind, barId: `window:${project.id}`, label: project.name, start: project.targetStart, end: project.targetEnd } },
  };
  const event = { active, delta: { x: days * DAY, y: 0 }, over: null, activatorEvent: null };
  emit("onDragStart", event);
  emit("onDragEnd", event);
}

/** A window drawn on a row: the pointer went down at the surface's left edge (x = 100, day 0 of the range) and was released `days` later. */
function drawWindow(project: RoadmapProject, days: number) {
  const active = { id: `draw:window:${project.id}`, data: { current: { kind: "draw", barId: `window:${project.id}`, label: project.name, trackLeft: () => 100 } } };
  const zone = { id: "timeline-track", data: { current: { zoneLeft: () => 100, visibleBounds: () => null } } };
  emit("onDragStart", { active, delta: { x: 0, y: 0 }, over: null, activatorEvent: { clientX: 100, clientY: 0 } });
  act(() => {
    window.dispatchEvent(new PointerEvent("pointermove", { clientX: 100 + days * DAY + 1, clientY: 0, isPrimary: true }));
  });
  emit("onDragEnd", { active, delta: { x: 0, y: 0 }, over: zone, activatorEvent: { clientX: 100, clientY: 0 } });
}

const flag = (kind: PlanFlag["kind"], severity: PlanFlag["severity"], days: number | null): PlanFlag => ({ kind, severity, days, teamId: null, otherProjectId: null });

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
  can: { editTargetWindow: true },
  ...over,
});

// Invoices: a window, a span past it (drift flags), editable. Taxes: no window, editable. Audit: a window, NOT editable. Ledger: unranked, no window, editable.
const INVOICES = project(1, "Invoices", {
  rankPosition: 1,
  targetStart: "2026-02-02",
  targetEnd: "2026-03-31",
  span: { start: "2026-03-02", end: "2026-04-10" },
  drift: { startDays: 28, endDays: 10 },
  flags: [flag("DRIFT_END_LATE", "WARNING", 10), flag("DRIFT_START_LATE", "INFO", 28), flag("RANK_INVERSION", "WARNING", 3)],
});
const TAXES = project(2, "Taxes", { rankPosition: 2, span: { start: "2026-03-09", end: "2026-05-01" } });
const AUDIT = project(3, "Audit", { rankPosition: 3, targetStart: "2026-05-04", targetEnd: "2026-06-05", can: { editTargetWindow: false } });
const LEDGER = project(4, "Ledger");

const viewOf = (): RoadmapView => ({
  revision: 7,
  can: { editRank: true },
  teams: [],
  links: [],
  ranked: [
    { position: 1, project: INVOICES },
    { position: 2, project: TAXES },
    { position: 3, project: AUDIT },
  ],
  unranked: [LEDGER],
});

let view: RoadmapView;
let windowStatus: { status: number };
/** While set, the window PUT waits for it (a write "in flight"). */
let windowGate: Promise<void> | null;
let rankingGate: Promise<void> | null;
let mockFetch: FetchMock;

function serve() {
  mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "GET" && url === "/api/v1/views/roadmap") return jsonResponse(200, view);
    const window = /^\/api\/v1\/projects\/(\d+)\/target-window$/.exec(url);
    if (method === "PUT" && window !== null) {
      await windowGate;
      if (windowStatus.status !== 204) return jsonResponse(windowStatus.status, { title: "x", status: windowStatus.status });
      const body = JSON.parse(init?.body as string) as { targetStart: string | null; targetEnd: string | null };
      view = applyRoadmapWindow(view, Number(window[1]), body.targetStart, body.targetEnd);
      return new Response(null, { status: 204 });
    }
    if (method === "PUT" && url === "/api/v1/roadmap/ranking") {
      await rankingGate;
      const body = JSON.parse(init?.body as string) as { projectIds: number[] };
      view = { ...applyRanking(view, body.projectIds), revision: view.revision + 1 };
      return jsonResponse(200, { revision: view.revision });
    }
    return jsonResponse(404, { title: "x", status: 404 });
  });
}

const windowPuts = () =>
  mockFetch.mock.calls
    .filter(([u, init]) => /\/target-window$/.test(u as string) && (init as RequestInit).method === "PUT")
    .map(([u, init]) => ({ id: Number(/projects\/(\d+)\//.exec(u as string)?.[1]), body: JSON.parse((init as RequestInit).body as string) as { targetStart: string | null; targetEnd: string | null } }));
const gets = () => mockFetch.mock.calls.filter(([u, init]) => u === "/api/v1/views/roadmap" && ((init as RequestInit | undefined)?.method ?? "GET") === "GET").length;

const grid = () => screen.getByRole("grid", { name: "Roadmap timeline" });
const rowOf = (name: string) => within(grid()).getByRole("link", { name: `Open ${name}` }).closest('[role="row"]') as HTMLElement;
const liveText = () => screen.getAllByRole("status").map((region) => region.textContent).join(" | ");
const settled = () => waitFor(() => expect(grid()).toHaveAttribute("aria-busy", "false"));
/** The window bar of a project: an editable bar is a draggable named by `timeline.bar.window`; a read-only one is an image with ", read-only". */
const windowBar = (name: string, start: string, end: string) => within(rowOf(name)).queryByLabelText(`${name}, target window ${start} to ${end}`);

async function openMenu(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole("button", { name: `Operations for ${name}` }));
}

beforeEach(() => {
  view = viewOf();
  windowStatus = { status: 204 };
  windowGate = null;
  rankingGate = null;
  dndProps = null;
  mockFetch = vi.fn();
  vi.stubGlobal("fetch", mockFetch);
  localStorage.setItem("astrolabe.auth.token", "fake-token");
  serve();
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("Roadmap page: the target window's gestures follow the project's own can.editTargetWindow", () => {
  test("an editable window is a draggable band with handles; a project without the right reads an image; the draw surface is only on rows without a window", async () => {
    renderWithProviders(<Roadmap />);
    await screen.findByRole("grid", { name: "Roadmap timeline" });
    expect(windowBar("Invoices", "2026-02-02", "2026-03-31")).toHaveAttribute("data-tone", "window");
    expect(within(rowOf("Invoices")).getByLabelText("Resize start of Invoices")).toBeInTheDocument();
    expect(within(rowOf("Invoices")).queryByRole("img", { name: /target window/ })).toBeNull();
    // Audit's owner may not change its window: the band is a read-only image, no handles.
    expect(within(rowOf("Audit")).getByRole("img", { name: "Audit, target window 2026-05-04 to 2026-06-05, read-only" })).toBeInTheDocument();
    expect(within(rowOf("Audit")).queryByLabelText("Resize start of Audit")).toBeNull();
    // Draw: Taxes and Ledger have no window and may be given one; Invoices has one, Audit may not.
    const surfaces = [...document.querySelectorAll("[data-draw-surface]")].map((surface) => surface.closest('[role="row"]'));
    expect(surfaces).toEqual([rowOf("Taxes"), rowOf("Ledger")]);
  });

  test("the row menu offers Edit target window… (and Clear only with a window) by the project's right; a project without it gets neither", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Roadmap />);
    await screen.findByRole("grid", { name: "Roadmap timeline" });
    await openMenu(user, "Invoices");
    expect(await screen.findByRole("menuitem", { name: "Edit target window of Invoices" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Clear target window of Invoices" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menuitem")).toBeNull());
    await openMenu(user, "Taxes");
    expect(await screen.findByRole("menuitem", { name: "Edit target window of Taxes" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /^Clear target window/ })).toBeNull();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menuitem")).toBeNull());
    await openMenu(user, "Audit");
    expect(await screen.findByRole("menuitem", { name: "Open project Audit" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /target window/ })).toBeNull();
  });
});

describe("Roadmap page: moving, resizing and drawing the band", () => {
  test("a moved band PUTs the shifted window, shows it at once and drops the drift figures it decided; the refetch brings the server's", async () => {
    renderWithProviders(<Roadmap />);
    await screen.findByRole("grid", { name: "Roadmap timeline" });
    expect(rowOf("Invoices").querySelector('[title="10 days past the target end"]')).not.toBeNull();
    dragBand(INVOICES, "move", 7);
    // Optimistic: the band is where it was dropped, the overrun band and the drift flags (not the rank inversion) are gone until the refetch.
    await waitFor(() => expect(windowBar("Invoices", "2026-02-09", "2026-04-07")).not.toBeNull());
    expect(rowOf("Invoices").querySelector('[title="10 days past the target end"]')).toBeNull();
    expect(rowOf("Invoices").querySelector("[data-flags]")).toHaveAttribute("data-flags", "1,0");
    await waitFor(() => expect(windowPuts()).toEqual([{ id: 1, body: { targetStart: "2026-02-09", targetEnd: "2026-04-07" } }]));
    await waitFor(() => expect(gets()).toBeGreaterThan(1));
    await settled();
    expect(windowBar("Invoices", "2026-02-09", "2026-04-07")).not.toBeNull();
    // A drag is announced by dnd-kit's own region, not by the page.
    expect(liveText()).not.toContain("target window 2026-02-09");
  });

  test("a resize moves one edge", async () => {
    renderWithProviders(<Roadmap />);
    await screen.findByRole("grid", { name: "Roadmap timeline" });
    dragBand(INVOICES, "resize-end", 14);
    await waitFor(() => expect(windowPuts()).toEqual([{ id: 1, body: { targetStart: "2026-02-02", targetEnd: "2026-04-14" } }]));
    await settled();
  });

  test("a window drawn on a row without one is PUT as the days between the pointer-down and the release, either order", async () => {
    renderWithProviders(<Roadmap />);
    await screen.findByRole("grid", { name: "Roadmap timeline" });
    drawWindow(TAXES, 10);
    await waitFor(() => expect(windowPuts()).toHaveLength(1));
    const { id, body } = windowPuts()[0];
    expect(id).toBe(2);
    expect(body.targetStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect((Date.parse(body.targetEnd ?? "") - Date.parse(body.targetStart ?? "")) / 86_400_000).toBe(10);
    await settled();
    // The row now has its window: a band, and no draw surface any more.
    expect(within(rowOf("Taxes")).getByLabelText(`Taxes, target window ${body.targetStart} to ${body.targetEnd}`)).toBeInTheDocument();
    expect(rowOf("Taxes").querySelector("[data-draw-surface]")).toBeNull();
  });

  test("a proposal for a bar that is not a window, or for a project that has left the view, is refused (the page says so)", async () => {
    renderWithProviders(<Roadmap />);
    await screen.findByRole("grid", { name: "Roadmap timeline" });
    const active = { id: "bar:5:move", data: { current: { kind: "move", barId: 5, label: "Stray", start: "2026-02-02", end: "2026-02-06" } } };
    const stray = { active, delta: { x: DAY, y: 0 }, over: null, activatorEvent: null };
    emit("onDragStart", stray);
    emit("onDragEnd", stray);
    expect(windowPuts()).toEqual([]);
    dragBand(project(99, "Vanished", { targetStart: "2026-02-02", targetEnd: "2026-02-06" }), "move", 1);
    expect(windowPuts()).toEqual([]);
    expect(await screen.findByText("This project is no longer in the plan — it was removed in the meantime.")).toBeInTheDocument();
    expect(liveText()).toContain("This project is no longer in the plan");
  });
});

describe("Roadmap page: the dialog and Clear", () => {
  test("Edit target window… saves the dates, closes, announces, and the focus returns to the row's menu button", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Roadmap />);
    await screen.findByRole("grid", { name: "Roadmap timeline" });
    await openMenu(user, "Taxes");
    await user.click(await screen.findByRole("menuitem", { name: "Edit target window of Taxes" }));
    const dialog = await screen.findByRole("dialog", { name: "Target window of Taxes" });
    // No window yet: Clear has nothing to remove.
    expect(within(dialog).getByRole("button", { name: "Clear" })).toBeDisabled();
    // Both dates are needed to save a window (Clear is the way to have none).
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByText("Enter a start date")).toBeInTheDocument();
    expect(within(dialog).getByText("Enter an end date")).toBeInTheDocument();
    expect(windowPuts()).toEqual([]);
    const start = within(dialog).getByRole("textbox", { name: "Target start" });
    const end = within(dialog).getByRole("textbox", { name: "Target end" });
    await user.type(start, "2026-04-01");
    await user.type(end, "2026-04-30");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(windowPuts()).toEqual([{ id: 2, body: { targetStart: "2026-04-01", targetEnd: "2026-04-30" } }]));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(liveText()).toContain("Taxes: target window 2026-04-01 to 2026-04-30");
    await settled();
    expect(windowBar("Taxes", "2026-04-01", "2026-04-30")).not.toBeNull();
    await waitFor(() => expect(screen.getByRole("button", { name: "Operations for Taxes" })).toHaveFocus());
  });

  test("the dialog is prefilled with the window, checks the order of the dates and sends nothing while it is wrong", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Roadmap />);
    await screen.findByRole("grid", { name: "Roadmap timeline" });
    await openMenu(user, "Invoices");
    await user.click(await screen.findByRole("menuitem", { name: "Edit target window of Invoices" }));
    const dialog = await screen.findByRole("dialog", { name: "Target window of Invoices" });
    const end = within(dialog).getByRole("textbox", { name: "Target end" });
    expect(within(dialog).getByRole("textbox", { name: "Target start" })).toHaveValue("2026-02-02");
    expect(end).toHaveValue("2026-03-31");
    await user.clear(end);
    await user.type(end, "2026-01-15");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByText("The end must not be before the start")).toBeInTheDocument();
    expect(windowPuts()).toEqual([]);
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(screen.getByRole("button", { name: "Operations for Invoices" })).toHaveFocus());
  });

  test("the dialog's Clear PUTs the null pair and the band goes", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Roadmap />);
    await screen.findByRole("grid", { name: "Roadmap timeline" });
    await openMenu(user, "Invoices");
    await user.click(await screen.findByRole("menuitem", { name: "Edit target window of Invoices" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Clear" }));
    await waitFor(() => expect(windowPuts()).toEqual([{ id: 1, body: { targetStart: null, targetEnd: null } }]));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(liveText()).toContain("Invoices: target window cleared");
    await settled();
    expect(within(rowOf("Invoices")).queryByLabelText(/target window/)).toBeNull();
  });

  test("Clear target window from the menu clears at once, announces it, offers the draw on the row and keeps focus on the menu button", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Roadmap />);
    await screen.findByRole("grid", { name: "Roadmap timeline" });
    await openMenu(user, "Invoices");
    await user.click(await screen.findByRole("menuitem", { name: "Clear target window of Invoices" }));
    expect(within(rowOf("Invoices")).queryByLabelText(/target window/)).toBeNull();
    expect(rowOf("Invoices").querySelector("[data-draw-surface]")).not.toBeNull();
    await waitFor(() => expect(windowPuts()).toEqual([{ id: 1, body: { targetStart: null, targetEnd: null } }]));
    expect(liveText()).toContain("Invoices: target window cleared");
    await settled();
    await waitFor(() => expect(screen.getByRole("button", { name: "Operations for Invoices" })).toHaveFocus());
  });
});

describe("Roadmap page: failures and the one write at a time", () => {
  test("a 403 rolls the band back, reloads and says who may change the window", async () => {
    windowStatus = { status: 403 };
    renderWithProviders(<Roadmap />);
    await screen.findByRole("grid", { name: "Roadmap timeline" });
    const before = gets();
    dragBand(INVOICES, "move", 7);
    expect(await screen.findByText("Only an administrator, an owner above the project or a roadmap editor can change the target window")).toBeInTheDocument();
    await waitFor(() => expect(gets()).toBeGreaterThan(before));
    await waitFor(() => expect(windowBar("Invoices", "2026-02-02", "2026-03-31")).not.toBeNull());
    expect(windowBar("Invoices", "2026-02-09", "2026-04-07")).toBeNull();
  });

  test.each([
    [404, "This project is no longer in the plan — it was removed in the meantime."],
    [400, "These dates cannot be saved: the end must not be before the start"],
    [500, "Save failed (500)"],
  ])("a %i is mapped to words and rolls back", async (status, sentence) => {
    windowStatus = { status };
    renderWithProviders(<Roadmap />);
    await screen.findByRole("grid", { name: "Roadmap timeline" });
    dragBand(INVOICES, "resize-end", 7);
    expect(await screen.findByText(sentence)).toBeInTheDocument();
    await waitFor(() => expect(windowBar("Invoices", "2026-02-02", "2026-03-31")).not.toBeNull());
  });

  test("a window change made while a RANK save is in flight is refused out loud, and keeps the dialog open", async () => {
    const user = userEvent.setup();
    let release: () => void = () => undefined;
    rankingGate = new Promise((resolve) => {
      release = resolve;
    });
    renderWithProviders(<Roadmap />);
    await screen.findByRole("grid", { name: "Roadmap timeline" });
    await openMenu(user, "Audit");
    await user.click(await screen.findByRole("menuitem", { name: "Move up Audit" }));
    await waitFor(() => expect(grid()).toHaveAttribute("aria-busy", "true"));
    dragBand(INVOICES, "move", 7);
    expect(windowPuts()).toEqual([]);
    expect(screen.getByRole("note")).toHaveTextContent("A save is still running");
    expect(liveText()).toContain("A save is still running");
    expect(windowBar("Invoices", "2026-02-02", "2026-03-31")).not.toBeNull();
    // The dialog says it in an alert of its own and stays open.
    await openMenu(user, "Taxes");
    await user.click(await screen.findByRole("menuitem", { name: "Edit target window of Taxes" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByRole("textbox", { name: "Target start" }), "2026-04-01");
    await user.type(within(dialog).getByRole("textbox", { name: "Target end" }), "2026-04-30");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByText("A save is still running — try your change again in a moment.")).toBeInTheDocument();
    expect(windowPuts()).toEqual([]);
    release();
    await settled();
    // Once the rank save is over the same change goes through.
    await waitFor(() => expect(within(dialog).queryByText(/still running/)).toBeNull());
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(windowPuts()).toEqual([{ id: 2, body: { targetStart: "2026-04-01", targetEnd: "2026-04-30" } }]));
  });

  test("and the other way round: a rank change made while a window save is in flight is refused", async () => {
    const user = userEvent.setup();
    let release: () => void = () => undefined;
    windowGate = new Promise((resolve) => {
      release = resolve;
    });
    renderWithProviders(<Roadmap />);
    await screen.findByRole("grid", { name: "Roadmap timeline" });
    dragBand(INVOICES, "move", 7);
    await waitFor(() => expect(grid()).toHaveAttribute("aria-busy", "true"));
    expect(screen.getByText("Saving…")).toBeInTheDocument();
    await openMenu(user, "Audit");
    await user.click(await screen.findByRole("menuitem", { name: "Move up Audit" }));
    expect(mockFetch.mock.calls.some(([u]) => u === "/api/v1/roadmap/ranking")).toBe(false);
    expect(screen.getByRole("note")).toHaveTextContent("A save is still running");
    release();
    await settled();
    await waitFor(() => expect(screen.queryByRole("note")).toBeNull());
  });
});
