import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { screen, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import ProjectView from "./ProjectView";
import type { ProjectMilestone, ProjectView as ProjectViewDocument } from "../api/milestones";
import { headingOutline } from "../test/headings";
import { routeFetch } from "../test/http";
import { planView } from "../test/planView";
import { renderWithProviders } from "../test/render";

// The Milestones table on the project page (1.29): where it sits, that it is shown by default, that the address opens it with a Schedule choice, and
// that a project with nothing to list has no section. The table's own behaviour: components/ProjectMilestonesTable.test.tsx.

const OPEN_KEY = "astrolabe.viewSettings.project.milestonesOpen";

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
  span: scheduled.length === 0 ? null : { start: "2027-01-11", end: "2027-01-15" },
  drift: null,
  scheduled,
  unscheduled,
  dependencies: [],
  idleGaps: [],
  criticalPath: { upstream: [], upstreamTruncated: false },
});

let project: ProjectViewDocument;

beforeEach(() => {
  project = viewOf([milestone(1, "Discovery"), milestone(2, "Build", { startDate: "2027-01-04", endDate: "2027-01-08" })], [milestone(3, "Rollout", { startDate: null, endDate: null })]);
  vi.stubGlobal(
    "fetch",
    routeFetch({
      "GET /api/v1/views/project/7": () => project,
      "GET /api/v1/public-holidays": { items: [] },
      "GET /api/v1/teams": { items: [], page: 1, pageSize: 100, total: 0 },
      "GET /api/v1/views/plan": planView(),
      "GET /api/v1/baselines": { items: [], can: { manage: false } },
      "GET /api/v1/schedule-proposals/teams": { items: [], truncated: false },
    }),
  );
  localStorage.setItem("astrolabe.auth.token", "fake-token");
  localStorage.setItem("astrolabe.auth.roles", JSON.stringify(["USER"]));
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

const renderPage = (route = "/projects/7") =>
  renderWithProviders(
    <main id="main-content" tabIndex={-1}>
      <Routes>
        <Route path="/projects/:id" element={<ProjectView />} />
      </Routes>
    </main>,
    { route },
  );
const table = () => screen.findByRole("table", { name: "Milestones of this project" });
const names = (milestones: HTMLElement) => within(milestones).getAllByRole("row").slice(1).map((row) => within(row).getAllByRole("cell")[0].textContent);

describe("the project page's Milestones table", () => {
  test("shown by default, between the Unscheduled tray and the Dependencies, listing the view's own milestones", async () => {
    renderPage();
    expect(names(await table())).toEqual(["Build", "Discovery", "Rollout"]);
    expect(headingOutline()).toEqual([
      [2, "Invoices"],
      [3, "Timeline"],
      [3, "Unscheduled"],
      [3, "Milestones"],
      [3, "Dependencies"],
      [3, "Idle gaps"],
    ]);
  });

  test("?milestones=unscheduled opens it with the Not scheduled choice even where the browser remembered it hidden, and remembers nothing", async () => {
    localStorage.setItem(OPEN_KEY, "false");
    renderPage("/projects/7?milestones=unscheduled");
    expect(names(await table())).toEqual(["Rollout"]);
    expect(localStorage.getItem(OPEN_KEY)).toBe("false");
  });

  test("hidden, the page shows the heading and the toggle only; showing it again lists the same rows", async () => {
    const user = userEvent.setup();
    localStorage.setItem(OPEN_KEY, "false");
    renderPage();
    await screen.findByRole("grid", { name: "Milestone timeline" });
    expect(screen.queryByRole("table", { name: "Milestones of this project" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show the milestones table" }));
    expect(names(await table())).toEqual(["Build", "Discovery", "Rollout"]);
  });

  test("a project without milestones has the page's empty state and no Milestones section", async () => {
    project = viewOf([], []);
    renderPage();
    await screen.findByText("No milestones yet");
    expect(screen.queryByRole("heading", { name: "Milestones" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /milestones table$/ })).not.toBeInTheDocument();
  });
});
