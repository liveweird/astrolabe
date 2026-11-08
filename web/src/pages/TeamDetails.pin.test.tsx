import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { screen, waitFor, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import TeamDetails from "./TeamDetails";
import type { TeamMilestone, TeamView } from "../api/teams";
import { READ_ONLY_PANEL } from "../test/flow";
import { jsonResponse } from "../test/http";
import { renderWithProviders } from "../test/render";
import { applyPin } from "../utils/pinUpdate";
import { applyTeamSchedule } from "../utils/teamViewUpdate";

// The pin on the team page (1.7): the row menu's Pin / Unpin dates (a scheduled row of a viewer with `can.schedule`), the request, the quiet live-region
// confirmation (no toast), the glyph and the bar's name, the refusals and the failures. The project page's twin is ProjectView.pin.test.tsx.

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
  startDate: "2027-02-01",
  endDate: "2027-02-05",
  createdAt: 1,
  updatedAt: 2,
  projectName: "Invoices",
  programName: "Billing",
  workStreamName: "Platform",
  rankPosition: 1,
  ...over,
});

const viewOf = (can: boolean, over: Partial<TeamView> = {}): TeamView => ({
  jiraSites: [],
  revision: 10,
  team: { id: 1, name: "Payments", description: null, managerPersonId: 12, managerName: "Cara New", createdAt: 1, updatedAt: 2, can: { schedule: can, editCapacity: can, editOrder: can } },
  order: { custom: false, revision: 4, milestoneIds: [] },
  capacity: { periods: [] },
  weeks: [],
  weeksTruncated: false,
  scheduled: [milestone(1, "tv-a"), milestone(2, "tv-b", { startDate: "2027-02-08", endDate: "2027-02-10", pinned: true })],
  unscheduled: [milestone(3, "tv-tray", { startDate: null, endDate: null })],
  dependencies: [],
  idleGaps: [],
  ...over,
});

type FetchMock = ReturnType<typeof vi.fn>;
let view: TeamView;
let pinPut: { status: number; body?: unknown };

