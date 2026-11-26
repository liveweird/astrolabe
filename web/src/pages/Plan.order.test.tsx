import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { act, screen, waitFor } from "@testing-library/react";
import { DndContext } from "@dnd-kit/core";
import Plan from "./Plan";
import type { PlanView } from "../api/plan";
import { jsonResponse, routeFetch } from "../test/http";
import { linksView } from "../test/jiraLinks";
import { findPlanTree, planOf, planStatus } from "../test/planView";
import { renderWithProviders } from "../test/render";
import { applyOrder, fullIds, withOrderRevision } from "../utils/planOrder";

const PINS_KEY = "astrolabe.viewSettings.plan.pins";
const STALE = { type: "urn:astrolabe:problem:stale-revision", title: "Conflict", status: 409, detail: "stale" };

// happy-dom has no layout, so a pointer drag cannot run here (e2e drives the real one): the context is wrapped to hand the test its drag handlers, and
// the rows get a layout of their own (below). What the page does WHEN dnd-kit reports a drop is ours to pin.
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

/** Platform (Billing with two projects, Identity, Ledger) and Finance (Tax, Audit) are open; Legacy and Old are closed. */
const PLAN = () =>
  planOf(
    [
      {
        id: 1,
        name: "Platform",
        programOrderRevision: 3,
        programs: [
          { id: 10, name: "Billing", projects: [{ id: 100, name: "Invoices" }, { id: 101, name: "Taxes" }] },
          { id: 11, name: "Identity" },
          { id: 13, name: "Ledger" },
        ],
      },
      { id: 3, name: "Finance", programs: [{ id: 14, name: "Tax" }, { id: 15, name: "Audit" }] },
      { id: 2, name: "Legacy", endDate: "2025-12-31", programs: [{ id: 12, name: "Archive" }] },
      { id: 4, name: "Old", endDate: "2024-12-31", programs: [{ id: 16, name: "Attic" }] },
    ],
    { revision: 8, workStreamOrderRevision: 2 },
  );

/** The server as the page sees it: the view it answers, the PUTs it took and what it says to the next one. */
let server: PlanView;
let puts: { path: string; body: unknown }[];
let putAnswer: (() => Response | Promise<Response>) | null;
let viewGets: number;

function serve(over: Parameters<typeof routeFetch>[0] = {}) {
  const store = (path: string, body: unknown, apply: (revision: number) => void) => {
    puts.push({ path, body });
    if (putAnswer !== null) return putAnswer();
    apply(server.revision + 1);
    return jsonResponse(200, { revision: server.revision });
  };
  vi.stubGlobal(
    "fetch",
    routeFetch({
      "GET /api/v1/views/plan": () => {
        viewGets += 1;
        return server;
      },
      "GET /api/v1/views/jira-links": linksView(),
      "PUT /api/v1/work-stream-order": ({ json }) => {
        const body = json() as { workStreamIds: number[] };
        return store("/api/v1/work-stream-order", body, (revision) => {
          server = withOrderRevision(applyOrder(server, { kind: "workStream" }, body.workStreamIds), { kind: "workStream" }, revision);
        });
      },
      "PUT /api/v1/work-streams/:id/program-order": ({ params, json }) => {
        const body = json() as { programIds: number[] };
        return store(`/api/v1/work-streams/${params.id}/program-order`, body, (revision) => {
          const list = { kind: "program", streamId: Number(params.id) } as const;
          server = withOrderRevision(applyOrder(server, list, body.programIds), list, revision);
        });
      },
      ...over,
    }),
  );
}

const rows = () => Array.from(document.querySelectorAll('tr[data-scope="tree"]')).map((row) => row.getAttribute("data-key"));
const keysOf = (kind: string) => rows().filter((key) => key?.startsWith(kind));
/** The program rows of one work stream, in table order. */
const programsOf = (streamKey: string) => Array.from(document.querySelectorAll(`tr[data-scope="tree"][data-kind="program"][data-parent="${streamKey}"]`)).map((row) => row.getAttribute("data-key"));
const handles = () => document.querySelectorAll("tr[data-scope='tree'] [data-plan-handle]");
const handled = () => Array.from(document.querySelectorAll("tr[data-scope='tree']")).filter((row) => row.querySelector("[data-plan-handle]") !== null).map((row) => row.getAttribute("data-key"));
const menuButton = (name: string) => screen.getByRole("button", { name: `Operations for ${name}` });
const openMenu = (user: ReturnType<typeof userEvent.setup>, name: string) => user.click(menuButton(name));
const item = (name: string) => screen.findByRole("menuitem", { name });
const settled = () => waitFor(() => expect(screen.queryByText("Saving…")).toBeNull());

