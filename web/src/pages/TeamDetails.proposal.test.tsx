import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import { Route, Routes } from "react-router-dom";
import TeamDetails from "./TeamDetails";
import type { ScheduleProposal, ScheduleProposalEnd, ScheduleProposalLink, ScheduleProposalMove, TeamMilestone, TeamView, WeekLoad } from "../api/teams";
import { READ_ONLY_PANEL } from "../test/flow";
import { headingOutline } from "../test/headings";
import { jsonResponse } from "../test/http";
import { renderWithProviders } from "../test/render";
import { localIsoDate } from "../utils/isoDate";

// The schedule proposal on the team page: the button, the preview mode on the timeline (read-only, second bars, appended rows, the
// proposed load), the notes, and (C5) the Proposed schedule section - accept selected, the outcome and stale notes, Discard.

const TOKEN_KEY = "astrolabe.auth.token";
const ROLES_KEY = "astrolabe.auth.roles";

type FetchMock = ReturnType<typeof vi.fn>;

const CHECK_URL = "/api/v1/schedule-proposals/check";

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
  estimateMd: 4,
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

const PA = milestone(1, "tp-a", { startDate: "2027-02-01", endDate: "2027-02-05" });
const PB = milestone(2, "tp-b", { startDate: "2027-02-08", endDate: "2027-02-10" });
const TRAYED = milestone(3, "tp-tray");

const week = (weekStart: string, load: number): WeekLoad => ({ weekStart, load, capacity: 10, overloaded: false, overloadMd: null, maxWip: 1, wipExceeded: false });

const viewOf = (over: Partial<TeamView> = {}): TeamView => ({
  jiraSites: [],
  revision: 10,
  team: {
    id: 1,
    name: "Payments",
    description: null,
    managerPersonId: 12,
    managerName: "Cara New",
    createdAt: 1,
    updatedAt: 2,
    can: { schedule: true, editCapacity: true, editOrder: true },
  },
  order: { custom: true, revision: 4, milestoneIds: [1, 2] },
  capacity: {
    periods: [
      {
        id: 11,
        teamId: 1,
        effectiveFrom: "2027-02-03",
        mdPerWeek: 8,
        wipLimit: 1,
        createdAt: 1,
        updatedAt: 2,
        source: "MANUAL",
        flowSprintName: null,
      },
    ],
  },
  weeks: [week("2027-02-01", 8.5)],
  weeksTruncated: false,
  scheduled: [PA, PB],
  unscheduled: [TRAYED],
  dependencies: [],
  idleGaps: [{ start: "2027-02-11", end: "2027-02-17", workingDays: 5 }],
  ...over,
});

const move = (milestoneId: number, name: string, over: Partial<ScheduleProposalMove> = {}): ScheduleProposalMove => ({
  milestoneId,
  name,
  projectId: 7,
  projectName: "Invoices",
  estimateMd: 4,
  from: null,
  to: { start: "2027-06-07", end: "2027-06-10" },
  workingDays: 4,
  shiftDays: null,
  ...over,
});

const proposalOf = (over: Partial<ScheduleProposal> = {}): ScheduleProposal => ({
  revision: 10,
  scopeHash: "a".repeat(64),
  asOf: localIsoDate(),
  teamId: 1,
  moves: [
    move(2, "tp-b", { from: { start: "2027-02-08", end: "2027-02-10" }, to: { start: "2027-06-14", end: "2027-06-16" }, workingDays: 3, shiftDays: 90 }),
    move(3, "tp-tray"),
  ],
  unchanged: [1],
  unplaced: [],
  pinned: [],
  weeks: [week("2027-06-07", 9)],
  weeksTruncated: false,
  dependencies: [],
  ...over,
});

let view: TeamView;
let proposalAnswer: Response | (() => Response | Promise<Response>);
let batchAnswer: Response | (() => Response | Promise<Response>);
let checkAnswer: Response | (() => Response | Promise<Response>);
let mockFetch: FetchMock;

function serve() {
  mockFetch.mockImplementation((url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "GET" && url === "/api/v1/views/team/1") return Promise.resolve(jsonResponse(200, view));
    if (method === "GET" && url === "/api/v1/teams/1/flow") return Promise.resolve(jsonResponse(200, READ_ONLY_PANEL));
    if (method === "GET" && url === "/api/v1/public-holidays") return Promise.resolve(jsonResponse(200, { items: [] }));
    if (method === "POST" && url === "/api/v1/teams/1/schedule-proposal") return Promise.resolve(typeof proposalAnswer === "function" ? proposalAnswer() : proposalAnswer.clone());
    if (method === "POST" && url === CHECK_URL) return Promise.resolve(typeof checkAnswer === "function" ? checkAnswer() : checkAnswer.clone());
    if (method === "POST" && url === "/api/v1/teams/1/milestone-schedules") return Promise.resolve(typeof batchAnswer === "function" ? batchAnswer() : batchAnswer.clone());
    return Promise.resolve(jsonResponse(404, { title: "Not Found", status: 404 }));
  });
}