describe("the team page's pin", () => {
  let mockFetch: FetchMock;
  beforeEach(() => {
    view = viewOf(true);
    pinPut = { status: 200 };
    mockFetch = vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && url === "/api/v1/views/team/1") return Promise.resolve(jsonResponse(200, view));
      if (method === "GET" && url === "/api/v1/teams/1/flow") return Promise.resolve(jsonResponse(200, READ_ONLY_PANEL));
      if (method === "GET" && url === "/api/v1/public-holidays") return Promise.resolve(jsonResponse(200, { items: [] }));
      const pin = /^\/api\/v1\/milestones\/(\d+)\/pin$/.exec(url);
      if (method === "PUT" && pin) {
        if (pinPut.status !== 200) return Promise.resolve(jsonResponse(pinPut.status, pinPut.body ?? { title: "x", status: pinPut.status }));
        const body = JSON.parse(init?.body as string) as { pinned: boolean };
        view = { ...applyPin(view, Number(pin[1]), body.pinned), revision: view.revision + 1 };
        return Promise.resolve(jsonResponse(200, { revision: view.revision }));
      }
      const schedule = /^\/api\/v1\/milestones\/(\d+)\/schedule$/.exec(url);
      if (method === "PUT" && schedule) {
        const body = JSON.parse(init?.body as string) as { startDate: string | null; endDate: string | null };
        view = { ...applyTeamSchedule(view, Number(schedule[1]), body.startDate, body.endDate), revision: view.revision + 1 };
        return Promise.resolve(jsonResponse(200, { revision: view.revision }));
      }
      // The order PUT is only observed (its body); the view is left as it is.
      if (method === "PUT" && url === "/api/v1/teams/1/milestone-order") return Promise.resolve(jsonResponse(200, { revision: view.revision }));
      return Promise.resolve(jsonResponse(404, { title: "Not Found", status: 404 }));
    });
    vi.stubGlobal("fetch", mockFetch);
    localStorage.setItem("astrolabe.auth.token", "fake-token");
    localStorage.setItem("astrolabe.auth.roles", JSON.stringify(["USER"]));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  const renderPage = () => renderWithProviders(<Routes><Route path="/teams/:id" element={<TeamDetails />} /></Routes>, { route: "/teams/1" });
  const grid = () => screen.findByRole("grid", { name: "Team milestone timeline" });
  const pinPuts = () =>
    mockFetch.mock.calls
      .filter(([url, init]) => /\/pin$/.test(url as string) && (init as RequestInit | undefined)?.method === "PUT")
      .map(([url, init]) => ({ url: url as string, body: JSON.parse((init as RequestInit).body as string) as unknown }));
  const putsTo = (matcher: RegExp) =>
    mockFetch.mock.calls
      .filter(([url, init]) => matcher.test(url as string) && (init as RequestInit | undefined)?.method === "PUT")
      .map(([, init]) => JSON.parse((init as RequestInit).body as string) as Record<string, unknown>);
  const viewGets = () => mockFetch.mock.calls.filter(([url, init]) => url === "/api/v1/views/team/1" && ((init as RequestInit | undefined)?.method ?? "GET") === "GET").length;
  const live = () => screen.getAllByRole("status").map((region) => region.textContent).join(" | ");
  const rowOf = (name: string) => within(screen.getByRole("grid", { name: "Team milestone timeline" })).getAllByRole("row").find((row) => row.textContent?.includes(name)) as HTMLElement;
  const openMenu = async (user: ReturnType<typeof userEvent.setup>, name: string) => user.click(screen.getByRole("button", { name: `Operations for ${name}` }));

  test("a pinned row shows the glyph with a hidden 'pinned' and says so in its bar's name; an unpinned row neither", async () => {
    renderPage();
    await grid();
    expect(within(rowOf("tv-b")).getByText("pinned")).toBeInTheDocument();
    expect(rowOf("tv-b").querySelector("svg.tabler-icon-pin")).toHaveAttribute("aria-hidden", "true");
    expect(within(rowOf("tv-b")).getByRole("button", { name: /^tv-b, Invoices, 2027-02-08 to 2027-02-10, 10 man-days, pinned$/ })).toBeInTheDocument();
    expect(within(rowOf("tv-a")).queryByText("pinned")).toBeNull();
    expect(within(rowOf("tv-a")).getByRole("button", { name: /^tv-a, Invoices, 2027-02-01 to 2027-02-05, 10 man-days$/ })).toBeInTheDocument();
  });

  test("Pin dates sends exactly {pinned: true}, shows the glyph at once, says it in the live region (no toast) and refreshes the view", async () => {
    const user = userEvent.setup();
    renderPage();
    await grid();
    const before = viewGets();
    await openMenu(user, "tv-a");
    await user.click(await screen.findByRole("menuitem", { name: "Pin dates of tv-a" }));
    expect(pinPuts()).toEqual([{ url: "/api/v1/milestones/1/pin", body: { pinned: true } }]);
    await waitFor(() => expect(within(rowOf("tv-a")).getByText("pinned")).toBeInTheDocument());
    expect(live()).toContain("tv-a pinned");
    await waitFor(() => expect(viewGets()).toBeGreaterThan(before));
    expect(document.querySelector(".mantine-Notification-root")).toBeNull();
    // The menu now offers the opposite action.
    await openMenu(user, "tv-a");
    expect(await screen.findByRole("menuitem", { name: "Unpin dates of tv-a" })).toBeInTheDocument();
  });

  test("Unpin dates on a pinned row sends {pinned: false} and removes the glyph", async () => {
    const user = userEvent.setup();
    renderPage();
    await grid();
    await openMenu(user, "tv-b");
    expect(screen.queryByRole("menuitem", { name: "Pin dates of tv-b" })).toBeNull();
    await user.click(await screen.findByRole("menuitem", { name: "Unpin dates of tv-b" }));
    expect(pinPuts()).toEqual([{ url: "/api/v1/milestones/2/pin", body: { pinned: false } }]);
    await waitFor(() => expect(within(rowOf("tv-b")).queryByText("pinned")).toBeNull());
    expect(live()).toContain("tv-b unpinned");
  });

  test("a viewer without can.schedule has no pin item (the glyph still shows); a tray row has none either", async () => {
    view = viewOf(false);
    const user = userEvent.setup();
    renderPage();
    await grid();
    expect(within(rowOf("tv-b")).getByText("pinned")).toBeInTheDocument();
    await openMenu(user, "tv-b");
    expect(screen.queryByRole("menuitem", { name: /pin dates/i })).toBeNull();
  });

  test("a manager's tray row offers no pin (an unscheduled milestone cannot be pinned)", async () => {
    const user = userEvent.setup();
    renderPage();
    await grid();
    await openMenu(user, "tv-tray");
    expect(await screen.findByRole("menuitem", { name: "Edit schedule of tv-tray" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /pin dates/i })).toBeNull();
  });

  test("a 409 (the milestone lost its dates meanwhile) rolls the glyph back and says so inline", async () => {
    pinPut = { status: 409, body: { type: "urn:astrolabe:problem:milestone-unscheduled", title: "Conflict", status: 409, detail: "unscheduled" } };
    const user = userEvent.setup();
    renderPage();
    await grid();
    await openMenu(user, "tv-a");
    await user.click(await screen.findByRole("menuitem", { name: "Pin dates of tv-a" }));
    expect(await screen.findByText(/has no dates any more, so its dates cannot be pinned/)).toBeInTheDocument();
    await waitFor(() => expect(within(rowOf("tv-a")).queryByText("pinned")).toBeNull());
  });

  test("a 403 reads the schedule's forbidden sentence", async () => {
    pinPut = { status: 403 };
    const user = userEvent.setup();
    renderPage();
    await grid();
    await openMenu(user, "tv-a");
    await user.click(await screen.findByRole("menuitem", { name: "Pin dates of tv-a" }));
    expect(await screen.findByText("Only the team's manager or an administrator can schedule this milestone")).toBeInTheDocument();
    await waitFor(() => expect(within(rowOf("tv-a")).queryByText("pinned")).toBeNull());
  });

  test("a pin made while another write is in flight is refused out loud (the page's one-write rule), not lost silently", async () => {
    const held: ((response: Response) => void)[] = [];
    const original = mockFetch.getMockImplementation() as (url: string, init?: RequestInit) => Promise<Response>;
    mockFetch.mockImplementation((url: string, init?: RequestInit) =>
      url === "/api/v1/milestones/1/pin" && init?.method === "PUT" ? new Promise<Response>((resolve) => held.push(resolve)) : original(url, init),
    );
    const user = userEvent.setup();
    renderPage();
    await grid();
    await openMenu(user, "tv-a");
    await user.click(await screen.findByRole("menuitem", { name: "Pin dates of tv-a" }));
    await openMenu(user, "tv-b");
    await user.click(await screen.findByRole("menuitem", { name: "Unpin dates of tv-b" }));
    expect(await screen.findByRole("note")).toHaveTextContent("A save is still running — try your change again in a moment.");
    expect(pinPuts().map((c) => c.url)).toEqual(["/api/v1/milestones/1/pin"]);
    expect(live()).toContain("A save is still running");
    // Let the held save finish and its refresh land before the test (and its fetch stub) ends.
    const before = viewGets();
    held.forEach((release) => release(jsonResponse(200, { revision: 11 })));
    await waitFor(() => expect(viewGets()).toBeGreaterThan(before));
  });

  test("a 500 rolls the optimistic glyph back and shows the generic failure inline (no toast)", async () => {
    pinPut = { status: 500 };
    const user = userEvent.setup();
    renderPage();
    await grid();
    await openMenu(user, "tv-a");
    await user.click(await screen.findByRole("menuitem", { name: "Pin dates of tv-a" }));
    expect(await screen.findByText("Save failed (500)")).toBeInTheDocument();
    await waitFor(() => expect(within(rowOf("tv-a")).queryByText("pinned")).toBeNull());
    expect(document.querySelector(".mantine-Notification-root")).toBeNull();
  });

  test("a failed pin's message goes away with the next taken schedule change (Unschedule)", async () => {
    pinPut = { status: 409, body: { type: "urn:astrolabe:problem:milestone-unscheduled", title: "Conflict", status: 409, detail: "unscheduled" } };
    const user = userEvent.setup();
    renderPage();
    await grid();
    await openMenu(user, "tv-a");
    await user.click(await screen.findByRole("menuitem", { name: "Pin dates of tv-a" }));
    expect(await screen.findByText(/has no dates any more, so its dates cannot be pinned/)).toBeInTheDocument();
    await waitFor(() => expect(within(rowOf("tv-a")).queryByText("pinned")).toBeNull());
    await openMenu(user, "tv-a");
    await user.click(await screen.findByRole("menuitem", { name: "Unschedule tv-a" }));
    await waitFor(() => expect(putsTo(/\/schedule$/)).toHaveLength(1));
    await waitFor(() => expect(screen.queryByText(/has no dates any more, so its dates cannot be pinned/)).toBeNull());
  });

  test("a pin stores the plan revision it answers and leaves the team's order revision alone: the next schedule PUT carries the former, the next order PUT the latter", async () => {
    const user = userEvent.setup();
    renderPage();
    await grid();
    const before = viewGets();
    await openMenu(user, "tv-a");
    await user.click(await screen.findByRole("menuitem", { name: "Pin dates of tv-a" }));
    await waitFor(() => expect(viewGets()).toBeGreaterThan(before));
    // The view's plan revision was 10; the pin answered 11, and the schedule PUT sends the plan revision, never the order's (4).
    await user.click(screen.getByRole("button", { name: "Schedule tv-tray" }));
    await waitFor(() => expect(putsTo(/\/schedule$/)).toHaveLength(1));
    expect(putsTo(/\/schedule$/)[0]).toMatchObject({ expectedRevision: 11 });
    await waitFor(() => expect(within(screen.getByRole("grid", { name: "Team milestone timeline" })).getAllByRole("row").some((row) => row.textContent?.includes("tv-tray"))).toBe(true));
    await waitFor(() => expect(screen.getByRole("grid", { name: "Team milestone timeline" })).toHaveAttribute("aria-busy", "false"));
    // The order PUT sends the TEAM's order revision, untouched by the pin and the schedule change.
    await openMenu(user, "tv-a");
    await user.click(await screen.findByRole("menuitem", { name: "Move down tv-a" }));
    await waitFor(() => expect(putsTo(/milestone-order$/)).toHaveLength(1));
    expect(putsTo(/milestone-order$/)[0]).toMatchObject({ expectedRevision: 4 });
  });
});
