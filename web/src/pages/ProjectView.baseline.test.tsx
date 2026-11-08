import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { act, screen, waitFor, within } from "@testing-library/react";
import { DndContext } from "@dnd-kit/core";
import { Route, Routes } from "react-router-dom";
import ProjectView from "./ProjectView";
import type { Movement } from "../api/baselines";
import type { ProjectMilestone, ProjectView as ProjectViewDocument } from "../api/milestones";
import { jsonResponse } from "../test/http";
import { renderWithProviders } from "../test/render";
import { applySchedule } from "../utils/projectViewUpdate";

type FetchMock = ReturnType<typeof vi.fn>;

// The v0.9 baseline overlay on the project page: the picker, the shadow bars, the appended rows, the facts-line badge, the Movement section,
// the typed 400 that clears the pick and the optimistic step that keeps the baseline block.

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

const PICK_KEY = "astrolabe.viewSettings.timeline.baseline";
const UNKNOWN = { type: "urn:astrolabe:problem:unknown-baseline", title: "Bad Request", status: 400, detail: "unknown baseline" };

const milestone = (id: number, name: string, over: Partial<ProjectMilestone> = {}): ProjectMilestone => ({
  jira: null,
  flags: [],
  id,
  projectId: 7,
  name,
  description: null,
  teamId: 3,
  teamName: "Backend",
  estimateMd: 5,
  startDate: null,
  endDate: null,
  createdAt: 1,
  updatedAt: 2,
  slackDays: null,
  critical: false,
  pinned: false,
  can: { edit: true, delete: true, schedule: true },
  ...over,
});

const move = (kind: Movement["kind"], startDays: number | null, endDays: number | null, estimateDelta: number | null = 0): Movement => ({ kind, startDays, endDays, estimateDelta });

const ALPHA = milestone(1, "Alpha", { startDate: "2027-01-11", endDate: "2027-01-15" });
const BETA = milestone(2, "Beta", { startDate: "2027-01-18", endDate: "2027-01-29" });
const GAMMA = milestone(3, "Gamma");
const DELTA = milestone(4, "Delta", { startDate: "2027-01-04", endDate: "2027-01-08" });

const plainView = (): ProjectViewDocument => ({
  revision: 10,
  jiraSites: [],
  project: {
    jira: null,
    flags: [],
    id: 7,
    programId: 70,
    workStreamId: 700,
    programName: "Billing",
    workStreamName: "Platform",
    name: "Invoices",
    description: null,
    ownerPersonId: 5,
    ownerName: "Ola Owner",
    targetStart: null,
    targetEnd: null,
    createdAt: 1,
    updatedAt: 2,
    can: { edit: true, delete: true, editTargetWindow: true, createMilestone: true, createDependency: true },
  },
  span: { start: "2027-01-04", end: "2027-01-29" },
  drift: null,
  scheduled: [DELTA, ALPHA, BETA],
  unscheduled: [GAMMA],
  dependencies: [],
  idleGaps: [],
  criticalPath: { upstream: [], upstreamTruncated: false },
});

/** The view with `?baseline=5`: Alpha slipped 5 days, Beta did not move, Gamma was scheduled then, Delta is new, "Gone" was deleted. */
const withBaseline = (view = plainView()): ProjectViewDocument => ({
  ...view,
  baseline: {
    id: 5,
    name: "Q1 plan",
    planRevision: 4,
    project: { span: { start: "2027-01-04", end: "2027-01-22" }, movement: move("MOVED", 0, 5) },
    milestones: [
      { milestoneId: 1, teamIdThen: 3, start: "2027-01-04", end: "2027-01-08", estimateMd: 5, movement: move("MOVED", 5, 5) },
      { milestoneId: 2, teamIdThen: 3, start: "2027-01-18", end: "2027-01-29", estimateMd: 5, movement: move("UNCHANGED", 0, 0) },
      { milestoneId: 3, teamIdThen: 3, start: "2027-02-01", end: "2027-02-05", estimateMd: 5, movement: move("UNSCHEDULED", null, null) },
    ],
    removed: [{ milestoneId: 9, projectId: 7, name: "Gone", teamId: 3, teamName: "Backend", estimateMd: 2, start: "2027-01-25", end: "2027-01-26" }],
  },
});

const BASELINES = {
  items: [
    { id: 6, name: "Q2 plan", description: null, planRevision: 9, createdAt: 2, createdBy: null, milestoneCount: 4, projectCount: 1 },
    { id: 5, name: "Q1 plan", description: null, planRevision: 4, createdAt: 1, createdBy: null, milestoneCount: 4, projectCount: 1 },
  ],
  can: { manage: false },
};

