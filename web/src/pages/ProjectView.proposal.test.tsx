import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DndContext } from "@dnd-kit/core";
import userEvent from "@testing-library/user-event";
import { act, screen, waitFor, within } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import { Route, Routes } from "react-router-dom";
import ProjectView from "./ProjectView";
import type { ProjectMilestone, ProjectView as ProjectViewDocument } from "../api/milestones";
import type { CrossTeamProposal } from "../api/scheduleProposals";
import { ACCEPT_URL, block, CHECK_URL, move, RUN_URL, STALE_REVISION } from "../test/crossTeamRun";
import { headingOutline } from "../test/headings";
import { jsonResponse, routeFetch } from "../test/http";
import { planView } from "../test/planView";
import { renderWithProviders } from "../test/render";
import { localIsoDate } from "../utils/isoDate";

// The project page previews a cross-team schedule proposal (1.33): Propose over the teams of the project's milestones (a click), the dashed bars on its rows, the "(new)" row of a tray
// milestone the run places, the summary row's proposed span, the sentence about the project's end, the run's sections cut to this project, an accept that names only this project's
// moves (an administrator, the manager of one of the two teams, a login that manages none), and the lock over the date writes while a run is requested or open.

// happy-dom has no layout, so a pointer drag cannot run here: the context is wrapped to hand the test its drag-end handler (what the page does WHEN dnd-kit reports a drop is ours to pin).
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

const milestone = (id: number, name: string, teamId: number, teamName: string, over: Partial<ProjectMilestone> = {}): ProjectMilestone => ({
  jira: null,
  flags: [],
  id,
  projectId: 7,
  name,
  description: null,
  teamId,
  teamName,
  estimateMd: 5,
  startDate: "2027-01-11",
  endDate: "2027-01-15",
  createdAt: 1,
  updatedAt: 2,
  slackDays: null,
  critical: false,
  pinned: false,
  can: { edit: true, delete: true, schedule: true },
  ...over,
});

const viewOf = (scheduled: ProjectMilestone[], unscheduled: ProjectMilestone[]): ProjectViewDocument => ({
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
    can: { edit: true, delete: true, editTargetWindow: false, createMilestone: true, createDependency: false },
  },
  span: { start: "2027-01-04", end: "2027-01-15" },
  drift: null,
  scheduled,
  unscheduled,
  dependencies: [],
  idleGaps: [],
  criticalPath: { upstream: [], upstreamTruncated: false },
});

const TEAMS = [
  { id: 1, name: "Alpha" },
  { id: 2, name: "Beta" },
];
const onProject = { projectId: 7, projectName: "Invoices" };
const other = { projectId: 8, projectName: "Taxes" };
/** Alpha moves Discovery and places Rollout (and moves one milestone of another project), Beta moves Build (and one of another project). */
const RUN: CrossTeamProposal = {
  revision: 12,
  asOf: localIsoDate(),
  passes: 1,
  settled: true,
  scopeHash: "b".repeat(64),
  teams: [
    block(1, "Alpha", [
      move(1, "Discovery", "2027-01-18", "2027-01-22", { ...onProject, from: { start: "2027-01-11", end: "2027-01-15" }, shiftDays: 5 }),
      move(3, "Rollout", "2027-01-25", "2027-01-29", onProject),
      move(90, "Filing", "2027-02-01", "2027-02-05", { ...other, shiftDays: 3 }),
    ]),
    block(2, "Beta", [move(2, "Build", "2027-01-11", "2027-01-15", { ...onProject, from: { start: "2027-01-04", end: "2027-01-08" }, shiftDays: 5 }), move(91, "Audit", "2027-02-08", "2027-02-12", { ...other, shiftDays: 5 })]),
  ],
  projects: [{ projectId: 7, name: "Invoices", before: { start: "2027-01-04", end: "2027-01-15" }, after: { start: "2027-01-11", end: "2027-01-29" }, endShiftDays: 10 }],
};