const batchPosts = () =>
  mockFetch.mock.calls.filter(([url, init]) => url === "/api/v1/teams/1/milestone-schedules" && (init as RequestInit).method === "POST").map(([, init]) => JSON.parse((init as RequestInit).body as string));

const proposalPosts = () =>
  mockFetch.mock.calls.filter(([url, init]) => url === "/api/v1/teams/1/schedule-proposal" && (init as RequestInit).method === "POST").map(([, init]) => JSON.parse((init as RequestInit).body as string));

function renderPage(queryClient?: QueryClient) {
  return renderWithProviders(
    <Routes>
      <Route path="/teams/:id" element={<TeamDetails />} />
    </Routes>,
    { route: "/teams/1", queryClient },
  );
}

/** A proposal answer the test releases by hand: the request window stays open until `release` is called. */
function heldProposal() {
  let release: ((response: Response) => void) | null = null;
  proposalAnswer = () =>
    new Promise<Response>((resolve) => {
      release = resolve;
    });
  return async (response: Response) => {
    await waitFor(() => expect(release).not.toBeNull());
    await act(async () => release?.(response));
  };
}

const putCalls = () => mockFetch.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "PUT");

const grid = () => screen.getByRole("grid", { name: "Team milestone timeline" });
const proposeButton = () => screen.queryByRole("button", { name: "Propose schedule" });
const proposalBars = () => [...document.querySelectorAll('[data-tone="proposal"]')];
const liveText = () => screen.getAllByRole("status").map((region) => region.textContent).join(" | ");

async function openPreview(user: ReturnType<typeof userEvent.setup>) {
  renderPage();
  await screen.findByRole("grid", { name: "Team milestone timeline" });
  await user.click(screen.getByRole("button", { name: "Propose schedule" }));
  await screen.findByRole("button", { name: "Discard" });
}

