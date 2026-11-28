import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { cleanup, screen, waitFor } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import ProjectView from "./ProjectView";
import type { ProjectDependency } from "../api/dependencies";
import type { ProjectMilestone, ProjectView as ProjectViewDocument } from "../api/milestones";
import type { RoadmapLink, RoadmapView } from "../api/roadmap";
import { block, CHECK_URL, move, RUN_URL, TEAMS_URL } from "../test/crossTeamRun";
import { routeFetch } from "../test/http";
import { TEAM_LIST } from "../test/overviewRun";
import { planView } from "../test/planView";
import { jsonResponse } from "../test/http";
import { roadmapProject, roadmapView } from "../test/roadmapView";
import { renderWithProviders } from "../test/render";
import { localIsoDate } from "../utils/isoDate";

// The project page's team picker (1.38): the run starts over the teams of the project's milestones and may be asked over any other active teams; an untouched picker asks exactly that
// set, a changed one has a reset, the picker is off while a run is open, and an empty choice keeps Propose off with its reason.

const milestone = (id: number, name: string, teamId: number, teamName: string): ProjectMilestone => ({
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
});
const VIEW: ProjectViewDocument = {
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
  span: { start: "2027-01-11", end: "2027-01-15" },
  drift: null,
  scheduled: [milestone(1, "Discovery", 1, "Alpha"), milestone(2, "Build", 2, "Beta")],
  unscheduled: [],
  dependencies: [],
  idleGaps: [],
  criticalPath: { upstream: [], upstreamTruncated: false },
};
const RUN = {
  revision: 12,
  asOf: localIsoDate(),
  passes: 1,
  settled: true,
  scopeHash: "b".repeat(64),
  teams: [block(1, "Alpha", [move(1, "Discovery", "2027-01-18", "2027-01-22", { projectId: 7, projectName: "Invoices", shiftDays: 5 })])],
  projects: [],
};

let mockFetch: ReturnType<typeof routeFetch>;
// The page's view and the Roadmap document a closure click reads: a test swaps them (the default page waits on nothing, so the button is not drawn).
let view: ProjectViewDocument = VIEW;
let roadmap: () => unknown = () => roadmapView();

beforeEach(() => {
  mockFetch = routeFetch({
    "GET /api/v1/views/project/7": () => view,
    "GET /api/v1/views/roadmap": () => roadmap(),
    "GET /api/v1/public-holidays": { items: [] },
    "GET /api/v1/teams": TEAM_LIST,
    "GET /api/v1/views/plan": planView(),
    "GET /api/v1/baselines": { items: [], can: { manage: false } },
    [`GET ${TEAMS_URL}`]: { items: [{ id: 1, name: "Alpha" }, { id: 2, name: "Beta" }], truncated: false },
    [`POST ${RUN_URL}`]: RUN,
    [`POST ${CHECK_URL}`]: { teams: [] },
  });
  vi.stubGlobal("fetch", mockFetch);
  localStorage.setItem("astrolabe.auth.token", "fake-token");
  localStorage.setItem("astrolabe.auth.roles", JSON.stringify(["USER"]));
});