let project: ProjectViewDocument;
let rights: { id: number; name: string }[];
let runAnswer: () => unknown;
let mockFetch: ReturnType<typeof routeFetch>;

beforeEach(() => {
  project = viewOf(
    [milestone(1, "Discovery", 1, "Alpha"), milestone(2, "Build", 2, "Beta", { startDate: "2027-01-04", endDate: "2027-01-08" })],
    [milestone(3, "Rollout", 1, "Alpha", { startDate: null, endDate: null })],
  );
  rights = TEAMS;
  dndProps = null;
  runAnswer = () => RUN;
  mockFetch = routeFetch({
    "GET /api/v1/views/project/7": () => project,
    "GET /api/v1/public-holidays": { items: [] },
    "GET /api/v1/teams": { items: [], page: 1, pageSize: 100, total: 0 },
    "GET /api/v1/views/plan": planView(),
    "GET /api/v1/baselines": { items: [], can: { manage: false } },
    "GET /api/v1/schedule-proposals/teams": () => ({ items: rights, truncated: false }),
    "POST /api/v1/schedule-proposals": () => runAnswer(),
    "POST /api/v1/schedule-proposals/check": { teams: [] },
    "POST /api/v1/schedule-proposals/accept": { revision: 13, accepted: [1, 2, 3], skipped: [] },
    "PUT /api/v1/milestones/:id/schedule": () => ({ revision: 11 }),
  });
  vi.stubGlobal("fetch", mockFetch);
  localStorage.setItem("astrolabe.auth.token", "fake-token");
  localStorage.setItem("astrolabe.auth.roles", JSON.stringify(["USER"]));
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

const bodies = (method: string, url: string) => mockFetch.mock.calls.filter(([u, init]) => u === url && ((init as RequestInit | undefined)?.method ?? "GET") === method).map(([, init]) => JSON.parse((init as RequestInit).body as string) as Record<string, unknown>);
const renderPage = (queryClient?: QueryClient) =>
  renderWithProviders(
    <main id="main-content" tabIndex={-1}>
      <Routes>
        <Route path="/projects/:id" element={<ProjectView />} />
      </Routes>
    </main>,
    { route: "/projects/7", queryClient },
  );
const proposeButton = () => screen.getByRole("button", { name: "Propose schedule" });
const proposalBars = () => [...document.querySelectorAll('[data-tone="proposal"]')].map((bar) => bar.getAttribute("aria-label"));
const grid = () => screen.getByRole("grid", { name: "Milestone timeline" });
const liveText = () => screen.getAllByRole("status").map((region) => region.textContent).join(" | ");

async function opened(user: ReturnType<typeof userEvent.setup>) {
  renderPage();
  await screen.findByRole("grid", { name: "Milestone timeline" });
  await waitFor(() => expect(proposeButton()).toBeEnabled());
  return user;
}
async function proposed(user: ReturnType<typeof userEvent.setup>) {
  await opened(user);
  await user.click(proposeButton());
  await screen.findByRole("heading", { name: "Schedule proposal" });
}

describe("asking for the proposal", () => {
  test("nothing is requested until Propose is clicked; one click asks for the distinct teams of the project's milestones, scheduled and unscheduled", async () => {
    const user = userEvent.setup();
    await opened(user);
    expect(screen.getByText(/Proposes dates for the 2 teams that work on this project's milestones/)).toBeInTheDocument();
    expect(bodies("POST", RUN_URL)).toEqual([]);
    expect(proposalBars()).toEqual([]);
    await user.click(proposeButton());
    await screen.findByRole("heading", { name: "Schedule proposal" });
    expect(bodies("POST", RUN_URL)).toEqual([{ asOf: localIsoDate(), teamIds: [1, 2] }]);
    expect(proposeButton()).toBeDisabled();
    expect(liveText()).toContain("Proposed schedule ready");
    expect(headingOutline().filter(([level]) => level === 3).map(([, name]) => name)).toEqual(["Timeline", "Unscheduled", "Schedule proposal", "Alpha", "Beta", "Milestones", "Dependencies", "Idle gaps"]);
  });

  test("Propose waits for the rights read, and the line says so", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockFetch = routeFetch({
      "GET /api/v1/views/project/7": () => project,
      "GET /api/v1/public-holidays": { items: [] },
      "GET /api/v1/teams": { items: [], page: 1, pageSize: 100, total: 0 },
      "GET /api/v1/views/plan": planView(),
      "GET /api/v1/baselines": { items: [], can: { manage: false } },
      "GET /api/v1/schedule-proposals/teams": async () => {
        await gate;
        return { items: TEAMS, truncated: false };
      },
    });
    vi.stubGlobal("fetch", mockFetch);
    renderPage();
    await screen.findByRole("grid", { name: "Milestone timeline" });
    expect(proposeButton()).toBeDisabled();
    expect(proposeButton()).toHaveAccessibleDescription("Checking what you may accept…");
    release();
    await waitFor(() => expect(proposeButton()).toBeEnabled());
  });
});

describe("what the open proposal draws", () => {
  test("a dashed bar on each moved row, a (new) row for the tray milestone it places, the summary row's proposed span, no idle bands; the current bars are read-only", async () => {
    project = { ...project, idleGaps: [{ start: "2027-01-09", end: "2027-01-10", workingDays: 2 }] };
    const user = userEvent.setup();
    await proposed(user);
    expect(proposalBars().sort()).toEqual([
      "Proposed: Build, 2027-01-11 to 2027-01-15, read-only",
      "Proposed: Discovery, 2027-01-18 to 2027-01-22, read-only",
      "Proposed: Invoices, 2027-01-11 to 2027-01-29, read-only",
      "Proposed: Rollout, 2027-01-25 to 2027-01-29, read-only",
    ]);
    const rows = within(grid()).getAllByRole("row");
    expect(rows.some((row) => row.textContent?.includes("Rollout") && row.textContent.includes("(new)"))).toBe(true);
    expect(within(grid()).queryByRole("img", { name: /idle/i })).toBeNull();
    expect(within(grid()).getByRole("img", { name: /^Discovery,.*read-only$/ })).toBeInTheDocument();
    // the run's moves of another project (Filing, Audit) have no row here
    expect(proposalBars().join("|")).not.toMatch(/Filing|Audit/);
  });

  test("with its extra columns hidden (1.34), every row of the preview, the (new) row included, has the drawn columns plus the track, and the dashed bars stay", async () => {
    const user = userEvent.setup();
    await proposed(user);
    const cellCounts = () => within(grid()).getAllByRole("row").slice(1).map((row) => row.querySelectorAll('[role="rowheader"], [role="gridcell"]').length);
    const bars = proposalBars().sort();
    // the summary row, Discovery, Build and the (new) Rollout: Milestone, Team, Estimate, Operations + the track
    expect(cellCounts()).toEqual([5, 5, 5, 5]);
    await user.click(screen.getByRole("button", { name: "Hide columns" }));
    expect(cellCounts()).toEqual([3, 3, 3, 3]);
    expect(proposalBars().sort()).toEqual(bars);
  });

  test("the project's end in a sentence: later, earlier, unchanged, newly scheduled, only the start", async () => {
    const user = userEvent.setup();
    await proposed(user);
    expect(screen.getByText("If every team's moves are accepted, the project would end on 2027-01-29 instead of 2027-01-15, 10 working days later.")).toBeInTheDocument();
    const entry = RUN.projects[0];
    const variants: [CrossTeamProposal["projects"], string][] = [
      [[{ ...entry, endShiftDays: -1, after: { start: "2027-01-04", end: "2027-01-14" } }], "If every team's moves are accepted, the project would end on 2027-01-14 instead of 2027-01-15, 1 working day earlier."],
      [[], "The project's dates would not change."],
      [[{ ...entry, before: null, endShiftDays: null }], "The project would be newly scheduled, from 2027-01-11 to 2027-01-29."],
      [[{ ...entry, endShiftDays: 0, after: { start: "2027-01-11", end: "2027-01-15" } }], "The project would still end on 2027-01-15; only its start moves."],
    ];
    for (const [projects, sentence] of variants) {
      runAnswer = () => ({ ...RUN, projects });
      await user.click(screen.getByRole("button", { name: "Propose again" }));
      expect(await screen.findByText(sentence)).toBeInTheDocument();
    }
  });

  test("the run's other moves of these teams are counted and their teams linked, not offered; the sections hold this project's moves only", async () => {
    const user = userEvent.setup();
    await proposed(user);
    const note = screen.getByText(/The run also moves 2 other milestones of these teams, not offered here:/);
    expect(within(note).getAllByRole("link").map((link) => link.getAttribute("aria-label"))).toEqual(["Open team Alpha", "Open team Beta"]);
    expect(screen.queryByText("Filing")).toBeNull();
    expect(screen.queryByText("Audit")).toBeNull();
    expect(screen.getByRole("button", { name: "Accept selected (3)" })).toBeEnabled();
  });

  test("Discard removes the bars and the section, gives the focus back to Propose and leaves the timeline as it was", async () => {
    const user = userEvent.setup();
    await opened(user);
    // the range only ever grows (a drag never shifts bars under the pointer), so the rows and bars are compared, not the scale
    const rowsOf = () => within(grid()).getAllByRole("row").slice(1).map((row) => [row.textContent, [...row.querySelectorAll("[aria-label]")].map((bar) => bar.getAttribute("aria-label"))]);
    const before = rowsOf();
    await user.click(proposeButton());
    await screen.findByRole("heading", { name: "Schedule proposal" });
    expect(rowsOf()).not.toEqual(before);
    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.queryByRole("heading", { name: "Schedule proposal" })).toBeNull();
    expect(proposalBars()).toEqual([]);
    expect(rowsOf()).toEqual(before);
    await waitFor(() => expect(proposeButton()).toHaveFocus());
    expect(bodies("POST", RUN_URL)).toHaveLength(1);
  });
});

describe("what the viewer may accept", () => {
  test("an administrator: this project's moves are ticked, the accept names both teams and carries only this project's items, there is no Save", async () => {
    const user = userEvent.setup();
    await proposed(user);
    expect(screen.queryByRole("button", { name: /Save/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Accept selected (3)" }));
    await waitFor(() => expect(bodies("POST", ACCEPT_URL)).toHaveLength(1));
    const [body] = bodies("POST", ACCEPT_URL);
    expect(body).toMatchObject({ expectedRevision: 12, teamIds: [1, 2], acceptTeamIds: [1, 2] });
    expect((body.items as { milestoneId: number }[]).map((item) => item.milestoneId)).toEqual([1, 3, 2]);
    expect(screen.queryByRole("heading", { name: "Schedule proposal" })).toBeNull();
  });

  test("the manager of one of the two teams: only their moves are ticked, the accept names that team alone, the check describes exactly the ticked moves, the other team is a read-only preview", async () => {
    rights = [TEAMS[0]];
    const user = userEvent.setup();
    await proposed(user);
    expect(screen.getByRole("button", { name: "Accept selected (2)" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Show the moves of Beta" })).toHaveAttribute("aria-expanded", "false");
    await waitFor(() => expect(bodies("POST", CHECK_URL).length).toBeGreaterThan(0));
    const checks = bodies("POST", CHECK_URL);
    expect((checks[checks.length - 1].items as { milestoneId: number }[]).map((item) => item.milestoneId)).toEqual([1, 3]);
    await user.click(screen.getByRole("button", { name: "Accept selected (2)" }));
    await waitFor(() => expect(bodies("POST", ACCEPT_URL)).toHaveLength(1));
    const [body] = bodies("POST", ACCEPT_URL);
    expect(body).toMatchObject({ teamIds: [1, 2], acceptTeamIds: [1] });
    expect((body.items as { milestoneId: number }[]).map((item) => item.milestoneId)).toEqual([1, 3]);
  });

  test("a login that manages none previews: bars, sentence and a preview line, no Accept, no check request; Propose again and Discard stay", async () => {
    rights = [];
    const user = userEvent.setup();
    await proposed(user);
    expect(screen.getByText(/This is a preview\./)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Accept selected/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Propose again" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Discard" })).toBeInTheDocument();
    expect(proposalBars()).toHaveLength(4);
    expect(screen.getByText("If every team's moves are accepted, the project would end on 2027-01-29 instead of 2027-01-15, 10 working days later.")).toBeInTheDocument();
    expect(bodies("POST", CHECK_URL)).toEqual([]);
    expect(bodies("POST", ACCEPT_URL)).toEqual([]);
  });
});

describe("the date writes are locked while a proposal is requested or open", () => {
  test("the tray is read-only, a menu's date item is refused out loud with no write, an edit that is not a date stays available; Discard unlocks", async () => {
    const user = userEvent.setup();
    await proposed(user);
    expect(screen.getByRole("button", { name: "Schedule Rollout" })).toBeDisabled();
    await user.click(screen.getAllByRole("button", { name: "Operations for Discovery" })[0]);
    expect(await screen.findByRole("menuitem", { name: "Edit Discovery" })).toBeInTheDocument();
    await user.click(await screen.findByRole("menuitem", { name: "Unschedule Discovery" }));
    expect(liveText()).toContain("A proposal is open, so the schedule is read-only");
    expect(screen.getAllByRole("note").map((note) => note.textContent).join("|")).toContain("A proposal is open, so the schedule is read-only");
    expect(mockFetch.mock.calls.filter(([url, init]) => String(url).includes("/schedule") && ((init as RequestInit | undefined)?.method ?? "GET") === "PUT")).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.getByRole("button", { name: "Schedule Rollout" })).toBeEnabled();
  });

  test("the lock starts with the request, not with the answer", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    runAnswer = () => gate.then(() => RUN);
    const user = userEvent.setup();
    await opened(user);
    await user.click(proposeButton());
    expect(screen.getByText("Asking for a proposal — the dates are read-only until it arrives.")).toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: "Operations for Discovery" })[0]);
    await user.click(await screen.findByRole("menuitem", { name: "Unschedule Discovery" }));
    expect(liveText()).toContain("A save is still running");
    release();
    await screen.findByRole("heading", { name: "Schedule proposal" });
  });
});

describe("every date write is refused while a proposal is requested or open", () => {
  const writes = () => mockFetch.mock.calls.filter(([url, init]) => /\/milestones\/\d+\/(schedule|pin)$/.test(String(url)) && (init as RequestInit | undefined)?.method === "PUT");
  const openMenu = async (user: ReturnType<typeof userEvent.setup>, name: string) => user.click(screen.getAllByRole("button", { name: `Operations for ${name}` })[0]);

  test("a drop is refused out loud in the request window and while the run is open: no write either time", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    runAnswer = () => gate.then(() => RUN);
    const user = userEvent.setup();
    await opened(user);
    await user.click(proposeButton());
    dropMove(project.scheduled[0], 5);
    expect(liveText()).toContain("A save is still running");
    release();
    await screen.findByRole("heading", { name: "Schedule proposal" });
    dropMove(project.scheduled[0], 6);
    expect(liveText()).toContain("A proposal is open, so the schedule is read-only");
    expect(writes()).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Discard" }));
    dropMove(project.scheduled[0], 7);
    await waitFor(() => expect(writes()).toHaveLength(1));
  });

  test("Pin dates and Edit schedule are refused while it is open: no write, no dialog", async () => {
    const user = userEvent.setup();
    await proposed(user);
    await openMenu(user, "Discovery");
    await user.click(await screen.findByRole("menuitem", { name: "Pin dates of Discovery" }));
    await openMenu(user, "Discovery");
    await user.click(await screen.findByRole("menuitem", { name: "Edit schedule of Discovery" }));
    expect(liveText()).toContain("A proposal is open, so the schedule is read-only");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(writes()).toEqual([]);
  });

  test("Schedule on Jira's dates is refused too", async () => {
    const jira = { bindingId: 6, connectionId: 1, issueKey: "E2E-3", start: "2027-03-01", end: "2027-03-05", rollup: null };
    project = { ...viewOf([milestone(1, "Discovery", 1, "Alpha")], [milestone(3, "Rollout", 1, "Alpha", { startDate: null, endDate: null, jira })]), jiraSites: [{ connectionId: 1, siteUrl: "https://jira.example.test", state: "CURRENT", mappingOk: true }] };
    const user = userEvent.setup();
    await proposed(user);
    await user.click(screen.getByRole("button", { name: "Operations for Rollout (dates from Jira)" }));
    await user.click(await screen.findByRole("menuitem", { name: /^Schedule on Jira's dates/ }));
    expect(liveText()).toContain("A proposal is open, so the schedule is read-only");
    expect(writes()).toEqual([]);
  });
});

describe("the rest of the run's life", () => {
  test("a rights read that failed says so, and the run still previews", async () => {
    mockFetch = routeFetch({
      "GET /api/v1/views/project/7": () => project,
      "GET /api/v1/public-holidays": { items: [] },
      "GET /api/v1/teams": { items: [], page: 1, pageSize: 100, total: 0 },
      "GET /api/v1/views/plan": planView(),
      "GET /api/v1/baselines": { items: [], can: { manage: false } },
      "GET /api/v1/schedule-proposals/teams": () => jsonResponse(500, { title: "x", status: 500 }),
      "POST /api/v1/schedule-proposals": RUN,
    });
    vi.stubGlobal("fetch", mockFetch);
    const user = userEvent.setup();
    await proposed(user);
    expect(screen.getByText("Could not read which teams you manage; this is a preview only.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Accept selected/ })).toBeNull();
  });

  test("an accept answered by a stale-revision 409 closes the preview and says the plan changed", async () => {
    mockFetch = routeFetch({
      "GET /api/v1/views/project/7": () => project,
      "GET /api/v1/public-holidays": { items: [] },
      "GET /api/v1/teams": { items: [], page: 1, pageSize: 100, total: 0 },
      "GET /api/v1/views/plan": planView(),
      "GET /api/v1/baselines": { items: [], can: { manage: false } },
      "GET /api/v1/schedule-proposals/teams": { items: TEAMS, truncated: false },
      "POST /api/v1/schedule-proposals": RUN,
      "POST /api/v1/schedule-proposals/accept": () => jsonResponse(409, STALE_REVISION),
    });
    vi.stubGlobal("fetch", mockFetch);
    const user = userEvent.setup();
    await proposed(user);
    await user.click(screen.getByRole("button", { name: "Accept selected (3)" }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Schedule proposal" })).toBeNull());
    expect(screen.getAllByRole("note").map((note) => note.textContent).join("|")).toContain("The plan changed in the meantime — nothing was saved. Propose again.");
    expect(proposalBars()).toEqual([]);
  });

  test("Propose again asks for the project's CURRENT teams, not the run's", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const user = userEvent.setup();
    renderPage(queryClient);
    await screen.findByRole("grid", { name: "Milestone timeline" });
    await waitFor(() => expect(proposeButton()).toBeEnabled());
    await user.click(proposeButton());
    await screen.findByRole("heading", { name: "Schedule proposal" });
    // a third team's milestone arrives while the run is open
    project = viewOf(project.scheduled, [milestone(3, "Rollout", 1, "Alpha", { startDate: null, endDate: null }), milestone(4, "Launch", 3, "Gamma", { startDate: null, endDate: null })]);
    await act(() => queryClient.invalidateQueries({ queryKey: ["plan"] }));
    await user.click(screen.getByRole("button", { name: "Propose again" }));
    await waitFor(() => expect(bodies("POST", RUN_URL)).toHaveLength(2));
    expect(bodies("POST", RUN_URL).map((body) => body.teamIds)).toEqual([[1, 2], [1, 2, 3]]);
  });
});
