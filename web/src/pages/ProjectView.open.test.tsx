import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { screen } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import ProjectView from "./ProjectView";
import type { ProjectMilestone, ProjectView as ProjectViewDocument } from "../api/milestones";
import { routeFetch } from "../test/http";
import { planView } from "../test/planView";
import { renderWithProviders } from "../test/render";
import { OPEN_LEAD_PX, OPEN_TODAY_SHARE } from "../utils/timelineOpen";
import { defaultRange, makeScale, scrollLeftToCenter, toEpochDay } from "../utils/timelineScale";

// Where the project page opens (`timeline.md` "Where a Gantt opens"): today a quarter of the visible grid from the left, or the first bar when nothing
// else is on that screen; a milestone's address still wins. The rule and the shared Timeline's cases: utils/timelineOpen.test.ts, components/Timeline.open.test.tsx.

const TODAY = "2026-06-10";
const VIEWPORT = 1200;

const milestone = (id: number, name: string, startDate: string, endDate: string): ProjectMilestone => ({
  jira: null,
  flags: [],
  id,
  projectId: 7,
  name,
  description: null,
  teamId: 3,
  teamName: "Backend",
  estimateMd: 5,
  startDate,
  endDate,
  createdAt: 1,
  updatedAt: 2,
  slackDays: null,
  critical: false,
  pinned: false,
  can: { edit: true, delete: true, schedule: true },
});

const viewOf = (scheduled: ProjectMilestone[]): ProjectViewDocument => ({
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
  span: { start: scheduled[0].startDate ?? "", end: scheduled[0].endDate ?? "" },
  drift: null,
  scheduled,
  unscheduled: [],
  dependencies: [],
  idleGaps: [],
  criticalPath: { upstream: [], upstreamTruncated: false },
});

let project: ProjectViewDocument;
const originals = (["clientWidth", "clientHeight"] as const).map((name) => [name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)] as const);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(`${TODAY}T12:00:00`));
  // happy-dom lays nothing out: the open rule reads the scroller's width.
  for (const [name, value] of [["clientWidth", VIEWPORT], ["clientHeight", 600]] as const) Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get: () => value });
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
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
  for (const [name, descriptor] of originals) {
    if (descriptor === undefined) delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
    else Object.defineProperty(HTMLElement.prototype, name, descriptor);
  }
});

/** The page, and the facts the opened grid is judged by: the scroller, the scale the page built from the dates, the pane's width. */
async function openPage(dates: [string, string][], route = "/projects/7") {
  project = viewOf(dates.map(([start, end], index) => milestone(index + 1, `Step ${index + 1}`, start, end)));
  renderWithProviders(
    <main id="main-content" tabIndex={-1}>
      <Routes>
        <Route path="/projects/:id" element={<ProjectView />} />
      </Routes>
    </main>,
    { route },
  );
  const grid = await screen.findByRole("grid", { name: "Milestone timeline" });
  const scale = makeScale("week", defaultRange(dates.flat(), TODAY, "week"));
  const pane = Number.parseFloat(grid.style.getPropertyValue("--timeline-left"));
  return { scroller: screen.getByRole("region", { name: "Milestone timeline" }), scale, pane };
}

describe("where the project page opens", () => {
  test("work starting months after today: the first bar, not an empty grid around today", async () => {
    const { scroller, scale } = await openPage([["2026-10-05", "2026-10-16"], ["2026-11-02", "2026-11-13"]]);
    expect(scroller.scrollLeft).toBe(scale.xOf(toEpochDay("2026-10-05")) - OPEN_LEAD_PX);
  });

  test("work around today: today a quarter of the visible grid from the left", async () => {
    const { scroller, scale, pane } = await openPage([["2026-06-08", "2026-06-19"]]);
    expect(pane).toBeGreaterThan(0);
    expect(scroller.scrollLeft).toBe(scale.xOf(toEpochDay(TODAY)) + scale.dayWidth / 2 - OPEN_TODAY_SHARE * (VIEWPORT - pane));
  });

  test("work all in the past: the first bar", async () => {
    const { scroller, scale } = await openPage([["2026-02-02", "2026-02-13"], ["2026-03-02", "2026-03-13"]]);
    expect(scroller.scrollLeft).toBe(scale.xOf(toEpochDay("2026-02-02")) - OPEN_LEAD_PX);
  });

  test("a milestone's address wins: the track is centred on its bar, not left where it opened", async () => {
    const { scroller, scale, pane } = await openPage([["2026-10-05", "2026-10-16"], ["2026-11-02", "2026-11-13"]], "/projects/7?milestone=2");
    const centred = scrollLeftToCenter(scale, toEpochDay("2026-11-02"), VIEWPORT, pane);
    await vi.waitFor(() => expect(scroller.scrollLeft).toBe(centred));
  });
});
