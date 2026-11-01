import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { act, screen, waitFor, within } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import { DndContext } from "@dnd-kit/core";
import { Route, Routes } from "react-router-dom";
import ProjectView from "./ProjectView";
import type { DependencyEndpoint, ProjectDependency } from "../api/dependencies";
import type { ProjectMilestone, ProjectView as ProjectViewDocument } from "../api/milestones";
import { applySchedule } from "../utils/projectViewUpdate";
import { headingOutline } from "../test/headings";
import { jsonResponse } from "../test/http";
import { renderWithProviders } from "../test/render";

type FetchMock = ReturnType<typeof vi.fn>;

// happy-dom has no layout, so a pointer drag cannot run here (e2e drives the real one). The context is wrapped to hand the test its
// drag-end handler: what the page does WHEN dnd-kit reports a drop is ours to pin.
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
const dropMove = (m: ProjectMilestone, days: number) =>
  act(() =>
    dndProps?.onDragEnd?.({
      active: { id: `bar:${m.id}:move`, data: { current: { kind: "move", barId: m.id, label: m.name, start: m.startDate, end: m.endDate } } },
      delta: { x: days * 28, y: 0 },
      over: null,
      activatorEvent: null,
    } as never),
  );

const milestone = (id: number, name: string, over: Partial<ProjectMilestone> = {}): ProjectMilestone => ({
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
  can: { edit: true, delete: true, schedule: true },
  ...over,
});

const DISCOVERY = milestone(1, "Discovery", { description: "Interviews", estimateMd: 12.25, startDate: "2027-01-11", endDate: "2027-01-15" });
const BUILD = milestone(2, "Build", { startDate: "2027-01-18", endDate: "2027-01-29" });
const ROLLOUT = milestone(3, "Rollout");
const AUDIT = milestone(4, "Audit", { teamId: 4, teamName: "Design" });
/** A milestone of ANOTHER project (the dependency pickers' search result, and the ghost row's end). */
const ALPHA_MILESTONE = { ...milestone(21, "a1", { startDate: "2027-01-04", endDate: "2027-01-08", teamName: "Design" }), projectId: 99 };

const viewOf = (over: Partial<ProjectViewDocument> = {}): ProjectViewDocument => ({
  revision: 10,
  project: {
    id: 7,
    programId: 70,
    workStreamId: 700,
    programName: "Billing",
    workStreamName: "Platform",
    name: "Invoices",
    description: "Monthly invoicing",
    ownerPersonId: 5,
    ownerName: "Ola Owner",
    targetStart: "2027-01-04",
    targetEnd: "2027-01-22",
    createdAt: 1,
    updatedAt: 2,
    can: { edit: true, delete: true, editTargetWindow: true, createMilestone: true, createDependency: true },
  },
  span: { start: "2027-01-11", end: "2027-01-29" },
  drift: { startDays: 7, endDays: 7 },
  scheduled: [DISCOVERY, BUILD],
  unscheduled: [AUDIT, ROLLOUT],
  dependencies: [],
  idleGaps: [],
  ...over,
});

/** The project's own `can` without the right to link: a milestone row with no flags of its own then has no menu at all. */
const withoutLinking = () => ({ ...viewOf().project, can: { ...viewOf().project.can, createDependency: false } });

const STALE = { type: "urn:astrolabe:problem:stale-revision", title: "Conflict", status: 409, detail: "stale" };

let view: ProjectViewDocument;
/** The public-holiday dictionary the stand-in server answers (empty unless a test adds a row). */
let holidays: { id: number; date: string; name: string }[];
let putStatus: { status: number; body?: unknown };
let dependencyPost: { status: number; body?: unknown };
/** Runs when a dependency POST is accepted: the test's stand-in for the server adding the link to the view. */
let onDependencyCreated: (() => void) | null;

/** A tiny server: GET answers the current view; an accepted schedule PUT applies the dates and bumps the revision. */
function serve(mockFetch: FetchMock) {
  mockFetch.mockImplementation((url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "GET" && url === "/api/v1/views/project/7") return Promise.resolve(jsonResponse(200, view));
    if (method === "GET" && url === "/api/v1/public-holidays") return Promise.resolve(jsonResponse(200, { items: holidays }));
    const schedule = /^\/api\/v1\/milestones\/(\d+)\/schedule$/.exec(url);
    if (method === "PUT" && schedule) {
      if (putStatus.status !== 200) return Promise.resolve(jsonResponse(putStatus.status, putStatus.body ?? { title: "x", status: putStatus.status }));
      const body = JSON.parse(init?.body as string) as { startDate: string | null; endDate: string | null };
      view = { ...applySchedule(view, Number(schedule[1]), body.startDate, body.endDate), revision: view.revision + 1 };
      return Promise.resolve(jsonResponse(200, { revision: view.revision }));
    }
    if (method === "POST" && url === "/api/v1/projects/7/milestones") return Promise.resolve(jsonResponse(201, { id: 9 }));
    if (method === "POST" && url === "/api/v1/projects/7/dependencies") {
      if (dependencyPost.status === 201) onDependencyCreated?.();
      return Promise.resolve(jsonResponse(dependencyPost.status, dependencyPost.body ?? { id: 50 }));
    }
    if (method === "GET" && url.startsWith("/api/v1/milestones?")) {
      const item = { ...ALPHA_MILESTONE, projectName: "Alpha", projectId: 99 };
      return Promise.resolve(jsonResponse(200, { items: [item], page: 1, pageSize: 50, total: 1 }));
    }
    if (method === "DELETE") return Promise.resolve(new Response(null, { status: 204 }));
    if (url.startsWith("/api/v1/teams?")) {
      return Promise.resolve(jsonResponse(200, { items: [{ id: 3, name: "Backend" }, { id: 4, name: "Design" }], page: 1, pageSize: 50, total: 2 }));
    }
    return Promise.resolve(jsonResponse(404, { title: "x", status: 404 }));
  });
}

const calls = (mockFetch: FetchMock, method: string, matcher: RegExp) =>
  mockFetch.mock.calls
    .filter(([url, init]) => matcher.test(url as string) && ((init as RequestInit | undefined)?.method ?? "GET") === method)
    .map(([url, init]) => ({ url: url as string, body: (init as RequestInit | undefined)?.body ? JSON.parse((init as RequestInit).body as string) : undefined }));
const schedulePuts = (mockFetch: FetchMock) => calls(mockFetch, "PUT", /\/schedule$/).map((c) => c.body);
const viewGets = (mockFetch: FetchMock) => calls(mockFetch, "GET", /views\/project\/7$/).length;

function renderPage(queryClient?: QueryClient) {
  return renderWithProviders(
    <Routes>
      <Route path="/projects/:id" element={<ProjectView />} />
      <Route path="/plan" element={<p>The plan</p>} />
    </Routes>,
    { route: "/projects/7", queryClient },
  );
}

/** The text of every polite live region (the page's own and dnd-kit's). */
const liveText = () => screen.getAllByRole("status").map((region) => region.textContent).join(" | ");

const barOf = (name: string) => screen.getByRole("button", { name: new RegExp(`^${name}, `) });

let mockFetch: FetchMock;

