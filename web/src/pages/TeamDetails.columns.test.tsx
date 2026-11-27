import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { screen, waitFor, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import TeamDetails from "./TeamDetails";
import type { ScheduleProposal, TeamChainMember, TeamCriticalChain, TeamMilestone, TeamView } from "../api/teams";
import { READ_ONLY_PANEL } from "../test/flow";
import { jsonResponse } from "../test/http";
import { renderWithProviders } from "../test/render";

// The team page's hideable columns (1.34, timeline.md "Hidden columns"): Project, Estimate, Flags and Slack (the last two only while they exist); the
// milestone name and Operations stay. A hidden column is a hole: the critical chain's rows, the baseline's, a proposal's and the arrows are drawn as before.

const KEY = "astrolabe.viewSettings.timeline.columns.team";
const CRITICAL_KEY = "astrolabe.viewSettings.timeline.criticalPath";
const BASELINE_KEY = "astrolabe.viewSettings.timeline.baseline";

const LINKED = { bindingId: 6, connectionId: 1, issueKey: "E2E-3", start: null, end: null, rollup: null };
const milestone = (id: number, name: string, over: Partial<TeamMilestone> = {}): TeamMilestone => ({
  jira: null,
  flags: [],
  slackDays: 0,
  critical: true,
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
const TV_A = milestone(1, "tv-a", { startDate: "2027-02-08", endDate: "2027-02-12", jira: LINKED });
const TV_B = milestone(2, "tv-b", { startDate: "2027-02-15", endDate: "2027-02-16", slackDays: 3, critical: false });
const TRAYED = milestone(3, "tv-tray", { slackDays: null, critical: false });

const member = (kind: "MILESTONE" | "PROJECT", id: number, name: string, start: string, end: string, over: Partial<TeamChainMember> = {}): TeamChainMember => ({
  kind,
  id,
  name,
  projectId: kind === "PROJECT" ? id : 70,
  projectName: kind === "PROJECT" ? name : "Alpha",
  teamId: kind === "PROJECT" ? null : 9,
  teamName: kind === "PROJECT" ? null : "Platform",
  startDate: start,
  endDate: end,
  hops: 1,
  chainOf: [7],
  ...over,
});
const NEAR = member("MILESTONE", 92, "tg-near", "2027-02-01", "2027-02-05", { projectId: 71, projectName: "Beta" });
const WHOLE = member("PROJECT", 94, "Gamma", "2027-01-04", "2027-01-08");
const CHAIN: TeamCriticalChain = {
  members: [NEAR, WHOLE],
  links: [{ id: 201, predecessor: { kind: "PROJECT", id: 94 }, successor: { kind: "MILESTONE", id: 92 }, type: "FS", lagDays: 0 }],
  truncated: false,
};
const endpoint = (m: TeamChainMember | TeamMilestone) => ({
  kind: ("kind" in m ? m.kind : "MILESTONE") as "MILESTONE" | "PROJECT",
  id: m.id,
  name: m.name,
  projectId: m.projectId,
  projectName: m.projectName,
  teamId: m.teamId,
  teamName: m.teamName,
  startDate: m.startDate,
  endDate: m.endDate,
});
const OWN_LINK = {
  id: 41,
  predecessor: endpoint(NEAR),
  successor: endpoint(TV_A),
  type: "FS" as const,
  lagDays: 0,
  check: { status: "OK" as const, shortfallDays: null, slackDays: 0, requiredDate: "2027-02-08", actualDate: "2027-02-08" },
  critical: true,
  can: { edit: false, delete: false },
};
const BASELINE: NonNullable<TeamView["baseline"]> = {
  id: 5,
  name: "Q1 plan",
  planRevision: 4,
  milestones: [{ milestoneId: 1, teamIdThen: 1, start: "2027-02-01", end: "2027-02-05", estimateMd: 4, movement: { kind: "MOVED", startDays: 5, endDays: 5, estimateDelta: 0 } }],
  removed: [{ milestoneId: 9, projectId: 7, name: "tv-gone", teamId: 1, teamName: "Payments", estimateMd: 2, start: "2027-02-22", end: "2027-02-23" }],
  capacity: { captured: false, periods: [] },
};
const PROPOSAL: ScheduleProposal = {
  revision: 10,
  scopeHash: "a".repeat(64),
  asOf: "2027-01-04",
  teamId: 1,
  moves: [{ milestoneId: 3, name: "tv-tray", projectId: 7, projectName: "Invoices", estimateMd: 4, from: null, to: { start: "2027-03-01", end: "2027-03-04" }, workingDays: 4, shiftDays: null }],
  unchanged: [1, 2],
  unplaced: [],
  pinned: [],
  weeks: [],
  weeksTruncated: false,
  dependencies: [],
};
const plainView = (): TeamView => ({
  jiraSites: [],
  revision: 10,
  team: { id: 1, name: "Payments", description: null, managerPersonId: 12, managerName: "Cara New", colour: "INDIGO", createdAt: 1, updatedAt: 2, can: { schedule: true, editCapacity: true, editOrder: true }, flags: [] },
  order: { custom: false, revision: 4, milestoneIds: [] },
  capacity: { periods: [] },
  weeks: [],
  weeksTruncated: false,
  scheduled: [TV_A, TV_B],
  unscheduled: [TRAYED],
  dependencies: [OWN_LINK],
  idleGaps: [],
});

let server: TeamView;
const documentFor = (url: string): TeamView => ({ ...server, ...(url.includes("baseline=5") ? { baseline: BASELINE } : {}), ...(url.includes("criticalChain=true") ? { criticalChain: CHAIN } : {}) });

beforeEach(() => {
  server = plainView();
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && url.startsWith("/api/v1/views/team/1")) return Promise.resolve(jsonResponse(200, documentFor(url)));
      if (method === "GET" && url === "/api/v1/teams/1/flow") return Promise.resolve(jsonResponse(200, READ_ONLY_PANEL));
      if (method === "GET" && url === "/api/v1/public-holidays") return Promise.resolve(jsonResponse(200, { items: [] }));
      if (method === "GET" && url === "/api/v1/baselines") return Promise.resolve(jsonResponse(200, { items: [{ id: 5, name: "Q1 plan", description: null, planRevision: 4, createdAt: 2, createdBy: null, milestoneCount: 1, projectCount: 1 }], can: { manage: false } }));
      if (method === "POST" && url === "/api/v1/teams/1/schedule-proposal") return Promise.resolve(jsonResponse(200, PROPOSAL));
      return Promise.resolve(jsonResponse(404, { title: "Not Found", status: 404 }));
    }),
  );
  localStorage.setItem("astrolabe.auth.token", "fake-token");
  localStorage.setItem("astrolabe.auth.roles", JSON.stringify(["ADMIN"]));
});
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

