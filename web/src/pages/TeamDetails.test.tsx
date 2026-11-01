import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { act, screen, waitFor, within } from "@testing-library/react";
import { DndContext } from "@dnd-kit/core";
import { Route, Routes } from "react-router-dom";
import TeamDetails from "./TeamDetails";
import type { DependencyEndpoint, ProjectDependency } from "../api/dependencies";
import type { CapacityPeriod, TeamMilestone, TeamView } from "../api/teams";
import { headingOutline } from "../test/headings";
import { jsonResponse } from "../test/http";
import { renderWithProviders } from "../test/render";
import { applyTeamOrder, applyTeamSchedule } from "../utils/teamViewUpdate";

const TOKEN_KEY = "astrolabe.auth.token";
const ROLES_KEY = "astrolabe.auth.roles";

type FetchMock = ReturnType<typeof vi.fn>;

// happy-dom has no layout, so a pointer drag cannot run here (e2e drives the real one): the context is wrapped to hand the test its
// drag-end handler. What the page does WHEN dnd-kit reports a drop is ours to pin.
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
const dropMove = (m: TeamMilestone, days: number) =>
  act(() =>
    dndProps?.onDragEnd?.({
      active: { id: `bar:${m.id}:move`, data: { current: { kind: "move", barId: m.id, label: m.name, start: m.startDate, end: m.endDate } } },
      delta: { x: days * 28, y: 0 },
      over: null,
      activatorEvent: null,
    } as never),
  );

/** A row dragged by its handle and released in `slot`'s gap: the pointer went down at `y` and the row zone starts at client y = 100 (36 px rows). */
const dropRow = (m: TeamMilestone, position: number, y: number) => {
  const dragged = { id: `row:${m.id}`, data: { current: { kind: "row", barId: m.id, label: m.name, position, count: 3 } } };
  const zone = {
    id: "timeline-rows",
    data: { current: { zoneTop: () => 100, rowBounds: () => ({ left: 0, right: 900, top: 100, bottom: 600 }), rowCount: 3 } },
  };
  const event = { active: dragged, delta: { x: 0, y: 0 }, over: zone, activatorEvent: { clientX: 40, clientY: y } };
  act(() => dndProps?.onDragStart?.(event as never));
  act(() => dndProps?.onDragEnd?.(event as never));
};