beforeEach(() => {
  view = viewOf();
  holidays = [];
  putStatus = { status: 200 };
  dependencyPost = { status: 201 };
  onDependencyCreated = null;
  dndProps = null;
  mockFetch = vi.fn();
  vi.stubGlobal("fetch", mockFetch);
  localStorage.setItem("astrolabe.auth.token", "fake-token");
  serve(mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  localStorage.clear();
});

describe("Project view page", () => {
  test("renders the facts, the timeline and the tray; the heading outline is pinned", async () => {
    renderPage();
    await screen.findByRole("grid", { name: "Milestone timeline" });
    expect(headingOutline()).toEqual([
      [2, "Invoices"],
      [3, "Timeline"],
      [3, "Unscheduled"],
      [3, "Dependencies"],
    ]);
    expect(screen.getByText("Monthly invoicing")).toBeInTheDocument();
    expect(screen.getByText("Billing · Platform · Owner: Ola Owner")).toBeInTheDocument();
    const facts = screen.getByRole("group", { name: "Project facts" });
    expect(within(facts).getByText("Target window: 2027-01-04 – 2027-01-22")).toBeInTheDocument();
    expect(within(facts).getByText("Scheduled span: 2027-01-11 – 2027-01-29")).toBeInTheDocument();
    // The span runs a week late on both ends: orange warnings, never red.
    expect(within(facts).getByText("Ends 7 days after the target")).toBeInTheDocument();
    expect(within(facts).getByText("Starts 7 days after the target")).toBeInTheDocument();
    expect(barOf("Discovery")).toHaveAccessibleName("Discovery, Backend, 2027-01-11 to 2027-01-15, 12.25 man-days");
    const tray = screen.getByRole("table", { name: "Unscheduled milestones" });
    expect(within(tray).getAllByRole("row").slice(1).map((r) => within(r).getAllByRole("cell")[1].textContent)).toEqual(["Audit", "Rollout"]);
  });

  test("an ahead span is gray, no drift says nothing alarming, no window and nothing scheduled read as such", async () => {
    view = viewOf({ drift: { startDays: -3, endDays: 0 } });
    const { unmount } = renderPage();
    const facts = await screen.findByRole("group", { name: "Project facts" });
    expect(within(facts).getByText("Starts 3 days before the target")).toBeInTheDocument();
    expect(within(facts).queryByText(/Ends/)).toBeNull();
    unmount();

    view = viewOf({ drift: null, span: null, scheduled: [], unscheduled: [ROLLOUT], project: { ...viewOf().project, targetStart: null, targetEnd: null } });
    renderPage();
    const empty = await screen.findByRole("group", { name: "Project facts" });
    expect(within(empty).getByText("No target window")).toBeInTheDocument();
    expect(within(empty).getByText("Nothing scheduled")).toBeInTheDocument();
  });

  test("a project owner (no schedule right) gets plan editors but read-only bars and no Schedule buttons or handles", async () => {
    const readOnly = (m: ProjectMilestone) => ({ ...m, can: { edit: true, delete: true, schedule: false } });
    view = viewOf({ scheduled: [readOnly(DISCOVERY), readOnly(BUILD)], unscheduled: [readOnly(ROLLOUT)] });
    renderPage();
    await screen.findByRole("grid", { name: "Milestone timeline" });
    expect(screen.getByRole("img", { name: /^Discovery, Backend, .*, read-only$/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^(Resize|Schedule)/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Discovery, / })).toBeNull();
    // The owner's menu offers Edit and Delete, not the schedule items.
    await userEvent.setup().click(screen.getByRole("button", { name: "Operations for Discovery" }));
    expect(await screen.findByRole("menuitem", { name: "Edit Discovery" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Delete Discovery" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /schedule/i })).toBeNull();
    expect(screen.getByText(/manager or an administrator schedules them/)).toBeInTheDocument();
  });

  test("a stranger sees the page without any action", async () => {
    const none = { edit: false, delete: false, schedule: false };
    view = viewOf({
      project: { ...viewOf().project, can: { edit: false, delete: false, editTargetWindow: false, createMilestone: false, createDependency: false } },
      scheduled: [{ ...DISCOVERY, can: none }],
      unscheduled: [{ ...ROLLOUT, can: none }],
    });
    renderPage();
    await screen.findByRole("grid", { name: "Milestone timeline" });
    expect(screen.queryByRole("button", { name: /New milestone|Edit|Delete|Operations/ })).toBeNull();
  });

  test("New milestone posts the plan fields only (no dates) and refreshes the view", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("grid", { name: "Milestone timeline" });
    await user.click(screen.getByRole("button", { name: "New milestone" }));
    const dialog = await screen.findByRole("dialog", { name: "New milestone" });
    await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "  Pilot  ");
    await user.click(within(dialog).getByRole("combobox", { name: "Team" }));
    await user.click(await screen.findByRole("option", { name: "Design" }));
    await user.type(within(dialog).getByRole("textbox", { name: "Estimate" }), "2.5");
    const before = viewGets(mockFetch);
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(calls(mockFetch, "POST", /milestones$/)).toHaveLength(1));
    expect(calls(mockFetch, "POST", /milestones$/)[0].body).toEqual({ name: "Pilot", description: null, teamId: 4, estimateMd: 2.5 });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(viewGets(mockFetch)).toBeGreaterThan(before));
  });

  test("a create without a team or an estimate is refused on the form", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("grid", { name: "Milestone timeline" });
    await user.click(screen.getByRole("button", { name: "New milestone" }));
    const dialog = await screen.findByRole("dialog", { name: "New milestone" });
    await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "Pilot");
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(await within(dialog).findByText("Pick a team")).toBeInTheDocument();
    expect(within(dialog).getByText("Enter the estimate in man-days")).toBeInTheDocument();
    expect(calls(mockFetch, "POST", /milestones$/)).toHaveLength(0);
  });

  test("a duplicate name (409) marks the name field", async () => {
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === "PUT" && url === "/api/v1/milestones/1") return Promise.resolve(jsonResponse(409, { title: "Conflict", status: 409 }));
      if (url === "/api/v1/views/project/7") return Promise.resolve(jsonResponse(200, view));
      return Promise.resolve(jsonResponse(404, { title: "x", status: 404 }));
    });
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("grid", { name: "Milestone timeline" });
    await user.click(screen.getByRole("button", { name: "Operations for Discovery" }));
    await user.click(await screen.findByRole("menuitem", { name: "Edit Discovery" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit milestone" });
    expect(within(dialog).getByRole("textbox", { name: "Name" })).toHaveValue("Discovery");
    expect(within(dialog).getByRole("textbox", { name: "Estimate" })).toHaveValue("12.25");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByText("A milestone with this name already exists in this project")).toBeInTheDocument();
  });

  test("Edit schedule… PUTs the expected revision and the dates; the next change carries the revision the PUT answered", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("grid", { name: "Milestone timeline" });
    await user.click(screen.getByRole("button", { name: "Operations for Discovery" }));
    await user.click(await screen.findByRole("menuitem", { name: "Edit schedule of Discovery" }));
    const dialog = await screen.findByRole("dialog", { name: "Schedule of Discovery" });
    const start = within(dialog).getByRole("textbox", { name: "Start date" });
    await user.clear(start);
    await user.type(start, "2027-01-12");
    const end = within(dialog).getByRole("textbox", { name: "End date" });
    await user.clear(end);
    await user.type(end, "2027-01-14");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(schedulePuts(mockFetch)).toHaveLength(1));
    expect(schedulePuts(mockFetch)[0]).toEqual({ expectedRevision: 10, startDate: "2027-01-12", endDate: "2027-01-14" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // The bar already reads the new dates and the live region says so.
    await waitFor(() => expect(barOf("Discovery")).toHaveAccessibleName(/2027-01-12 to 2027-01-14/));
    expect(liveText()).toContain("Discovery scheduled: 2027-01-12 to 2027-01-14");
    // The next change goes out with the adopted revision (11), after the refetch settled.
    await waitFor(() => expect(screen.getByRole("grid", { name: "Milestone timeline" })).toHaveAttribute("aria-busy", "false"));
    dropMove(view.scheduled.find((m) => m.id === 1)!, 1);
    await waitFor(() => expect(schedulePuts(mockFetch)).toHaveLength(2));
    expect(schedulePuts(mockFetch)[1]).toMatchObject({ expectedRevision: 11, startDate: "2027-01-13", endDate: "2027-01-15" });
  });

});

