import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { screen, waitFor, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import ProjectView from "./ProjectView";
import type { Movement } from "../api/baselines";
import type { ProjectDependency } from "../api/dependencies";
import type { ProjectMilestone, ProjectView as ProjectViewDocument } from "../api/milestones";
import { jsonResponse } from "../test/http";
import { renderWithProviders } from "../test/render";

// The project page's hideable columns (1.34, timeline.md "Hidden columns"): the menu offers Team, Estimate, Flags and Slack (the last two only while they
// exist), Milestone and Operations never leave, the choice is remembered under `columns.project`, and a hidden column is a hole: baseline rows,
// ghost rows and arrows are drawn as before.

const KEY = "astrolabe.viewSettings.timeline.columns.project";
const CRITICAL_KEY = "astrolabe.viewSettings.timeline.criticalPath";
const BASELINE_KEY = "astrolabe.viewSettings.timeline.baseline";

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
  slackDays: 2,
  critical: false,
  pinned: false,
  can: { edit: true, delete: true, schedule: true },
  ...over,
});

const LINKED = { bindingId: 6, connectionId: 1, issueKey: "E2E-3", start: null, end: null, rollup: null };
const ALPHA = milestone(1, "Alpha");
const BETA = milestone(2, "Beta", { startDate: "2027-01-18", endDate: "2027-01-22" });

const end = (m: ProjectMilestone) => ({ kind: "MILESTONE" as const, id: m.id, name: m.name, projectId: 7, projectName: "Invoices", teamId: 3, teamName: "Backend", startDate: m.startDate, endDate: m.endDate });
const LINK: ProjectDependency = {
  id: 31,
  predecessor: end(ALPHA),
  successor: end(BETA),
  type: "FS",
  lagDays: 0,
  check: { status: "OK", shortfallDays: null, slackDays: 0, requiredDate: "2027-01-18", actualDate: "2027-01-18" },
  critical: false,
  can: { edit: true, delete: true },
};

const move = (kind: Movement["kind"], startDays: number | null, endDays: number | null): Movement => ({ kind, startDays, endDays, estimateDelta: 0 });

const viewOf = (over: Partial<ProjectViewDocument> = {}): ProjectViewDocument => ({
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
  span: { start: "2027-01-11", end: "2027-01-22" },
  drift: null,
  scheduled: [ALPHA, BETA],
  unscheduled: [],
  dependencies: [],
  idleGaps: [],
  criticalPath: { upstream: [], upstreamTruncated: false },
  ...over,
});

/** The view with `?baseline=5`: Alpha slipped, "Gone" was deleted since (an appended row). */
const withBaseline = (view: ProjectViewDocument): ProjectViewDocument => ({
  ...view,
  baseline: {
    id: 5,
    name: "Q1 plan",
    planRevision: 4,
    project: { span: { start: "2027-01-04", end: "2027-01-22" }, movement: move("MOVED", 0, 5) },
    milestones: [
      { milestoneId: 1, teamIdThen: 3, start: "2027-01-04", end: "2027-01-08", estimateMd: 5, movement: move("MOVED", 5, 5) },
      { milestoneId: 2, teamIdThen: 3, start: "2027-01-18", end: "2027-01-22", estimateMd: 5, movement: move("UNCHANGED", 0, 0) },
    ],
    removed: [{ milestoneId: 9, projectId: 7, name: "Gone", teamId: 3, teamName: "Backend", estimateMd: 2, start: "2027-01-25", end: "2027-01-26" }],
  },
});

let view: ProjectViewDocument;

beforeEach(() => {
  view = viewOf();
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (url.startsWith("/api/v1/views/project/7")) return Promise.resolve(jsonResponse(200, url.endsWith("?baseline=5") ? withBaseline(view) : view));
      if (url === "/api/v1/public-holidays") return Promise.resolve(jsonResponse(200, { items: [] }));
      if (url === "/api/v1/baselines") return Promise.resolve(jsonResponse(200, { items: [{ id: 5, name: "Q1 plan", description: null, planRevision: 4, createdAt: 1, createdBy: null, milestoneCount: 2, projectCount: 1 }], can: { manage: false } }));
      return Promise.resolve(jsonResponse(404, { title: "Not Found", status: 404 }));
    }),
  );
  localStorage.setItem("astrolabe.auth.token", "fake-token");
});
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

const renderPage = () => renderWithProviders(<Routes><Route path="/projects/:id" element={<ProjectView />} /></Routes>, { route: "/projects/7" });
const timeline = () => screen.findByRole("grid", { name: "Milestone timeline" });
const headers = (grid: HTMLElement) => within(grid).getAllByRole("columnheader").map((header) => header.textContent);
const toggle = () => screen.getByRole("button", { name: /^(Hide|Show) columns$/ });
const chevron = () => screen.getByRole("button", { name: "Choose columns" });
const arrows = () => document.querySelectorAll("[data-arrow]").length;
/** The cells of every body row: the left cells (row header and grid cells) plus the track. */
const cellCounts = (grid: HTMLElement) => within(grid).getAllByRole("row").slice(1).map((row) => row.querySelectorAll('[role="rowheader"], [role="gridcell"]').length);