const milestone = (id: number, name: string, over: Partial<TeamMilestone> = {}): TeamMilestone => ({
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

const TV_A = milestone(1, "tv-a", { startDate: "2027-02-01", endDate: "2027-02-05" });
const TV_B = milestone(2, "tv-b", { startDate: "2027-02-04", endDate: "2027-02-05", estimateMd: 4 });
const TV_C = milestone(3, "tv-c", { startDate: "2027-02-08", endDate: "2027-02-10", projectId: 8, projectName: "Payouts", rankPosition: 2 });
const TRAYED = milestone(4, "tv-tray", { description: "Waiting" });

const PERIOD: CapacityPeriod = { id: 11, teamId: 1, effectiveFrom: "2027-02-03", mdPerWeek: 8, wipLimit: 1, createdAt: 1, updatedAt: 2 };

const endpoint = (m: TeamMilestone, over: Partial<DependencyEndpoint> = {}): DependencyEndpoint => ({
  kind: "MILESTONE",
  id: m.id,
  name: m.name,
  projectId: m.projectId,
  projectName: m.projectName,
  teamId: 1,
  teamName: "Payments",
  startDate: m.startDate,
  endDate: m.endDate,
  ...over,
});
const LINK: ProjectDependency = {
  id: 31,
  predecessor: endpoint(TV_A),
  successor: endpoint(TV_B),
  type: "FS",
  lagDays: 0,
  check: { status: "VIOLATED", shortfallDays: 3, requiredDate: "2027-02-08", actualDate: "2027-02-04" },
  critical: false,
  can: { edit: false, delete: false },
};

const viewOf = (over: Partial<TeamView> = {}): TeamView => ({
  revision: 10,
  team: {
    id: 1,
    name: "Payments",
    description: "Money movers",
    managerPersonId: 12,
    managerName: "Cara New",
    createdAt: 1,
    updatedAt: 2,
    can: { schedule: true, editCapacity: true, editOrder: true },
  },
  order: { custom: false, revision: 4, milestoneIds: [] },
  capacity: { periods: [PERIOD] },
  weeks: [
    { weekStart: "2027-02-01", load: 8.5, capacity: 4.8, overloaded: true, overloadMd: 3.7, maxWip: 2, wipExceeded: true },
    { weekStart: "2027-02-08", load: 1.2, capacity: 8, overloaded: false, overloadMd: null, maxWip: 1, wipExceeded: false },
    { weekStart: "2027-01-25", load: 0, capacity: null, overloaded: false, overloadMd: null, maxWip: 0, wipExceeded: false },
  ],
  weeksTruncated: false,
  scheduled: [TV_A, TV_B, TV_C],
  unscheduled: [TRAYED],
  dependencies: [LINK],
  idleGaps: [],
  ...over,
});

const STALE = { type: "urn:astrolabe:problem:stale-revision", title: "Conflict", status: 409, detail: "stale" };

let view: TeamView;
let orderPut: { status: number; body?: unknown };
let schedulePut: { status: number; body?: unknown };
let periodPost: { status: number; body?: unknown };

/** A tiny server: GET answers the current view; an accepted order PUT applies the order and bumps the order revision, an accepted schedule PUT the dates. */
function serve(mockFetch: FetchMock) {
  mockFetch.mockImplementation((url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "GET" && url === "/api/v1/views/team/1") return Promise.resolve(jsonResponse(200, view));
    if (method === "GET" && url === "/api/v1/public-holidays") return Promise.resolve(jsonResponse(200, { items: [{ id: 1, date: "2027-02-03", name: "Founders' Day" }] }));
    if (method === "PUT" && url === "/api/v1/teams/1/milestone-order") {
      if (orderPut.status !== 200) return Promise.resolve(jsonResponse(orderPut.status, orderPut.body ?? { title: "x", status: orderPut.status }));
      const body = JSON.parse(init?.body as string) as { milestoneIds: number[] };
      const applied = applyTeamOrder(view, body.milestoneIds);
      view = { ...applied, revision: view.revision + 1, order: { ...applied.order, revision: view.revision + 1 } };
      return Promise.resolve(jsonResponse(200, { revision: view.revision }));
    }
    const schedule = /^\/api\/v1\/milestones\/(\d+)\/schedule$/.exec(url);
    if (method === "PUT" && schedule) {
      if (schedulePut.status !== 200) return Promise.resolve(jsonResponse(schedulePut.status, schedulePut.body ?? { title: "x", status: schedulePut.status }));
      const body = JSON.parse(init?.body as string) as { startDate: string | null; endDate: string | null };
      view = { ...applyTeamSchedule(view, Number(schedule[1]), body.startDate, body.endDate), revision: view.revision + 1 };
      return Promise.resolve(jsonResponse(200, { revision: view.revision }));
    }
    if (method === "POST" && url === "/api/v1/teams/1/capacity") return Promise.resolve(jsonResponse(periodPost.status, periodPost.body ?? { ...PERIOD, id: 12 }));
    if (method === "PUT" && url === "/api/v1/capacity-periods/11") return Promise.resolve(new Response(null, { status: 204 }));
    if (method === "DELETE") return Promise.resolve(new Response(null, { status: 204 }));
    if (method === "PUT" && url === "/api/v1/teams/1") return Promise.resolve(new Response(null, { status: 204 }));
    return Promise.resolve(jsonResponse(404, { title: "Not Found", status: 404 }));
  });
}

const calls = (mockFetch: FetchMock, method: string, matcher: RegExp) =>
  mockFetch.mock.calls
    .filter(([url, init]) => matcher.test(url as string) && ((init as RequestInit | undefined)?.method ?? "GET") === method)
    .map(([url, init]) => ({ url: url as string, body: (init as RequestInit | undefined)?.body ? JSON.parse((init as RequestInit).body as string) : undefined }));
const orderPuts = (mockFetch: FetchMock) => calls(mockFetch, "PUT", /milestone-order$/).map((c) => c.body);
const schedulePuts = (mockFetch: FetchMock) => calls(mockFetch, "PUT", /\/schedule$/).map((c) => c.body);
const viewGets = (mockFetch: FetchMock) => calls(mockFetch, "GET", /views\/team\/1$/).length;

function renderPage(route = "/teams/1") {
  return renderWithProviders(
    <Routes>
      <Route path="/teams/:id" element={<TeamDetails />} />
    </Routes>,
    { route },
  );
}

/** The scheduled rows in the grid, by their name, top to bottom. */
const rowNames = () =>
  within(screen.getByRole("grid", { name: "Team milestone timeline" }))
    .getAllByRole("row")
    .slice(1)
    .map((row) => /tv-[a-z]+/.exec(row.textContent ?? "")?.[0]);

const barOf = (name: string) => screen.getByRole("button", { name: new RegExp(`^${name}, `) });
const liveText = () => screen.getAllByRole("status").map((region) => region.textContent).join(" | ");

async function openMenu(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole("button", { name: `Operations for ${name}` }));
}

let mockFetch: FetchMock;