describe("Project view page: schedule writes", () => {
  test("the schedule dialog refuses a Saturday–Sunday-only span before asking the server", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("grid", { name: "Milestone timeline" });
    await user.click(screen.getByRole("button", { name: "Operations for Discovery" }));
    await user.click(await screen.findByRole("menuitem", { name: "Edit schedule of Discovery" }));
    const dialog = await screen.findByRole("dialog", { name: "Schedule of Discovery" });
    const start = within(dialog).getByRole("textbox", { name: "Start date" });
    await user.clear(start);
    await user.type(start, "2027-01-09");
    const end = within(dialog).getByRole("textbox", { name: "End date" });
    await user.clear(end);
    await user.type(end, "2027-01-10");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByText("A milestone must cover at least one working day (Monday to Friday, not a public holiday)")).toBeInTheDocument();
    expect(schedulePuts(mockFetch)).toHaveLength(0);
  });

  test("the schedule dialog counts the cached public holidays: a holiday-only span is refused before asking the server, one more weekday is saved", async () => {
    holidays = [{ id: 1, date: "2027-01-06", name: "Epiphany" }];
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("grid", { name: "Milestone timeline" });
    await user.click(screen.getByRole("button", { name: "Operations for Discovery" }));
    await user.click(await screen.findByRole("menuitem", { name: "Edit schedule of Discovery" }));
    const dialog = await screen.findByRole("dialog", { name: "Schedule of Discovery" });
    await waitFor(() => expect(mockFetch.mock.calls.some(([url]) => url === "/api/v1/public-holidays")).toBe(true));
    // Let the dictionary land before pressing Save (the page's own query resolves on the same tick as the dialog's).
    await screen.findByText(/Public holidays shown: 2027-01-06 Epiphany/);
    const start = within(dialog).getByRole("textbox", { name: "Start date" });
    await user.clear(start);
    await user.type(start, "2027-01-06");
    const end = within(dialog).getByRole("textbox", { name: "End date" });
    await user.clear(end);
    await user.type(end, "2027-01-06");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByText("A milestone must cover at least one working day (Monday to Friday, not a public holiday)")).toBeInTheDocument();
    expect(schedulePuts(mockFetch)).toHaveLength(0);

    await user.clear(end);
    await user.type(end, "2027-01-07");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(schedulePuts(mockFetch)).toHaveLength(1));
    expect(schedulePuts(mockFetch)[0]).toEqual({ expectedRevision: 10, startDate: "2027-01-06", endDate: "2027-01-07" });
  });

  test("the timeline names the holiday on its header day cell and lists it for assistive technology", async () => {
    holidays = [{ id: 1, date: "2027-01-12", name: "Founders' Day" }];
    renderPage();
    await screen.findByRole("grid", { name: "Milestone timeline" });
    expect(await screen.findByText("Public holidays shown: 2027-01-12 Founders' Day")).toBeInTheDocument();
    const named = document.querySelectorAll<HTMLElement>("[data-holiday]");
    expect(named).toHaveLength(1);
    expect(named[0]).toHaveAttribute("title", "Public holiday: Founders' Day");
  });

  test("the tray's Schedule places the milestone for one calendar week from the later of today and the target start", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 11, 1, 10, 0)); // local wall-clock time: "today" is the viewer's own calendar day
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderPage();
    await screen.findByRole("grid", { name: "Milestone timeline" });
    await user.click(screen.getByRole("button", { name: "Schedule Rollout" }));
    await waitFor(() => expect(schedulePuts(mockFetch)).toHaveLength(1));
    // Target start 2027-01-04 is after "today": start there, end six days later.
    expect(schedulePuts(mockFetch)[0]).toEqual({ expectedRevision: 10, startDate: "2027-01-04", endDate: "2027-01-10" });
    await waitFor(() => expect(barOf("Rollout")).toHaveAccessibleName(/2027-01-04 to 2027-01-10/));
    expect(screen.getByRole("table", { name: "Unscheduled milestones" })).not.toHaveTextContent("Rollout");
  });

  test("the Schedule button starts today when the target start has passed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2027, 1, 3, 10, 0));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderPage();
    await screen.findByRole("grid", { name: "Milestone timeline" });
    await user.click(screen.getByRole("button", { name: "Schedule Audit" }));
    await waitFor(() => expect(schedulePuts(mockFetch)).toHaveLength(1));
    expect(schedulePuts(mockFetch)[0]).toMatchObject({ startDate: "2027-02-03", endDate: "2027-02-09" });
  });

  test("a Schedule pressed on a Saturday starts that Saturday (the viewer's local day) and runs the week to the next Friday", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2027, 0, 9, 23, 30)); // Saturday 2027-01-09, late in the evening, local time
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderPage();
    await screen.findByRole("grid", { name: "Milestone timeline" });
    await user.click(screen.getByRole("button", { name: "Schedule Audit" }));
    await waitFor(() => expect(schedulePuts(mockFetch)).toHaveLength(1));
    // the target start (2027-01-04) has passed; the span still contains working days (Mon-Fri 11-15)
    expect(schedulePuts(mockFetch)[0]).toMatchObject({ startDate: "2027-01-09", endDate: "2027-01-15" });
  });

  test("Unschedule sends the null pair and the milestone returns to the tray", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("grid", { name: "Milestone timeline" });
    await user.click(screen.getByRole("button", { name: "Operations for Build" }));
    await user.click(await screen.findByRole("menuitem", { name: "Unschedule Build" }));
    await waitFor(() => expect(schedulePuts(mockFetch)).toHaveLength(1));
    expect(schedulePuts(mockFetch)[0]).toEqual({ expectedRevision: 10, startDate: null, endDate: null });
    await waitFor(() => expect(screen.getByRole("table", { name: "Unscheduled milestones" })).toHaveTextContent("Build"));
    expect(screen.queryByRole("button", { name: /^Build, / })).toBeNull();
    expect(liveText()).toContain("Build moved back to Unscheduled");
  });

  test("a dropped bar proposes the moved dates; a change made while a save runs is refused out loud, never lost silently", async () => {
    const gate: { resolve?: (response: Response) => void } = {};
    const held = new Promise<Response>((resolve) => {
      gate.resolve = resolve;
    });
    const base = mockFetch.getMockImplementation() as (url: string, init?: RequestInit) => Promise<Response>;
    mockFetch.mockImplementation((url: string, init?: RequestInit) => (init?.method === "PUT" ? held : base(url, init)));
    renderPage();
    await screen.findByRole("grid", { name: "Milestone timeline" });
    dropMove(DISCOVERY, 2);
    await waitFor(() => expect(schedulePuts(mockFetch)).toHaveLength(1));
    expect(schedulePuts(mockFetch)[0]).toEqual({ expectedRevision: 10, startDate: "2027-01-13", endDate: "2027-01-17" });
    expect(screen.getByRole("grid", { name: "Milestone timeline" })).toHaveAttribute("aria-busy", "true");
    // the busy state is VISIBLE, not only aria-busy
    expect(screen.getByText("Saving…")).toBeInTheDocument();
    // a second drop during the save: nothing is sent, the page says so (visibly and in the live region), and dnd-kit's own drop
    // announcement is corrected to "not changed"
    dropMove(BUILD, 1);
    expect(schedulePuts(mockFetch)).toHaveLength(1);
    expect(screen.getByText("A save is still running — try your change again in a moment.")).toBeInTheDocument();
    expect(liveText()).toContain("A save is still running");
    // said ONCE: the status region is the live announcer, the visible notice is not a second `role="alert"`
    expect(screen.queryByRole("alert")).toBeNull();
    const announced = dndProps?.accessibility?.announcements?.onDragEnd?.({ active: { id: `bar:${BUILD.id}:move` } } as never);
    expect(announced).toBe("Build was not changed: a save is still running. Try again in a moment.");
    gate.resolve?.(jsonResponse(200, { revision: 11 }));
    await waitFor(() => expect(screen.getByRole("grid", { name: "Milestone timeline" })).toHaveAttribute("aria-busy", "false"));
    // the notice goes with the save, and the retry is taken
    await waitFor(() => expect(screen.queryByText("A save is still running — try your change again in a moment.")).toBeNull());
    expect(screen.queryByText("Saving…")).toBeNull();
  });

  test("the tray's Schedule button and the schedule dialog are refused the same way while a save runs", async () => {
    const gate: { resolve?: (response: Response) => void } = {};
    const held = new Promise<Response>((resolve) => {
      gate.resolve = resolve;
    });
    const base = mockFetch.getMockImplementation() as (url: string, init?: RequestInit) => Promise<Response>;
    mockFetch.mockImplementation((url: string, init?: RequestInit) => (init?.method === "PUT" ? held : base(url, init)));
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("grid", { name: "Milestone timeline" });
    dropMove(DISCOVERY, 1);
    await waitFor(() => expect(schedulePuts(mockFetch)).toHaveLength(1));
    await user.click(screen.getByRole("button", { name: "Schedule Rollout" }));
    expect(await screen.findByText("A save is still running — try your change again in a moment.")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(schedulePuts(mockFetch)).toHaveLength(1);
    expect(screen.getByRole("table", { name: "Unscheduled milestones" })).toHaveTextContent("Rollout");
    // the dialog stays open and says so inside itself
    await user.click(screen.getByRole("button", { name: "Operations for Build" }));
    await user.click(await screen.findByRole("menuitem", { name: "Edit schedule of Build" }));
    const dialog = await screen.findByRole("dialog", { name: "Schedule of Build" });
    const announcedBefore = liveText();
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    // inside the dialog the refusal is its own live alert — and the page's status region does not say it a second time
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("A save is still running — try your change again in a moment.");
    expect(liveText()).toBe(announcedBefore);
    expect(screen.getByRole("dialog", { name: "Schedule of Build" })).toBeInTheDocument();
    expect(schedulePuts(mockFetch)).toHaveLength(1);
    gate.resolve?.(jsonResponse(200, { revision: 11 }));
    await waitFor(() => expect(within(dialog).queryByText(/still running/)).toBeNull());
  });

  test("the same announcement twice is re-read: the live region text flips an invisible suffix each time", async () => {
    const gate: { resolve?: (response: Response) => void } = {};
    const held = new Promise<Response>((resolve) => {
      gate.resolve = resolve;
    });
    const base = mockFetch.getMockImplementation() as (url: string, init?: RequestInit) => Promise<Response>;
    mockFetch.mockImplementation((url: string, init?: RequestInit) => (init?.method === "PUT" ? held : base(url, init)));
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("grid", { name: "Milestone timeline" });
    dropMove(DISCOVERY, 1);
    await waitFor(() => expect(schedulePuts(mockFetch)).toHaveLength(1));
    const region = () => screen.getAllByRole("status").find((r) => r.textContent?.includes("still running"));
    const said: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      await user.click(screen.getByRole("button", { name: "Schedule Rollout" }));
      await waitFor(() => expect(region()).toBeDefined());
      // let the new text commit before reading it: each refusal is the SAME sentence
      await waitFor(() => expect(region()?.textContent).not.toBe(said[i - 1]));
      said.push(region()?.textContent ?? "");
    }
    const zeroWidth = "\u200B";
    expect(said.map((text) => text.replaceAll(zeroWidth, ""))).toEqual(Array(3).fill("A save is still running — try your change again in a moment."));
    // consecutive texts differ (that is what makes a screen reader read the repeat), by exactly the invisible suffix
    expect(said[0]).not.toBe(said[1]);
    expect(said[1]).not.toBe(said[2]);
    expect(said[0]).toBe(said[2]);
    expect(said.filter((text) => text.endsWith(zeroWidth))).toHaveLength(2);
    expect(schedulePuts(mockFetch)).toHaveLength(1);
    gate.resolve?.(jsonResponse(200, { revision: 11 }));
    await waitFor(() => expect(screen.getByRole("grid", { name: "Milestone timeline" })).toHaveAttribute("aria-busy", "false"));
  });

  test("saving the schedule dialog of a milestone that is gone says so, announces it and closes the dialog", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("grid", { name: "Milestone timeline" });
    await user.click(screen.getByRole("button", { name: "Operations for Build" }));
    await user.click(await screen.findByRole("menuitem", { name: "Edit schedule of Build" }));
    const dialog = await screen.findByRole("dialog", { name: "Schedule of Build" });
    // while the dialog is open Build is deleted elsewhere; the next refetch (after another milestone's save) no longer has it
    view = viewOf({ scheduled: [DISCOVERY], unscheduled: [AUDIT, ROLLOUT] });
    dropMove(DISCOVERY, 1);
    await waitFor(() => expect(schedulePuts(mockFetch)).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Build, / })).toBeNull());
    await waitFor(() => expect(screen.getByRole("grid", { name: "Milestone timeline" })).toHaveAttribute("aria-busy", "false"));
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Schedule of Build" })).toBeNull());
    expect(screen.getByText("This milestone no longer exists — it was removed in the meantime.")).toBeInTheDocument();
    expect(liveText()).toContain("This milestone no longer exists");
    expect(screen.queryByRole("alert")).toBeNull();
    // nothing was sent for the vanished milestone
    expect(schedulePuts(mockFetch)).toHaveLength(1);
    // the notice goes with the next change that is taken
    await user.click(screen.getByRole("button", { name: "Schedule Rollout" }));
    await waitFor(() => expect(schedulePuts(mockFetch)).toHaveLength(2));
    await waitFor(() => expect(screen.queryByText(/no longer exists — it was removed/)).toBeNull());
  });

  test("the schedule dialog sends the revision of the view it was OPENED on, so another manager's move of that milestone is a stale 409", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("grid", { name: "Milestone timeline" });
    await user.click(screen.getByRole("button", { name: "Operations for Discovery" }));
    await user.click(await screen.findByRole("menuitem", { name: "Edit schedule of Discovery" }));
    const dialog = await screen.findByRole("dialog", { name: "Schedule of Discovery" });
    // while it is open the page moves on: another milestone is dropped and its save adopts revision 11
    dropMove(BUILD, 1);
    await waitFor(() => expect(schedulePuts(mockFetch)).toHaveLength(1));
    await waitFor(() => expect(screen.getByRole("grid", { name: "Milestone timeline" })).toHaveAttribute("aria-busy", "false"));
    const end = within(dialog).getByRole("textbox", { name: "End date" });
    await user.clear(end);
    await user.type(end, "2027-01-14");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(schedulePuts(mockFetch)).toHaveLength(2));
    expect(schedulePuts(mockFetch)[1]).toMatchObject({ expectedRevision: 10, startDate: "2027-01-11", endDate: "2027-01-14" });
  });

  describe("a save that settles after the page is gone", () => {
    /** Hold the schedule PUT, drop a bar, unmount: the PUT is in flight with no page left. */
    async function unmountDuringSave() {
      const gate: { settle?: (response: Response) => void } = {};
      const held = new Promise<Response>((resolve) => {
        gate.settle = resolve;
      });
      const base = mockFetch.getMockImplementation() as (url: string, init?: RequestInit) => Promise<Response>;
      mockFetch.mockImplementation((url: string, init?: RequestInit) => (init?.method === "PUT" ? held : base(url, init)));
      const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const { unmount, container } = renderPage(queryClient);
      await screen.findByRole("grid", { name: "Milestone timeline" });
      dropMove(DISCOVERY, 1);
      await waitFor(() => expect(schedulePuts(mockFetch)).toHaveLength(1));
      unmount();
      const cached = () => queryClient.getQueryData<ProjectViewDocument>(["plan", "project", 7]);
      const discovery = (current: ProjectViewDocument | undefined) => current?.scheduled.find((m) => m.id === DISCOVERY.id);
      // the optimistic move is what the cache holds while the save is out
      expect(discovery(cached())).toMatchObject({ startDate: "2027-01-12", endDate: "2027-01-16" });
      const getsBefore = viewGets(mockFetch);
      return { gate, errors, queryClient, cached, discovery, container, getsBefore };
    }

    test("success adopts the answered revision in the cache and renders nothing", async () => {
      const { gate, errors, cached, discovery, container, getsBefore } = await unmountDuringSave();
      gate.settle?.(jsonResponse(200, { revision: 11 }));
      await waitFor(() => expect(cached()?.revision).toBe(11));
      // the saved dates stay (the next visit starts from them), and the closed page is not refetched into life
      expect(discovery(cached())).toMatchObject({ startDate: "2027-01-12", endDate: "2027-01-16" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(viewGets(mockFetch)).toBe(getsBefore);
      expect(container).toBeEmptyDOMElement();
      expect(screen.queryByRole("grid")).toBeNull();
      expect(errors).not.toHaveBeenCalled();
      errors.mockRestore();
    });

    test("a failure rolls the cache back to the view before the drop and renders nothing", async () => {
      const { gate, errors, cached, discovery, container, getsBefore } = await unmountDuringSave();
      gate.settle?.(jsonResponse(500, { title: "x", status: 500 }));
      await waitFor(() => expect(discovery(cached())).toMatchObject({ startDate: "2027-01-11", endDate: "2027-01-15" }));
      expect(cached()?.revision).toBe(10);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(viewGets(mockFetch)).toBe(getsBefore);
      expect(container).toBeEmptyDOMElement();
      expect(screen.queryByRole("grid")).toBeNull();
      expect(errors).not.toHaveBeenCalled();
      errors.mockRestore();
    });
  });

  test("a stale 409 rolls the bar back, says so and reloads the view", async () => {
    putStatus = { status: 409, body: STALE };
    renderPage();
    await screen.findByRole("grid", { name: "Milestone timeline" });
    const before = viewGets(mockFetch);
    dropMove(DISCOVERY, 3);
    expect(await screen.findByText(/moved by someone else in the meantime/)).toBeInTheDocument();
    await waitFor(() => expect(viewGets(mockFetch)).toBeGreaterThan(before));
    await waitFor(() => expect(barOf("Discovery")).toHaveAccessibleName(/2027-01-11 to 2027-01-15/));
    expect(screen.getByRole("grid", { name: "Milestone timeline" })).toHaveAttribute("aria-busy", "false");
  });

  test("a refused span (400) and a 403 surface as inline alerts in words, and the bar rolls back", async () => {
    putStatus = { status: 400 };
    renderPage();
    await screen.findByRole("grid", { name: "Milestone timeline" });
    dropMove(DISCOVERY, 5);
    expect(await screen.findByRole("alert")).toHaveTextContent("a milestone must cover at least one working day");
    await waitFor(() => expect(barOf("Discovery")).toHaveAccessibleName(/2027-01-11 to 2027-01-15/));
    putStatus = { status: 403 };
    await waitFor(() => expect(screen.getByRole("grid", { name: "Milestone timeline" })).toHaveAttribute("aria-busy", "false"));
    dropMove(DISCOVERY, 5);
    expect(await screen.findByText("Only the team's manager or an administrator can schedule this milestone")).toBeInTheDocument();
  });

  test("deleting a milestone confirms by name and DELETEs it", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("grid", { name: "Milestone timeline" });
    await user.click(screen.getByRole("button", { name: "Operations for Build" }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete Build" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete milestone?" });
    expect(dialog).toHaveTextContent('Milestone "Build" will be deleted.');
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(calls(mockFetch, "DELETE", /milestones\/2$/)).toHaveLength(1));
  });

  test("deleting the project states how many milestones go with it, then returns to the plan", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("grid", { name: "Milestone timeline" });
    await user.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete project?" });
    expect(dialog).toHaveTextContent('Project "Invoices" and its 4 milestones will be deleted.');
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(calls(mockFetch, "DELETE", /projects\/7$/)).toHaveLength(1));
    expect(await screen.findByText("The plan")).toBeInTheDocument();
  });

  test("a project without milestones shows the empty state with its next step", async () => {
    view = viewOf({ scheduled: [], unscheduled: [], span: null, drift: null });
    renderPage();
    expect(await screen.findByText("No milestones yet")).toBeInTheDocument();
    expect(screen.getByText("Add the first milestone to plan this project.")).toBeInTheDocument();
    expect(screen.queryByRole("grid")).toBeNull();
  });

  test("the zoom is remembered across visits", async () => {
    const user = userEvent.setup();
    const { unmount } = renderPage();
    await screen.findByRole("grid", { name: "Milestone timeline" });
    await user.click(screen.getByText("Month"));
    expect(JSON.parse(localStorage.getItem("astrolabe.viewSettings.timeline.zoom") ?? "null")).toBe("month");
    unmount();
    renderPage();
    await screen.findByRole("grid", { name: "Milestone timeline" });
    expect(screen.getByRole("radio", { name: "Month" })).toBeChecked();
  });

});