const renderPage = () => renderWithProviders(<Routes><Route path="/teams/:id" element={<TeamDetails />} /></Routes>, { route: "/teams/1" });
const timeline = () => screen.findByRole("grid", { name: "Team milestone timeline" });
const headers = (grid: HTMLElement) => within(grid).getAllByRole("columnheader").map((header) => header.textContent);
const toggle = () => screen.getByRole("button", { name: /^(Hide|Show) columns$/ });
const chevron = () => screen.getByRole("button", { name: "Choose columns" });
const arrows = () => document.querySelectorAll("[data-arrow]").length;
const cellCounts = (grid: HTMLElement) => within(grid).getAllByRole("row").slice(1).map((row) => row.querySelectorAll('[role="rowheader"], [role="gridcell"]').length);

async function menuItems(user: ReturnType<typeof userEvent.setup>) {
  await user.click(chevron());
  const menu = await screen.findByRole("menu", { name: "Choose columns" });
  return within(menu).getAllByRole("menuitemcheckbox");
}

describe("the team page's hideable columns", () => {
  test("the menu offers Project, Estimate and Flags (a linked milestone), never the milestone or Operations; a first visit writes nothing", async () => {
    const user = userEvent.setup();
    renderPage();
    const grid = await timeline();
    expect(headers(grid)).toEqual(["Milestone", "Project", "Estimate", "Flags", "Operations"]);
    expect((await menuItems(user)).map((item) => [item.textContent, item.getAttribute("aria-checked")])).toEqual([["Project", "true"], ["Estimate", "true"], ["Flags", "true"]]);
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  test("without a linked or flagged milestone there is no Flags to offer, and Slack joins while Critical path is on", async () => {
    const user = userEvent.setup();
    server = { ...plainView(), scheduled: [{ ...TV_A, jira: null }, TV_B] };
    renderPage();
    const grid = await timeline();
    expect((await menuItems(user)).map((item) => item.textContent)).toEqual(["Project", "Estimate"]);
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Critical path" }));
    await waitFor(() => expect(headers(grid)).toEqual(["Milestone", "Project", "Estimate", "Slack", "Operations"]));
    expect((await menuItems(user)).map((item) => item.textContent)).toEqual(["Project", "Estimate", "Slack"]);
  });

  test("the toggle keeps the milestone and Operations, writes the page's key, and the row menu still reaches the project", async () => {
    const user = userEvent.setup();
    renderPage();
    const grid = await timeline();
    await user.click(toggle());
    expect(headers(grid)).toEqual(["Milestone", "Operations"]);
    expect(JSON.parse(localStorage.getItem(KEY) ?? "null")).toEqual({ collapsed: true, hidden: [] });
    await user.click(screen.getByRole("button", { name: "Operations for tv-a" }));
    expect(await screen.findByRole("menuitem", { name: "Open project Invoices" })).toBeInTheDocument();
  });

  test("the control sits right after Scroll to today and before the page's own controls", async () => {
    renderPage();
    await timeline();
    const today = screen.getByRole("button", { name: "Scroll to today" });
    const group = screen.getByRole("group", { name: "Columns" });
    const critical = screen.getByRole("button", { name: "Critical path" });
    const follows = (a: Element, b: Element) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    expect(follows(today, group)).toBe(true);
    expect(follows(group, critical)).toBe(true);
    expect(group.parentElement).toBe(today.parentElement);
  });

  test("with the critical chain, a baseline and the arrows, every row has the drawn columns plus the track, and the arrows do not change", async () => {
    const user = userEvent.setup();
    localStorage.setItem(CRITICAL_KEY, "true");
    localStorage.setItem(BASELINE_KEY, "5");
    renderPage();
    const grid = await timeline();
    // the team's two rows, the chain's two (a milestone of another team, a whole project) and the baseline's removed one
    await waitFor(() => expect(within(grid).getAllByRole("row")).toHaveLength(1 + 5));
    expect(headers(grid)).toEqual(["Milestone", "Project", "Estimate", "Flags", "Slack", "Operations"]);
    expect(cellCounts(grid)).toEqual([7, 7, 7, 7, 7]);
    const drawn = arrows();
    expect(drawn).toBe(2);
    await user.click(toggle());
    expect(cellCounts(grid)).toEqual([3, 3, 3, 3, 3]);
    expect(arrows()).toBe(drawn);
  });

  test("with a proposal's rows open beside the chain and a baseline, every row has the drawn columns plus the track, and the proposal's bar is still there", async () => {
    const user = userEvent.setup();
    localStorage.setItem(CRITICAL_KEY, "true");
    localStorage.setItem(BASELINE_KEY, "5");
    renderPage();
    const grid = await timeline();
    await waitFor(() => expect(within(grid).getAllByRole("row")).toHaveLength(1 + 5));
    await user.click(screen.getByRole("button", { name: "Propose schedule" }));
    await screen.findByRole("button", { name: "Discard" });
    await screen.findByRole("img", { name: "Proposed: tv-tray, 2027-03-01 to 2027-03-04, read-only" });
    const rows = within(grid).getAllByRole("row").length;
    expect(rows).toBeGreaterThan(1 + 5);
    const full = cellCounts(grid);
    expect(new Set(full)).toEqual(new Set([7]));
    const drawn = arrows();
    await user.click(toggle());
    expect(within(grid).getAllByRole("row")).toHaveLength(rows);
    expect(cellCounts(grid)).toEqual(full.map(() => 3));
    expect(arrows()).toBe(drawn);
  });
});