beforeEach(() => {
  view = viewOf();
  orderPut = { status: 200 };
  schedulePut = { status: 200 };
  periodPost = { status: 201 };
  dndProps = null;
  mockFetch = vi.fn();
  vi.stubGlobal("fetch", mockFetch);
  localStorage.setItem(TOKEN_KEY, "fake-token");
  localStorage.setItem(ROLES_KEY, JSON.stringify(["ADMIN"]));
  serve(mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  localStorage.clear();
});

describe("Team view page", () => {
  test("the timeline gets the public-holiday dictionary: the header day cell is named and the list is there for assistive technology", async () => {
    renderPage();
    await screen.findByRole("grid", { name: "Team milestone timeline" });
    expect(await screen.findByText(/Public holidays shown: 2027-02-03 Founders' Day/)).toBeInTheDocument();
    expect(document.querySelector("[data-holiday]")).toHaveAttribute("title", "Public holiday: Founders' Day");
  });

  test("renders the facts, the timeline with the strip, the tray, the capacity and the weekly load; the heading outline is pinned", async () => {
    renderPage();
    await screen.findByRole("grid", { name: "Team milestone timeline" });
    expect(headingOutline()).toEqual([
      [2, "Payments"],
      [3, "Timeline"],
      [3, "Unscheduled"],
      [3, "Capacity"],
      [3, "Weekly load"],
      [3, "Idle gaps"],
    ]);
    expect(screen.getByText("Money movers")).toBeInTheDocument();
    expect(screen.getByText("Manager: Cara New")).toBeInTheDocument();
    const facts = screen.getByRole("group", { name: "Team facts" });
    expect(within(facts).getByText("4 milestones")).toBeInTheDocument();
    expect(within(facts).getByText("3 scheduled")).toBeInTheDocument();
    expect(within(facts).getByText("1 week overloaded")).toBeInTheDocument();
    expect(within(facts).getByText("1 week over WIP limit")).toBeInTheDocument();
    expect(within(facts).getByText("1 conflict")).toBeInTheDocument();
    expect(within(facts).queryByText("Custom order")).toBeNull();
    expect(rowNames()).toEqual(["tv-a", "tv-b", "tv-c"]);
    expect(barOf("tv-a")).toHaveAccessibleName("tv-a, Invoices, 2027-02-01 to 2027-02-05, 10 man-days, 1 conflict");
    expect(barOf("tv-c")).toHaveAccessibleName("tv-c, Payouts, 2027-02-08 to 2027-02-10, 10 man-days");
    // The strip is in the header: one cell per week with the server's verdicts, and the decorative marks.
    const overloaded = document.querySelector('[data-week="2027-02-01"]');
    expect(overloaded).toHaveAttribute("data-overloaded", "true");
    expect(overloaded).toHaveAttribute("data-wip-exceeded", "true");
    expect(document.querySelector('[data-week="2027-02-08"]')).toHaveAttribute("data-overloaded", "false");
    // The arrows between this timeline's rows: the one link (a violated one).
    expect(document.querySelectorAll("[data-arrow]")).toHaveLength(1);
    expect(document.querySelector("[data-arrow]")).toHaveAttribute("data-violated", "true");
  });

  test("idle gaps: a hatched band per gap, a gray badge in the facts line and the table behind a disclosure; none = no band, no badge", async () => {
    const user = userEvent.setup();
    view = viewOf({ idleGaps: [{ start: "2027-02-11", end: "2027-02-17", workingDays: 5 }, { start: "2027-03-01", end: "2027-03-03", workingDays: 3 }] });
    renderPage();
    await screen.findByRole("grid", { name: "Team milestone timeline" });
    const bands = [...document.querySelectorAll('[data-band-tone="idle"]')];
    expect(bands.map((band) => band.getAttribute("title"))).toEqual([
      "Idle 2027-02-11 to 2027-02-17, 5 working days",
      "Idle 2027-03-01 to 2027-03-03, 3 working days",
    ]);
    expect(within(screen.getByRole("group", { name: "Team facts" })).getByText("2 idle gaps")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show the idle gaps" }));
    const rows = within(await screen.findByRole("table", { name: "Idle gaps" })).getAllByRole("row").slice(1);
    expect(rows.map((row) => within(row).getAllByRole("cell").map((cell) => cell.textContent))).toEqual([
      ["2027-02-11", "2027-02-17", "5"],
      ["2027-03-01", "2027-03-03", "3"],
    ]);
  });

  test("no idle gaps: no band, no badge, the section says so", async () => {
    renderPage();
    await screen.findByRole("grid", { name: "Team milestone timeline" });
    expect(document.querySelector('[data-band-tone="idle"]')).toBeNull();
    expect(within(screen.getByRole("group", { name: "Team facts" })).queryByText(/idle gap/)).toBeNull();
    expect(screen.getByText("No idle gaps of 3 or more working days.")).toBeInTheDocument();
  });

  test("nothing scheduled: no Idle gaps section", async () => {
    view = viewOf({ scheduled: [], idleGaps: [] });
    renderPage();
    await screen.findByRole("grid", { name: "Team milestone timeline" });
    expect(screen.queryByRole("heading", { name: "Idle gaps" })).toBeNull();
  });

  test("the Capacity section lists the periods with the limit ('—' when none)", async () => {
    view = viewOf({ capacity: { periods: [PERIOD, { ...PERIOD, id: 12, effectiveFrom: "2027-03-01", mdPerWeek: 10.5, wipLimit: null }] } });
    renderPage();
    const table = await screen.findByRole("table", { name: "Capacity periods of the team" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((r) => within(r).getAllByRole("cell").slice(0, 3).map((c) => c.textContent))).toEqual([
      ["2027-02-03", "8", "1"],
      ["2027-03-01", "10.5", "—"],
    ]);
  });

  test("the weekly table is behind a disclosure and reads load, capacity, WIP and the verdicts in words", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("grid", { name: "Team milestone timeline" });
    expect(screen.queryByRole("table", { name: "Weekly load of the team" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Show the weekly figures" }));
    const table = await screen.findByRole("table", { name: "Weekly load of the team" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((r) => within(r).getAllByRole("cell").map((c) => c.textContent))).toEqual([
      ["W05 · 2027-02-01", "8.50", "4.80", "2", "Overloaded · +3.70 MDOver WIP limit"],
      ["W06 · 2027-02-08", "1.20", "8.00", "1", "OK"],
      ["W04 · 2027-01-25", "0.00", "—", "0", "No capacity"],
    ]);
    await user.click(screen.getByRole("button", { name: "Hide the weekly figures" }));
    expect(screen.queryByRole("table", { name: "Weekly load of the team" })).toBeNull();
  });

  test("a stranger reads the page without a single control: no Add period, no Move items, no Schedule, no Reset, read-only bars", async () => {
    localStorage.setItem(ROLES_KEY, "[]");
    view = viewOf({ team: { ...viewOf().team, can: { schedule: false, editCapacity: false, editOrder: false } } });
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("grid", { name: "Team milestone timeline" });
    expect(screen.getByRole("img", { name: /^tv-a, Invoices, .*, 1 conflict, read-only$/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^(Add period|Reset order|Schedule|Resize)/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Edit$/ })).toBeNull();
    await openMenu(user, "tv-a");
    expect(await screen.findByRole("menuitem", { name: "Open project Invoices" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /Move|schedule/i })).toBeNull();
    expect(screen.getByText(/manager or an administrator schedules them/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Operations for Payments|Edit the period/ })).toBeNull();
  });

  test("an administrator edits the team from the page and the save refreshes the view", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: /^edit$/i }));
    const modal = await screen.findByRole("dialog");
    expect(within(modal).getByLabelText("Name")).toHaveValue("Payments");
    await user.type(within(modal).getByLabelText("Name"), " EU");
    const before = viewGets(mockFetch);
    await user.click(within(modal).getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(calls(mockFetch, "PUT", /\/teams\/1$/)).toHaveLength(1));
    expect(calls(mockFetch, "PUT", /\/teams\/1$/)[0].body).toEqual({ name: "Payments EU", description: "Money movers", managerPersonId: 12 });
    await waitFor(() => expect(viewGets(mockFetch)).toBeGreaterThan(before));
  });

  test("a team without a manager says so, and an empty team says it has no milestones (the capacity and weekly sections remain)", async () => {
    view = viewOf({ team: { ...viewOf().team, managerPersonId: null, managerName: null }, scheduled: [], unscheduled: [], weeks: [], dependencies: [] });
    renderPage();
    expect(await screen.findByText("No manager")).toBeInTheDocument();
    expect(screen.getByText("This team has no milestones yet")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "Capacity" })).toBeInTheDocument();
    expect(screen.getByText("Nothing is scheduled yet, so there is no weekly load.")).toBeInTheDocument();
  });

  test("a missing team shows the not-found message with a way back", async () => {
    mockFetch.mockImplementation(() => Promise.resolve(jsonResponse(404, { title: "Not Found", status: 404 })));
    renderPage();
    expect(await screen.findByText("This team does not exist (or was deleted).")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to teams" })).toHaveAttribute("href", "/teams");
  });
});

describe("Team view page: the order", () => {
  test("Move down PUTs the TEAM's order revision and the scheduled ids; the live region says where the row went; the menu keeps focus", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("grid", { name: "Team milestone timeline" });
    await openMenu(user, "tv-a");
    await user.click(await screen.findByRole("menuitem", { name: "Move down tv-a" }));
    await waitFor(() => expect(orderPuts(mockFetch)).toHaveLength(1));
    // order.revision (4), never the plan revision (10).
    expect(orderPuts(mockFetch)[0]).toEqual({ expectedRevision: 4, milestoneIds: [2, 1, 3] });
    await waitFor(() => expect(rowNames()).toEqual(["tv-b", "tv-a", "tv-c"]));
    expect(liveText()).toContain("tv-a moved to position 2 of 3");
    expect(await screen.findByText("Custom order")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("grid", { name: "Team milestone timeline" })).toHaveAttribute("aria-busy", "false"));
    expect(screen.getByRole("button", { name: "Operations for tv-a" })).toHaveFocus();
    // The next change carries the revision the PUT answered (11), not a stale one.
    await openMenu(user, "tv-c");
    await user.click(await screen.findByRole("menuitem", { name: "Move tv-c to top" }));
    await waitFor(() => expect(orderPuts(mockFetch)).toHaveLength(2));
    expect(orderPuts(mockFetch)[1]).toEqual({ expectedRevision: 11, milestoneIds: [3, 2, 1] });
  });

  test("a listed milestone that is now unscheduled keeps its stored place in the PUT", async () => {
    const user = userEvent.setup();
    // Stored order [tv-a, tv-tray (unscheduled), tv-b, tv-c]: Move tv-c to top is [tv-c, tv-tray, tv-a, tv-b] — the tray keeps INDEX 1.
    view = viewOf({ order: { custom: true, revision: 4, milestoneIds: [1, 4, 2, 3] } });
    renderPage();
    await screen.findByRole("grid", { name: "Team milestone timeline" });
    await openMenu(user, "tv-c");
    await user.click(await screen.findByRole("menuitem", { name: "Move tv-c to top" }));
    await waitFor(() => expect(orderPuts(mockFetch)).toHaveLength(1));
    expect(orderPuts(mockFetch)[0]).toEqual({ expectedRevision: 4, milestoneIds: [3, 4, 1, 2] });
    // The position and count describe the VISIBLE rows (3), never the full stored list (4).
    expect(liveText()).toContain("tv-c moved to position 1 of 3");
    await waitFor(() => expect(rowNames()).toEqual(["tv-c", "tv-a", "tv-b"]));
  });

  test("Move to bottom, and the ends of the list disable what cannot move", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("grid", { name: "Team milestone timeline" });
    await openMenu(user, "tv-a");
    expect(await screen.findByRole("menuitem", { name: "Move up tv-a" })).toHaveAttribute("data-disabled", "true");
    expect(screen.getByRole("menuitem", { name: "Move tv-a to top" })).toHaveAttribute("data-disabled", "true");
    await user.click(screen.getByRole("menuitem", { name: "Move tv-a to bottom" }));
    await waitFor(() => expect(orderPuts(mockFetch)).toHaveLength(1));
    expect(orderPuts(mockFetch)[0]).toEqual({ expectedRevision: 4, milestoneIds: [2, 3, 1] });
    await waitFor(() => expect(rowNames()).toEqual(["tv-b", "tv-c", "tv-a"]));
    await waitFor(() => expect(screen.getByRole("grid", { name: "Team milestone timeline" })).toHaveAttribute("aria-busy", "false"));
    await openMenu(user, "tv-a");
    expect(await screen.findByRole("menuitem", { name: "Move down tv-a" })).toHaveAttribute("data-disabled", "true");
  });

  test.each([
    ["a stale 409", 409, STALE],
    ["a 400 (a listed milestone left the team)", 400, { title: "Bad Request", status: 400, detail: "Unknown, deleted or other-team milestone ids" }],
  ])("%s rolls the list back at once, then the reload brings the server's view, and the manager is told the list changed", async (_name, status, body) => {
    orderPut = { status, body };
    // After the failing PUT the reload is HELD and, once released, answers a DIFFERENT view (the server's own order: tv-c first): the
    // rollback (the pre-change view put back into the cache) and the reload are then told apart — without the rollback the rows keep
    // the optimistic order while the reload is pending.
    const refetch: { hold: boolean; release: (() => void) | null } = { hold: false, release: null };
    const inner = mockFetch.getMockImplementation() as (url: string, init?: RequestInit) => Promise<Response>;
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === "PUT" && url === "/api/v1/teams/1/milestone-order") refetch.hold = true;
      if (refetch.hold && (init?.method ?? "GET") === "GET" && url === "/api/v1/views/team/1") {
        return new Promise<Response>((resolve) => {
          refetch.release = () => resolve(jsonResponse(200, viewOf({ scheduled: [TV_C, TV_A, TV_B], order: { custom: true, revision: 9, milestoneIds: [3, 1, 2] } })));
        });
      }
      return inner(url, init);
    });
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("grid", { name: "Team milestone timeline" });
    await openMenu(user, "tv-a");
    await user.click(await screen.findByRole("menuitem", { name: "Move down tv-a" }));
    // Rolled back while the reload is still pending: the note waits for the save (including its reload) to settle.
    await waitFor(() => expect(refetch.release).not.toBeNull());
    expect(rowNames()).toEqual(["tv-a", "tv-b", "tv-c"]);
    expect(screen.queryByText("Custom order")).toBeNull();
    expect(screen.queryByRole("note")).toBeNull();
    act(() => refetch.release?.());
    expect(await screen.findByRole("note")).toHaveTextContent(/The team's order changed in the meantime/);
    await waitFor(() => expect(rowNames()).toEqual(["tv-c", "tv-a", "tv-b"]));
    expect(screen.getByText("Custom order")).toBeInTheDocument();
    expect(liveText()).toContain("The team's order changed in the meantime");
  });

  test("a 403 shows its own sentence inline", async () => {
    orderPut = { status: 403 };
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("grid", { name: "Team milestone timeline" });
    await openMenu(user, "tv-b");
    await user.click(await screen.findByRole("menuitem", { name: "Move up tv-b" }));
    expect(await screen.findByText("Only the team's manager or an administrator can change the order")).toBeInTheDocument();
  });

  test("Reset order is off without a custom order; with one it confirms (naming the project rank) and PUTs the empty list", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("grid", { name: "Team milestone timeline" });
    expect(screen.getByRole("button", { name: "Reset order" })).toBeDisabled();
    await openMenu(user, "tv-a");
    await user.click(await screen.findByRole("menuitem", { name: "Move tv-a to bottom" }));
    await waitFor(() => expect(screen.getByRole("grid", { name: "Team milestone timeline" })).toHaveAttribute("aria-busy", "false"));
    await user.click(screen.getByRole("button", { name: "Reset order" }));
    const dialog = await screen.findByRole("dialog", { name: "Reset the order?" });
    expect(dialog).toHaveTextContent("project rank");
    await user.click(within(dialog).getByRole("button", { name: "Reset" }));
    await waitFor(() => expect(orderPuts(mockFetch)).toHaveLength(2));
    expect(orderPuts(mockFetch)[1]).toEqual({ expectedRevision: 11, milestoneIds: [] });
    await waitFor(() => expect(rowNames()).toEqual(["tv-a", "tv-b", "tv-c"]));
    await waitFor(() => expect(screen.queryByText("Custom order")).toBeNull());
    expect(liveText()).toContain("The order was reset to the project rank");
  });
});