describe("Project view page: rows, rights and edge cases", () => {
  test("a row without any action has no menu, and the grid still walks and keeps exactly one tab stop", async () => {
    const none = { edit: false, delete: false, schedule: false };
    view = viewOf({ scheduled: [{ ...DISCOVERY, can: none }, { ...BUILD, can: none }], unscheduled: [], project: withoutLinking() });
    const user = userEvent.setup();
    renderPage();
    const grid = await screen.findByRole("grid", { name: "Milestone timeline" });
    expect(screen.queryByRole("button", { name: /^Operations for/ })).toBeNull();
    // name -> team -> estimate -> the (menu-less) actions cell, a plain stop -> the bar
    const name = screen.getByRole("rowheader", { name: /^Discovery/ });
    act(() => name.focus());
    await user.keyboard("{ArrowRight}{ArrowRight}{ArrowRight}");
    expect((document.activeElement as HTMLElement).dataset.gridPos).toBe("1,3");
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(screen.getByRole("img", { name: /^Discovery, .*read-only$/ }));
    expect(grid.querySelectorAll('[data-grid-pos][tabindex="0"]')).toHaveLength(1);
  });

  test("when a refetch takes the row menu away from under the tab stop, one tab stop remains", async () => {
    const none = { edit: false, delete: false, schedule: false };
    const user = userEvent.setup();
    renderPage();
    const grid = await screen.findByRole("grid", { name: "Milestone timeline" });
    const menu = screen.getByRole("button", { name: "Operations for Discovery" });
    act(() => menu.focus());
    expect(menu).toHaveAttribute("tabindex", "0");
    // the rights are revoked: the next view has no actions on that row (a drop triggers the refetch)
    view = viewOf({ scheduled: [{ ...DISCOVERY, can: none }, BUILD], project: withoutLinking() });
    dropMove(BUILD, 1);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Operations for Discovery" })).toBeNull());
    const stops = grid.querySelectorAll<HTMLElement>('[data-grid-pos][tabindex="0"]');
    expect(stops).toHaveLength(1);
    // the stop stays where the menu was: the same cell (row 1, the actions column), now a plain stop
    expect(stops[0].dataset.gridPos).toBe("1,3");
    act(() => stops[0].focus());
    expect(document.activeElement).toBe(stops[0]);
    // Tab leaves the grid in one step (it is a single stop), and does not drop focus to the page body
    await user.tab();
    expect(grid.contains(document.activeElement)).toBe(false);
    expect(document.activeElement).not.toBe(document.body);
  });

  test("a non-numeric project id reads as gone, not as a generic failure", async () => {
    renderWithProviders(
      <Routes>
        <Route path="/projects/:id" element={<ProjectView />} />
      </Routes>,
      { route: "/projects/abc" },
    );
    expect(await screen.findByText("This project no longer exists.")).toBeInTheDocument();
    expect(mockFetch).not.toHaveBeenCalledWith(expect.stringContaining("/views/project/"), expect.anything());
  });

  test("an unknown project reads as gone, with the way back", async () => {
    mockFetch.mockImplementation(() => Promise.resolve(jsonResponse(404, { title: "Not found", status: 404 })));
    renderPage();
    expect(await screen.findByText("This project no longer exists.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Project" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to the plan" })).toHaveAttribute("href", "/plan");
  });
});

// ---- dependencies (v0.4) -----------------------------------------------------------------------------------------------

const endpointOf = (m: ProjectMilestone, over: Partial<DependencyEndpoint> = {}): DependencyEndpoint => ({
  kind: "MILESTONE",
  id: m.id,
  name: m.name,
  projectId: m.projectId,
  projectName: "Invoices",
  teamId: m.teamId,
  teamName: m.teamName,
  startDate: m.startDate,
  endDate: m.endDate,
  ...over,
});
/** The ghost end: milestone a1 of project Alpha (99). */
const GHOST = endpointOf(ALPHA_MILESTONE, { projectName: "Alpha" });
/** This project as a whole (the summary row's end): its derived span. */
const WHOLE_PROJECT: DependencyEndpoint = {
  kind: "PROJECT",
  id: 7,
  name: "Invoices",
  projectId: 7,
  projectName: "Invoices",
  teamId: null,
  teamName: null,
  startDate: "2027-01-11",
  endDate: "2027-01-29",
};

const OK_CHECK = { status: "OK", shortfallDays: null, requiredDate: "2027-01-11", actualDate: "2027-01-11" } as const;
const VIOLATED_CHECK = { status: "VIOLATED", shortfallDays: 2, requiredDate: "2027-01-11", actualDate: "2027-01-07" } as const;
const NOT_YET_CHECK = { status: "UNSCHEDULED", shortfallDays: null, requiredDate: null, actualDate: null } as const;

const dependencyOf = (id: number, predecessor: DependencyEndpoint, successor: DependencyEndpoint, over: Partial<ProjectDependency> = {}): ProjectDependency => ({
  id,
  predecessor,
  successor,
  type: "FS",
  lagDays: 0,
  check: OK_CHECK,
  can: { delete: true },
  ...over,
});

/** a1 (Alpha, a ghost) → Discovery violated; Discovery → Build OK; Rollout (the tray) → Build not scheduled yet - the server's order. */
const VIOLATED_LINK = dependencyOf(31, GHOST, endpointOf(DISCOVERY), { check: VIOLATED_CHECK });
const OK_LINK = dependencyOf(32, endpointOf(DISCOVERY), endpointOf(BUILD), { lagDays: 1, check: { ...OK_CHECK, requiredDate: "2027-01-19", actualDate: "2027-01-19" } });
const NOT_YET_LINK = dependencyOf(33, endpointOf(ROLLOUT), endpointOf(BUILD), { type: "SS", lagDays: -2, check: NOT_YET_CHECK });

const arrows = () => Array.from(document.querySelectorAll<SVGPathElement>("[data-arrow]"));
const tableRows = () => within(screen.getByRole("table", { name: "Dependencies of the project" })).getAllByRole("row").slice(1);

describe("Project view page: dependencies", () => {
  test("the Dependencies table is the conflict list - violated first, with what each needs - and the facts say how many conflicts", async () => {
    view = viewOf({ dependencies: [VIOLATED_LINK, OK_LINK, NOT_YET_LINK] });
    renderPage();
    await screen.findByRole("grid", { name: "Milestone timeline" });
    const rows = tableRows();
    expect(rows).toHaveLength(3);
    // violated: red badge naming the shortfall, the ghost end with its project, the type, the lag, what it needs and what it has
    expect(rows[0]).toHaveTextContent("Violated · 2 working days short");
    expect(within(rows[0]).getAllByRole("cell").map((cell) => cell.textContent)).toEqual([
      "Violated · 2 working days short",
      "a1 · Alpha",
      "Finish → Start (FS)",
      "0 working days",
      "Discovery",
      "needs 2027-01-11 · is 2027-01-07",
      "",
    ]);
    expect(rows[1]).toHaveTextContent("OK");
    expect(rows[1]).toHaveTextContent("1 working day");
    expect(rows[2]).toHaveTextContent("Not scheduled yet");
    expect(rows[2]).toHaveTextContent("-2 working days (lead)");
    const facts = screen.getByRole("group", { name: "Project facts" });
    expect(within(facts).getByText("1 conflict")).toBeInTheDocument();
    // the violated bar says so in its name; an unaffected one does not
    expect(barOf("Discovery")).toHaveAccessibleName("Discovery, Backend, 2027-01-11 to 2027-01-15, 12.25 man-days, 1 conflict");
    expect(barOf("Build")).toHaveAccessibleName("Build, Backend, 2027-01-18 to 2027-01-29, 5 man-days");
  });

  test("a project without links shows the empty state, with the hint the caller's rights allow, and no facts badge", async () => {
    renderPage();
    await screen.findByRole("grid", { name: "Milestone timeline" });
    expect(screen.getByRole("heading", { level: 3, name: "Dependencies" })).toBeInTheDocument();
    expect(screen.getByText("No dependencies yet")).toBeInTheDocument();
    expect(screen.getByText("Link a milestone, or the whole project, to the work it waits for.")).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "Dependencies of the project" })).toBeNull();
    expect(screen.getByRole("button", { name: "Add dependency" })).toBeInTheDocument();
    expect(screen.queryByText(/conflict/)).toBeNull();
    expect(arrows()).toHaveLength(0);
  });

  test("a read-only caller sees the links and the conflicts but gets no Add dependency, no menu item and no Delete", async () => {
    view = viewOf({
      dependencies: [{ ...VIOLATED_LINK, can: { delete: false } }],
      project: withoutLinking(),
      scheduled: [{ ...DISCOVERY, can: { edit: false, delete: false, schedule: false } }, BUILD],
    });
    renderPage();
    await screen.findByRole("grid", { name: "Milestone timeline" });
    expect(screen.queryByRole("button", { name: "Add dependency" })).toBeNull();
    expect(tableRows()).toHaveLength(1);
    expect(within(tableRows()[0]).queryByRole("button")).toBeNull();
    expect(screen.queryByRole("button", { name: "Operations for Discovery" })).toBeNull();
    expect(screen.getByText("1 conflict")).toBeInTheDocument();
  });

  test("the empty state of a read-only caller points at the project's owner", async () => {
    view = viewOf({ project: withoutLinking() });
    renderPage();
    await screen.findByRole("grid", { name: "Milestone timeline" });
    expect(screen.getByText("The project's owner adds dependencies.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add dependency" })).toBeNull();
  });

  test("a link to another project's milestone draws a ghost row with a link to that project, and one arrow per drawable link, red when violated", async () => {
    view = viewOf({ dependencies: [VIOLATED_LINK, OK_LINK, NOT_YET_LINK] });
    renderPage();
    const grid = await screen.findByRole("grid", { name: "Milestone timeline" });
    // own rows first, then the ghost: "Alpha › a1" with the link (its accessible name keeps the visible text and says where it goes)
    const link = within(grid).getByRole("link", { name: "Alpha › a1 - open project Alpha" });
    expect(link).toHaveAttribute("href", "/projects/99");
    expect(link).toHaveTextContent("Alpha › a1");
    const ghostBar = within(grid).getByRole("img", { name: /^a1, 2027-01-04 to 2027-01-08, from project Alpha, read-only$/ });
    expect(ghostBar).toHaveAttribute("data-tone", "ghost");
    // the not-scheduled link has no arrow (Rollout is in the tray); the other two do
    expect(arrows().map((arrow) => [arrow.getAttribute("data-arrow"), arrow.getAttribute("data-violated")])).toEqual([
      ["31", "true"],
      ["32", "false"],
    ]);
  });

  test("the summary row appears only while the project itself is an end, with its span as a hollow bar", async () => {
    view = viewOf({ dependencies: [OK_LINK] });
    const { unmount } = renderPage();
    const grid = await screen.findByRole("grid", { name: "Milestone timeline" });
    expect(within(grid).queryByText("(whole project)")).toBeNull();
    unmount();

    view = viewOf({ dependencies: [dependencyOf(34, GHOST, WHOLE_PROJECT, { check: OK_CHECK })] });
    renderPage();
    const withSummary = await screen.findByRole("grid", { name: "Milestone timeline" });
    expect(within(withSummary).getByText("(whole project)")).toBeInTheDocument();
    expect(within(withSummary).getByRole("img", { name: "Invoices, the project's span 2027-01-11 to 2027-01-29, read-only" })).toHaveAttribute("data-tone", "summary");
    expect(arrows()).toHaveLength(1);
  });

  test("an own end that has no row (not in the view's lists) is skipped: no arrow, no crash", async () => {
    const lost = { ...endpointOf(BUILD), id: 999, name: "Lost" };
    view = viewOf({ dependencies: [dependencyOf(35, GHOST, lost), OK_LINK] });
    renderPage();
    await screen.findByRole("grid", { name: "Milestone timeline" });
    expect(arrows().map((arrow) => arrow.getAttribute("data-arrow"))).toEqual(["32"]);
    expect(tableRows()).toHaveLength(2);
  });

  test("Add dependency POSTs the picked link under the project, closes the dialog and refreshes the view", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("grid", { name: "Milestone timeline" });
    onDependencyCreated = () => {
      view = { ...viewOf({ dependencies: [VIOLATED_LINK] }), revision: view.revision + 1 };
    };
    await user.click(screen.getByRole("button", { name: "Add dependency" }));
    const dialog = await screen.findByRole("dialog", { name: "Add dependency" });
    await user.click(within(dialog).getByRole("combobox", { name: "Predecessor" }));
    await user.click(await screen.findByRole("option", { name: "a1 · Alpha" }));
    const before = viewGets(mockFetch);
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls(mockFetch, "POST", /\/projects\/7\/dependencies$/).map((c) => c.body)).toEqual([
      { predecessor: { kind: "MILESTONE", id: 21 }, successor: { kind: "PROJECT", id: 7 }, type: "FS", lagDays: 0 },
    ]);
    // the refreshed view carries the new link: the table row, the badge and the arrow
    await waitFor(() => expect(tableRows()).toHaveLength(1));
    expect(viewGets(mockFetch)).toBeGreaterThan(before);
    expect(screen.getByText("1 conflict")).toBeInTheDocument();
    expect(arrows()).toHaveLength(1);
  });

  test("the milestone row menu's Add dependency… opens the dialog with that milestone as the successor", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("grid", { name: "Milestone timeline" });
    await user.click(screen.getByRole("button", { name: "Operations for Build" }));
    await user.click(await screen.findByRole("menuitem", { name: "Add a dependency to Build" }));
    const dialog = await screen.findByRole("dialog", { name: "Add dependency" });
    expect(within(dialog).getByRole("combobox", { name: "Successor" })).toHaveValue("Build");
  });

  test("a tray milestone can be a successor too", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("grid", { name: "Milestone timeline" });
    await user.click(screen.getByRole("button", { name: "Operations for Rollout" }));
    await user.click(await screen.findByRole("menuitem", { name: "Add a dependency to Rollout" }));
    expect(within(await screen.findByRole("dialog")).getByRole("combobox", { name: "Successor" })).toHaveValue("Rollout");
  });

  test("a cycle 409 shows the notice with the path in the dialog and adds nothing; the duplicate pair says so", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("grid", { name: "Milestone timeline" });
    await user.click(screen.getByRole("button", { name: "Add dependency" }));
    const dialog = await screen.findByRole("dialog", { name: "Add dependency" });
    await user.click(within(dialog).getByRole("combobox", { name: "Predecessor" }));
    await user.click(await screen.findByRole("option", { name: "a1 · Alpha" }));
    dependencyPost = {
      status: 409,
      body: {
        type: "urn:astrolabe:problem:dependency-cycle",
        title: "Conflict",
        status: 409,
        detail: "x",
        cycle: [
          { kind: "PROJECT", id: 7, name: "Invoices" },
          { kind: "MILESTONE", id: 21, name: "a1" },
          { kind: "PROJECT", id: 7, name: "Invoices" },
        ],
      },
    };
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("This link would close a cycle through:");
    expect(alert).toHaveTextContent("Invoices → a1 → Invoices");
    expect(screen.queryByRole("table", { name: "Dependencies of the project" })).toBeNull();
    dependencyPost = { status: 409, body: { title: "Conflict", status: 409, detail: "These two endpoints are already linked" } };
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(within(dialog).getByRole("alert")).toHaveTextContent("These two ends are already linked."));
    expect(screen.getByRole("dialog", { name: "Add dependency" })).toBeInTheDocument();
  });

  test("Delete confirms through the shared dialog, DELETEs the link and refreshes the view", async () => {
    const user = userEvent.setup();
    view = viewOf({ dependencies: [VIOLATED_LINK, OK_LINK] });
    renderPage();
    await screen.findByRole("grid", { name: "Milestone timeline" });
    await user.click(screen.getByRole("button", { name: "Operations for a1 · Alpha → Discovery" }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete a1 · Alpha → Discovery" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete dependency?" });
    expect(dialog).toHaveTextContent("The dependency a1 · Alpha → Discovery (FS) will be deleted. Nothing moves.");
    view = { ...viewOf({ dependencies: [OK_LINK] }), revision: 11 };
    const before = viewGets(mockFetch);
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(tableRows()).toHaveLength(1));
    expect(calls(mockFetch, "DELETE", /\/dependencies\/31$/)).toHaveLength(1);
    expect(viewGets(mockFetch)).toBeGreaterThan(before);
    expect(screen.queryByText(/conflict/)).toBeNull();
    // no ghost row any more: the link to a1 is gone
    expect(screen.queryByRole("link", { name: /open project Alpha$/ })).toBeNull();
  });

  test("two links with the same bare names from different projects have distinct menu and confirm names", async () => {
    const user = userEvent.setup();
    const otherGhost = { ...GHOST, id: 22, projectId: 98, projectName: "Gamma" };
    view = viewOf({ dependencies: [VIOLATED_LINK, dependencyOf(36, otherGhost, endpointOf(DISCOVERY), { check: VIOLATED_CHECK })] });
    renderPage();
    await screen.findByRole("grid", { name: "Milestone timeline" });
    expect(screen.getByRole("button", { name: "Operations for a1 · Alpha → Discovery" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Operations for a1 · Gamma → Discovery" }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete a1 · Gamma → Discovery" }));
    expect(await screen.findByRole("dialog", { name: "Delete dependency?" })).toHaveTextContent("The dependency a1 · Gamma → Discovery (FS)");
  });

  test("a failed Delete says so inside the dialog", async () => {
    const user = userEvent.setup();
    view = viewOf({ dependencies: [VIOLATED_LINK] });
    renderPage();
    await screen.findByRole("grid", { name: "Milestone timeline" });
    mockFetch.mockImplementation((_url: string, init?: RequestInit) =>
      Promise.resolve(init?.method === "DELETE" ? jsonResponse(403, { title: "Forbidden", status: 403 }) : jsonResponse(200, view)),
    );
    await user.click(screen.getByRole("button", { name: "Operations for a1 · Alpha → Discovery" }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete a1 · Alpha → Discovery" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Delete" }));
    expect(await screen.findByText(/Only the owners of the successor's project/)).toBeInTheDocument();
  });

  test("a schedule write refetches the view, so the table, the conflicts badge and the arrow follow the server's new check", async () => {
    view = viewOf({ dependencies: [{ ...VIOLATED_LINK, check: OK_CHECK }] });
    renderPage();
    await screen.findByRole("grid", { name: "Milestone timeline" });
    expect(screen.queryByText(/conflict/)).toBeNull();
    expect(arrows()[0]).toHaveAttribute("data-violated", "false");
    const before = viewGets(mockFetch);
    // The server recomputes the check against the new dates, which the optimistic update cannot do.
    mockFetch.mockImplementation(((impl) => (url: string, init?: RequestInit) => {
      if (init?.method === "PUT" && /\/schedule$/.test(url)) view = { ...view, dependencies: [VIOLATED_LINK] };
      return impl(url, init);
    })(mockFetch.getMockImplementation() as (url: string, init?: RequestInit) => Promise<Response>));
    dropMove(DISCOVERY, -4);
    await waitFor(() => expect(schedulePuts(mockFetch)).toHaveLength(1));
    await waitFor(() => expect(viewGets(mockFetch)).toBeGreaterThan(before));
    expect(await screen.findByText("1 conflict")).toBeInTheDocument();
    expect(tableRows()[0]).toHaveTextContent("Violated · 2 working days short");
    expect(arrows()[0]).toHaveAttribute("data-violated", "true");
  });

  test("deleting a milestone or the project names the links that go with it", async () => {
    const user = userEvent.setup();
    view = viewOf({ dependencies: [VIOLATED_LINK, OK_LINK] });
    renderPage();
    await screen.findByRole("grid", { name: "Milestone timeline" });
    // Discovery is on both links, Build on one
    await user.click(screen.getByRole("button", { name: "Operations for Discovery" }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete Discovery" }));
    expect(await screen.findByRole("dialog", { name: "Delete milestone?" })).toHaveTextContent('Milestone "Discovery" will be deleted. Its 2 dependencies will be deleted too.');
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(await screen.findByRole("dialog", { name: "Delete project?" })).toHaveTextContent(
      'Project "Invoices" and its 4 milestones will be deleted. Its 2 dependencies will be deleted too.',
    );
  });
});
