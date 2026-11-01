import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { act, screen, waitFor, within } from "@testing-library/react";
import { DndContext } from "@dnd-kit/core";
import Programs from "./Programs";
import type { ProgramsView } from "../api/programs";
import type { PlanFlag, RoadmapProject } from "../api/roadmap";
import { applyProgramsWindow } from "../utils/targetWindowUpdate";
import { jsonResponse } from "../test/http";
import { renderWithProviders } from "../test/render";

// The target window on the programs page (v0.6): the same project row, write path and dialog as the roadmap's (`Roadmap.window.test.tsx` pins the
// details); here what is the tree's own - the roll-up counts follow the drift flags a window change drops, the cache is the programs view's.

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

const emit = (name: "onDragStart" | "onDragEnd", event: unknown) => act(() => (dndProps?.[name] as ((e: unknown) => void) | undefined)?.(event));

/** The Quarter zoom (the default) is 3 px a day. */
const DAY = 3;

function dragBand(project: RoadmapProject, kind: "move" | "resize-start" | "resize-end", days: number) {
  const active = { id: `bar:window:${project.id}:${kind}`, data: { current: { kind, barId: `window:${project.id}`, label: project.name, start: project.targetStart, end: project.targetEnd } } };
  const event = { active, delta: { x: days * DAY, y: 0 }, over: null, activatorEvent: null };
  emit("onDragStart", event);
  emit("onDragEnd", event);
}

const flag = (kind: PlanFlag["kind"], severity: PlanFlag["severity"], days: number): PlanFlag => ({ kind, severity, days, teamId: null, otherProjectId: null });

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

const INVOICES = project(1, "Invoices", {
  targetStart: "2026-02-02",
  targetEnd: "2026-03-31",
  span: { start: "2026-03-02", end: "2026-04-10" },
  drift: { startDays: 28, endDays: 10 },
  flags: [flag("DRIFT_END_LATE", "WARNING", 10), flag("DRIFT_START_LATE", "INFO", 28)],
});
const TAXES = project(2, "Taxes", { span: { start: "2026-05-04", end: "2026-06-05" } });
const AUDIT = project(3, "Audit", { targetStart: "2026-07-06", targetEnd: "2026-07-31", can: { editTargetWindow: false } });

const viewOf = (): ProgramsView => ({
  revision: 9,
  teams: [],
  links: [],
  workStreams: [
    {
      id: 1,
      name: "Platform",
      ownerName: "Sam Stream",
      startDate: "2026-01-05",
      endDate: null,
      span: { start: "2026-03-02", end: "2026-06-05" },
      flags: { warnings: 1, infos: 1 },
      programs: [{ id: 10, name: "Billing", ownerName: "Pat Program", span: { start: "2026-03-02", end: "2026-06-05" }, flags: { warnings: 1, infos: 1 }, projects: [INVOICES, TAXES, AUDIT] }],
    },
  ],
});

let view: ProgramsView;
let windowStatus: number;
let windowGate: Promise<void> | null;
let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  view = viewOf();
  windowStatus = 204;
  windowGate = null;
  dndProps = null;
  mockFetch = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "GET" && url === "/api/v1/views/programs") return jsonResponse(200, view);
    const match = /^\/api\/v1\/projects\/(\d+)\/target-window$/.exec(url);
    if (method === "PUT" && match !== null) {
      await windowGate;
      if (windowStatus !== 204) return jsonResponse(windowStatus, { title: "x", status: windowStatus });
      const body = JSON.parse(init?.body as string) as { targetStart: string | null; targetEnd: string | null };
      view = applyProgramsWindow(view, Number(match[1]), body.targetStart, body.targetEnd);
      return new Response(null, { status: 204 });
    }
    return jsonResponse(404, { title: "x", status: 404 });
  });
  vi.stubGlobal("fetch", mockFetch);
  localStorage.setItem("astrolabe.auth.token", "fake-token");
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