async function menuItems(user: ReturnType<typeof userEvent.setup>) {
  await user.click(chevron());
  const menu = await screen.findByRole("menu", { name: "Choose columns" });
  return within(menu).getAllByRole("menuitemcheckbox");
}

describe("the project page's hideable columns", () => {
  test("the menu offers Team and Estimate; Milestone and Operations are never in it, and a first visit writes nothing", async () => {
    const user = userEvent.setup();
    renderPage();
    const grid = await timeline();
    expect(headers(grid)).toEqual(["Milestone", "Team", "Estimate", "Operations"]);
    const items = await menuItems(user);
    expect(items.map((item) => [item.textContent, item.getAttribute("aria-checked")])).toEqual([["Team", "true"], ["Estimate", "true"]]);
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  test("Flags is offered while a scheduled milestone is linked, and Slack while Critical path is on, each in its column's place", async () => {
    const user = userEvent.setup();
    view = viewOf({ scheduled: [{ ...ALPHA, jira: LINKED }, BETA] });
    localStorage.setItem(CRITICAL_KEY, "true");
    renderPage();
    const grid = await timeline();
    expect(headers(grid)).toEqual(["Milestone", "Team", "Estimate", "Flags", "Slack", "Operations"]);
    expect((await menuItems(user)).map((item) => item.textContent)).toEqual(["Team", "Estimate", "Flags", "Slack"]);
  });

  test("hiding every column keeps Milestone and Operations, writes the page's key and brings everything back", async () => {
    const user = userEvent.setup();
    renderPage();
    const grid = await timeline();
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
    await user.click(toggle());
    expect(headers(grid)).toEqual(["Milestone", "Operations"]);
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    expect(JSON.parse(localStorage.getItem(KEY) ?? "null")).toEqual({ collapsed: true, hidden: [] });
    // the row menu is still the way on, and the bar keeps naming its team
    expect(screen.getByRole("button", { name: "Operations for Alpha" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Alpha, Backend, 2027-01-11 to 2027-01-15, 5 man-days" })).toBeInTheDocument();
    await user.click(toggle());
    expect(headers(grid)).toEqual(["Milestone", "Team", "Estimate", "Operations"]);
  });

  test("one column unticked leaves the others, and the choice is read back on the next visit", async () => {
    const user = userEvent.setup();
    const first = renderPage();
    const grid = await timeline();
    await user.click((await menuItems(user))[0]);
    expect(headers(grid)).toEqual(["Milestone", "Estimate", "Operations"]);
    expect(JSON.parse(localStorage.getItem(KEY) ?? "null")).toEqual({ collapsed: false, hidden: ["team"] });
    first.unmount();
    renderPage();
    expect(headers(await timeline())).toEqual(["Milestone", "Estimate", "Operations"]);
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
    // the toolbar's own children are siblings: the control is not nested in a page control
    expect(group.parentElement).toBe(today.parentElement);
  });

  test("a hidden Slack stays hidden when Critical path is turned on, and is still in the menu, unticked", async () => {
    const user = userEvent.setup();
    localStorage.setItem(KEY, JSON.stringify({ collapsed: false, hidden: ["slack", "estimate"] }));
    renderPage();
    const grid = await timeline();
    expect(headers(grid)).toEqual(["Milestone", "Team", "Operations"]);
    await user.click(screen.getByRole("button", { name: "Critical path" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Critical path" })).toHaveAttribute("aria-pressed", "true"));
    expect(headers(grid)).toEqual(["Milestone", "Team", "Operations"]);
    const items = await menuItems(user);
    expect(items.map((item) => [item.textContent, item.getAttribute("aria-checked")])).toEqual([["Team", "true"], ["Estimate", "false"], ["Slack", "false"]]);
  });

  test("with a baseline, a link's arrow and the critical path on, every row has the drawn columns plus the track, and the arrows do not change", async () => {
    const user = userEvent.setup();
    view = viewOf({ scheduled: [{ ...ALPHA, jira: LINKED, critical: true, slackDays: 0 }, BETA], dependencies: [LINK] });
    localStorage.setItem(CRITICAL_KEY, "true");
    localStorage.setItem(BASELINE_KEY, "5");
    renderPage();
    const grid = await timeline();
    await waitFor(() => expect(within(grid).getByRole("row", { name: /Gone/ })).toBeInTheDocument());
    // Alpha, Beta and the baseline's appended "Gone" row: Milestone, Team, Estimate, Flags, Slack, Operations + the track
    expect(cellCounts(grid)).toEqual([7, 7, 7]);
    const drawn = arrows();
    expect(drawn).toBe(1);
    await user.click(toggle());
    expect(headers(grid)).toEqual(["Milestone", "Operations"]);
    expect(cellCounts(grid)).toEqual([3, 3, 3]);
    expect(arrows()).toBe(drawn);
    // a bar still sits on its own row
    expect(within(grid).getByRole("row", { name: /Gone/ })).toBeInTheDocument();
  });
});
