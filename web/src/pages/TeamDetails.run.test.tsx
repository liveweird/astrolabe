import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { screen, waitFor, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import TeamDetails from "./TeamDetails";
import type { DependencyEndpoint, ProjectDependency } from "../api/dependencies";
import type { CrossTeamProposal } from "../api/scheduleProposals";
import type { ScheduleProposal, TeamMilestone, TeamView } from "../api/teams";
import { ACCEPT_URL, block, CHECK_URL, move, RUN_URL, STALE_REVISION, STALE_SCOPE, TEAMS_URL } from "../test/crossTeamRun";
import { READ_ONLY_PANEL } from "../test/flow";
import { headingOutline } from "../test/headings";
import { jsonResponse, routeFetch } from "../test/http";
import { TEAM_LIST } from "../test/overviewRun";
import { renderWithProviders } from "../test/render";
import { localIsoDate } from "../utils/isoDate";

// The team page's "Plan together with" (1.38): beside Propose a picker of the other teams and "Add linked teams"; with teams chosen Propose runs the cross-team proposal over this team and
// them, previewed on the page (a section with the run's sections, the other teams' linked milestones as dimmed rows with a ghost bar and the dashed bar), accepted in the run's one
// accept; with none chosen it is the per-team proposal it always was. Team 1 (Payments) is the page's; Beta (2) and Gamma (3) come from the teams list.

const PER_TEAM_URL = "/api/v1/teams/1/schedule-proposal";

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
  programId: 4,
  programName: "Billing",
  workStreamId: 1,
  workStreamName: "Platform",
  rankPosition: 1,
  ...over,
});
const TR_A = milestone(1, "tr-a", { startDate: "2042-02-02", endDate: "2042-02-06" });
const TR_B = milestone(2, "tr-b", { startDate: "2042-02-09", endDate: "2042-02-10" });
const TR_TRAY = milestone(3, "tr-tray");

const endpoint = (kind: "MILESTONE" | "PROJECT", id: number, name: string, teamId: number | null, teamName: string | null): DependencyEndpoint => ({
  kind,
  id,
  name,
  projectId: kind === "PROJECT" ? id : 8,
  projectName: kind === "PROJECT" ? name : "Taxes",
  teamId,
  teamName,
  startDate: "2042-02-16",
  endDate: "2042-02-17",
});
const ownEnd = (m: TeamMilestone): DependencyEndpoint => ({ kind: "MILESTONE", id: m.id, name: m.name, projectId: 7, projectName: "Invoices", teamId: 1, teamName: "Payments", startDate: m.startDate, endDate: m.endDate });
const link = (id: number, from: DependencyEndpoint, to: DependencyEndpoint): ProjectDependency => ({
  id,
  predecessor: from,
  successor: to,
  type: "FS",
  lagDays: 0,
  check: { status: "OK", shortfallDays: null, slackDays: 0, requiredDate: "2042-02-09", actualDate: "2042-02-09" },
  critical: false,
  can: { edit: false, delete: false },
});

/** Beta's milestone 21 and the whole project 9 lead into the team's tr-a, Gamma's milestone 31 into tr-b. */
const DEPENDENCIES = [
  link(51, endpoint("MILESTONE", 21, "bt-linked", 2, "Beta"), ownEnd(TR_A)),
  link(52, endpoint("PROJECT", 9, "Whole", null, null), ownEnd(TR_A)),
  link(53, endpoint("MILESTONE", 31, "gm-moved", 3, "Gamma"), ownEnd(TR_B)),
];

const viewOf = (over: Partial<TeamView> = {}): TeamView => ({
  jiraSites: [],
  revision: 10,
  team: { id: 1, name: "Payments", description: null, managerPersonId: 12, managerName: "Cara New", colour: "INDIGO", createdAt: 1, updatedAt: 2, can: { schedule: true, editCapacity: true, editOrder: true }, flags: [] },
  order: { custom: false, revision: 4, milestoneIds: [] },
  capacity: { periods: [] },
  weeks: [],
  weeksTruncated: false,
  scheduled: [TR_A, TR_B],
  unscheduled: [TR_TRAY],
  dependencies: DEPENDENCIES,
  idleGaps: [],
  ...over,
});