const puts = () =>
  mockFetch.mock.calls
    .filter(([u, init]) => /\/target-window$/.test(u as string) && (init as RequestInit).method === "PUT")
    .map(([u, init]) => ({ id: Number(/projects\/(\d+)\//.exec(u as string)?.[1]), body: JSON.parse((init as RequestInit).body as string) as unknown }));
const gets = () => mockFetch.mock.calls.filter(([u, init]) => u === "/api/v1/views/programs" && ((init as RequestInit | undefined)?.method ?? "GET") === "GET").length;
const grid = () => screen.getByRole("grid", { name: "Programs timeline" });
const rowOf = (name: string) => within(grid()).getByRole("link", { name: `Open ${name}` }).closest('[role="row"]') as HTMLElement;
const nodeRow = (label: string) => within(grid()).getByRole("button", { name: label }).closest('[role="row"]') as HTMLElement;
const liveText = () => screen.getAllByRole("status").map((region) => region.textContent).join(" | ");
const settled = () => waitFor(() => expect(grid()).toHaveAttribute("aria-busy", "false"));

/** The page with the program open (its project rows shown). */
async function openProgram(user: ReturnType<typeof userEvent.setup>) {
  renderWithProviders(<Programs />);
  await screen.findByRole("grid", { name: "Programs timeline" });
  await user.click(within(grid()).getByRole("button", { name: "Program Billing" }));
  await waitFor(() => expect(within(grid()).getByRole("link", { name: "Open Invoices" })).toBeInTheDocument());
}

describe("Programs page: the target window", () => {
  test("a project's band is editable, its row drawable and its menu complete only by its own can.editTargetWindow", async () => {
    const user = userEvent.setup();
    await openProgram(user);
    expect(within(rowOf("Invoices")).getByLabelText("Invoices, target window 2026-02-02 to 2026-03-31")).toHaveAttribute("data-tone", "window");
    expect(within(rowOf("Audit")).getByRole("img", { name: "Audit, target window 2026-07-06 to 2026-07-31, read-only" })).toBeInTheDocument();
    expect([...document.querySelectorAll("[data-draw-surface]")].map((surface) => surface.closest('[role="row"]'))).toEqual([rowOf("Taxes")]);
    await user.click(screen.getByRole("button", { name: "Operations for Invoices" }));
    expect(await screen.findByRole("menuitem", { name: "Edit target window of Invoices" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Clear target window of Invoices" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menuitem")).toBeNull());
    await user.click(screen.getByRole("button", { name: "Operations for Audit" }));
    expect(await screen.findByRole("menuitem", { name: "Open project Audit" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /target window/ })).toBeNull();
  });

  test("a moved band PUTs the window; the row's flags and its program's and stream's roll-ups lose the drift they decided, then the refetch is the truth", async () => {
    const user = userEvent.setup();
    await openProgram(user);
    expect(nodeRow("Program Billing").querySelector("[data-flags]")).toHaveAttribute("data-flags", "1,1");
    const before = gets();
    dragBand(INVOICES, "move", 7);
    await waitFor(() => expect(within(rowOf("Invoices")).getByLabelText("Invoices, target window 2026-02-09 to 2026-04-07")).toBeInTheDocument());
    expect(rowOf("Invoices").querySelector("[data-flags]")).toBeNull();
    expect(nodeRow("Program Billing").querySelector("[data-flags]")).toBeNull();
    expect(nodeRow("Work stream Platform").querySelector("[data-flags]")).toBeNull();
    await waitFor(() => expect(puts()).toEqual([{ id: 1, body: { targetStart: "2026-02-09", targetEnd: "2026-04-07" } }]));
    await waitFor(() => expect(gets()).toBeGreaterThan(before));
    await settled();
    expect(within(rowOf("Invoices")).getByLabelText("Invoices, target window 2026-02-09 to 2026-04-07")).toBeInTheDocument();
  });

  test("the dialog sets a window on a row without one; the focus comes back to the row's menu button", async () => {
    const user = userEvent.setup();
    await openProgram(user);
    await user.click(screen.getByRole("button", { name: "Operations for Taxes" }));
    await user.click(await screen.findByRole("menuitem", { name: "Edit target window of Taxes" }));
    const dialog = await screen.findByRole("dialog", { name: "Target window of Taxes" });
    await user.type(within(dialog).getByRole("textbox", { name: "Target start" }), "2026-05-04");
    await user.type(within(dialog).getByRole("textbox", { name: "Target end" }), "2026-06-05");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(puts()).toEqual([{ id: 2, body: { targetStart: "2026-05-04", targetEnd: "2026-06-05" } }]));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(liveText()).toContain("Taxes: target window 2026-05-04 to 2026-06-05");
    await settled();
    await waitFor(() => expect(screen.getByRole("button", { name: "Operations for Taxes" })).toHaveFocus());
    expect(rowOf("Taxes").querySelector("[data-draw-surface]")).toBeNull();
  });

  test("Clear target window clears at once and keeps the focus on the menu button", async () => {
    const user = userEvent.setup();
    await openProgram(user);
    await user.click(screen.getByRole("button", { name: "Operations for Invoices" }));
    await user.click(await screen.findByRole("menuitem", { name: "Clear target window of Invoices" }));
    expect(within(rowOf("Invoices")).queryByLabelText(/target window/)).toBeNull();
    await waitFor(() => expect(puts()).toEqual([{ id: 1, body: { targetStart: null, targetEnd: null } }]));
    expect(liveText()).toContain("Invoices: target window cleared");
    await settled();
    await waitFor(() => expect(screen.getByRole("button", { name: "Operations for Invoices" })).toHaveFocus());
  });

  test("a 403 rolls the tree back, reloads and says who may change the window; a second change during a save is refused out loud", async () => {
    windowStatus = 403;
    let release: () => void = () => undefined;
    windowGate = new Promise((resolve) => {
      release = resolve;
    });
    const user = userEvent.setup();
    await openProgram(user);
    dragBand(INVOICES, "move", 7);
    await waitFor(() => expect(grid()).toHaveAttribute("aria-busy", "true"));
    expect(screen.getByText("Saving…")).toBeInTheDocument();
    dragBand(INVOICES, "resize-end", 3);
    expect(puts()).toHaveLength(1);
    expect(screen.getByRole("note")).toHaveTextContent("A save is still running");
    expect(liveText()).toContain("A save is still running");
    release();
    expect(await screen.findByText("Only an administrator, an owner above the project or a roadmap editor can change the target window")).toBeInTheDocument();
    await settled();
    expect(within(rowOf("Invoices")).getByLabelText("Invoices, target window 2026-02-02 to 2026-03-31")).toBeInTheDocument();
    expect(nodeRow("Program Billing").querySelector("[data-flags]")).toHaveAttribute("data-flags", "1,1");
  });
});
