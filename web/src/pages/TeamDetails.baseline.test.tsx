import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { act, screen, waitFor, within } from "@testing-library/react";
import { DndContext } from "@dnd-kit/core";
import { Route, Routes } from "react-router-dom";
import TeamDetails from "./TeamDetails";
import type { Movement } from "../api/baselines";
import type { TeamMilestone, TeamView } from "../api/teams";
import { jsonResponse } from "../test/http";
import { READ_ONLY_PANEL } from "../test/flow";
import { renderWithProviders } from "../test/render";
import { applyTeamSchedule } from "../utils/teamViewUpdate";

type FetchMock = ReturnType<typeof vi.fn>;

// The v0.9 baseline overlay on the team page: the picker in the timeline toolbar, shadow bars, the appended rows (one moved to another team),
// the Movement section with its Project column, the typed 400 and the optimistic steps that keep the baseline block.

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

const milestone = (id: number, name: string, over: Partial<TeamMilestone> = {}): TeamMilestone => ({
  jira: null,
  flags: [],
  slackDays: null,
  critical: false,
  pinned: false,
  id,
  projectId: 7,
  name,
  description: null,
  teamId: 1,
  teamName: "Payments",
  estimateMd: 10,
  startDate: null,
  endDate: null,
  createdAt: 1,
  updatedAt: 2,
  projectName: "Invoices",
  programName: "Billing",
  workStreamName: "Platform",
  rankPosition: 1,
  ...over,
});

const move = (kind: Movement["kind"], startDays: number | null, endDays: number | null, estimateDelta: number | null = 0): Movement => ({ kind, startDays, endDays, estimateDelta });

const TV_A = milestone(1, "tv-a", { startDate: "2027-02-01", endDate: "2027-02-05" });
const TV_B = milestone(2, "tv-b", { startDate: "2027-02-08", endDate: "2027-02-10" });
const TV_TRAY = milestone(3, "tv-tray");

const plainView = (): TeamView => ({
  jiraSites: [],
  revision: 10,
  team: { id: 1, name: "Payments", description: null, managerPersonId: 12, managerName: "Cara New", createdAt: 1, updatedAt: 2, can: { schedule: true, editCapacity: true, editOrder: true }, flags: [] },
  order: { custom: false, revision: 4, milestoneIds: [] },
  capacity: { periods: [] },
  weeks: [],
  weeksTruncated: false,
  scheduled: [TV_A, TV_B],
  unscheduled: [TV_TRAY],
  dependencies: [],
  idleGaps: [],
});

/** tv-a slipped a week, tv-b is new, tv-tray was scheduled then, "tv-gone" was deleted and "tv-away" now sits on Billing. */
const withBaseline = (view = plainView()): TeamView => ({
  ...view,
  baseline: {
    id: 5,
    name: "Q1 plan",
    planRevision: 4,
    milestones: [
      { milestoneId: 1, teamIdThen: 1, start: "2027-01-25", end: "2027-01-29", estimateMd: 10, movement: move("MOVED", 5, 5) },
      { milestoneId: 3, teamIdThen: 1, start: "2027-02-15", end: "2027-02-17", estimateMd: 10, movement: move("UNSCHEDULED", null, null) },
    ],
    removed: [
      { milestoneId: 8, projectId: 7, name: "tv-gone", teamId: 1, teamName: "Payments", estimateMd: 3, start: "2027-02-02", end: "2027-02-03" },
      { milestoneId: 9, projectId: 8, name: "tv-away", teamId: 1, teamName: "Payments", estimateMd: 4, start: "2027-02-04", end: "2027-02-05", now: { teamId: 2, teamName: "Billing" } },
    ],
  },
});

const BASELINES = {
  items: [
    { id: 5, name: "Q1 plan", description: null, planRevision: 4, createdAt: 2, createdBy: null, milestoneCount: 3, projectCount: 1 },
    { id: 6, name: "Q0 plan", description: null, planRevision: 3, createdAt: 1, createdBy: null, milestoneCount: 3, projectCount: 1 },
  ],
  can: { manage: false },
};

let view: TeamView;
let mockFetch: FetchMock;
let viewUrls: string[];

