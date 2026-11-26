import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import ProjectTimeline from "./ProjectTimeline";
import TimelineDndContext from "./TimelineDndContext";
import type { MilestoneActions } from "./MilestoneMenu";
import type { DependencyEndpoint, ProjectDependency } from "../api/dependencies";
import type { ProjectMilestone, ProjectView } from "../api/milestones";
import { routeFetch } from "../test/http";
import { renderWithProviders } from "../test/render";
import { makeScale, toEpochDay } from "../utils/timelineScale";

// Team colours on the project timeline (1.29): a milestone bar and a ghost end with a team take the team's colour (`data-tint` on the bar's frame, what
// tests read, never the colour), the Team cell carries a swatch beside the name, and everything else stays neutral. The colours come from the one cached
// teams read (`useTeamColours`); a team it lacks, or a read that has not answered, draws today's neutral bar.

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
  startDate: "2042-02-02",
  endDate: "2042-02-06",
  createdAt: 1,
  updatedAt: 2,
  slackDays: null,
  critical: false,
  pinned: false,
  can: { edit: true, delete: true, schedule: true },
  ...over,
});

const BACKEND = milestone(1, "pt-backend", 3, "Backend");
const DESIGN = milestone(2, "pt-design", 4, "Design", { startDate: "2042-02-09", endDate: "2042-02-10" });
const GONE = milestone(3, "pt-gone", 99, "Retired", { startDate: "2042-02-11", endDate: "2042-02-12" });

const endpoint = (kind: "MILESTONE" | "PROJECT", id: number, name: string, teamId: number | null, teamName: string | null): DependencyEndpoint => ({
  kind,
  id,
  name,
  projectId: 99,
  projectName: "Other",
  teamId,
  teamName,
  startDate: "2042-01-26",
  endDate: "2042-01-30",
});

const own = (m: ProjectMilestone): DependencyEndpoint => ({ ...endpoint("MILESTONE", m.id, m.name, m.teamId, m.teamName), projectId: 7, projectName: "Invoices" });

const link = (id: number, predecessor: DependencyEndpoint, successor: DependencyEndpoint): ProjectDependency => ({
  id,
  predecessor,
  successor,
  type: "FS",
  lagDays: 0,
  check: { status: "OK", shortfallDays: null, slackDays: 0, requiredDate: "2042-02-02", actualDate: "2042-02-02" },
  critical: false,
  can: { edit: false, delete: false },
});

const viewOf = (over: Partial<ProjectView> = {}): ProjectView => ({
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
    can: { edit: true, delete: true, editTargetWindow: true, createMilestone: true, createDependency: true },
  },
  span: { start: "2042-02-02", end: "2042-02-12" },
  drift: null,
  scheduled: [BACKEND, DESIGN, GONE],
  unscheduled: [],
  dependencies: [
    link(41, endpoint("MILESTONE", 91, "pt-ghost", 4, "Design"), own(BACKEND)),
    link(42, endpoint("PROJECT", 92, "Whole other", null, null), own(DESIGN)),
    link(43, endpoint("MILESTONE", 93, "pt-orphan", 98, "Closed down"), own(GONE)),
  ],
  idleGaps: [],
  criticalPath: { upstream: [], upstreamTruncated: false },
  ...over,
});

const NOOP = vi.fn();
const ACTIONS: MilestoneActions = { edit: NOOP, editSchedule: NOOP, unschedule: NOOP, pin: NOOP, remove: NOOP, schedule: NOOP, scheduleOnJira: NOOP, addDependency: NOOP };

/** The teams read of the colour lookup: Backend INDIGO, Design TEAL (the other teams are deleted, so absent). */
const TEAMS = {
  items: [
    { id: 3, name: "Backend", description: null, managerPersonId: null, managerName: null, colour: "INDIGO", createdAt: 1, updatedAt: 2 },
    { id: 4, name: "Design", description: null, managerPersonId: null, managerName: null, colour: "TEAL", createdAt: 1, updatedAt: 2 },
  ],
  page: 1,
  pageSize: 100,
  total: 2,
};