const own = move(2, "tr-b", "2042-03-02", "2042-03-03", { from: { start: "2042-02-09", end: "2042-02-10" }, shiftDays: 15, workingDays: 2 });
const RUN: CrossTeamProposal = {
  revision: 10,
  asOf: localIsoDate(),
  passes: 1,
  settled: true,
  scopeHash: "b".repeat(64),
  teams: [
    block(1, "Payments", [own, move(3, "tr-tray", "2042-03-09", "2042-03-10")]),
    block(2, "Beta", [move(21, "bt-linked", "2042-02-23", "2042-02-24", { projectId: 8, projectName: "Taxes", from: { start: "2042-02-16", end: "2042-02-17" }, shiftDays: 5 }), move(22, "bt-other", "2042-02-02", "2042-02-03", { projectId: 8, projectName: "Taxes" })]),
    block(3, "Gamma", [move(31, "gm-moved", "2042-03-16", "2042-03-17", { projectId: 6, projectName: "Reports", from: { start: "2042-03-02", end: "2042-03-03" }, shiftDays: 10 })]),
  ],
  projects: [{ projectId: 9, name: "Whole", before: { start: "2042-02-16", end: "2042-02-27" }, after: { start: "2042-02-23", end: "2042-03-06" }, endShiftDays: 5 }],
};
const SOLO: ScheduleProposal = {
  revision: 10,
  scopeHash: "a".repeat(64),
  asOf: localIsoDate(),
  teamId: 1,
  moves: [own],
  unchanged: [1],
  unplaced: [],
  pinned: [],
  weeks: [],
  weeksTruncated: false,
  dependencies: [],
};

let mockFetch: ReturnType<typeof routeFetch>;
let manages: number[];
/** While set, the run is only answered once `releaseRun` is called: the request window stays open. */
let holdRun: Promise<void> | null;
let releaseRun: () => void;
/** What the accept answers (a body, or a `Response` for a refusal); the rights read answers 500 while `rightsFail` is set. */
let acceptWith: () => unknown;
let rightsFail: boolean;

