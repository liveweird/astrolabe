import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { screen, waitFor } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import ProjectView from "./ProjectView";
import type { ProjectMilestone, ProjectView as ProjectViewDocument } from "../api/milestones";
import { block, CHECK_URL, move, RUN_URL, TEAMS_URL } from "../test/crossTeamRun";
import { routeFetch } from "../test/http";
import { TEAM_LIST } from "../test/overviewRun";
import { planView } from "../test/planView";
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

beforeEach(() => {
  mockFetch = routeFetch({
    "GET /api/v1/views/project/7": () => VIEW,
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
  vi.unstubAllGlobals();
  localStorage.clear();
});

const posted = () => mockFetch.mock.calls.filter(([u, init]) => String(u) === RUN_URL && (init as RequestInit | undefined)?.method === "POST").map(([, init]) => JSON.parse((init as RequestInit).body as string) as Record<string, unknown>);
const proposeButton = () => screen.getByRole("button", { name: "Propose schedule" });
const picker = () => screen.getByRole("combobox", { name: "Teams in the run" });
const pills = () => [...document.querySelectorAll(".mantine-MultiSelect-pill")].map((pill) => pill.textContent);
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