// ---- a layout for happy-dom: every tree row is 36 px high, stacked from y = 100, the table is 800 px wide -----------------------------------------------
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.tagName === "TR" && this.getAttribute("data-scope") === "tree") {
      const index = Array.from(document.querySelectorAll('tr[data-scope="tree"]')).indexOf(this);
      const top = 100 + 36 * index;
      return { x: 0, y: top, left: 0, right: 800, top, bottom: top + 36, width: 800, height: 36, toJSON: () => ({}) };
    }
    if (this.tagName === "TABLE") return { x: 0, y: 0, left: 0, right: 800, top: 0, bottom: 0, width: 800, height: 0, toJSON: () => ({}) };
    return { x: 0, y: 0, left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) };
  });
});

/** The live pointer moves to client y (the window's `pointermove`, which the page follows during a drag). */
const movePointer = (y: number) => act(() => void window.dispatchEvent(new PointerEvent("pointermove", { clientX: 20, clientY: y, isPrimary: true })));

/**
 * A row dragged by its grip from client y 140 and moved to `y`; `release` ends the drag there. The slot comes from the pointer against the blocks'
 * midpoints, so `y` alone decides it (read from the live pointer, as the page does). `scrolled` is the scroll adjustment dnd-kit folds into its `delta` after an
 * autoscroll or a wheel: it must change nothing. `data` is what the grip carries.
 */
function drag(key: string, y: number, release = true, scrolled = 0) {
  const view = server;
  const kind = key.startsWith("ws:") ? "workStream" : "program";
  const id = Number(key.slice(3));
  const label = kind === "workStream" ? (view.workStreams.find((stream) => stream.id === id)?.name ?? "") : (view.workStreams.flatMap((stream) => stream.programs).find((program) => program.id === id)?.name ?? "");
  const siblings = kind === "workStream" ? view.workStreams.filter((stream) => (stream.endDate !== null) === (view.workStreams.find((s) => s.id === id)?.endDate !== null)).map((s) => s.id) : fullIds(view, { kind: "program", streamId: view.workStreams.find((s) => s.programs.some((p) => p.id === id))?.id ?? 0 });
  const data = { key, node: { kind, id }, label, index: siblings.indexOf(id), count: siblings.length };
  const event = { active: { id: `plan-row:${key}`, data: { current: data } }, delta: { x: 0, y: y - 140 + scrolled }, activatorEvent: { clientX: 20, clientY: 140 } };
  act(() => dndProps?.onDragStart?.(event as never));
  movePointer(y);
  act(() => dndProps?.onDragMove?.(event as never));
  if (release) act(() => dndProps?.onDragEnd?.(event as never));
  return event;
}

/** The fake server, the layout and the page's storage, for each test of a describe. */
function useServerAndLayout() {
  beforeEach(() => {
    localStorage.setItem("astrolabe.auth.token", "fake-token");
    server = PLAN();
    puts = [];
    putAnswer = null;
    viewGets = 0;
    dndProps = null;
    serve();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    localStorage.clear();
  });
}