function renderTimeline(view: ProjectView) {
  const scale = makeScale("week", { from: toEpochDay("2042-01-20"), to: toEpochDay("2042-02-22") });
  return renderWithProviders(
    <TimelineDndContext scale={scale} onSchedule={vi.fn(() => true)} onReorder={vi.fn(() => true)}>
      <ProjectTimeline view={view} scale={scale} onZoomChange={vi.fn()} today="2042-01-21" busy={false} actions={ACTIONS} label="Project timeline" criticalPath={false} toolbar={null} jira={null} />
    </TimelineDndContext>,
  );
}

const grid = () => screen.getByRole("grid", { name: "Project timeline" });
const rowOf = (name: string) => within(grid()).getAllByRole("row").slice(1).find((row) => row.textContent?.includes(name)) as HTMLElement;
const tintOf = (name: string) => rowOf(name).querySelector("[data-tint]")?.getAttribute("data-tint") ?? null;

beforeEach(() => {
  vi.stubGlobal("fetch", routeFetch({ "GET /api/v1/teams": TEAMS, "GET /api/v1/public-holidays": { items: [] } }));
  localStorage.setItem("astrolabe.auth.token", "fake-token");
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("ProjectTimeline team colours", () => {
  test("each milestone bar takes its team's colour once the teams read answers; before that, and for a team the read lacks, it stays neutral", async () => {
    renderTimeline(viewOf());
    // before the read has answered: today's neutral bars
    expect(tintOf("pt-backend")).toBeNull();
    await waitFor(() => expect(tintOf("pt-backend")).toBe("var(--astrolabe-team-indigo)"));
    expect(tintOf("pt-design")).toBe("var(--astrolabe-team-teal)");
    // a deleted team (not in the read): neutral, and its Team cell keeps the name
    expect(tintOf("pt-gone")).toBeNull();
    expect(within(rowOf("pt-gone")).getByText("Retired")).toBeInTheDocument();
  });

  test("the bar's frame sets the bar colour token, the tone and the critical outline are untouched", async () => {
    renderTimeline(viewOf());
    await waitFor(() => expect(tintOf("pt-backend")).not.toBeNull());
    const frame = rowOf("pt-backend").querySelector<HTMLElement>("[data-tint]") as HTMLElement;
    expect(frame.style.getPropertyValue("--timeline-bar")).toBe("var(--astrolabe-team-indigo)");
    // the frame is the bar's wrapper; its body is the bar itself
    const body = frame.firstElementChild as HTMLElement;
    expect(body).not.toHaveAttribute("data-tone");
    expect(body).not.toHaveAttribute("data-critical");
  });

  test("a ghost end with a team takes that team's colour (tone stays ghost); a whole-project end and an unknown team stay neutral", async () => {
    renderTimeline(viewOf());
    await waitFor(() => expect(tintOf("pt-ghost")).toBe("var(--astrolabe-team-teal)"));
    expect(rowOf("pt-ghost").querySelector("[data-tone]")).toHaveAttribute("data-tone", "ghost");
    expect(tintOf("Whole other")).toBeNull();
    expect(tintOf("pt-orphan")).toBeNull();
  });

  test("the Team cell is a swatch beside the name: the name stays text, the swatch carries the key and no text; no swatch before the read answers", async () => {
    renderTimeline(viewOf());
    const cellOf = (name: string, team: string) => within(rowOf(name)).getByText(team).closest("[role='gridcell']") as HTMLElement;
    expect(cellOf("pt-backend", "Backend").querySelector("[data-team-colour]")).toBeNull();
    await waitFor(() => expect(cellOf("pt-backend", "Backend").querySelector("[data-team-colour]")).toHaveAttribute("data-team-colour", "INDIGO"));
    expect(cellOf("pt-backend", "Backend").querySelector("[data-team-colour]")).toHaveTextContent("");
    expect(cellOf("pt-design", "Design").querySelector("[data-team-colour]")).toHaveAttribute("data-team-colour", "TEAL");
    expect(cellOf("pt-ghost", "Design").querySelector("[data-team-colour]")).toHaveAttribute("data-team-colour", "TEAL");
    expect(cellOf("pt-gone", "Retired").querySelector("[data-team-colour]")).toBeNull();
  });

  test("the summary row's bar stays neutral", async () => {
    renderTimeline(viewOf({ dependencies: [link(44, { ...endpoint("PROJECT", 7, "Invoices", null, null), projectId: 7 }, own(BACKEND))] }));
    await waitFor(() => expect(tintOf("pt-backend")).not.toBeNull());
    expect(tintOf("Invoices")).toBeNull();
  });
});