let view: ProjectViewDocument;
let mockFetch: FetchMock;
let viewUrls: string[];

function serve() {
  mockFetch.mockImplementation((url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "GET" && url.startsWith("/api/v1/views/project/7")) {
      viewUrls.push(url);
      if (url.endsWith("?baseline=5")) return Promise.resolve(jsonResponse(200, withBaseline(view)));
      if (url.endsWith("?baseline=99")) return Promise.resolve(jsonResponse(400, UNKNOWN));
      if (url.endsWith("?baseline=6")) return Promise.resolve(jsonResponse(200, { ...withBaseline(view), baseline: { ...withBaseline(view).baseline!, id: 6, name: "Q2 plan" } }));
      return Promise.resolve(jsonResponse(200, view));
    }
    if (method === "GET" && url === "/api/v1/baselines") return Promise.resolve(jsonResponse(200, BASELINES));
    if (method === "GET" && url === "/api/v1/public-holidays") return Promise.resolve(jsonResponse(200, { items: [] }));
    const schedule = /^\/api\/v1\/milestones\/(\d+)\/schedule$/.exec(url);
    if (method === "PUT" && schedule) {
      const body = JSON.parse(init?.body as string) as { startDate: string | null; endDate: string | null };
      view = { ...applySchedule(view, Number(schedule[1]), body.startDate, body.endDate), revision: view.revision + 1 };
      return Promise.resolve(jsonResponse(200, { revision: view.revision }));
    }
    return Promise.resolve(jsonResponse(404, { title: "x", status: 404 }));
  });
}

function renderPage() {
  return renderWithProviders(
    <Routes>
      <Route path="/projects/:id" element={<ProjectView />} />
    </Routes>,
    { route: "/projects/7" },
  );
}

const grid = () => screen.findByRole("grid", { name: "Milestone timeline" });
/** The shadow bars, by their accessible name. */
const shadows = () => [...document.querySelectorAll('[data-tone="baseline"]')].map((bar) => bar.getAttribute("aria-label"));