describe("Plan page: re-arranging work streams and programs", () => {
  useServerAndLayout();

  describe("who sees what", () => {
    test("an administrator has a grip on every work stream among its own state and every program among its stream's, never on a project or a lone node", async () => {
      renderWithProviders(<Plan />);
      await findPlanTree();
      // Legacy and Old are two closed streams: they re-arrange among themselves. Legacy's Archive and Old's Attic are alone in their stream.
      expect(handled()).toEqual(["ws:1", "pg:10", "pg:11", "pg:13", "ws:3", "pg:14", "pg:15", "ws:2", "ws:4"]);
      expect(handles()[0]).toHaveAttribute("aria-hidden", "true");
      expect(handles()[0]).toHaveAttribute("data-print", "hide");
      expect(handles()[0]).not.toHaveAttribute("tabindex");
    });

    test("a stream or program with no grip keeps a grip's room while others have one, so the names line up; no room where nothing can be moved", async () => {
      renderWithProviders(<Plan />);
      await findPlanTree();
      const roomOf = (key: string) => document.querySelector(`tr[data-scope="tree"][data-key="${key}"] [class*="planRowHandleRoom"]`);
      // Archive (alone in its stream) has no grip; Platform has one. Projects have neither, and keep their own indent.
      expect(roomOf("pg:12")).not.toBeNull();
      expect(roomOf("ws:1")).toBeNull();
      expect(roomOf("pj:100")).toBeNull();
    });

    test("no room is kept where nothing at all can be moved", async () => {
      server = planOf([{ id: 1, name: "Platform", can: { orderPrograms: false }, programs: [{ id: 10, name: "Billing" }, { id: 11, name: "Identity" }] }], { can: { createWorkStream: false, orderWorkStreams: false } });
      renderWithProviders(<Plan />);
      await findPlanTree();
      expect(document.querySelectorAll('tr[data-scope="tree"] [class*="planRowHandleRoom"]')).toHaveLength(0);
    });

    test("a reader with no right has no grip and no Move item", async () => {
      server = planOf(
        [
          { id: 1, name: "Platform", can: { orderPrograms: false }, programs: [{ id: 10, name: "Billing" }, { id: 11, name: "Identity" }] },
          { id: 2, name: "Finance", can: { orderPrograms: false } },
        ],
        { can: { createWorkStream: false, orderWorkStreams: false } },
      );
      const user = userEvent.setup();
      renderWithProviders(<Plan />);
      await findPlanTree();
      expect(handles()).toHaveLength(0);
      await openMenu(user, "Platform");
      await item("Pin: Platform");
      expect(screen.queryByRole("menuitem", { name: /^Move (up|down)/ })).toBeNull();
      await user.keyboard("{Escape}");
      await openMenu(user, "Billing");
      await item("Pin: Billing");
      expect(screen.queryByRole("menuitem", { name: /^Move (up|down)/ })).toBeNull();
    });

    test("a work stream's owner re-arranges its programs and nothing else: no grip on a stream, none on another stream's programs", async () => {
      server = planOf(
        [
          { id: 1, name: "Platform", programs: [{ id: 10, name: "Billing" }, { id: 11, name: "Identity" }] },
          { id: 3, name: "Finance", can: { orderPrograms: false }, programs: [{ id: 14, name: "Tax" }, { id: 15, name: "Audit" }] },
        ],
        { can: { createWorkStream: false, orderWorkStreams: false } },
      );
      const user = userEvent.setup();
      renderWithProviders(<Plan />);
      await findPlanTree();
      expect(handled()).toEqual(["pg:10", "pg:11"]);
      await openMenu(user, "Platform");
      await item("Pin: Platform");
      expect(screen.queryByRole("menuitem", { name: /^Move (up|down)/ })).toBeNull();
      await user.keyboard("{Escape}");
      await openMenu(user, "Tax");
      await item("Pin: Tax");
      expect(screen.queryByRole("menuitem", { name: /^Move (up|down)/ })).toBeNull();
      await user.keyboard("{Escape}");
      await openMenu(user, "Identity");
      expect(await item("Move up: Identity")).not.toHaveAttribute("data-disabled");
      expect(screen.getByRole("menuitem", { name: "Move down: Identity" })).toHaveAttribute("data-disabled", "true");
    });

    test("the Move items follow the row's place: disabled at either end of its siblings, and closed streams never among the open ones", async () => {
      const user = userEvent.setup();
      renderWithProviders(<Plan />);
      await findPlanTree();
      await openMenu(user, "Platform");
      expect(await item("Move up: Platform")).toHaveAttribute("data-disabled", "true");
      expect(screen.getByRole("menuitem", { name: "Move down: Platform" })).not.toHaveAttribute("data-disabled");
      await user.keyboard("{Escape}");
      // Finance is the last OPEN stream: nothing below it to move down among (Legacy and Old are closed).
      await openMenu(user, "Finance");
      expect(await item("Move down: Finance")).toHaveAttribute("data-disabled", "true");
      expect(screen.getByRole("menuitem", { name: "Move up: Finance" })).not.toHaveAttribute("data-disabled");
      await user.keyboard("{Escape}");
      await openMenu(user, "Legacy");
      expect(await item("Move up: Legacy")).toHaveAttribute("data-disabled", "true");
      expect(screen.getByRole("menuitem", { name: "Move down: Legacy" })).not.toHaveAttribute("data-disabled");
    });

    test("the Move items sit after the view group and before the edit group, each group set apart", async () => {
      const user = userEvent.setup();
      renderWithProviders(<Plan />);
      await findPlanTree();
      await openMenu(user, "Identity");
      const labels = (await screen.findAllByRole("menuitem")).map((entry) => entry.getAttribute("aria-label"));
      expect(labels.slice(0, 5)).toEqual(["Show only this: Identity", "Pin: Identity", "Move up: Identity", "Move down: Identity", "Edit Identity"]);
      const menu = screen.getByRole("menuitem", { name: "Move up: Identity" }).parentElement as HTMLElement;
      expect(menu.querySelectorAll(".mantine-Menu-divider").length).toBeGreaterThanOrEqual(2);
    });

    test("a pinned copy has no grip and no Move item", async () => {
      localStorage.setItem(PINS_KEY, JSON.stringify(["pg:10"]));
      const user = userEvent.setup();
      renderWithProviders(<Plan />);
      await findPlanTree();
      expect(document.querySelectorAll("tr[data-scope='pinned']").length).toBeGreaterThan(0);
      expect(document.querySelectorAll("tr[data-scope='pinned'] [data-plan-handle]")).toHaveLength(0);
      await user.click(screen.getByRole("button", { name: "Operations for Billing (pinned)" }));
      await screen.findByRole("menuitem", { name: "Show only this: Billing (pinned)" });
      expect(screen.queryByRole("menuitem", { name: /Move (up|down)/ })).toBeNull();
    });
  });

  describe("Move up and Move down", () => {
    test("Move down on a program PUTs the stream's complete list with the stream's own revision, reorders at once, says so and keeps the focus on the menu button", async () => {
      const user = userEvent.setup();
      renderWithProviders(<Plan />);
      await findPlanTree();
      await openMenu(user, "Billing");
      await user.click(await item("Move down: Billing"));
      expect(programsOf("ws:1")).toEqual(["pg:11", "pg:10", "pg:13"]);
      await waitFor(() => expect(puts).toEqual([{ path: "/api/v1/work-streams/1/program-order", body: { expectedRevision: 3, programIds: [11, 10, 13] } }]));
      expect(planStatus()).toHaveTextContent("Billing moved to position 2 of 3");
      await settled();
      await waitFor(() => expect(viewGets).toBeGreaterThan(1));
      await waitFor(() => expect(menuButton("Billing")).toHaveFocus());
      // The projects travelled with their program.
      expect(rows().slice(0, 7)).toEqual(["ws:1", "pg:11", "pg:10", "pj:100", "pj:101", "pg:13", "ws:3"]);
    });

    test("Move up on a work stream PUTs the work stream list (the closed ones last) with the list's own revision; the answered revision is the next one", async () => {
      const user = userEvent.setup();
      renderWithProviders(<Plan />);
      await findPlanTree();
      await openMenu(user, "Finance");
      await user.click(await item("Move up: Finance"));
      await waitFor(() => expect(puts).toEqual([{ path: "/api/v1/work-stream-order", body: { expectedRevision: 2, workStreamIds: [3, 1, 2, 4] } }]));
      expect(keysOf("ws:")).toEqual(["ws:3", "ws:1", "ws:2", "ws:4"]);
      expect(planStatus()).toHaveTextContent("Finance moved to position 1 of 2");
      await settled();
      await waitFor(() => expect(menuButton("Finance")).toHaveFocus());
      await openMenu(user, "Finance");
      await user.click(await item("Move down: Finance"));
      await waitFor(() => expect(puts).toHaveLength(2));
      // The server answered revision 9: that is the next expectedRevision of the list, not the plan's.
      expect(puts[1]).toEqual({ path: "/api/v1/work-stream-order", body: { expectedRevision: 9, workStreamIds: [1, 3, 2, 4] } });
    });

    test("closed streams move among themselves, and an open stream's list keeps them after it", async () => {
      const user = userEvent.setup();
      renderWithProviders(<Plan />);
      await findPlanTree();
      await openMenu(user, "Legacy");
      await user.click(await item("Move down: Legacy"));
      await waitFor(() => expect(puts).toEqual([{ path: "/api/v1/work-stream-order", body: { expectedRevision: 2, workStreamIds: [1, 3, 4, 2] } }]));
      expect(keysOf("ws:")).toEqual(["ws:1", "ws:3", "ws:4", "ws:2"]);
    });

    test("hide closed alone does not turn reordering off, and the list sent still holds the hidden closed streams", async () => {
      const user = userEvent.setup();
      renderWithProviders(<Plan />, { route: "/plan?hideClosed=true" });
      await findPlanTree();
      expect(handled().filter((key) => key?.startsWith("ws:"))).toEqual(["ws:1", "ws:3"]);
      expect(screen.queryByRole("note")).toBeNull();
      await openMenu(user, "Finance");
      await user.click(await item("Move up: Finance"));
      await waitFor(() => expect(puts).toEqual([{ path: "/api/v1/work-stream-order", body: { expectedRevision: 2, workStreamIds: [3, 1, 2, 4] } }]));
    });

    test("a rolled-back move returns the focus to the row's menu button", async () => {
      putAnswer = () => jsonResponse(500, { type: "about:blank", title: "Oops", status: 500 });
      const user = userEvent.setup();
      renderWithProviders(<Plan />);
      await findPlanTree();
      await openMenu(user, "Billing");
      await user.click(await item("Move down: Billing"));
      expect(await screen.findByText("Action failed (500)")).toBeInTheDocument();
      await waitFor(() => expect(programsOf("ws:1")).toEqual(["pg:10", "pg:11", "pg:13"]));
      await waitFor(() => expect(menuButton("Billing")).toHaveFocus());
    });
  });

  describe("failures", () => {
    test("a stale 409 says the plan changed, rolls the order back, reloads the plan and loses nothing", async () => {
      putAnswer = () => jsonResponse(409, STALE);
      const user = userEvent.setup();
      renderWithProviders(<Plan />);
      await findPlanTree();
      const before = viewGets;
      // Someone else's order lands before the reload.
      server = applyOrder(server, { kind: "program", streamId: 1 }, [13, 11, 10]);
      await openMenu(user, "Billing");
      await user.click(await item("Move down: Billing"));
      const note = await screen.findByRole("note");
      expect(note).toHaveTextContent("The plan changed in the meantime");
      expect(planStatus()).toHaveTextContent("The plan changed in the meantime");
      await waitFor(() => expect(viewGets).toBeGreaterThan(before));
      await waitFor(() => expect(programsOf("ws:1")).toEqual(["pg:13", "pg:11", "pg:10"]));
      // The note stays until the next change; a change then goes out against the reloaded list.
      putAnswer = null;
      await openMenu(user, "Ledger");
      await user.click(await item("Move down: Ledger"));
      await waitFor(() => expect(puts).toHaveLength(2));
      expect(puts[1].body).toEqual({ expectedRevision: 3, programIds: [11, 13, 10] });
      await waitFor(() => expect(screen.queryByText(/changed in the meantime/)).toBeNull());
    });

    test.each([
      ["a 400 (a listed node is gone)", 400, "The plan changed in the meantime"],
      ["a 404 (the work stream is gone)", 404, "The plan changed in the meantime"],
      ["a 403", 403, "Only an administrator can reorder work streams"],
      ["a 500", 500, "Action failed (500)"],
    ])("%s rolls the order back and says so", async (_name, status, words) => {
      putAnswer = () => jsonResponse(status, { type: "about:blank", title: "No", status });
      const user = userEvent.setup();
      renderWithProviders(<Plan />);
      await findPlanTree();
      await openMenu(user, "Billing");
      await user.click(await item("Move down: Billing"));
      await waitFor(() => expect(document.body).toHaveTextContent(words));
      await waitFor(() => expect(programsOf("ws:1")).toEqual(["pg:10", "pg:11", "pg:13"]));
    });

    test("a change made while a save is in flight is refused out loud: the note, the announcement, one PUT", async () => {
      const resolvers: Array<(response: Response) => void> = [];
      putAnswer = () => new Promise<Response>((resolve) => resolvers.push(resolve));
      const user = userEvent.setup();
      renderWithProviders(<Plan />);
      await findPlanTree();
      await openMenu(user, "Billing");
      await user.click(await item("Move down: Billing"));
      await waitFor(() => expect(puts).toHaveLength(1));
      await openMenu(user, "Tax");
      await user.click(await item("Move down: Tax"));
      expect(await screen.findByRole("note")).toHaveTextContent("A save is still running");
      expect(planStatus()).toHaveTextContent("A save is still running");
      // A drop is refused the same way.
      drag("ws:3", 110);
      expect(puts).toHaveLength(1);
      act(() => resolvers[0](jsonResponse(200, { revision: 9 })));
      await waitFor(() => expect(screen.queryByRole("note")).toBeNull());
    });
  });

  describe("off while the table shows only part of the plan", () => {
    test.each([
      ["a search", "/plan?q=bill"],
      ["an owner filter", "/plan?ownerPersonId=6"],
      ["a focus", "/plan?workStreamId=1"],
    ])("%s: no grip, the Move items disabled and pointing at the note that says why", async (_name, route) => {
      server = planOf(
        [{ id: 1, name: "Platform", programOrderRevision: 3, programs: [{ id: 10, name: "Billing" }, { id: 11, name: "Identity" }] }, { id: 3, name: "Finance" }],
        { revision: 8, workStreamOrderRevision: 2 },
      );
      const user = userEvent.setup();
      renderWithProviders(<Plan />, { route });
      await findPlanTree();
      expect(handles()).toHaveLength(0);
      const note = screen.getByRole("note");
      expect(note).toHaveTextContent("Reordering is off while a search, an owner filter or");
      await openMenu(user, "Billing");
      const up = await item("Move up: Billing");
      expect(up).toHaveAttribute("data-disabled", "true");
      expect(screen.getByRole("menuitem", { name: "Move down: Billing" })).toHaveAttribute("data-disabled", "true");
      expect(up).toHaveAttribute("aria-describedby", note.id);
      await user.click(screen.getByRole("menuitem", { name: "Move down: Billing" }));
      expect(puts).toEqual([]);
    });

    test("a reader who could not reorder anything is not told about it", async () => {
      server = planOf([{ id: 1, name: "Platform", can: { orderPrograms: false }, programs: [{ id: 10, name: "Billing" }, { id: 11, name: "Identity" }] }], { can: { createWorkStream: false, orderWorkStreams: false } });
      renderWithProviders(<Plan />, { route: "/plan?q=bill" });
      await findPlanTree();
      expect(screen.queryByRole("note")).toBeNull();
    });
  });

});