describe("Team view page: the row drag", () => {
  const handlesIn = (row: HTMLElement) => row.querySelectorAll("[data-row-handle]").length;
  const rowElements = () => within(screen.getByRole("grid", { name: "Team milestone timeline" })).getAllByRole("row").slice(1);

  test("the manager's rows carry a pointer-only handle (hidden from assistive technology, not a tab stop); a stranger's rows carry none", async () => {
    const { unmount } = renderPage();
    await screen.findByRole("grid", { name: "Team milestone timeline" });
    expect(rowElements().map(handlesIn)).toEqual([1, 1, 1]);
    // one stop per cell: the handle is no button, no link and not focusable
    expect(rowElements()[0].querySelector("[data-row-handle]")).not.toHaveAttribute("tabindex");
    unmount();
    localStorage.setItem(ROLES_KEY, "[]");
    view = viewOf({ team: { ...viewOf().team, can: { schedule: false, editCapacity: false, editOrder: false } } });
    renderPage();
    await screen.findByRole("grid", { name: "Team milestone timeline" });
    expect(rowElements().map(handlesIn)).toEqual([0, 0, 0]);
  });

  test("a drop PUTs the TEAM's order revision and the new order, applies it at once and shows the custom order", async () => {
    renderPage();
    await screen.findByRole("grid", { name: "Team milestone timeline" });
    // y = 172: 72 px into the body = exactly 2 rows, the slot after tv-b
    dropRow(TV_A, 1, 172);
    await waitFor(() => expect(orderPuts(mockFetch)).toHaveLength(1));
    expect(orderPuts(mockFetch)[0]).toEqual({ expectedRevision: 4, milestoneIds: [2, 1, 3] });
    await waitFor(() => expect(rowNames()).toEqual(["tv-b", "tv-a", "tv-c"]));
    expect(await screen.findByText("Custom order")).toBeInTheDocument();
    // dnd-kit's region is the single announcer of a drag: the page's polite region does not repeat the menu's sentence.
    expect(liveText()).not.toContain("moved to position");
  });

  test("the slot below the last row drops the milestone last; the slot above the first drops it first", async () => {
    renderPage();
    await screen.findByRole("grid", { name: "Team milestone timeline" });
    dropRow(TV_A, 1, 500);
    await waitFor(() => expect(orderPuts(mockFetch)).toHaveLength(1));
    expect(orderPuts(mockFetch)[0]).toEqual({ expectedRevision: 4, milestoneIds: [2, 3, 1] });
    await waitFor(() => expect(screen.getByRole("grid", { name: "Team milestone timeline" })).toHaveAttribute("aria-busy", "false"));
    dropRow(TV_C, 3, 101);
    await waitFor(() => expect(orderPuts(mockFetch)).toHaveLength(2));
    expect(orderPuts(mockFetch)[1]).toEqual({ expectedRevision: 11, milestoneIds: [3, 2, 1] });
  });

  test("a drop beside the row itself (the page decides: the order is unchanged) sends nothing, refuses nothing and marks no custom order", async () => {
    renderPage();
    await screen.findByRole("grid", { name: "Team milestone timeline" });
    dropRow(TV_B, 2, 130); // 30 px in = the slot before row 1: tv-b's own place
    dropRow(TV_B, 2, 170); // 70 px in = the slot after row 1
    expect(orderPuts(mockFetch)).toHaveLength(0);
    expect(rowNames()).toEqual(["tv-a", "tv-b", "tv-c"]);
    expect(screen.queryByRole("note")).toBeNull();
    expect(screen.queryByText("Custom order")).toBeNull();
  });

  test("the pick-up position is only for announcements: a drop judged against the order shown NOW (the list changed after pick-up)", async () => {
    renderPage();
    await screen.findByRole("grid", { name: "Team milestone timeline" });
    // tv-b was picked up as position 3 (it was last when the drag began); now it is row 2, so slot 3 (below tv-c) is a real move, slot 2 is none
    dropRow(TV_B, 3, 172);
    expect(orderPuts(mockFetch)).toHaveLength(0);
    dropRow(TV_B, 3, 190);
    await waitFor(() => expect(orderPuts(mockFetch)).toHaveLength(1));
    expect(orderPuts(mockFetch)[0]).toEqual({ expectedRevision: 4, milestoneIds: [1, 3, 2] });
  });

  test("a stale 409 rolls the rows back, reloads the view and says the order changed in the meantime", async () => {
    orderPut = { status: 409, body: STALE };
    renderPage();
    await screen.findByRole("grid", { name: "Team milestone timeline" });
    dropRow(TV_A, 1, 172);
    expect(await screen.findByRole("note")).toHaveTextContent(/the team's order changed in the meantime/i);
    await waitFor(() => expect(rowNames()).toEqual(["tv-a", "tv-b", "tv-c"]));
    expect(viewGets(mockFetch)).toBeGreaterThan(1);
  });

  test("a drop made while a save is still running is refused out loud and never sent", async () => {
    const gate: { release: (() => void) | null } = { release: null };
    const inner = mockFetch.getMockImplementation() as (url: string, init?: RequestInit) => Promise<Response>;
    mockFetch.mockImplementation((url: string, init?: RequestInit) =>
      init?.method === "PUT" && url === "/api/v1/teams/1/milestone-order"
        ? new Promise<Response>((resolve) => {
            gate.release = () => resolve(jsonResponse(200, { revision: 11 }));
          })
        : inner(url, init),
    );
    renderPage();
    await screen.findByRole("grid", { name: "Team milestone timeline" });
    dropRow(TV_A, 1, 190);
    await waitFor(() => expect(gate.release).not.toBeNull());
    dropRow(TV_C, 3, 101);
    expect(await screen.findByRole("note")).toHaveTextContent("A save is still running — try your change again in a moment.");
    expect(orderPuts(mockFetch)).toHaveLength(1);
    act(() => gate.release?.());
    await waitFor(() => expect(screen.getByRole("grid", { name: "Team milestone timeline" })).toHaveAttribute("aria-busy", "false"));
  });
});

describe("Team view page: scheduling", () => {
  test("a bar drop PUTs the PLAN revision, applies the dates and refetches the view (the strip follows the server)", async () => {
    renderPage();
    await screen.findByRole("grid", { name: "Team milestone timeline" });
    const before = viewGets(mockFetch);
    dropMove(TV_C, 1);
    await waitFor(() => expect(schedulePuts(mockFetch)).toHaveLength(1));
    expect(schedulePuts(mockFetch)[0]).toEqual({ expectedRevision: 10, startDate: "2027-02-09", endDate: "2027-02-11" });
    await waitFor(() => expect(barOf("tv-c")).toHaveAccessibleName(/2027-02-09 to 2027-02-11/));
    await waitFor(() => expect(viewGets(mockFetch)).toBeGreaterThan(before));
  });

  test("Edit schedule… from the tray's row PUTs the dates and moves the row onto the timeline", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("grid", { name: "Team milestone timeline" });
    await openMenu(user, "tv-tray");
    await user.click(await screen.findByRole("menuitem", { name: "Edit schedule of tv-tray" }));
    const dialog = await screen.findByRole("dialog", { name: "Schedule of tv-tray" });
    await user.type(within(dialog).getByRole("textbox", { name: "Start date" }), "2027-03-01");
    await user.type(within(dialog).getByRole("textbox", { name: "End date" }), "2027-03-05");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(schedulePuts(mockFetch)).toHaveLength(1));
    expect(schedulePuts(mockFetch)[0]).toEqual({ expectedRevision: 10, startDate: "2027-03-01", endDate: "2027-03-05" });
    await waitFor(() => expect(rowNames()).toContain("tv-tray"));
    expect(liveText()).toContain("tv-tray scheduled: 2027-03-01 to 2027-03-05");
  });

  test("the tray's Schedule places the milestone for one calendar week from today", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 11, 1, 10, 0));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderPage();
    await screen.findByRole("grid", { name: "Team milestone timeline" });
    await user.click(screen.getByRole("button", { name: "Schedule tv-tray" }));
    await waitFor(() => expect(schedulePuts(mockFetch)).toHaveLength(1));
    expect(schedulePuts(mockFetch)[0]).toEqual({ expectedRevision: 10, startDate: "2026-12-01", endDate: "2026-12-07" });
  });

  test("a stale 409 on a schedule write rolls back and says THIS milestone moved", async () => {
    schedulePut = { status: 409, body: STALE };
    renderPage();
    await screen.findByRole("grid", { name: "Team milestone timeline" });
    dropMove(TV_C, 1);
    expect(await screen.findByText(/moved by someone else in the meantime/)).toBeInTheDocument();
    await waitFor(() => expect(barOf("tv-c")).toHaveAccessibleName(/2027-02-08 to 2027-02-10/));
  });

  test("a schedule drop is refused out loud while the order is still saving (one write in flight at a time)", async () => {
    const gate: { release: (() => void) | null } = { release: null };
    const inner = mockFetch.getMockImplementation() as (url: string, init?: RequestInit) => Promise<Response>;
    mockFetch.mockImplementation((url: string, init?: RequestInit) =>
      init?.method === "PUT" && url === "/api/v1/teams/1/milestone-order"
        ? new Promise<Response>((resolve) => {
            gate.release = () => resolve(jsonResponse(200, { revision: 11 }));
          })
        : inner(url, init),
    );
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("grid", { name: "Team milestone timeline" });
    await openMenu(user, "tv-a");
    await user.click(await screen.findByRole("menuitem", { name: "Move tv-a to bottom" }));
    await waitFor(() => expect(gate.release).not.toBeNull());
    dropMove(TV_C, 1);
    expect(await screen.findByRole("note")).toHaveTextContent("A save is still running — try your change again in a moment.");
    expect(schedulePuts(mockFetch)).toHaveLength(0);
    act(() => gate.release?.());
    // Let the save settle (its background refetch runs while fetch is still stubbed).
    await waitFor(() => expect(screen.getByRole("grid", { name: "Team milestone timeline" })).toHaveAttribute("aria-busy", "false"));
    // The refusal does not outlive the save that caused it (the ORDER save here, not a schedule one).
    expect(screen.queryByRole("note")).toBeNull();
  });

  /** Hold the next schedule PUT; `gate.release()` answers it. */
  function holdSchedulePut() {
    const gate: { release: (() => void) | null } = { release: null };
    const inner = mockFetch.getMockImplementation() as (url: string, init?: RequestInit) => Promise<Response>;
    mockFetch.mockImplementation((url: string, init?: RequestInit) =>
      init?.method === "PUT" && /\/schedule$/.test(url)
        ? new Promise<Response>((resolve) => {
            gate.release = () => resolve(jsonResponse(200, { revision: 11 }));
          })
        : inner(url, init),
    );
    return gate;
  }

  test("a Move made while a schedule save runs is refused out loud (note and live region), never sent, and the note goes away with the save", async () => {
    const gate = holdSchedulePut();
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("grid", { name: "Team milestone timeline" });
    dropMove(TV_C, 1);
    await waitFor(() => expect(gate.release).not.toBeNull());
    await openMenu(user, "tv-a");
    await user.click(await screen.findByRole("menuitem", { name: "Move tv-a to bottom" }));
    expect(await screen.findByRole("note")).toHaveTextContent("A save is still running — try your change again in a moment.");
    expect(liveText()).toContain("A save is still running");
    expect(orderPuts(mockFetch)).toHaveLength(0);
    expect(rowNames()).toEqual(["tv-a", "tv-b", "tv-c"]);
    act(() => gate.release?.());
    await waitFor(() => expect(screen.queryByRole("note")).toBeNull());
    await waitFor(() => expect(screen.getByRole("grid", { name: "Team milestone timeline" })).toHaveAttribute("aria-busy", "false"));
  });

  test("a Reset confirmed while a schedule save runs is refused: the dialog stays open and says so; confirmed again after the save it goes through", async () => {
    view = viewOf({ order: { custom: true, revision: 6, milestoneIds: [1, 2, 3] } });
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("grid", { name: "Team milestone timeline" });
    await user.click(screen.getByRole("button", { name: "Reset order" }));
    const dialog = await screen.findByRole("dialog", { name: "Reset the order?" });
    const gate = holdSchedulePut();
    dropMove(TV_C, 1);
    await waitFor(() => expect(gate.release).not.toBeNull());
    await user.click(within(dialog).getByRole("button", { name: "Reset" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("A save is still running");
    expect(screen.getByRole("dialog", { name: "Reset the order?" })).toBeInTheDocument();
    expect(orderPuts(mockFetch)).toHaveLength(0);
    act(() => gate.release?.());
    await waitFor(() => expect(screen.getByRole("grid", { name: "Team milestone timeline" })).toHaveAttribute("aria-busy", "false"));
    await user.click(within(screen.getByRole("dialog", { name: "Reset the order?" })).getByRole("button", { name: "Reset" }));
    await waitFor(() => expect(orderPuts(mockFetch)).toHaveLength(1));
    expect(orderPuts(mockFetch)[0]).toEqual({ expectedRevision: 6, milestoneIds: [] });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Reset the order?" })).toBeNull());
  });
});

describe("Team view page: capacity", () => {
  async function openAddDialog(user: ReturnType<typeof userEvent.setup>) {
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Add period" }));
    return screen.findByRole("dialog", { name: "Add a capacity period" });
  }

  test("Add period POSTs the date (a Tuesday is fine), the man-days and a limit; an empty limit travels as null", async () => {
    const user = userEvent.setup();
    const dialog = await openAddDialog(user);
    expect(within(dialog).getByText(/A weekend date applies from the Monday after it/)).toBeInTheDocument();
    await user.type(within(dialog).getByRole("textbox", { name: "Effective from" }), "2027-03-02");
    await user.type(within(dialog).getByRole("textbox", { name: "Man-days per week" }), "12.5");
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(calls(mockFetch, "POST", /capacity$/)).toHaveLength(1));
    expect(calls(mockFetch, "POST", /capacity$/)[0].body).toEqual({ effectiveFrom: "2027-03-02", mdPerWeek: 12.5, wipLimit: null });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  test("a WIP limit of 7 is sent as 7; a limit of 0 is refused inline before the server is asked", async () => {
    const user = userEvent.setup();
    const dialog = await openAddDialog(user);
    await user.type(within(dialog).getByRole("textbox", { name: "Effective from" }), "2027-03-06");
    await user.type(within(dialog).getByRole("textbox", { name: "Man-days per week" }), "10");
    await user.type(within(dialog).getByRole("textbox", { name: "WIP limit" }), "0");
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(await within(dialog).findByText("Enter a whole number from 1 to 99, or leave empty for no limit")).toBeInTheDocument();
    expect(calls(mockFetch, "POST", /capacity$/)).toHaveLength(0);
    await user.clear(within(dialog).getByRole("textbox", { name: "WIP limit" }));
    await user.type(within(dialog).getByRole("textbox", { name: "WIP limit" }), "7");
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(calls(mockFetch, "POST", /capacity$/)).toHaveLength(1));
    expect(calls(mockFetch, "POST", /capacity$/)[0].body).toEqual({ effectiveFrom: "2027-03-06", mdPerWeek: 10, wipLimit: 7 });
  });

  test("a missing date and missing man-days are refused on the form; a taken date (409) marks the date field", async () => {
    const user = userEvent.setup();
    const dialog = await openAddDialog(user);
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(await within(dialog).findByText("Enter a valid date (YYYY-MM-DD)")).toBeInTheDocument();
    expect(within(dialog).getByText("Enter man-days from 0, with at most two decimals")).toBeInTheDocument();
    periodPost = { status: 409, body: { title: "Conflict", status: 409 } };
    await user.type(within(dialog).getByRole("textbox", { name: "Effective from" }), "2027-02-03");
    await user.type(within(dialog).getByRole("textbox", { name: "Man-days per week" }), "8");
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(await within(dialog).findByText("Another period starts on this date")).toBeInTheDocument();
  });

  test("Edit prefills the period and PUTs the full replace; clearing the limit sends null", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("grid", { name: "Team milestone timeline" });
    await openMenu(user, "2027-02-03");
    await user.click(await screen.findByRole("menuitem", { name: "Edit the period from 2027-02-03" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit the capacity period" });
    expect(within(dialog).getByRole("textbox", { name: "Effective from" })).toHaveValue("2027-02-03");
    expect(within(dialog).getByRole("textbox", { name: "Man-days per week" })).toHaveValue("8");
    await user.clear(within(dialog).getByRole("textbox", { name: "WIP limit" }));
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls(mockFetch, "PUT", /capacity-periods\/11$/)).toHaveLength(1));
    expect(calls(mockFetch, "PUT", /capacity-periods\/11$/)[0].body).toEqual({ effectiveFrom: "2027-02-03", mdPerWeek: 8, wipLimit: null });
  });

  test("Delete confirms and DELETEs the period, then refreshes the view", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("grid", { name: "Team milestone timeline" });
    const before = viewGets(mockFetch);
    await openMenu(user, "2027-02-03");
    await user.click(await screen.findByRole("menuitem", { name: "Delete the period from 2027-02-03" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete the capacity period?" });
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(calls(mockFetch, "DELETE", /capacity-periods\/11$/)).toHaveLength(1));
    await waitFor(() => expect(viewGets(mockFetch)).toBeGreaterThan(before));
  });

  test("without capacity the section says so and, for a manager, offers the first period", async () => {
    view = viewOf({ capacity: { periods: [] } });
    renderPage();
    expect(await screen.findByText("No capacity set")).toBeInTheDocument();
    expect(screen.getByText(/Add a period to compare/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add period" })).toBeInTheDocument();
  });
});