beforeEach(() => {
  view = plainView();
  viewUrls = [];
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


/** Holds the answer of the view requests `matches` selects until the returned function releases them (the next pick still loading). */
function holdViews(matches: (url: string) => boolean): () => void {
  const base = mockFetch.getMockImplementation() as (url: string, init?: RequestInit) => Promise<Response>;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  mockFetch.mockImplementation((url: string, init?: RequestInit) => (matches(url) ? gate.then(() => base(url, init)) : base(url, init)));
  return release;
}

describe("Project view page with a baseline", () => {
  test("no baseline by default: the plain view is fetched, the picker reads None and nothing is drawn", async () => {
    renderPage();
    await grid();
    expect(viewUrls).toEqual(["/api/v1/views/project/7"]);
    expect(await screen.findByRole("combobox", { name: "Baseline" })).toHaveValue("None");
    expect(shadows()).toEqual([]);
    expect(screen.queryByRole("heading", { name: /Movement vs baseline/ })).toBeNull();
  });

  test("the picker lists the baselines newest first with the first marked latest; picking one fetches it and is remembered", async () => {
    const user = userEvent.setup();
    renderPage();
    await grid();
    const picker = await screen.findByRole("combobox", { name: "Baseline" });
    await user.click(picker);
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["None", "Q2 plan (latest)", "Q1 plan"]);
    await user.click(screen.getByRole("option", { name: "Q1 plan" }));
    await waitFor(() => expect(viewUrls.at(-1)).toBe("/api/v1/views/project/7?baseline=5"));
    expect(JSON.parse(localStorage.getItem(PICK_KEY) ?? "null")).toBe(5);
    await waitFor(() => expect(shadows().length).toBeGreaterThan(0));
    expect(screen.getByRole("combobox", { name: "Baseline" })).toHaveValue("Q1 plan");
    // None again: the plain view, the overlay gone, the pick forgotten
    await user.click(screen.getByRole("combobox", { name: "Baseline" }));
    await user.click(screen.getByRole("option", { name: "None" }));
    await waitFor(() => expect(shadows()).toEqual([]));
    expect(JSON.parse(localStorage.getItem(PICK_KEY) ?? "null")).toBeNull();
  });

  test("a remembered pick is sent straight away: shadow bars under the rows, appended rows for what is gone, a mark on what is new", async () => {
    localStorage.setItem(PICK_KEY, "5");
    renderPage();
    await grid();
    expect(viewUrls).toEqual(["/api/v1/views/project/7?baseline=5"]);
    // Alpha, Beta (their frozen spans), Gone (removed) and Gamma (in the tray now, scheduled then) - none for Delta (new)
    await waitFor(() => expect(shadows()).toHaveLength(4));
    expect(shadows()).toEqual(
      expect.arrayContaining([
        "Baseline: Alpha, 2027-01-04 to 2027-01-08, 5 working days later (start and end), read-only",
        "Baseline: Beta, 2027-01-18 to 2027-01-29, read-only",
        "Baseline: Gone, 2027-01-25 to 2027-01-26, read-only",
        "Baseline: Gamma, 2027-02-01 to 2027-02-05, unscheduled since the baseline, read-only",
      ]),
    );
    const rows = within(screen.getByRole("grid", { name: "Milestone timeline" })).getAllByRole("row");
    expect(rows.map((row) => row.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining("Delta (new since the baseline)"), expect.stringContaining("Gone (removed)"), expect.stringContaining("Gamma (unscheduled since the baseline)")]),
    );
    // the appended rows come after the current ones and carry no editable bar
    const names = rows.slice(1).map((row) => /Alpha|Beta|Delta|Gone|Gamma/.exec(row.textContent ?? "")?.[0]);
    expect(names).toEqual(["Delta", "Alpha", "Beta", "Gone", "Gamma"]);
    // the current bars keep their own tone
    expect(screen.getByRole("button", { name: /^Alpha, Backend/ })).not.toHaveAttribute("data-tone");
  });

  test("the facts line says how the project's span moved: an orange badge when its end is later", async () => {
    localStorage.setItem(PICK_KEY, "5");
    renderPage();
    await grid();
    const badge = await screen.findByText("Ends 5 working days later than the baseline");
    expect(badge.closest(".mantine-Badge-root")?.getAttribute("style") ?? "").toContain("orange");
  });

  test("the Movement section: totals, then a table that lists only the changed rows by default (an unchanged one with the switch off)", async () => {
    const user = userEvent.setup();
    localStorage.setItem(PICK_KEY, "5");
    renderPage();
    await grid();
    expect(await screen.findByRole("heading", { name: "Movement vs baseline Q1 plan" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show the movement" }));
    const table = await screen.findByRole("table", { name: "Movement since the baseline" });
    const rowsOf = () => within(table).getAllByRole("row").slice(1).map((row) => within(row).getAllByRole("cell").map((cell) => cell.textContent));
    expect(rowsOf()).toEqual([
      ["Delta", "—", "2027-01-04 – 2027-01-08", "—", "—", "5", "New"],
      ["Alpha", "2027-01-04 – 2027-01-08", "2027-01-11 – 2027-01-15", "+5", "+5", "5", "Later"],
      ["Gamma", "2027-02-01 – 2027-02-05", "Unscheduled", "—", "—", "5", "Unscheduled"],
      ["Gone", "2027-01-25 – 2027-01-26", "—", "—", "—", "2", "Removed"],
    ]);
    await user.click(screen.getByRole("switch", { name: "Changed only" }));
    expect(rowsOf().map((cells) => cells[0])).toEqual(["Delta", "Alpha", "Beta", "Gamma", "Gone"]);
    expect(rowsOf()[2]).toEqual(["Beta", "2027-01-18 – 2027-01-29", "2027-01-18 – 2027-01-29", "0", "0", "5", "Unchanged"]);
  });

  test("an estimate-only change counts as changed", async () => {
    const user = userEvent.setup();
    localStorage.setItem(PICK_KEY, "5");
    const base = withBaseline();
    view = plainView();
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url === "/api/v1/views/project/7?baseline=5") {
        return Promise.resolve(
          jsonResponse(200, {
            ...base,
            scheduled: [{ ...BETA, estimateMd: 8 }],
            unscheduled: [],
            baseline: { ...base.baseline!, milestones: [{ milestoneId: 2, teamIdThen: 3, start: "2027-01-18", end: "2027-01-29", estimateMd: 5, movement: move("UNCHANGED", 0, 0, 3) }], removed: [] },
          }),
        );
      }
      if (url === "/api/v1/baselines") return Promise.resolve(jsonResponse(200, BASELINES));
      if (url === "/api/v1/public-holidays") return Promise.resolve(jsonResponse(200, { items: [] }));
      return Promise.resolve(jsonResponse(404, { title: "x", status: 404, init }));
    });
    renderPage();
    await grid();
    await user.click(await screen.findByRole("button", { name: "Show the movement" }));
    const table = await screen.findByRole("table", { name: "Movement since the baseline" });
    const cells = within(within(table).getAllByRole("row")[1]).getAllByRole("cell").map((cell) => cell.textContent);
    expect(cells).toEqual(["Beta", "2027-01-18 – 2027-01-29", "2027-01-18 – 2027-01-29", "0", "0", "5 → 8", "Re-estimated"]);
  });

  test("a pick the server no longer knows (the typed 400) clears itself, refetches the plain view once and does not loop", async () => {
    localStorage.setItem(PICK_KEY, "99");
    renderPage();
    await grid();
    expect(viewUrls).toEqual(["/api/v1/views/project/7?baseline=99", "/api/v1/views/project/7"]);
    await waitFor(() => expect(JSON.parse(localStorage.getItem(PICK_KEY) ?? "null")).toBeNull());
    expect(screen.queryByText(/Could not load/)).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(viewUrls).toHaveLength(2);
  });

  test.each([
    ["another baseline B", "Q2 plan (latest)", "/api/v1/views/project/7?baseline=6"],
    ["no baseline", "None", "/api/v1/views/project/7"],
  ])("changing to %s: while it loads no shadow bar, appended row or Movement section of the old pick is on screen, and nothing can be written", async (_name, option, url) => {
    const user = userEvent.setup();
    localStorage.setItem(PICK_KEY, "5");
    renderPage();
    await grid();
    await waitFor(() => expect(shadows()).toHaveLength(4));
    const release = holdViews((requested) => requested === url);
    await user.click(screen.getByRole("combobox", { name: "Baseline" }));
    await user.click(await screen.findByRole("option", { name: option }));
    await waitFor(() => expect(mockFetch.mock.calls.some(([requested]) => requested === url)).toBe(true));
    expect(shadows()).toEqual([]);
    expect(screen.queryByText(/Gone \(removed\)/)).toBeNull();
    expect(screen.queryByRole("heading", { name: /Movement vs baseline/ })).toBeNull();
    expect(screen.queryByText(/than the baseline/)).toBeNull();
    act(() => {
      dndProps?.onDragEnd?.({
        active: { id: "bar:1:move", data: { current: { kind: "move", barId: 1, label: "Alpha", start: ALPHA.startDate, end: ALPHA.endDate } } },
        delta: { x: 28, y: 0 },
        over: null,
        activatorEvent: null,
      } as never);
    });
    expect(mockFetch.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "PUT")).toBe(false);
    release();
    await waitFor(() => expect(screen.getByRole("grid", { name: "Milestone timeline" })).toBeInTheDocument());
    if (option === "None") await waitFor(() => expect(JSON.parse(localStorage.getItem(PICK_KEY) ?? "null")).toBeNull());
    else await waitFor(() => expect(shadows().length).toBeGreaterThan(0));
  });

  test("a drag keeps the baseline block of the cached view: the shadow bars stay while the save is out", async () => {
    localStorage.setItem(PICK_KEY, "5");
    const gate: { settle?: (response: Response) => void } = {};
    const held = new Promise<Response>((resolve) => {
      gate.settle = resolve;
    });
    const base = mockFetch.getMockImplementation() as (url: string, init?: RequestInit) => Promise<Response>;
    mockFetch.mockImplementation((url: string, init?: RequestInit) => (init?.method === "PUT" ? held : base(url, init)));
    renderPage();
    await grid();
    await waitFor(() => expect(shadows()).toHaveLength(4));
    act(() =>
      dndProps?.onDragEnd?.({
        active: { id: "bar:1:move", data: { current: { kind: "move", barId: 1, label: "Alpha", start: ALPHA.startDate, end: ALPHA.endDate } } },
        delta: { x: 28, y: 0 },
        over: null,
        activatorEvent: null,
      } as never),
    );
    await waitFor(() => expect(mockFetch.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "PUT")).toBe(true));
    expect(screen.getByRole("grid", { name: "Milestone timeline" })).toHaveAttribute("aria-busy", "true");
    // a pick changed now would make the save's answer land in another view entry
    expect(screen.getByRole("combobox", { name: "Baseline" })).toBeDisabled();
    expect(shadows()).toHaveLength(4);
    expect(screen.getByRole("button", { name: /^Alpha, Backend, 2027-01-12 to 2027-01-16/ })).toBeInTheDocument();
    gate.settle?.(jsonResponse(200, { revision: 11 }));
    await waitFor(() => expect(screen.getByRole("grid", { name: "Milestone timeline" })).toHaveAttribute("aria-busy", "false"));
    expect(screen.getByRole("combobox", { name: "Baseline" })).toBeEnabled();
    // the refetch after the save asks for the same pick
    await waitFor(() => expect(viewUrls.filter((url) => url.endsWith("?baseline=5")).length).toBeGreaterThan(1));
    expect(viewUrls.every((url) => url.endsWith("?baseline=5"))).toBe(true);
  });
});