beforeEach(() => {
  view = viewOf();
  proposalAnswer = jsonResponse(200, proposalOf());
  batchAnswer = jsonResponse(200, { revision: 11, accepted: [2, 3], skipped: [] });
  checkAnswer = jsonResponse(200, { teams: [{ teamId: 1, weeks: [week("2027-06-14", 3)], weeksTruncated: false, dependencies: [] }] });
  mockFetch = vi.fn();
  vi.stubGlobal("fetch", mockFetch);
  localStorage.setItem(TOKEN_KEY, "fake-token");
  localStorage.setItem(ROLES_KEY, JSON.stringify(["ADMIN"]));
  serve();
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("the Propose schedule button", () => {
  test("is offered with team.can.schedule and at least one milestone", async () => {
    renderPage();
    await screen.findByRole("grid", { name: "Team milestone timeline" });
    expect(proposeButton()).toBeEnabled();
  });

  test("is absent without team.can.schedule, even for an ADMIN session (the view's flag is the rule)", async () => {
    view = viewOf({ team: { ...viewOf().team, can: { schedule: false, editCapacity: false, editOrder: false } } });
    renderPage();
    await screen.findByRole("grid", { name: "Team milestone timeline" });
    expect(proposeButton()).toBeNull();
  });

  test("is absent while the team has no milestones", async () => {
    view = viewOf({ scheduled: [], unscheduled: [] });
    renderPage();
    await screen.findByText("This team has no milestones yet");
    expect(proposeButton()).toBeNull();
  });

  test("POSTs the viewer's local calendar day and opens the preview", async () => {
    const user = userEvent.setup();
    await openPreview(user);
    expect(proposalPosts()).toEqual([{ asOf: localIsoDate() }]);
    expect(proposeButton()).toBeDisabled();
    await waitFor(() => expect(liveText()).toContain("Proposed schedule ready: 2 moves"));
  });
});

describe("the preview", () => {
  test("proposal bars beside the current ones, rows appended for the tray's milestones, the proposed load in the strip, no idle bands", async () => {
    const user = userEvent.setup();
    await openPreview(user);
    expect(proposalBars()).toHaveLength(2);
    expect(screen.getByRole("img", { name: "Proposed: tp-b, 2027-06-14 to 2027-06-16, read-only" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Proposed: tp-tray, 2027-06-07 to 2027-06-10, read-only" })).toBeInTheDocument();
    const rows = within(grid()).getAllByRole("row").slice(1);
    expect(rows.map((row) => /tp-[a-z]+/.exec(row.textContent ?? "")?.[0])).toEqual(["tp-a", "tp-b", "tp-tray"]);
    expect(within(rows[2]).getByText("(new)")).toBeInTheDocument();
    expect(screen.getByText("Proposed load")).toBeInTheDocument();
    // only the section heading is left: the strip's own caption "Weekly load" gave way to "Proposed load"
    expect(screen.getAllByText("Weekly load")).toHaveLength(1);
    expect(document.querySelectorAll("[data-band-tone]")).toHaveLength(0);
    // the strip shows the proposal's weeks; that week lies far past the current schedule, so the range grew over the proposed spans
    expect(document.querySelector('[data-week="2027-06-07"]')).not.toBeNull();
    expect(document.querySelector('[data-week="2027-02-01"]')).toBeNull();
    expect(screen.getByText("2 moves · 1 newly scheduled · 1 stays · 0 could not be placed")).toBeInTheDocument();
  });

  test("the page is read-only: bars without handles, no row menu schedule or order items, tray Schedule disabled, no Reset order, no capacity edits", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("grid", { name: "Team milestone timeline" });
    // before: all of it is there
    expect(screen.getByRole("button", { name: "Reset order" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Add period" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^Resize start/ })).toHaveLength(2);
    expect(document.querySelectorAll("[data-row-handle]")).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "Propose schedule" }));
    await screen.findByRole("button", { name: "Discard" });
    // after: none of it
    expect(screen.queryByRole("button", { name: "Reset order" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add period" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Resize/ })).toBeNull();
    expect(document.querySelector("[data-row-handle]")).toBeNull();
    expect(screen.getByRole("button", { name: "Schedule tp-tray" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Operations for tp-a" }));
    expect(screen.getByRole("menuitem", { name: "Open project Invoices" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /^Edit schedule/ })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: /^Move/ })).toBeNull();
    // the capacity table itself stays readable
    expect(screen.getByRole("table", { name: "Capacity periods of the team" })).toBeInTheDocument();
  });

  test("Discard closes the preview without a request and brings the page back as it was", async () => {
    const user = userEvent.setup();
    await openPreview(user);
    const before = mockFetch.mock.calls.length;
    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(proposalBars()).toHaveLength(0);
    expect(screen.getAllByText("Weekly load")).toHaveLength(2);
    expect(screen.queryByText("Proposed load")).toBeNull();
    expect(screen.queryByText("(new)")).toBeNull();
    expect(screen.getByRole("button", { name: "Propose schedule" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Reset order" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^Resize start/ })).toHaveLength(2);
    expect(mockFetch.mock.calls.slice(before).filter(([, init]) => (init as RequestInit | undefined)?.method === "POST")).toEqual([]);
    expect(document.querySelectorAll('[data-band-tone="idle"]')).toHaveLength(1);
  });

  test("a proposal that leaves milestones unplaced still opens, and says how many in the line", async () => {
    proposalAnswer = jsonResponse(
      200,
      proposalOf({ moves: [], unchanged: [], unplaced: [{ milestoneId: 3, name: "tp-tray", projectId: 7, projectName: "Invoices", reason: "NO_ROOM" }] }),
    );
    const user = userEvent.setup();
    await openPreview(user);
    expect(screen.getByText("0 moves · 0 newly scheduled · 0 stay · 1 could not be placed")).toBeInTheDocument();
    expect(screen.getByText("no room within the 520-week horizon")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Accept selected (0)" })).toBeDisabled();
    expect(proposalBars()).toHaveLength(0);
  });
});

describe("a proposal that opens nothing", () => {
  test("nothing to propose: a dismissible note, said in the status region; no preview", async () => {
    proposalAnswer = jsonResponse(200, proposalOf({ moves: [], unchanged: [1, 2], unplaced: [], weeks: [] }));
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("grid", { name: "Team milestone timeline" });
    await user.click(screen.getByRole("button", { name: "Propose schedule" }));
    const note = await screen.findByRole("note");
    expect(note).toHaveTextContent("Nothing to propose: every milestone has started or stays where it is.");
    expect(liveText()).toContain("Nothing to propose");
    expect(screen.queryByRole("button", { name: "Discard" })).toBeNull();
    expect(proposalBars()).toHaveLength(0);
    expect(proposeButton()).toBeEnabled();
    await user.click(within(note).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("note")).toBeNull();
  });

  test("no capacity: the note names the day and asks for a capacity period first", async () => {
    proposalAnswer = jsonResponse(
      200,
      proposalOf({
        asOf: "2027-01-31",
        moves: [],
        unchanged: [],
        unplaced: [{ milestoneId: 3, name: "tp-tray", projectId: 7, projectName: "Invoices", reason: "NO_CAPACITY" }],
        weeks: [],
      }),
    );
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("grid", { name: "Team milestone timeline" });
    await user.click(screen.getByRole("button", { name: "Propose schedule" }));
    expect(await screen.findByRole("note")).toHaveTextContent("Nothing could be placed: the team has no capacity after 2027-01-31 — add a capacity period first.");
    expect(screen.queryByRole("button", { name: "Discard" })).toBeNull();
  });

  test("a refused request reads in words, inline, and opens nothing; a new request clears it", async () => {
    proposalAnswer = () => jsonResponse(403, { title: "Forbidden", status: 403 });
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("grid", { name: "Team milestone timeline" });
    await user.click(screen.getByRole("button", { name: "Propose schedule" }));
    expect(await screen.findByText("Only the team's manager or an administrator can propose a schedule")).toBeInTheDocument();
    expect(proposalBars()).toHaveLength(0);
    proposalAnswer = jsonResponse(200, proposalOf());
    await user.click(screen.getByRole("button", { name: "Propose schedule" }));
    await screen.findByRole("button", { name: "Discard" });
    expect(screen.queryByText("Only the team's manager or an administrator can propose a schedule")).toBeNull();
  });
});

describe("a weekend asOf", () => {
  test("the no-capacity note names the request's own day, not the next one", async () => {
    // 2027-01-30 is a Saturday
    proposalAnswer = jsonResponse(
      200,
      proposalOf({
        asOf: "2027-01-30",
        moves: [],
        unchanged: [],
        unplaced: [{ milestoneId: 3, name: "tp-tray", projectId: 7, projectName: "Invoices", reason: "NO_CAPACITY" }],
        weeks: [],
      }),
    );
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("grid", { name: "Team milestone timeline" });
    await user.click(screen.getByRole("button", { name: "Propose schedule" }));
    expect(await screen.findByRole("note")).toHaveTextContent("the team has no capacity after 2027-01-30 \u2014 add a capacity period first.");
  });
});

describe("read-only while a proposal is requested or open", () => {
  test("a tray Schedule and the row menu's items during the request window are refused out loud, with no PUT", async () => {
    const release = heldProposal();
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("grid", { name: "Team milestone timeline" });
    await user.click(screen.getByRole("button", { name: "Propose schedule" }));
    expect(screen.getByRole("button", { name: "Propose schedule" })).toBeDisabled();
    // the tray's button is not disabled yet (nothing is open), but it refuses
    await user.click(screen.getByRole("button", { name: "Schedule tp-tray" }));
    expect(screen.getAllByRole("note").map((n) => n.textContent)).toContain("A save is still running \u2014 try your change again in a moment.");
    expect(liveText()).toContain("try your change again in a moment");
    await user.click(screen.getByRole("button", { name: "Operations for tp-a" }));
    await user.click(screen.getByRole("menuitem", { name: /^Edit schedule/ }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(putCalls()).toEqual([]);
    await release(jsonResponse(200, proposalOf()));
    await screen.findByRole("button", { name: "Discard" });
    // the refusal note now says why in words
    expect(screen.getAllByRole("note").map((n) => n.textContent).join("|")).toContain("A proposal is open, so the schedule is read-only");
    expect(putCalls()).toEqual([]);
  });

  test("a schedule dialog that is open when the proposal resolves is gone, stays gone after Discard, and nothing can be written", async () => {
    const release = heldProposal();
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("grid", { name: "Team milestone timeline" });
    await user.click(screen.getByRole("button", { name: "Operations for tp-a" }));
    await user.click(screen.getByRole("menuitem", { name: /^Edit schedule/ }));
    await screen.findByRole("dialog");
    // the page behind the modal is inert for the user; the click is fed straight to the button
    fireEvent.click(screen.getByRole("button", { name: "Propose schedule", hidden: true }));
    await release(jsonResponse(200, proposalOf()));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await user.click(await screen.findByRole("button", { name: "Discard" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(putCalls()).toEqual([]);
  });

  test("an open Reset-order confirm is closed the same way and does not come back", async () => {
    const release = heldProposal();
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("grid", { name: "Team milestone timeline" });
    await user.click(screen.getByRole("button", { name: "Reset order" }));
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Propose schedule", hidden: true }));
    await release(jsonResponse(200, proposalOf()));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await user.click(await screen.findByRole("button", { name: "Discard" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(putCalls()).toEqual([]);
  });

  test("an open capacity editor is closed when a proposal is requested and does not come back", async () => {
    const release = heldProposal();
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("grid", { name: "Team milestone timeline" });
    await user.click(screen.getByRole("button", { name: "Add period" }));
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Propose schedule", hidden: true }));
    await release(jsonResponse(200, proposalOf()));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await user.click(await screen.findByRole("button", { name: "Discard" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("with no capacity period the hint to add one is hidden while previewing and back after Discard", async () => {
    view = viewOf({ capacity: { periods: [] } });
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("grid", { name: "Team milestone timeline" });
    expect(screen.getByText(/Add a period to compare/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Propose schedule" }));
    await screen.findByRole("button", { name: "Discard" });
    expect(screen.queryByText(/Add a period to compare/)).toBeNull();
    expect(screen.getByText("No capacity set")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.getByText(/Add a period to compare/)).toBeInTheDocument();
  });

  test("the row appended for a tray milestone has a kebab named apart from the tray row's", async () => {
    const user = userEvent.setup();
    await openPreview(user);
    expect(screen.getAllByRole("button", { name: "Operations for tp-tray" })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Operations for tp-tray (proposed row)" })).toBeInTheDocument();
  });
});

describe("focus", () => {
  test("opening a proposal moves the focus to Discard and discarding gives it back to Propose", async () => {
    const user = userEvent.setup();
    await openPreview(user);
    await waitFor(() => expect(screen.getByRole("button", { name: "Discard" })).toHaveFocus());
    await user.click(screen.getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Propose schedule" })).toHaveFocus());
  });
});

describe("a refetch under an open proposal", () => {
  test("a plan refetch (another tab's write) does not discard it: the bars stay and the view is re-read", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const user = userEvent.setup();
    renderPage(client);
    await screen.findByRole("grid", { name: "Team milestone timeline" });
    await user.click(screen.getByRole("button", { name: "Propose schedule" }));
    await screen.findByRole("button", { name: "Discard" });
    const reads = () => mockFetch.mock.calls.filter(([url, init]) => url === "/api/v1/views/team/1" && ((init as RequestInit | undefined)?.method ?? "GET") === "GET").length;
    const before = reads();
    view = viewOf({ revision: 11 });
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["plan"] });
    });
    expect(reads()).toBeGreaterThan(before);
    expect(proposalBars()).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Discard" })).toBeInTheDocument();
  });
});

describe("the Proposed schedule section", () => {
  const table = () => screen.getByRole("table", { name: "Proposed schedule moves" });
  const acceptButton = (count: number) => screen.getByRole("button", { name: `Accept selected (${count})` });

  test("an h3 right under the timeline, before the Unscheduled tray; absent without a proposal", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("grid", { name: "Team milestone timeline" });
    expect(headingOutline().map(([, text]) => text)).not.toContain("Proposed schedule");
    await user.click(screen.getByRole("button", { name: "Propose schedule" }));
    await screen.findByRole("table", { name: "Proposed schedule moves" });
    expect(headingOutline()).toEqual([
      [2, "Payments"],
      [3, "Timeline"],
      [3, "Proposed schedule"],
      [3, "Unscheduled"],
      [3, "Capacity"],
      [3, "Flow"],
      [3, "Weekly load"],
      [3, "Idle gaps"],
    ]);
    const rows = within(table()).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText("2027-06-14 to 2027-06-16")).toBeInTheDocument();
    expect(within(rows[0]).getByText("90 working days later")).toBeInTheDocument();
    expect(within(rows[1]).getByText("Unscheduled → 2027-06-07 to 2027-06-10, 4 working days")).toBeInTheDocument();
  });

  test("Accept selected sends exactly the selected moves with the proposal's revision, then the outcome note replaces the section", async () => {
    batchAnswer = jsonResponse(200, { revision: 11, accepted: [2], skipped: [] });
    const user = userEvent.setup();
    await openPreview(user);
    await user.click(screen.getByRole("checkbox", { name: "Accept tp-tray" }));
    expect(acceptButton(1)).toBeEnabled();
    await user.click(acceptButton(1));
    await waitFor(() => expect(screen.queryByRole("table", { name: "Proposed schedule moves" })).toBeNull());
    expect(batchPosts()).toEqual([
      { expectedRevision: 10, scopeHash: "a".repeat(64), items: [{ milestoneId: 2, startDate: "2027-06-14", endDate: "2027-06-16" }] },
    ]);
    expect(screen.getByRole("note")).toHaveTextContent("1 scheduled");
    expect(liveText()).toContain("1 scheduled");
    expect(proposalBars()).toHaveLength(0);
    // the focus is back on Propose once the write is over
    await waitFor(() => expect(screen.getByRole("button", { name: "Propose schedule" })).toHaveFocus());
    // the note lasts until the next action
    await user.click(screen.getByRole("button", { name: "Propose schedule" }));
    await screen.findByRole("table", { name: "Proposed schedule moves" });
    expect(screen.queryByText("1 scheduled")).toBeNull();
  });

  test("a skipped milestone is named in the outcome note, with the server's reason in words", async () => {
    batchAnswer = jsonResponse(200, { revision: 11, accepted: [2], skipped: [{ milestoneId: 3, reason: "STALE" }] });
    const user = userEvent.setup();
    await openPreview(user);
    await user.click(acceptButton(2));
    const note = await screen.findByRole("note");
    expect(note).toHaveTextContent("1 scheduled · 1 skipped: rescheduled in the meantime");
    expect(batchPosts()[0].items).toHaveLength(2);
    await user.click(within(note).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("note")).toBeNull();
  });

  test("a whole-batch stale refusal closes the preview, says so in a note and reloads the view", async () => {
    batchAnswer = jsonResponse(409, { type: "urn:astrolabe:problem:stale-revision", title: "Conflict", status: 409, detail: "stale" });
    const user = userEvent.setup();
    await openPreview(user);
    const reads = () => mockFetch.mock.calls.filter(([url]) => url === "/api/v1/views/team/1").length;
    const before = reads();
    await user.click(acceptButton(2));
    const note = await screen.findByRole("note");
    expect(note).toHaveTextContent("The plan changed in the meantime");
    expect(screen.queryByRole("table", { name: "Proposed schedule moves" })).toBeNull();
    expect(liveText()).toContain("The plan changed in the meantime");
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
    await waitFor(() => expect(screen.getByRole("button", { name: "Propose schedule" })).toBeEnabled());
  });

  test("a stale-scope refusal swaps in a fresh preview with the ticks kept, an orange note, and the focus on Discard", async () => {
    batchAnswer = jsonResponse(409, { type: "urn:astrolabe:problem:stale-scope", title: "Conflict", status: 409, detail: "scope" });
    const user = userEvent.setup();
    await openPreview(user);
    await user.click(screen.getByRole("checkbox", { name: "Accept tp-tray" }));
    proposalAnswer = jsonResponse(200, proposalOf({ revision: 11, scopeHash: "d".repeat(64) }));
    await user.click(acceptButton(1));
    const note = await screen.findByRole("note");
    expect(note).toHaveTextContent("The team's plan changed since the proposal: here is a fresh one");
    expect(table()).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Accept tp-b" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Accept tp-tray" })).not.toBeChecked();
    await waitFor(() => expect(screen.getByRole("button", { name: "Discard" })).toHaveFocus());
    expect(screen.queryByRole("alert")).toBeNull();
    await user.click(within(note).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("note")).toBeNull();
    expect(table()).toBeInTheDocument();
  });

  test("a stale-scope refusal whose fresh proposal arrives BEFORE the plan refetch still ends with Discard enabled and focused", async () => {
    batchAnswer = jsonResponse(409, { type: "urn:astrolabe:problem:stale-scope", title: "Conflict", status: 409, detail: "scope" });
    const user = userEvent.setup();
    await openPreview(user);
    // From here on the view's refetch (the refresh after the refusal) is held, so the fresh proposal resolves first.
    const served = mockFetch.getMockImplementation() as (url: string, init?: RequestInit) => Promise<Response>;
    const held = { release: () => {} };
    mockFetch.mockImplementation((url: string, init?: RequestInit) =>
      url === "/api/v1/views/team/1" && (init?.method ?? "GET") === "GET"
        ? new Promise<Response>((resolve) => {
            held.release = () => resolve(jsonResponse(200, view));
          })
        : served(url, init),
    );
    proposalAnswer = jsonResponse(200, proposalOf({ revision: 11, scopeHash: "d".repeat(64) }));
    await user.click(acceptButton(2));
    await screen.findByRole("note");
    const discard = screen.getByRole("button", { name: "Discard" });
    await waitFor(() => expect(discard).toBeEnabled());
    await waitFor(() => expect(discard).toHaveFocus());
    expect(acceptButton(2)).toBeEnabled();
    held.release();
  });

  test("another failure stays inline with the preview open and the selection kept", async () => {
    batchAnswer = jsonResponse(403, { title: "Forbidden", status: 403 });
    const user = userEvent.setup();
    await openPreview(user);
    await user.click(screen.getByRole("checkbox", { name: "Accept tp-tray" }));
    await user.click(acceptButton(1));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Only the team's manager or an administrator can propose a schedule");
    // inline IN the section, above the actions, with the preview still open; the focus moved to it from the disabled Accept
    expect(screen.getByRole("heading", { name: "Proposed schedule" }).parentElement).toContainElement(alert);
    expect(alert).toHaveFocus();
    expect(table()).toBeInTheDocument();
    expect(acceptButton(1)).toBeEnabled();
    expect(screen.getByRole("checkbox", { name: "Accept tp-b" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Accept tp-tray" })).not.toBeChecked();
  });

  test("while the accept runs, Accept and Discard are disabled and a second click sends nothing", async () => {
    let release: ((response: Response) => void) | null = null;
    batchAnswer = () =>
      new Promise<Response>((resolve) => {
        release = resolve;
      });
    const user = userEvent.setup();
    await openPreview(user);
    await user.click(acceptButton(2));
    await waitFor(() => expect(batchPosts()).toHaveLength(1));
    expect(acceptButton(2)).toBeDisabled();
    expect(screen.getByRole("button", { name: "Discard" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Accept all" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Propose schedule" })).toBeDisabled();
    fireEvent.click(acceptButton(2));
    expect(batchPosts()).toHaveLength(1);
    await waitFor(() => expect(release).not.toBeNull());
    await act(async () => release?.(jsonResponse(200, { revision: 11, accepted: [2, 3], skipped: [] })));
    await waitFor(() => expect(screen.queryByRole("table", { name: "Proposed schedule moves" })).toBeNull());
  });

  test("Discard closes the section without a batch and gives the focus back to Propose", async () => {
    const user = userEvent.setup();
    await openPreview(user);
    await waitFor(() => expect(screen.getByRole("button", { name: "Discard" })).toHaveFocus());
    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.queryByRole("table", { name: "Proposed schedule moves" })).toBeNull();
    expect(batchPosts()).toEqual([]);
    await waitFor(() => expect(screen.getByRole("button", { name: "Propose schedule" })).toHaveFocus());
  });

  test("Accept all and Accept none are announced as 'N of M selected'", async () => {
    const user = userEvent.setup();
    await openPreview(user);
    await user.click(screen.getByRole("checkbox", { name: "Accept all" }));
    expect(screen.getByRole("checkbox", { name: "Accept tp-b" })).not.toBeChecked();
    expect(liveText()).toContain("0 of 2 selected");
    await user.click(screen.getByRole("checkbox", { name: "Accept all" }));
    expect(liveText()).toContain("2 of 2 selected");
    expect(acceptButton(2)).toBeEnabled();
  });
});

describe("the ticked-subset check (1.8)", () => {
  const end = (id: number, name: string): ScheduleProposalEnd => ({ kind: "MILESTONE", id, name, projectName: "Invoices" });
  const link = (id: number, predecessor: ScheduleProposalEnd, successor: ScheduleProposalEnd, before: ScheduleProposalLink["before"], status: ScheduleProposalLink["before"]): ScheduleProposalLink => ({
    id,
    predecessor,
    successor,
    type: "FS",
    lagDays: 0,
    before,
    check: { status, shortfallDays: status === "VIOLATED" ? 2 : null, slackDays: status === "VIOLATED" ? -2 : null, requiredDate: "2027-06-17", actualDate: null },
  });
  const checkPosts = () => mockFetch.mock.calls.filter(([url, init]) => url === CHECK_URL && (init as RequestInit).method === "POST").map(([, init]) => JSON.parse((init as RequestInit).body as string));
  // A fake clock (real time still flows for waitFor): the 300 ms debounce is advanced by hand, so "no request yet" never depends on load.
  const settle = () => act(() => vi.advanceTimersByTimeAsync(450));
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  const rowOf = (name: string) => screen.getByRole("checkbox", { name: `Accept ${name}` }).closest("tr") as HTMLElement;

  test("unticking a move sends the check with the ticked items, the Links column and the strip follow the answer; all ticked sends nothing; none ticked shows the plan as it is", async () => {
    const broken = link(1, end(2, "tp-b"), end(50, "Checkout page"), "OK", "VIOLATED");
    const old = link(4, end(60, "Design"), end(61, "Build"), "VIOLATED", "VIOLATED");
    proposalAnswer = jsonResponse(200, proposalOf({ dependencies: [broken, old] }));
    const user = userEvent.setup();
    await openPreview(user);
    // every move ticked: the proposal's own verdicts and load, and no request however long we wait
    expect(within(rowOf("tp-b")).getByText("would violate: Invoices › Checkout page must start on 2027-06-17 or later")).toBeInTheDocument();
    expect(screen.getByText("1 link would be violated")).toBeInTheDocument();
    expect(document.querySelector('[data-week="2027-06-07"]')).not.toBeNull();
    await settle();
    expect(checkPosts()).toEqual([]);

    // tp-tray unticked: only tp-b is asked about, and the answer (no violation, another load) replaces the proposal's
    await user.click(screen.getByRole("checkbox", { name: "Accept tp-tray" }));
    expect(screen.getByText("Checking the ticked moves…")).toBeInTheDocument();
    await waitFor(() => expect(checkPosts()).toEqual([{ teamIds: [1], items: [{ milestoneId: 2, startDate: "2027-06-14", endDate: "2027-06-16" }] }]));
    await waitFor(() => expect(screen.queryByText("1 link would be violated")).toBeNull());
    expect(screen.queryByText("Checking the ticked moves…")).toBeNull();
    expect(within(rowOf("tp-b")).queryByText(/would violate/)).toBeNull();
    expect(document.querySelector('[data-week="2027-06-14"]')).not.toBeNull();
    expect(document.querySelector('[data-week="2027-06-07"]')).toBeNull();

    // everything ticked again: the proposal's own again, still one request
    await user.click(screen.getByRole("checkbox", { name: "Accept tp-tray" }));
    expect(screen.getByText("1 link would be violated")).toBeInTheDocument();
    expect(document.querySelector('[data-week="2027-06-07"]')).not.toBeNull();
    await settle();
    expect(checkPosts()).toHaveLength(1);

    // nothing ticked: the plan as it is (only the link already violated before, gray; no new warning) and the current load, still one request
    await user.click(screen.getByRole("checkbox", { name: "Accept all" }));
    expect(screen.queryByText("1 link would be violated")).toBeNull();
    expect(screen.getByText("1 link stays violated")).toBeInTheDocument();
    expect(within(rowOf("tp-b")).queryByText(/would violate/)).toBeNull();
    expect(document.querySelector('[data-week="2027-02-01"]')).not.toBeNull();
    expect(document.querySelector('[data-week="2027-06-07"]')).toBeNull();
    await settle();
    expect(checkPosts()).toHaveLength(1);
  });

  test("unticking a predecessor turns the badge of the ticked successor red before the accept", async () => {
    // accepting both is fine (tp-b ends 06-16, tp-tray starts after it); without tp-b's move the successor would start before the stored end of tp-b
    const fine = link(1, end(2, "tp-b"), end(3, "tp-tray"), "OK", "OK");
    proposalAnswer = jsonResponse(200, proposalOf({ dependencies: [fine] }));
    const violated = link(1, end(2, "tp-b"), end(3, "tp-tray"), "OK", "VIOLATED");
    checkAnswer = jsonResponse(200, { teams: [{ teamId: 1, weeks: [week("2027-06-07", 4)], weeksTruncated: false, dependencies: [violated] }] });
    const user = userEvent.setup();
    await openPreview(user);
    expect(screen.queryByText(/would be violated/)).toBeNull();
    expect(within(rowOf("tp-tray")).queryByText("Conflict")).toBeNull();
    await user.click(screen.getByRole("checkbox", { name: "Accept tp-b" }));
    await waitFor(() => expect(screen.getByText("1 link would be violated")).toBeInTheDocument());
    const successor = rowOf("tp-tray");
    expect(within(successor).getByText("Conflict")).toBeInTheDocument();
    expect(within(successor).getByText("would violate: must start on 2027-06-17 or later (link from Invoices › tp-b)")).toBeInTheDocument();
    expect(checkPosts()).toEqual([{ teamIds: [1], items: [{ milestoneId: 3, startDate: "2027-06-07", endDate: "2027-06-10" }] }]);
  });

  test("a failed check says so inline, never as a toast or an alert, and the proposal's own verdicts stay", async () => {
    const broken = link(1, end(2, "tp-b"), end(50, "Checkout page"), "OK", "VIOLATED");
    proposalAnswer = jsonResponse(200, proposalOf({ dependencies: [broken] }));
    checkAnswer = jsonResponse(500, { title: "Internal Server Error", status: 500 });
    const user = userEvent.setup();
    await openPreview(user);
    await user.click(screen.getByRole("checkbox", { name: "Accept tp-tray" }));
    expect(await screen.findByText("The ticked moves could not be checked; the warnings describe all moves.")).toBeInTheDocument();
    expect(screen.queryByText("Checking the ticked moves…")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("1 link would be violated")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Accept selected (1)" })).toBeEnabled();
  });

  test("an accept that cancels a check in flight and then fails leaves the check asked again, not 'Checking…' forever", async () => {
    let held: ((response: Response) => void) | null = null;
    let calls = 0;
    checkAnswer = () => {
      calls += 1;
      return calls === 1
        ? new Promise<Response>((resolve) => {
            held = resolve;
          })
        : jsonResponse(200, { teams: [{ teamId: 1, weeks: [week("2027-06-14", 3)], weeksTruncated: false, dependencies: [] }] });
    };
    batchAnswer = jsonResponse(403, { title: "Forbidden", status: 403 });
    const user = userEvent.setup();
    await openPreview(user);
    await user.click(screen.getByRole("checkbox", { name: "Accept tp-tray" }));
    await waitFor(() => expect(checkPosts()).toHaveLength(1));
    expect(held).not.toBeNull();
    // the accept cancels the plan reads, the held check with them; its refusal leaves the preview open
    await user.click(screen.getByRole("button", { name: "Accept selected (1)" }));
    await screen.findByRole("alert");
    await waitFor(() => expect(checkPosts()).toHaveLength(2));
    await waitFor(() => expect(screen.queryByText("Checking the ticked moves…")).toBeNull());
    expect(document.querySelector('[data-week="2027-06-14"]')).not.toBeNull();
  });

  test("a successful subset accept sends no further check request", async () => {
    batchAnswer = jsonResponse(200, { revision: 11, accepted: [2], skipped: [] });
    const user = userEvent.setup();
    await openPreview(user);
    await user.click(screen.getByRole("checkbox", { name: "Accept tp-tray" }));
    await waitFor(() => expect(checkPosts()).toHaveLength(1));
    await user.click(screen.getByRole("button", { name: "Accept selected (1)" }));
    await waitFor(() => expect(screen.queryByRole("table", { name: "Proposed schedule moves" })).toBeNull());
    await settle();
    expect(checkPosts()).toHaveLength(1);
  });
});