describe("Plan page: the row drag", () => {
  useServerAndLayout();
  // Layout (36 px rows from y = 100): ws:1 100, pg:10 136, pj:100 172, pj:101 208, pg:11 244, pg:13 280, ws:3 316, pg:14 352, pg:15 388, ws:2 424, pg:12 460, ws:4 496, pg:16 532.
  // Platform's programs: Billing 136-244 (middle 190), Identity 244-280 (262), Ledger 280-316 (298); the open streams: Platform 100-316 (208), Finance 316-424 (370).

  test("a program dropped past the others' midpoints PUTs the stream's complete list, announced as a move", async () => {
    renderWithProviders(<Plan />);
    await findPlanTree();
    drag("pg:10", 300);
    await waitFor(() => expect(puts).toEqual([{ path: "/api/v1/work-streams/1/program-order", body: { expectedRevision: 3, programIds: [11, 13, 10] } }]));
    expect(programsOf("ws:1")).toEqual(["pg:11", "pg:13", "pg:10"]);
    expect(planStatus()).toHaveTextContent("Billing moved to position 3 of 3");
    await settled();
  });

  test("a work stream dropped above the first midpoint goes first; the closed ones stay after the open ones", async () => {
    renderWithProviders(<Plan />);
    await findPlanTree();
    drag("ws:3", 110);
    await waitFor(() => expect(puts).toEqual([{ path: "/api/v1/work-stream-order", body: { expectedRevision: 2, workStreamIds: [3, 1, 2, 4] } }]));
    expect(keysOf("ws:")).toEqual(["ws:3", "ws:1", "ws:2", "ws:4"]);
    await settled();
  });

  test("a closed stream is dropped among the closed ones by their own midpoints", async () => {
    renderWithProviders(<Plan />);
    await findPlanTree();
    // The closed blocks: Legacy 424-496 (460), Old 496-568 (532): below Old's midpoint is the last gap.
    drag("ws:2", 550);
    await waitFor(() => expect(puts).toEqual([{ path: "/api/v1/work-stream-order", body: { expectedRevision: 2, workStreamIds: [1, 3, 4, 2] } }]));
  });

  test("the drop line shows the gap while the row is held, the row stays put at half strength, and a drop beside the row itself writes nothing", async () => {
    renderWithProviders(<Plan />);
    await findPlanTree();
    drag("pg:10", 300, false);
    const line = document.querySelector("[data-plan-slot]");
    expect(line).toHaveAttribute("data-plan-slot", "3");
    expect(line).toHaveAttribute("aria-hidden", "true");
    expect((line as HTMLElement).style.top).toBe("315px"); // the bottom of the last block (316), less half the line
    expect(document.querySelector('tr[data-key="pg:10"]')).toHaveAttribute("data-dragging", "true");
    expect(programsOf("ws:1")).toEqual(["pg:10", "pg:11", "pg:13"]);
    expect(planStatus()).toHaveTextContent("Billing: drop to take position 3 of 3");
    // Back over its own gap: no marker, nothing to write.
    movePointer(240);
    act(() => dndProps?.onDragMove?.({ active: { id: "plan-row:pg:10", data: { current: undefined } }, delta: { x: 0, y: 100 }, activatorEvent: {} } as never));
    expect(document.querySelector("[data-plan-slot]")).toBeNull();
    act(() => dndProps?.onDragEnd?.({ active: { id: "plan-row:pg:10", data: { current: undefined } }, delta: { x: 0, y: 100 }, activatorEvent: {} } as never));
    expect(document.querySelector('tr[data-key="pg:10"]')).not.toHaveAttribute("data-dragging");
    expect(puts).toEqual([]);
    expect(planStatus()).toHaveTextContent("Billing dropped where it was, position 1 of 3");
  });

  test("a scroll under the drag (dnd-kit's delta carries it) moves nothing: the slot follows the pointer against the rows' live rectangles", async () => {
    renderWithProviders(<Plan />);
    await findPlanTree();
    // The pointer is at 300 (past every midpoint), but delta says the pointer travelled 600 px further: read from delta the drop would be "outside".
    drag("pg:10", 300, true, 600);
    await waitFor(() => expect(puts).toEqual([{ path: "/api/v1/work-streams/1/program-order", body: { expectedRevision: 3, programIds: [11, 13, 10] } }]));
    await settled();
    // And the other way: a delta that says "300" while the pointer is above the list is a drop outside, not a move.
    drag("pg:11", 90, true, 210);
    expect(puts).toHaveLength(1);
  });

  test("a drop outside the list's extent does nothing: above its parent's row, or below its last block", async () => {
    renderWithProviders(<Plan />);
    await findPlanTree();
    drag("pg:10", 90);
    expect(planStatus()).toHaveTextContent("Billing dropped outside its list, nothing changed");
    drag("pg:10", 600);
    drag("ws:3", 90);
    drag("ws:3", 430);
    expect(puts).toEqual([]);
    expect(programsOf("ws:1")).toEqual(["pg:10", "pg:11", "pg:13"]);
  });

  test("picking a row up, and cancelling the drag, are said", async () => {
    renderWithProviders(<Plan />);
    await findPlanTree();
    const event = drag("pg:11", 270, false);
    expect(planStatus()).toHaveTextContent(/Identity/);
    act(() => dndProps?.onDragCancel?.(event as never));
    expect(planStatus()).toHaveTextContent("Move of Identity cancelled");
    expect(document.querySelector("[data-plan-slot]")).toBeNull();
    expect(document.querySelector("tr[data-dragging]")).toBeNull();
    expect(puts).toEqual([]);
  });

  test("pick-up names the place and the count", async () => {
    renderWithProviders(<Plan />);
    await findPlanTree();
    const event = { active: { id: "plan-row:pg:11", data: { current: { key: "pg:11", node: { kind: "program", id: 11 }, label: "Identity", index: 1, count: 3 } } }, delta: { x: 0, y: 0 }, activatorEvent: { clientX: 1, clientY: 140 } };
    act(() => dndProps?.onDragStart?.(event as never));
    expect(planStatus()).toHaveTextContent("Identity picked up, position 2 of 3");
    act(() => dndProps?.onDragCancel?.(event as never));
  });

  test("a failed drop rolls the order back and says the plan changed", async () => {
    putAnswer = () => jsonResponse(409, STALE);
    renderWithProviders(<Plan />);
    await findPlanTree();
    drag("pg:10", 300);
    expect(await screen.findByRole("note")).toHaveTextContent("The plan changed in the meantime");
    await waitFor(() => expect(programsOf("ws:1")).toEqual(["pg:10", "pg:11", "pg:13"]));
  });
});
