import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { screen, waitFor, within } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import { Route, Routes, useLocation } from "react-router-dom";
import ProjectView from "./ProjectView";
import type { ProjectMilestone, ProjectView as ProjectViewDocument } from "../api/milestones";
import { projectViewKey } from "../hooks/useMilestoneSchedule";
import { jsonResponse, routeFetch } from "../test/http";
import { planView } from "../test/planView";
import { renderWithProviders } from "../test/render";

// A milestone's address on the project page (1.31): `?milestone=M` marks and focuses its timeline row (or its tray row) and its row of the Milestones
// table, then leaves the address; a milestone the project does not have is a notice, not an error page. The hook's own cases: hooks/useMilestoneArrival.test.tsx.

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
    }),
  );
  localStorage.setItem("astrolabe.auth.token", "fake-token");
  localStorage.setItem("astrolabe.auth.roles", JSON.stringify(["USER"]));
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

function Where() {
  const { pathname, search } = useLocation();
  return <output data-testid="where">{pathname + search}</output>;
}

const renderPage = (route: string) =>
  renderWithProviders(
    <main id="main-content" tabIndex={-1}>
      <Routes>
        <Route path="/projects/:id" element={<ProjectView />} />
      </Routes>
      <Where />
    </main>,
    { route },
  );
const where = () => screen.getByTestId("where").textContent;
const tableRowOf = (name: string) => within(screen.getByRole("table", { name: "Milestones of this project" })).getByRole("row", { name: new RegExp(`^${name}`) });

describe("a milestone's address on the project page", () => {
  test("a scheduled milestone: its timeline row header is marked and focused, its Milestones table row is marked, the parameter leaves the address", async () => {
    renderPage("/projects/7?milestone=2");
    const header = await screen.findByRole("rowheader", { name: /^Build/ });
    await waitFor(() => expect(header).toHaveFocus());
    expect(header).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("rowheader", { name: /^Discovery/ })).not.toHaveAttribute("aria-current");
    expect(tableRowOf("Build")).toHaveAttribute("aria-current", "true");
    expect(tableRowOf("Discovery")).not.toHaveAttribute("aria-current");
    await waitFor(() => expect(where()).toBe("/projects/7"));
  });

  test("an unscheduled milestone: its tray row is marked and focused, no timeline row is marked", async () => {
    renderPage("/projects/7?milestone=3&milestones=all");
    const tray = await screen.findByRole("table", { name: "Unscheduled milestones" });
    const row = within(tray).getByRole("row", { name: /Rollout/ });
    await waitFor(() => expect(row).toHaveFocus());
    expect(row).toHaveAttribute("aria-current", "true");
    expect(tableRowOf("Rollout")).toHaveAttribute("aria-current", "true");
    expect(within(screen.getByRole("grid")).queryAllByRole("rowheader").filter((cell) => cell.hasAttribute("aria-current"))).toHaveLength(0);
    await waitFor(() => expect(where()).toBe("/projects/7?milestones=all"));
  });

  test("a milestone the project does not have: a dismissible notice, the page works, nothing is marked, the parameter leaves the address", async () => {
    const user = userEvent.setup();
    renderPage("/projects/7?milestone=99");
    // the visible note is a plain `note`; the always-mounted polite status region says it
    expect(await screen.findByRole("note")).toHaveTextContent(/That milestone is not in this project any more/);
    await waitFor(() => expect(screen.getAllByRole("status").map((region) => region.textContent).join("")).toMatch(/That milestone is not in this project any more/));
    expect(await screen.findByRole("grid", { name: "Milestone timeline" })).toBeInTheDocument();
    expect(document.querySelectorAll("[aria-current]")).toHaveLength(0);
    await waitFor(() => expect(where()).toBe("/projects/7"));
    await user.click(screen.getByRole("button", { name: "Dismiss this notice" }));
    expect(screen.queryByRole("note")).toBeNull();
    await waitFor(() => expect(screen.getAllByRole("status").map((region) => region.textContent).join("")).not.toMatch(/That milestone/));
  });

  test("a failed refetch behind a cached copy that lacks the milestone says nothing: no notice, the address is left as it came", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "GET /api/v1/views/project/7": () => jsonResponse(500, { title: "Server error", status: 500 }),
        "GET /api/v1/public-holidays": { items: [] },
        "GET /api/v1/teams": { items: [], page: 1, pageSize: 100, total: 0 },
        "GET /api/v1/views/plan": planView(),
        "GET /api/v1/baselines": { items: [], can: { manage: false } },
      }),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(projectViewKey(7, null), project);
    renderWithProviders(
      <main id="main-content" tabIndex={-1}>
        <Routes>
          <Route path="/projects/:id" element={<ProjectView />} />
        </Routes>
        <Where />
      </main>,
      { route: "/projects/7?milestone=99", queryClient },
    );
    await screen.findByRole("grid", { name: "Milestone timeline" });
    await waitFor(() => expect(queryClient.getQueryState(projectViewKey(7, null))?.status).toBe("error"));
    expect(screen.queryByText(/That milestone is not in this project any more/)).toBeNull();
    expect(where()).toBe("/projects/7?milestone=99");
  });

  test("the focus is taken once: after it moved on, a later write of the view does not take it back", async () => {
    renderPage("/projects/7?milestone=2");
    const header = await screen.findByRole("rowheader", { name: /^Build/ });
    await waitFor(() => expect(header).toHaveFocus());
    await waitFor(() => expect(where()).toBe("/projects/7"));
    // the page re-renders (a zoom change); the mark stays and the row does not take the focus back from the control the user moved to
    const month = screen.getByRole("radio", { name: "Month" });
    await userEvent.setup().click(month);
    expect(screen.getByRole("rowheader", { name: /^Build/ })).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("rowheader", { name: /^Build/ })).not.toHaveFocus();
    expect(month).toHaveFocus();
  });
});