function serve() {
  mockFetch.mockImplementation((url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "GET" && url.startsWith("/api/v1/views/team/1")) {
      viewUrls.push(url);
      if (url.endsWith("?baseline=5")) return Promise.resolve(jsonResponse(200, withBaseline(view)));
      if (url.endsWith("?baseline=6")) return Promise.resolve(jsonResponse(200, { ...withBaseline(view), baseline: { ...withBaseline(view).baseline!, id: 6, name: "Q0 plan" } }));
      if (url.endsWith("?baseline=99")) return Promise.resolve(jsonResponse(400, UNKNOWN));
      return Promise.resolve(jsonResponse(200, view));
    }
    if (method === "GET" && url === "/api/v1/baselines") return Promise.resolve(jsonResponse(200, BASELINES));
    if (method === "GET" && url === "/api/v1/public-holidays") return Promise.resolve(jsonResponse(200, { items: [] }));
    if (method === "GET" && url === "/api/v1/teams/1/flow") return Promise.resolve(jsonResponse(200, READ_ONLY_PANEL));
    const schedule = /^\/api\/v1\/milestones\/(\d+)\/schedule$/.exec(url);
    if (method === "PUT" && schedule) {
      const body = JSON.parse(init?.body as string) as { startDate: string | null; endDate: string | null };
      view = { ...applyTeamSchedule(view, Number(schedule[1]), body.startDate, body.endDate), revision: view.revision + 1 };
      return Promise.resolve(jsonResponse(200, { revision: view.revision }));
    }
    return Promise.resolve(jsonResponse(404, { title: "x", status: 404 }));
  });
}

function renderPage() {
  return renderWithProviders(
    <Routes>
      <Route path="/teams/:id" element={<TeamDetails />} />
    </Routes>,
    { route: "/teams/1" },
  );
}

const grid = () => screen.findByRole("grid", { name: "Team milestone timeline" });
const shadows = () => [...document.querySelectorAll('[data-tone="baseline"]')].map((bar) => bar.getAttribute("aria-label"));

