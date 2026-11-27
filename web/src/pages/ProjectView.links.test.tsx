import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import ProjectView from "./ProjectView";
import type { DependencyEndpoint, ProjectDependency } from "../api/dependencies";
import type { ProjectMilestone, ProjectView as ProjectViewDocument } from "../api/milestones";
import { routeFetch } from "../test/http";
import { planView } from "../test/planView";
import { renderWithProviders } from "../test/render";

// The project page's names as links (1.31): the header sentence's program, work stream and owner; the Team cells of the timeline (each its row's roving stop) and of the
// Milestones table; the Dependencies table's ends. Its own subject (the project's whole-project end) and its own milestones' rows stay plain.

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

const endpoint = (over: Partial<DependencyEndpoint>): DependencyEndpoint => ({
  kind: "MILESTONE",
  id: 1,
  name: "Discovery",
  projectId: 7,
  projectName: "Invoices",
  teamId: 3,
  teamName: "Backend",
  startDate: "2027-01-11",
  endDate: "2027-01-15",
  ...over,
});
const dependency = (id: number, predecessor: DependencyEndpoint, successor: DependencyEndpoint): ProjectDependency => ({
  id,
  predecessor,
  successor,
  type: "FS",
  lagDays: 0,
  check: { status: "OK", shortfallDays: null, slackDays: 0, requiredDate: "2027-01-11", actualDate: "2027-01-11" },
  critical: false,
  can: { edit: false, delete: false },
});

const DISCOVERY = milestone(1, "Discovery", 3, "Backend");
const BUILD = milestone(2, "Build", 4, "Design", { startDate: "2027-01-18", endDate: "2027-01-22" });
const view: ProjectViewDocument = {
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
    can: { edit: false, delete: false, editTargetWindow: false, createMilestone: false, createDependency: false },
  },
  span: { start: "2027-01-11", end: "2027-01-22" },
  drift: null,
  scheduled: [DISCOVERY, BUILD],
  unscheduled: [milestone(3, "Rollout", 8, "Mobile", { startDate: null, endDate: null })],
  dependencies: [
    dependency(31, endpoint({ id: 21, name: "a1", projectId: 99, projectName: "Alpha", teamId: 8, teamName: "Mobile" }), endpoint({})),
    dependency(32, endpoint({ kind: "PROJECT", id: 7, name: "Invoices", teamId: null, teamName: null }), endpoint({ kind: "PROJECT", id: 99, name: "Alpha", projectId: 99, projectName: "Alpha", teamId: null, teamName: null })),
  ],
  idleGaps: [],
  criticalPath: { upstream: [], upstreamTruncated: false },
};

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    routeFetch({
      "GET /api/v1/views/project/7": () => view,
      "GET /api/v1/public-holidays": { items: [] },
      "GET /api/v1/teams": { items: [], page: 1, pageSize: 100, total: 0 },
      "GET /api/v1/views/plan": planView(),
      "GET /api/v1/baselines": { items: [], can: { manage: false } },
    }),
  );
  localStorage.setItem("astrolabe.auth.token", "fake-token");
  localStorage.setItem("astrolabe.auth.roles", JSON.stringify(["USER"]));
});
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

const renderPage = () =>
  renderWithProviders(
    <main id="main-content" tabIndex={-1}>
      <Routes>
        <Route path="/projects/:id" element={<ProjectView />} />
      </Routes>
    </main>,
    { route: "/projects/7" },
  );

describe("the project page's names as links", () => {
  test("the header sentence links its program, work stream and owner, the words between them plain", async () => {
    renderPage();
    const grid = await screen.findByRole("grid", { name: "Milestone timeline" });
    expect(grid).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open program Billing" })).toHaveAttribute("href", "/roadmap?mode=overview&programId=70");
    expect(screen.getByRole("link", { name: "Open work stream Platform" })).toHaveAttribute("href", "/roadmap?mode=overview&workStreamId=700");
    const owner = screen.getByRole("link", { name: "Open person Ola Owner" });
    expect(owner).toHaveAttribute("href", "/people/5");
    expect(owner.parentElement).toHaveTextContent("Billing · Platform · Owner: Ola Owner");
    // Text shares their block, so colour and hover alone would not tell them apart (axe `link-in-text-block`): underlined always.
    for (const link of [owner, screen.getByRole("link", { name: "Open program Billing" }), screen.getByRole("link", { name: "Open work stream Platform" })]) expect(link).toHaveAttribute("data-underline", "always");
  });

  test("a team's name in a timeline row is the cell's link (its roving stop), the milestone's own name stays plain", async () => {
    renderPage();
    const grid = await screen.findByRole("grid", { name: "Milestone timeline" });
    const build = within(grid).getByRole("rowheader", { name: /^Build/ }).closest('[role="row"]') as HTMLElement;
    const team = within(build).getByRole("link", { name: "Open team Design" });
    expect(team).toHaveAttribute("href", "/teams/4");
    // the cell's roving stop (a link in a grid cell carries the grid position)
    expect(team).toHaveAttribute("data-grid-pos");
    expect(within(build).queryByRole("link", { name: /Open milestone/ })).toBeNull();
    // A ghost row names another project's milestone and that milestone's team.
    expect(within(grid).getByRole("link", { name: "Open team Mobile" })).toHaveAttribute("href", "/teams/8");
  });

  test("the Unscheduled tray links its team names", async () => {
    renderPage();
    const tray = await screen.findByRole("table", { name: "Unscheduled milestones" });
    expect(within(within(tray).getByRole("row", { name: /Rollout/ })).getByRole("link", { name: "Open team Mobile" })).toHaveAttribute("href", "/teams/8");
  });

  test("the Milestones table links its Team cells too", async () => {
    renderPage();
    const table = await screen.findByRole("table", { name: "Milestones of this project" });
    expect(within(table).getByRole("link", { name: "Open team Backend" })).toHaveAttribute("href", "/teams/3");
    expect(within(table).queryByRole("link", { name: /Open milestone/ })).toBeNull();
  });

  test("the Dependencies table links a milestone end (and another project's name after it) and a whole-project end, but not this project as a whole", async () => {
    renderPage();
    const table = await screen.findByRole("table", { name: "Dependencies of the project" });
    const [first, second] = within(table).getAllByRole("row").slice(1);
    expect(within(first).getByRole("link", { name: "Open milestone a1" })).toHaveAttribute("href", "/projects/99?milestone=21");
    expect(within(first).getByRole("link", { name: "Open project Alpha" })).toHaveAttribute("href", "/projects/99");
    // The page's own milestone is a link too: it leads to its marked row on this very page.
    expect(within(first).getByRole("link", { name: "Open milestone Discovery" })).toHaveAttribute("href", "/projects/7?milestone=1");
    expect(within(second).getByRole("link", { name: "Open project Alpha" })).toHaveTextContent("Project Alpha");
    expect(within(second).queryByRole("link", { name: "Open project Invoices" })).toBeNull();
    expect(second).toHaveTextContent("Project Invoices");
  });
});