afterEach(() => {
  view = VIEW;
  roadmap = () => roadmapView();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const posted = () => mockFetch.mock.calls.filter(([u, init]) => String(u) === RUN_URL && (init as RequestInit | undefined)?.method === "POST").map(([, init]) => JSON.parse((init as RequestInit).body as string) as Record<string, unknown>);
const proposeButton = () => screen.getByRole("button", { name: "Propose schedule" });
const picker = () => screen.getByRole("combobox", { name: "Teams in the run" });
const pills = () => [...document.querySelectorAll(".mantine-MultiSelect-pill")].map((pill) => pill.textContent);
const roadmapReads = () => mockFetch.mock.calls.filter(([u]) => String(u) === "/api/v1/views/roadmap").length;
const resetButton = () => screen.queryByRole("button", { name: "Use this page's teams" });

async function opened() {
  renderWithProviders(
    <main id="main-content" tabIndex={-1}>
      <Routes>
        <Route path="/projects/:id" element={<ProjectView />} />
      </Routes>
    </main>,
    { route: "/projects/7" },
  );
  await screen.findByRole("grid", { name: "Milestone timeline" });
  await waitFor(() => expect(proposeButton()).toBeEnabled());
  await waitFor(() => expect(pills()).toEqual(["Alpha", "Beta"]));
}
async function toggle(user: ReturnType<typeof userEvent.setup>, team: string) {
  await user.click(picker());
  await user.click(await screen.findByRole("option", { name: team }));
}

describe("the run's team picker on the project page", () => {
  test("starts from the project's teams with no reset; an untouched picker asks exactly those", async () => {
    const user = userEvent.setup();
    await opened();
    expect(resetButton()).toBeNull();
    await user.click(proposeButton());
    await screen.findByRole("heading", { name: "Schedule proposal" });
    expect(posted()).toEqual([{ asOf: localIsoDate(), teamIds: [1, 2] }]);
  });

  test("any active team can be added; the row says the teams are chosen, and the reset puts the project's teams back", async () => {
    const user = userEvent.setup();
    await opened();
    await toggle(user, "Gamma");
    await waitFor(() => expect(pills()).toEqual(["Alpha", "Beta", "Gamma"]));
    expect(screen.getByText(/^Proposes dates for the 3 teams you chose; other teams' dates are kept/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Use this page's teams" }));
    await waitFor(() => expect(pills()).toEqual(["Alpha", "Beta"]));
    expect(resetButton()).toBeNull();
    await toggle(user, "Delta");
    await waitFor(() => expect(pills()).toEqual(["Alpha", "Beta", "Delta"]));
    await user.click(proposeButton());
    await screen.findByRole("heading", { name: "Schedule proposal" });
    expect(posted()).toEqual([{ asOf: localIsoDate(), teamIds: [1, 2, 4] }]);
  });

  test("Propose again asks over the chosen team set again (the picker cannot change under an open run)", async () => {
    const user = userEvent.setup();
    await opened();
    await toggle(user, "Beta");
    await waitFor(() => expect(pills()).toEqual(["Alpha"]));
    await user.click(proposeButton());
    await screen.findByRole("heading", { name: "Schedule proposal" });
    await user.click(screen.getByRole("button", { name: "Propose again" }));
    await waitFor(() => expect(posted()).toHaveLength(2));
    expect(posted()[1]).toEqual({ asOf: localIsoDate(), teamIds: [1] });
  });

  test("an empty choice keeps Propose off and says to choose a team", async () => {
    const user = userEvent.setup();
    await opened();
    await user.click(screen.getByLabelText("Clear the chosen teams"));
    expect(await screen.findByText("Choose at least one team.")).toBeInTheDocument();
    expect(proposeButton()).toBeDisabled();
    expect(proposeButton()).toHaveAccessibleDescription("Choose at least one team.");
  });

  test("the picker is not drawn while a run is open and is back after Discard, the choice kept", async () => {
    const user = userEvent.setup();
    await opened();
    await toggle(user, "Beta");
    await waitFor(() => expect(pills()).toEqual(["Alpha"]));
    await user.click(proposeButton());
    await screen.findByRole("heading", { name: "Schedule proposal" });
    expect(posted()).toEqual([{ asOf: localIsoDate(), teamIds: [1] }]);
    expect(screen.queryByRole("combobox", { name: "Teams in the run" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(picker()).toBeEnabled());
    expect(pills()).toEqual(["Alpha"]);
  });
});

// "Add the teams this project waits on" (1.39): a button on the project page only, shown while a link into the project has its predecessor in another project; a click reads the Roadmap
// document, walks the whole upstream chain and adds every team of it to the picker, up to the run's 50 teams.
const endpoint = (projectId: number, id: number) => ({ kind: "MILESTONE" as const, id, name: `M${id}`, projectId, projectName: `P${projectId}`, teamId: 1, teamName: "Alpha", startDate: null, endDate: null });
const dependency = (id: number, predecessor: ProjectDependency["predecessor"], successor: ProjectDependency["successor"]): ProjectDependency => ({
  id,
  predecessor,
  successor,
  type: "FS",
  lagDays: 0,
  check: { status: "UNSCHEDULED", shortfallDays: null, slackDays: null, requiredDate: null, actualDate: null },
  critical: false,
  can: { edit: false, delete: false },
});
const WAITING: ProjectViewDocument = { ...VIEW, dependencies: [dependency(1, endpoint(8, 80), endpoint(7, 1))] };
const pair = (predecessorProjectId: number, successorProjectId: number): RoadmapLink => ({ predecessorProjectId, successorProjectId, direct: null, milestoneLinks: { count: 1, violated: 0, unscheduled: 0 } });
/** 7 (this one, teams 1 and 2) waits on 8 (team 3), which waits on 9 (team 4). */
const chain = (over: Partial<RoadmapView> = {}): RoadmapView =>
  roadmapView({
    ranked: [
      { position: 1, project: roadmapProject({ id: 7, name: "Invoices", teamIds: [1, 2] }) },
      { position: 2, project: roadmapProject({ id: 8, name: "Taxes", teamIds: [3] }) },
    ],
    unranked: [roadmapProject({ id: 9, name: "Ledger", teamIds: [4] })],
    links: [pair(8, 7), pair(9, 8)],
    ...over,
  });
const closureButton = () => screen.queryByRole("button", { name: "Add the teams this project waits on" });
// A closure outcome is a visible note AND said into the page's polite status region: two elements carry the sentence.
const noted = async (text: string | RegExp) => {
  const hits = await screen.findAllByText(text, { exact: false });
  expect(hits.some((hit) => hit.closest("[role=note]") !== null)).toBe(true);
  expect(hits.some((hit) => hit.closest("[role=status]") !== null)).toBe(true);
};
const notes = (text: string) => screen.queryAllByRole("note").filter((note) => note.textContent?.includes(text));

describe("the dependency closure of the run on the project page", () => {
  test("is not drawn while the project waits on nothing, on a link inside the project, or on a project that waits on THIS one", async () => {
    await opened();
    expect(closureButton()).toBeNull();
    cleanup();
    view = { ...VIEW, dependencies: [dependency(1, endpoint(7, 2), endpoint(7, 1)), dependency(2, endpoint(7, 2), endpoint(9, 90))] };
    await opened();
    expect(closureButton()).toBeNull();
    expect(roadmapReads()).toBe(0);
  });

  test("is drawn for a project that waits on another one, and the Roadmap is not read until the click", async () => {
    view = WAITING;
    await opened();
    expect(closureButton()).toBeEnabled();
    expect(roadmapReads()).toBe(0);
  });

  test("a click adds every team of the whole upstream chain to the picker, says how many in a note and the status region, and the run asks over them", async () => {
    const user = userEvent.setup();
    view = WAITING;
    roadmap = () => chain();
    await opened();
    await user.click(closureButton()!);
    await waitFor(() => expect(pills()).toEqual(["Alpha", "Beta", "Gamma", "Delta"]));
    await noted("Added 2 teams this project waits on.");
    expect(roadmapReads()).toBe(1);
    expect(resetButton()).not.toBeNull();
    await user.click(proposeButton());
    await screen.findByRole("heading", { name: "Schedule proposal" });
    expect(posted()).toEqual([{ asOf: localIsoDate(), teamIds: [1, 2, 3, 4] }]);
  });

  test("keeps the teams the viewer already chose (the union), and a second click finds nothing to add", async () => {
    const user = userEvent.setup();
    view = WAITING;
    roadmap = () => chain({ links: [pair(8, 7)] });
    await opened();
    await toggle(user, "Delta");
    await waitFor(() => expect(pills()).toEqual(["Alpha", "Beta", "Delta"]));
    await user.click(closureButton()!);
    await waitFor(() => expect(pills()).toEqual(["Alpha", "Beta", "Gamma", "Delta"]));
    await user.click(closureButton()!);
    await noted("Nothing to add: the teams of the projects this one waits on are already in the run.");
    expect(pills()).toEqual(["Alpha", "Beta", "Gamma", "Delta"]);
  });

  test("a chain through a cycle ends; a project with no teams adds nothing", async () => {
    const user = userEvent.setup();
    view = WAITING;
    roadmap = () => chain({ links: [pair(8, 7), pair(9, 8), pair(7, 9)], ranked: [{ position: 1, project: roadmapProject({ id: 7, teamIds: [1, 2] }) }, { position: 2, project: roadmapProject({ id: 8, teamIds: [] }) }] });
    await opened();
    await user.click(closureButton()!);
    await noted("Added 1 team this project waits on.");
    expect(pills()).toEqual(["Alpha", "Beta", "Delta"]);
  });

  test("stops before the 50-team bound and says so: whole projects, the nearest first", async () => {
    const user = userEvent.setup();
    view = WAITING;
    const many = Array.from({ length: 50 }, (_, index) => 100 + index);
    roadmap = () => chain({ unranked: [roadmapProject({ id: 9, teamIds: many })] });
    await opened();
    await user.click(closureButton()!);
    await noted(/^Added 1 team, then stopped: a proposal takes at most 50 teams/);
    expect(pills()).toEqual(["Alpha", "Beta", "Gamma"]);
    expect(proposeButton()).toBeEnabled();
  });

  test("when even the nearest project would pass the bound nothing is added", async () => {
    const user = userEvent.setup();
    view = WAITING;
    roadmap = () => chain({ ranked: [{ position: 1, project: roadmapProject({ id: 8, teamIds: Array.from({ length: 49 }, (_, index) => 100 + index) }) }] });
    await opened();
    await user.click(closureButton()!);
    await noted("Nothing added: the next project upstream would take the proposal past 50 teams.");
    expect(pills()).toEqual(["Alpha", "Beta"]);
  });

  test("a failed read says so, adds nothing and can be tried again", async () => {
    const user = userEvent.setup();
    view = WAITING;
    roadmap = () => jsonResponse(500, { type: "about:blank", title: "Internal Server Error", status: 500 });
    await opened();
    await user.click(closureButton()!);
    await noted("The roadmap could not be read, so no teams were added. Try again.");
    expect(pills()).toEqual(["Alpha", "Beta"]);
    expect(closureButton()).toBeEnabled();
    roadmap = () => chain();
    await user.click(closureButton()!);
    await waitFor(() => expect(pills()).toEqual(["Alpha", "Beta", "Gamma", "Delta"]));
    expect(notes("could not be read")).toHaveLength(0);
  });

  test("is disabled while the Roadmap is read", async () => {
    const user = userEvent.setup();
    view = WAITING;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    roadmap = () => gate.then(() => chain());
    await opened();
    await user.click(closureButton()!);
    await waitFor(() => expect(closureButton()).toBeDisabled());
    release();
    await waitFor(() => expect(closureButton()).toBeEnabled());
    expect(roadmapReads()).toBe(1);
  });

  test("Propose is off, with its hint, while the Roadmap is read, so no run starts over a set the answer is about to change; it is back with the new set", async () => {
    const user = userEvent.setup();
    view = WAITING;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    roadmap = () => gate.then(() => chain());
    await opened();
    await user.click(closureButton()!);
    await waitFor(() => expect(proposeButton()).toBeDisabled());
    expect(proposeButton()).toHaveAccessibleDescription("Reading the roadmap for the teams this project waits on…");
    await user.click(proposeButton());
    expect(posted()).toEqual([]);
    release();
    await waitFor(() => expect(proposeButton()).toBeEnabled());
    expect(pills()).toEqual(["Alpha", "Beta", "Gamma", "Delta"]);
    await user.click(proposeButton());
    await screen.findByRole("heading", { name: "Schedule proposal" });
    expect(posted()).toEqual([{ asOf: localIsoDate(), teamIds: [1, 2, 3, 4] }]);
  });

  test("is not drawn while a run is open, its note is gone with the request, and it is back after Discard", async () => {
    const user = userEvent.setup();
    view = WAITING;
    roadmap = () => chain();
    await opened();
    await user.click(closureButton()!);
    await noted("Added 2 teams this project waits on.");
    await user.click(proposeButton());
    await screen.findByRole("heading", { name: "Schedule proposal" });
    expect(closureButton()).toBeNull();
    expect(notes("Added 2 teams this project waits on.")).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(closureButton()).toBeEnabled());
    expect(notes("Added 2 teams this project waits on.")).toHaveLength(0);
    expect(pills()).toEqual(["Alpha", "Beta", "Gamma", "Delta"]);
  });

  test("a hand edit of the picker drops the note", async () => {
    const user = userEvent.setup();
    view = WAITING;
    roadmap = () => chain();
    await opened();
    await user.click(closureButton()!);
    await noted("Added 2 teams this project waits on.");
    await user.click(screen.getByRole("button", { name: "Use this page's teams" }));
    await waitFor(() => expect(notes("Added 2 teams this project waits on.")).toHaveLength(0));
  });

  test("the run over the chain moves the upstream project's milestone, which this page cannot tick: it is counted, and the check asks about this project's ticked move alone", async () => {
    const user = userEvent.setup();
    view = WAITING;
    roadmap = () => chain();
    const upstream = move(80, "Tax rules", "2027-01-04", "2027-01-08", { projectId: 8, projectName: "Taxes" });
    mockFetch = routeFetch({
      "GET /api/v1/views/project/7": () => view,
      "GET /api/v1/views/roadmap": () => roadmap(),
      "GET /api/v1/public-holidays": { items: [] },
      "GET /api/v1/teams": TEAM_LIST,
      "GET /api/v1/views/plan": planView(),
      "GET /api/v1/baselines": { items: [], can: { manage: false } },
      [`GET ${TEAMS_URL}`]: { items: [{ id: 1, name: "Alpha" }, { id: 3, name: "Gamma" }], truncated: false },
      [`POST ${RUN_URL}`]: { ...RUN, teams: [...RUN.teams, block(3, "Gamma", [upstream])] },
      [`POST ${CHECK_URL}`]: { teams: [] },
    });
    vi.stubGlobal("fetch", mockFetch);
    await opened();
    await user.click(closureButton()!);
    await waitFor(() => expect(pills()).toEqual(["Alpha", "Beta", "Gamma", "Delta"]));
    await user.click(proposeButton());
    await screen.findByRole("heading", { name: "Schedule proposal" });
    expect(screen.getByText(/^The run also moves 1 other milestone of these teams, not offered here:/)).toBeInTheDocument();
    await waitFor(() => {
      const checks = mockFetch.mock.calls.filter(([u, init]) => String(u) === CHECK_URL && (init as RequestInit | undefined)?.method === "POST");
      expect(checks.length).toBeGreaterThan(0);
      const body = JSON.parse((checks[checks.length - 1][1] as RequestInit).body as string) as { items: { milestoneId: number }[] };
      expect(body.items.map((item) => item.milestoneId)).toEqual([1]);
    });
  });
});
