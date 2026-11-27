import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { screen } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import Programs from "./Programs";
import Roadmap from "./Roadmap";
import TeamDetails from "./TeamDetails";
import type { ProgramsView } from "../api/programs";
import type { RoadmapProject, RoadmapView } from "../api/roadmap";
import type { TeamMilestone, TeamView } from "../api/teams";
import { READ_ONLY_PANEL } from "../test/flow";
import { jsonResponse } from "../test/http";
import { renderWithProviders } from "../test/render";
import { OPEN_LEAD_PX, OPEN_TODAY_SHARE } from "../utils/timelineOpen";
import { defaultRange, makeScale, toEpochDay, type Zoom } from "../utils/timelineScale";

// Where the team page, the Roadmap (Prioritization) and the Roadmap overview open (`timeline.md` "Where a Gantt opens"): the same rule as the project page
// (`ProjectView.open.test.tsx`) through the same Timeline. Each page builds its own scale from its own dates, so each is checked against that.

const TODAY = "2026-06-10";
const VIEWPORT = 1200;
const originals = (["clientWidth", "clientHeight"] as const).map((name) => [name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)] as const);

const roadmapProject = (id: number, start: string, end: string): RoadmapProject => ({
  jira: null,
  id,
  name: `Project ${id}`,
  programId: 10,
  programName: "Billing",
  workStreamId: 1,
  workStreamName: "Platform",
  ownerPersonId: 5,
  ownerName: "Ola Owner",
  targetStart: null,
  targetEnd: null,
  rankPosition: id,
  teamIds: [],
  span: { start, end },
  drift: null,
  flags: [],
  can: { editTargetWindow: false },
});
const teamMilestone = (id: number, startDate: string, endDate: string): TeamMilestone => ({
  jira: null,
  flags: [],
  slackDays: 0,
  critical: false,
  pinned: false,
  id,
  projectId: 7,
  name: `Step ${id}`,
  description: null,
  teamId: 1,
  teamName: "Payments",
  estimateMd: 4,
  startDate,
  endDate,
  createdAt: 1,
  updatedAt: 2,
  projectName: "Invoices",
  programId: 4,
  programName: "Billing",
  workStreamId: 1,
  workStreamName: "Platform",
  rankPosition: 1,
});

let dates: [string, string][];

const roadmapView = (): RoadmapView => ({
  jiraSites: [],
  revision: 7,
  can: { editRank: false },
  teams: [],
  links: [],
  ranked: dates.map(([start, end], index) => ({ position: index + 1, project: roadmapProject(index + 1, start, end) })),
  unranked: [],
});
const programsView = (): ProgramsView => {
  const projects = dates.map(([start, end], index) => roadmapProject(index + 1, start, end));
  const span = { start: dates[0][0], end: dates[dates.length - 1][1] };
  const program = { id: 10, name: "Billing", ownerPersonId: 1, ownerName: "Pat Program", span, flags: { warnings: 0, infos: 0 }, projects };
  return { jiraSites: [], revision: 9, teams: [], links: [], workStreams: [{ id: 1, name: "Platform", ownerPersonId: 1, ownerName: "Sam Stream", startDate: "2026-01-05", endDate: null, span, flags: { warnings: 0, infos: 0 }, programs: [program] }] };
};
const teamView = (): TeamView => ({
  jiraSites: [],
  revision: 10,
  team: { id: 1, name: "Payments", description: null, managerPersonId: 12, managerName: "Cara New", colour: "INDIGO", createdAt: 1, updatedAt: 2, can: { schedule: true, editCapacity: true, editOrder: true }, flags: [] },
  order: { custom: false, revision: 4, milestoneIds: [] },
  capacity: { periods: [] },
  weeks: [],
  weeksTruncated: false,
  scheduled: dates.map(([start, end], index) => teamMilestone(index + 1, start, end)),
  unscheduled: [],
  dependencies: [],
  idleGaps: [],
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(`${TODAY}T12:00:00`));
  // happy-dom lays nothing out: the open rule reads the scroller's width.
  for (const [name, value] of [["clientWidth", VIEWPORT], ["clientHeight", 600]] as const) Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get: () => value });
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (url.startsWith("/api/v1/views/roadmap")) return Promise.resolve(jsonResponse(200, roadmapView()));
      if (url.startsWith("/api/v1/views/programs")) return Promise.resolve(jsonResponse(200, programsView()));
      if (url.startsWith("/api/v1/views/team/1")) return Promise.resolve(jsonResponse(200, teamView()));
      if (url === "/api/v1/teams/1/flow") return Promise.resolve(jsonResponse(200, READ_ONLY_PANEL));
      if (url === "/api/v1/baselines") return Promise.resolve(jsonResponse(200, { items: [], can: { manage: false } }));
      if (url === "/api/v1/public-holidays") return Promise.resolve(jsonResponse(200, { items: [] }));
      return Promise.resolve(jsonResponse(404, { title: "x", status: 404 }));
    }),
  );
  localStorage.setItem("astrolabe.auth.token", "fake-token");
  localStorage.setItem("astrolabe.auth.roles", JSON.stringify(["ADMIN"]));
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

/** The opened page's facts: its scroller, the scale it builds from `dates` at `zoom`, and the pane it drew. */
async function opened(label: string, zoom: Zoom) {
  const grid = await screen.findByRole("grid", { name: label });
  return {
    scroller: screen.getByRole("region", { name: label }),
    scale: makeScale(zoom, defaultRange(dates.flat(), TODAY, zoom)),
    pane: Number.parseFloat(grid.style.getPropertyValue("--timeline-left")),
  };
}

const PAGES = [
  { name: "the team page", label: "Team milestone timeline", zoom: "week" as const, render: () => renderWithProviders(<Routes><Route path="/teams/:id" element={<TeamDetails />} /></Routes>, { route: "/teams/1" }) },
  { name: "the Roadmap (Prioritization)", label: "Roadmap timeline", zoom: "quarter" as const, render: () => renderWithProviders(<Roadmap />) },
  { name: "the Roadmap overview", label: "Programs timeline", zoom: "quarter" as const, render: () => renderWithProviders(<Programs />) },
];

describe.each(PAGES)("where $name opens", ({ label, zoom, render }) => {
  test("work around today: today a quarter of the visible grid from the left, never at the far right", async () => {
    dates = [["2026-06-08", "2026-06-26"], ["2026-07-06", "2026-07-31"]];
    render();
    const { scroller, scale, pane } = await opened(label, zoom);
    expect(pane).toBeGreaterThan(0);
    expect(scroller.scrollLeft).toBe(scale.xOf(toEpochDay(TODAY)) + scale.dayWidth / 2 - OPEN_TODAY_SHARE * (VIEWPORT - pane));
  });

  test("work starting far after today: the first bar", async () => {
    // The last bar is far on, so the first bar is not within a screen of the range's end (the grid cannot scroll past it).
    dates = [["2027-03-01", "2027-03-26"], ["2028-09-04", "2028-10-06"]];
    render();
    const { scroller, scale } = await opened(label, zoom);
    expect(scroller.scrollLeft).toBe(scale.xOf(toEpochDay("2027-03-01")) - OPEN_LEAD_PX);
  });
});