beforeEach(() => {
  manages = [1, 2];
  holdRun = null;
  releaseRun = () => undefined;
  acceptWith = () => ({ revision: 11, accepted: [2, 3, 21], skipped: [] });
  rightsFail = false;
  mockFetch = routeFetch({
    "GET /api/v1/views/team/1": () => viewOf(),
    "GET /api/v1/teams/1/flow": READ_ONLY_PANEL,
    "GET /api/v1/public-holidays": { items: [] },
    "GET /api/v1/teams": TEAM_LIST,
    "GET /api/v1/baselines": { items: [], can: { manage: false } },
    [`GET ${TEAMS_URL}`]: () => (rightsFail ? jsonResponse(500, { title: "Boom", status: 500 }) : { items: manages.map((id) => ({ id, name: `Team ${id}` })), truncated: false }),
    [`POST ${RUN_URL}`]: () => (holdRun === null ? RUN : holdRun.then(() => RUN)),
    [`POST ${CHECK_URL}`]: { teams: [], projects: [] },
    [`POST ${ACCEPT_URL}`]: () => acceptWith(),
    [`POST ${PER_TEAM_URL}`]: SOLO,
  });
  vi.stubGlobal("fetch", mockFetch);
  localStorage.setItem("astrolabe.auth.token", "fake-token");
  localStorage.setItem("astrolabe.auth.roles", JSON.stringify(["USER"]));
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

const posted = (url: string) => mockFetch.mock.calls.filter(([u, init]) => String(u) === url && (init as RequestInit | undefined)?.method === "POST").map(([, init]) => JSON.parse((init as RequestInit).body as string) as Record<string, unknown>);
const grid = () => screen.getByRole("grid", { name: "Team milestone timeline" });
const proposeButton = () => screen.getByRole("button", { name: "Propose schedule" });
const picker = () => screen.getByRole("combobox", { name: "Plan together with" });
const pills = () => [...document.querySelectorAll(".mantine-MultiSelect-pill")].map((pill) => pill.textContent);
const rowHeaders = () => within(grid()).getAllByRole("row").slice(1).map((row) => row.querySelector('[role="rowheader"]')?.textContent);

async function opened(user: ReturnType<typeof userEvent.setup>) {
  renderWithProviders(
    <main id="main-content" tabIndex={-1}>
      <Routes>
        <Route path="/teams/:id" element={<TeamDetails />} />
      </Routes>
    </main>,
    { route: "/teams/1" },
  );
  await screen.findByRole("grid", { name: "Team milestone timeline" });
  await waitFor(() => expect(proposeButton()).toBeEnabled());
  return user;
}
async function choose(user: ReturnType<typeof userEvent.setup>, ...teams: string[]) {
  for (const team of teams) {
    await user.click(picker());
    await user.click(await screen.findByRole("option", { name: team }));
  }
  await waitFor(() => expect(pills()).toEqual(teams));
}
/** Open the run over Beta and Gamma; with `hold` the answer waits for `releaseRun`. */
async function openRun(user: ReturnType<typeof userEvent.setup>, hold = false) {
  await choose(user, "Beta", "Gamma");
  await waitFor(() => expect(proposeButton()).toBeEnabled());
  if (hold) holdRun = new Promise<void>((resolve) => (releaseRun = resolve));
  await user.click(proposeButton());
  if (!hold) await screen.findByRole("heading", { level: 3, name: "Schedule proposal" });
}

describe("Propose with nothing chosen", () => {
  test("is the per-team proposal it always was: the per-team route, its section, no run, no rights read", async () => {
    const user = await opened(userEvent.setup());
    expect(pills()).toEqual([]);
    await user.click(proposeButton());
    await screen.findByRole("heading", { level: 3, name: "Proposed schedule" });
    expect(posted(PER_TEAM_URL)).toEqual([{ asOf: localIsoDate() }]);
    expect(posted(RUN_URL)).toEqual([]);
    expect(mockFetch.mock.calls.filter(([u]) => String(u) === TEAMS_URL)).toHaveLength(0);
    expect(screen.queryByRole("heading", { name: "Schedule proposal" })).toBeNull();
    // the dimmed rows of a run are not there
    expect(rowHeaders()).toEqual(["tr-a", "tr-b"]);
  });

  test("a picker emptied again is the same", async () => {
    const user = await opened(userEvent.setup());
    await choose(user, "Beta");
    await user.click(screen.getByLabelText("Clear the chosen teams"));
    await waitFor(() => expect(pills()).toEqual([]));
    await user.click(proposeButton());
    await screen.findByRole("heading", { level: 3, name: "Proposed schedule" });
    expect(posted(PER_TEAM_URL)).toHaveLength(1);
    expect(posted(RUN_URL)).toEqual([]);
  });
});

describe("the picker row", () => {
  test("offers every other team (not this one), a reset that clears, and is not drawn without team.can.schedule", async () => {
    const user = await opened(userEvent.setup());
    await user.click(picker());
    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual(["Beta", "Gamma", "Delta"]);
    await user.click(screen.getByRole("option", { name: "Delta" }));
    await waitFor(() => expect(pills()).toEqual(["Delta"]));
    await user.click(screen.getByRole("button", { name: "Plan this team alone" }));
    await waitFor(() => expect(pills()).toEqual([]));
  });

  test("Add linked teams adds the teams at the other ends of the links of the team's milestones, keeping what was chosen", async () => {
    const user = await opened(userEvent.setup());
    await choose(user, "Gamma");
    await user.click(screen.getByRole("button", { name: "Add linked teams" }));
    await waitFor(() => expect(pills()).toEqual(["Beta", "Gamma"]));
    expect(screen.getByRole("button", { name: "Add linked teams" })).toBeDisabled();
  });

  test("a team with no linked team has no Add linked teams", async () => {
    mockFetch = routeFetch({
      "GET /api/v1/views/team/1": () => viewOf({ dependencies: [] }),
      "GET /api/v1/teams/1/flow": READ_ONLY_PANEL,
      "GET /api/v1/public-holidays": { items: [] },
      "GET /api/v1/teams": TEAM_LIST,
      "GET /api/v1/baselines": { items: [], can: { manage: false } },
    });
    vi.stubGlobal("fetch", mockFetch);
    await opened(userEvent.setup());
    expect(picker()).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Add linked teams" })).toBeNull();
  });

  test("without team.can.schedule neither Propose nor the picker is there", async () => {
    mockFetch = routeFetch({
      "GET /api/v1/views/team/1": () => viewOf({ team: { ...viewOf().team, can: { schedule: false, editCapacity: false, editOrder: false } } }),
      "GET /api/v1/teams/1/flow": READ_ONLY_PANEL,
      "GET /api/v1/public-holidays": { items: [] },
      "GET /api/v1/teams": TEAM_LIST,
      "GET /api/v1/baselines": { items: [], can: { manage: false } },
    });
    vi.stubGlobal("fetch", mockFetch);
    renderWithProviders(<Routes><Route path="/teams/:id" element={<TeamDetails />} /></Routes>, { route: "/teams/1" });
    await screen.findByRole("grid", { name: "Team milestone timeline" });
    expect(screen.queryByRole("button", { name: "Propose schedule" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Plan together with" })).toBeNull();
  });
});

describe("the run on the team page", () => {
  test("Propose asks ONE run over this team and the chosen ones; the section's heading takes the focus, the picker is gone, the outline has the run's sections", async () => {
    const user = await opened(userEvent.setup());
    await openRun(user);
    expect(posted(RUN_URL)).toEqual([{ asOf: localIsoDate(), teamIds: [1, 2, 3] }]);
    expect(posted(PER_TEAM_URL)).toEqual([]);
    expect(screen.getByRole("heading", { level: 3, name: "Schedule proposal" })).toHaveFocus();
    expect(screen.queryByRole("combobox", { name: "Plan together with" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Proposed schedule" })).toBeNull();
    expect(headingOutline().filter(([level]) => level === 3).map(([, text]) => text)).toEqual(["Timeline", "Schedule proposal", "Payments", "Beta", "Gamma", "Unscheduled", "Capacity", "Flow", "Weekly load", "Idle gaps"]);
  });

  test("the page is locked from the request until Discard: the picker leaves at once, the tray cannot schedule, Reset order is gone; Discard brings the picker back with the choice", async () => {
    const user = await opened(userEvent.setup());
    await openRun(user, true);
    // requested, not answered yet
    await waitFor(() => expect(posted(RUN_URL)).toHaveLength(1));
    expect(screen.queryByRole("combobox", { name: "Plan together with" })).toBeNull();
    expect(proposeButton()).toBeDisabled();
    releaseRun();
    await screen.findByRole("heading", { level: 3, name: "Schedule proposal" });
    expect(screen.getByRole("button", { name: "Schedule tr-tray" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Reset order" })).toBeNull();
    expect(proposeButton()).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(picker()).toBeEnabled());
    expect(pills()).toEqual(["Beta", "Gamma"]);
    expect(screen.getByRole("button", { name: "Schedule tr-tray" })).toBeEnabled();
  });

  test("a linked milestone of another team and a linked project get dimmed rows after the team's own, with the ghost bar and the dashed bar; a move no link names gets none", async () => {
    const user = await opened(userEvent.setup());
    await openRun(user);
    expect(rowHeaders()).toEqual(["tr-a", "tr-b", "bt-linkedBeta", "Project Whole", "gm-movedGamma", "tr-tray (new)"]);
    const linked = within(grid()).getAllByRole("row").find((row) => row.textContent?.includes("bt-linked")) as HTMLElement;
    expect(within(linked).getByRole("img", { name: "bt-linked, Beta, Taxes, 2042-02-16 to 2042-02-17, linked to this team's work, read-only" })).toHaveAttribute("data-tone", "ghost");
    expect(within(linked).getByRole("img", { name: "Proposed: bt-linked, 2042-02-23 to 2042-02-24, read-only" })).toHaveAttribute("data-tone", "proposal");
    const whole = within(grid()).getAllByRole("row").find((row) => row.textContent?.includes("Project Whole")) as HTMLElement;
    expect(within(whole).getByRole("img", { name: "Proposed: Whole, 2042-02-23 to 2042-03-06, read-only" })).toHaveAttribute("data-tone", "proposal");
    expect(within(grid()).queryByText("bt-other")).toBeNull();
    // the arrows of the two links reach the new rows
    expect([...document.querySelectorAll("[data-arrow]")].map((arrow) => arrow.getAttribute("data-arrow")).sort()).toEqual(["51", "52", "53"]);
  });

  test("unticking Beta's move drops its dashed bar and keeps its row", async () => {
    const user = await opened(userEvent.setup());
    await openRun(user);
    await user.click(await screen.findByRole("checkbox", { name: "Accept bt-linked" }));
    await waitFor(() => expect(screen.queryByRole("img", { name: "Proposed: bt-linked, 2042-02-23 to 2042-02-24, read-only" })).toBeNull());
    expect(rowHeaders()).toContain("bt-linkedBeta");
    expect(screen.getByRole("img", { name: /^bt-linked, Beta, Taxes, 2042-02-16 to 2042-02-17/ })).toBeInTheDocument();
  });

  test("a team the viewer does not manage (Gamma) is a read-only preview: its checkboxes are disabled, its linked move keeps its dashed bar whatever is ticked and is never ticked", async () => {
    const user = await opened(userEvent.setup());
    await openRun(user);
    // the other team's section is collapsed until asked for, and says why its ticks are not the viewer's
    expect(screen.queryByRole("checkbox", { name: "Accept gm-moved" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Show the moves of Gamma" }));
    expect(await screen.findByText(/Shown as it would be if this team's manager accepts/)).toBeInTheDocument();
    expect(await screen.findByRole("checkbox", { name: "Accept gm-moved" })).toBeDisabled();
    // Payments' two moves and Beta's two are ticked: Gamma's one is not offered, and its dashed bar stays
    expect(screen.getByRole("img", { name: "Proposed: gm-moved, 2042-03-16 to 2042-03-17, read-only" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Accept selected (4)" })).toBeEnabled();
  });

  test("a viewer who manages none of the other teams still previews the run on their own team; Accept takes this team's moves", async () => {
    manages = [1];
    const user = await opened(userEvent.setup());
    await openRun(user);
    await user.click(screen.getByRole("button", { name: "Accept selected (2)" }));
    await waitFor(() => expect(posted(ACCEPT_URL)).toHaveLength(1));
    expect(posted(ACCEPT_URL)[0]).toMatchObject({ teamIds: [1, 2, 3], acceptTeamIds: [1], items: [{ milestoneId: 2 }, { milestoneId: 3 }] });
  });

  test("Accept selected is the run's one accept: acceptTeamIds are the teams of the ticked moves, the section closes, the dimmed rows go and the outcome is said once", async () => {
    const user = await opened(userEvent.setup());
    await openRun(user);
    await user.click(screen.getByRole("button", { name: "Accept selected (4)" }));
    await waitFor(() => expect(posted(ACCEPT_URL)).toHaveLength(1));
    expect(posted(ACCEPT_URL)[0]).toEqual({
      expectedRevision: 10,
      scopeHash: "b".repeat(64),
      teamIds: [1, 2, 3],
      acceptTeamIds: [1, 2],
      items: [
        { milestoneId: 2, startDate: "2042-03-02", endDate: "2042-03-03" },
        { milestoneId: 3, startDate: "2042-03-09", endDate: "2042-03-10" },
        { milestoneId: 21, startDate: "2042-02-23", endDate: "2042-02-24" },
        { milestoneId: 22, startDate: "2042-02-02", endDate: "2042-02-03" },
      ],
    });
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Schedule proposal" })).toBeNull());
    expect((await screen.findAllByText("3 scheduled")).length).toBeGreaterThan(0);
    expect(rowHeaders()).not.toContain("bt-linkedBeta");
    expect(posted(PER_TEAM_URL)).toEqual([]);
  });

  test("a failed rights read leaves a preview and says so: no Accept, the same note as the overview and the project page", async () => {
    rightsFail = true;
    const user = await opened(userEvent.setup());
    await choose(user, "Beta");
    await waitFor(() => expect(proposeButton()).toBeEnabled());
    await user.click(proposeButton());
    await screen.findByRole("heading", { level: 3, name: "Schedule proposal" });
    expect(screen.getByText("Could not read which teams you manage; this is a preview only.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Accept selected/ })).toBeNull();
  });

  test("a stale scope asks the same teams again at once: the fresh run opens on its heading with the ticks kept and says so", async () => {
    const user = await opened(userEvent.setup());
    await openRun(user);
    await user.click(screen.getByRole("checkbox", { name: "Accept bt-other" }));
    acceptWith = () => jsonResponse(409, STALE_SCOPE);
    await user.click(screen.getByRole("button", { name: "Accept selected (3)" }));
    await waitFor(() => expect(posted(RUN_URL)).toHaveLength(2));
    expect(posted(RUN_URL)[1]).toEqual({ asOf: localIsoDate(), teamIds: [1, 2, 3] });
    expect(await screen.findByText(/^The plan of the chosen teams changed since the proposal/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("heading", { level: 3, name: "Schedule proposal" })).toHaveFocus());
    expect(screen.getByRole("button", { name: "Accept selected (3)" })).toBeEnabled();
    expect(screen.getByRole("checkbox", { name: "Accept bt-other" })).not.toBeChecked();
  });

  test("a stale revision closes the preview and says nothing was saved", async () => {
    const user = await opened(userEvent.setup());
    await openRun(user);
    acceptWith = () => jsonResponse(409, STALE_REVISION);
    await user.click(screen.getByRole("button", { name: "Accept selected (4)" }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Schedule proposal" })).toBeNull());
    expect((await screen.findAllByText("The plan changed in the meantime — nothing was saved. Propose again.")).length).toBeGreaterThan(0);
    expect(posted(RUN_URL)).toHaveLength(1);
    expect(picker()).toBeEnabled();
  });
});