beforeEach(() => {
  view = plainView();
  viewUrls = [];
  dndProps = null;
  mockFetch = vi.fn();
  vi.stubGlobal("fetch", mockFetch);
  localStorage.setItem("astrolabe.auth.token", "fake-token");
  localStorage.setItem("astrolabe.auth.roles", JSON.stringify(["ADMIN"]));
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

describe("Team page with a baseline", () => {
  test("no baseline by default: the plain view, the picker reads None, no shadow bar and no Movement section", async () => {
    renderPage();
    await grid();
    expect(viewUrls).toEqual(["/api/v1/views/team/1"]);
    expect(await screen.findByRole("combobox", { name: "Baseline" })).toHaveValue("None");
    expect(shadows()).toEqual([]);
    expect(screen.queryByRole("heading", { name: /Movement vs baseline/ })).toBeNull();
  });

  test("picking a baseline fetches it, remembers it for every timeline page and draws the shadow bars", async () => {
    const user = userEvent.setup();
    renderPage();
    await grid();
    await user.click(await screen.findByRole("combobox", { name: "Baseline" }));
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["None", "Q1 plan (latest)", "Q0 plan"]);
    await user.click(screen.getByRole("option", { name: "Q1 plan (latest)" }));
    await waitFor(() => expect(viewUrls.at(-1)).toBe("/api/v1/views/team/1?baseline=5"));
    expect(JSON.parse(localStorage.getItem(PICK_KEY) ?? "null")).toBe(5);
    await waitFor(() => expect(shadows().length).toBeGreaterThan(0));
  });

  test("shadow bars under the rows, appended rows after them (removed, moved away, unscheduled since), a mark on what is new", async () => {
    localStorage.setItem(PICK_KEY, "5");
    renderPage();
    await grid();
    await waitFor(() => expect(shadows()).toHaveLength(4));
    expect(shadows()).toEqual(
      expect.arrayContaining([
        "Baseline: tv-a, 2027-01-25 to 2027-01-29, 5 working days later (start and end), read-only",
        "Baseline: tv-gone, 2027-02-02 to 2027-02-03, read-only",
        "Baseline: tv-away, 2027-02-04 to 2027-02-05, read-only",
        "Baseline: tv-tray, 2027-02-15 to 2027-02-17, unscheduled since the baseline, read-only",
      ]),
    );
    const rows = within(screen.getByRole("grid", { name: "Team milestone timeline" })).getAllByRole("row").slice(1);
    expect(rows.map((row) => /tv-[a-z]+/.exec(row.textContent ?? "")?.[0])).toEqual(["tv-a", "tv-b", "tv-gone", "tv-away", "tv-tray"]);
    const text = rows.map((row) => row.textContent ?? "");
    expect(text[1]).toContain("tv-b (new since the baseline)");
    expect(text[2]).toContain("tv-gone (removed)");
    expect(text[3]).toContain("tv-away (moved to Billing)");
    expect(text[4]).toContain("tv-tray (unscheduled since the baseline)");
    // an appended row has no schedule or order items: its menu holds only the link to the project
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Operations for tv-away" }));
    expect((await screen.findAllByRole("menuitem")).map((item) => item.textContent)).toEqual(["Open project"]);
  });

  test("the Movement section has a Project column, says where a milestone moved and lists the changed rows", async () => {
    const user = userEvent.setup();
    localStorage.setItem(PICK_KEY, "5");
    renderPage();
    await grid();
    expect(await screen.findByRole("heading", { name: "Movement vs baseline Q1 plan" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show the movement" }));
    const table = await screen.findByRole("table", { name: "Movement since the baseline" });
    const rows = within(table).getAllByRole("row").slice(1).map((row) => within(row).getAllByRole("cell").map((cell) => cell.textContent));
    expect(rows).toEqual([
      ["tv-a", "Invoices", "2027-01-25 – 2027-01-29", "2027-02-01 – 2027-02-05", "+5", "+5", "10", "Later"],
      ["tv-b", "Invoices", "—", "2027-02-08 – 2027-02-10", "—", "—", "10", "New"],
      ["tv-tray", "Invoices", "2027-02-15 – 2027-02-17", "Unscheduled", "—", "—", "10", "Unscheduled"],
      ["tv-gone", "", "2027-02-02 – 2027-02-03", "—", "—", "—", "3", "Removed"],
      ["tv-away", "", "2027-02-04 – 2027-02-05", "Moved to Billing", "—", "—", "4", "Moved"],
    ]);
  });

  test("the typed 400 clears a remembered pick that is gone and fetches the plain view once", async () => {
    localStorage.setItem(PICK_KEY, "99");
    renderPage();
    await grid();
    expect(viewUrls).toEqual(["/api/v1/views/team/1?baseline=99", "/api/v1/views/team/1"]);
    expect(JSON.parse(localStorage.getItem(PICK_KEY) ?? "null")).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(viewUrls).toHaveLength(2);
  });

  test.each([
    ["another baseline B", "Q0 plan", "/api/v1/views/team/1?baseline=6"],
    ["no baseline", "None", "/api/v1/views/team/1"],
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
    expect(screen.queryByText(/tv-gone/)).toBeNull();
    expect(screen.queryByRole("heading", { name: /Movement vs baseline/ })).toBeNull();
    act(() => {
      dndProps?.onDragEnd?.({
        active: { id: "bar:1:move", data: { current: { kind: "move", barId: 1, label: "tv-a", start: TV_A.startDate, end: TV_A.endDate } } },
        delta: { x: 28, y: 0 },
        over: null,
        activatorEvent: null,
      } as never);
    });
    expect(mockFetch.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "PUT")).toBe(false);
    release();
    await waitFor(() => expect(screen.getByRole("grid", { name: "Team milestone timeline" })).toBeInTheDocument());
    if (option === "None") await waitFor(() => expect(JSON.parse(localStorage.getItem(PICK_KEY) ?? "null")).toBeNull());
    else await waitFor(() => expect(shadows().length).toBeGreaterThan(0));
  });

  test("a drop keeps the baseline block of the cached view; the refetch asks for the same pick", async () => {
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
        active: { id: "bar:1:move", data: { current: { kind: "move", barId: 1, label: "tv-a", start: TV_A.startDate, end: TV_A.endDate } } },
        delta: { x: 28, y: 0 },
        over: null,
        activatorEvent: null,
      } as never),
    );
    await waitFor(() => expect(screen.getByRole("grid", { name: "Team milestone timeline" })).toHaveAttribute("aria-busy", "true"));
    expect(screen.getByRole("combobox", { name: "Baseline" })).toBeDisabled();
    expect(shadows()).toHaveLength(4);
    gate.settle?.(jsonResponse(200, { revision: 11 }));
    await waitFor(() => expect(screen.getByRole("grid", { name: "Team milestone timeline" })).toHaveAttribute("aria-busy", "false"));
    await waitFor(() => expect(viewUrls.filter((url) => url.endsWith("?baseline=5")).length).toBeGreaterThan(1));
    expect(viewUrls.every((url) => url.endsWith("?baseline=5"))).toBe(true);
  });
});
