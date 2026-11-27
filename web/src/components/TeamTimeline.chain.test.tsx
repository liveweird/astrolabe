import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import TeamTimeline, { type TeamActions } from "./TeamTimeline";
import TimelineDndContext from "./TimelineDndContext";
import type { DependencyEndpoint, ProjectDependency } from "../api/dependencies";
import type { TeamChainLink, TeamChainMember, TeamCriticalChain, TeamMilestone, TeamView } from "../api/teams";
import { withoutGeneratedIds } from "../test/generatedIds";
import { jsonResponse, routeFetch } from "../test/http";
import { renderWithProviders } from "../test/render";
import { makeScale, toEpochDay } from "../utils/timelineScale";

// The team timeline with the critical chain (1.27): the other teams' members as read-only ghost rows after the team's own, the chain's links as
// critical arrows, and nothing of it while the page's toggle is off. The server's block is read, never recomputed.

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

const A = milestone(1, "tp-a", { startDate: "2042-02-02", endDate: "2042-02-06" });
const B = milestone(2, "tp-b", { startDate: "2042-02-09", endDate: "2042-02-10", projectId: 8, projectName: "Payouts" });

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

const NEAR = member("MILESTONE", 92, "tg-near", "2042-01-26", "2042-01-30", { projectId: 71, projectName: "Beta", hops: 1, chainOf: [7, 8] });
const UP = member("MILESTONE", 91, "tg-up", "2042-01-12", "2042-01-16", { hops: 2 });
const WHOLE = member("PROJECT", 72, "Gamma", "2042-01-05", "2042-01-09", { hops: 3 });

const chainLink = (id: number, from: TeamChainMember, to: TeamChainMember): TeamChainLink => ({
  id,
  predecessor: { kind: from.kind, id: from.id },
  successor: { kind: to.kind, id: to.id },
  type: "FS",
  lagDays: 0,
});

// The server lists members nearest first; the rows come out in chain order (start, end, name).
const CHAIN: TeamCriticalChain = { members: [NEAR, UP, WHOLE], links: [chainLink(201, UP, NEAR), chainLink(202, WHOLE, UP)], truncated: false };

const endpoint = (m: TeamChainMember | TeamMilestone): DependencyEndpoint => ({
  kind: "kind" in m ? m.kind : "MILESTONE",
  id: m.id,
  name: m.name,
  projectId: m.projectId,
  projectName: m.projectName,
  teamId: m.teamId,
  teamName: m.teamName,
  startDate: m.startDate,
  endDate: m.endDate,
});

// The team's own critical link tg-near -> tp-a is in dependencies[] with `critical: true`: its other end is a ghost row.
const OWN_LINK: ProjectDependency = {
  id: 41,
  predecessor: endpoint(NEAR),
  successor: endpoint(A),
  type: "FS",
  lagDays: 0,
  check: { status: "OK", shortfallDays: null, slackDays: 0, requiredDate: "2042-02-02", actualDate: "2042-02-02" },
  critical: true,
  can: { edit: false, delete: false },
};

const viewOf = (over: Partial<TeamView> = {}): TeamView => ({
  jiraSites: [],
  revision: 10,
  team: { id: 1, name: "Payments", description: null, managerPersonId: 12, managerName: "Cara New", colour: "INDIGO", createdAt: 1, updatedAt: 2, can: { schedule: true, editCapacity: true, editOrder: true }, flags: [] },
  order: { custom: false, revision: 4, milestoneIds: [] },
  capacity: { periods: [] },
  weeks: [],
  weeksTruncated: false,
  scheduled: [A, B],
  unscheduled: [],
  dependencies: [OWN_LINK],
  idleGaps: [],
  criticalChain: CHAIN,
  ...over,
});

const ACTIONS: TeamActions = { editSchedule: vi.fn(), unschedule: vi.fn(), pin: vi.fn(), schedule: vi.fn(), scheduleOnJira: vi.fn(), move: vi.fn(), moveTo: vi.fn() };

function renderTimeline(view: TeamView, criticalPath: boolean, queryClient?: QueryClient) {
  const scale = makeScale("week", { from: toEpochDay("2042-01-05"), to: toEpochDay("2042-02-22") });
  return renderWithProviders(
    <TimelineDndContext scale={scale} onSchedule={vi.fn(() => true)} onReorder={vi.fn(() => true)}>
      <TeamTimeline view={view} scale={scale} onZoomChange={vi.fn()} today="2042-01-06" busy={false} actions={ACTIONS} label="Team milestone timeline" criticalPath={criticalPath} />
    </TimelineDndContext>,
    { queryClient },
  );
}

const grid = () => screen.getByRole("grid", { name: "Team milestone timeline" });
const bodyRows = () => within(grid()).getAllByRole("row").slice(1);
const rowOf = (name: string) => bodyRows().find((row) => row.textContent?.includes(name)) as HTMLElement;
const arrows = () => [...document.querySelectorAll("[data-arrow]")].map((arrow) => [arrow.getAttribute("data-arrow"), arrow.getAttribute("data-critical"), arrow.getAttribute("data-violated")]);

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonResponse(200, { items: [] }))));
  localStorage.setItem("astrolabe.auth.token", "fake-token");
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("TeamTimeline with the critical chain", () => {
  test("off: the block changes nothing - the DOM equals the one of a view without it, no ghost row, no ghost arrow", () => {
    const without = renderTimeline(viewOf({ criticalChain: undefined }), false);
    const before = withoutGeneratedIds(without.container.innerHTML);
    without.unmount();
    const { container } = renderTimeline(viewOf(), false);
    expect(withoutGeneratedIds(container.innerHTML)).toBe(before);
    expect(bodyRows()).toHaveLength(2);
    expect(document.querySelector("[data-critical]")).toBeNull();
    expect(arrows()).toEqual([]);
  });

  test("on but no block yet (the plain document is still on screen): no ghost row", () => {
    renderTimeline(viewOf({ criticalChain: undefined }), true);
    expect(bodyRows()).toHaveLength(2);
    expect(arrows()).toEqual([]);
  });

  test("on: the members are rows after the team's own, in chain order (start, end, name), each read-only: no row handle, no estimate, and a menu with nothing but 'Open milestone' (a whole project's: 'Open project')", () => {
    renderTimeline(viewOf(), true);
    expect(bodyRows().map((row) => row.querySelector('[role="rowheader"]')?.textContent)).toEqual(["tp-a", "tp-b", "Project Gamma", "tg-upPlatform", "tg-nearPlatform"]);
    // only the team's two rows have a handle; a ghost milestone's menu (1.31) is the keyboard's way to the milestone and holds that one item, a whole project's row has one too since 1.34 (its Project cell may be hidden)
    expect(document.querySelectorAll("[data-row-handle]")).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: /^Operations for / }).map((button) => button.getAttribute("aria-label"))).toEqual([
      "Operations for tp-a",
      "Operations for tp-b",
      "Operations for Gamma",
      "Operations for tg-up",
      "Operations for tg-near",
    ]);
    // columns: Milestone, Project, Estimate, Slack, Operations - a ghost row keeps them all
    expect(within(grid()).getAllByRole("columnheader").map((header) => header.textContent)).toEqual(["Milestone", "Project", "Estimate", "Slack", "Operations"]);
    // the project, an empty estimate, "0 critical path" and an empty operations cell (the fifth gridcell is the bar's track)
    expect(within(rowOf("tg-up")).getAllByRole("gridcell").slice(0, 4).map((cell) => cell.textContent)).toEqual(["Alpha", "", "0 critical path", ""]);
  });

  test("a ghost milestone's team and project are links; a whole project is worded 'Project X' with a project link and no team", () => {
    renderTimeline(viewOf(), true);
    expect(within(rowOf("tg-up")).getByRole("link", { name: "Open team Platform" })).toHaveAttribute("href", "/teams/9");
    expect(within(rowOf("tg-up")).getByRole("link", { name: "Open project Alpha" })).toHaveAttribute("href", "/projects/70");
    expect(within(rowOf("Project Gamma")).queryByRole("link", { name: /Open team/ })).toBeNull();
    expect(within(rowOf("Project Gamma")).getByRole("link", { name: "Open project Gamma" })).toHaveAttribute("href", "/projects/72");
  });

  test("a whole project's row menu is the way to the project, whatever the Project column shows (1.34, the column may be hidden)", async () => {
    const user = userEvent.setup();
    renderTimeline(viewOf(), true);
    await user.click(within(rowOf("Project Gamma")).getByRole("button", { name: "Operations for Gamma" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((item) => [item.textContent, item.getAttribute("href")])).toEqual([["Open project", "/projects/72"]]);
  });

  test("a ghost milestone's name is a pointer-only link to the milestone, the team stays the cell's one stop, and the row menu opens the milestone for the keyboard", async () => {
    const user = userEvent.setup();
    renderTimeline(viewOf(), true);
    const row = rowOf("tg-up");
    const name = within(row).getByRole("link", { name: "Open milestone tg-up" });
    expect(name).toHaveAttribute("href", "/projects/70?milestone=91");
    // the pointer's link is out of the grid's tab order; the team link is the cell's roving stop
    expect(name).toHaveAttribute("tabindex", "-1");
    expect(name).not.toHaveAttribute("data-grid-pos");
    expect(within(row).getByRole("link", { name: "Open team Platform" })).toHaveAttribute("data-grid-pos");
    await user.click(within(row).getByRole("button", { name: "Operations for tg-up" }));
    expect(await screen.findByRole("menuitem", { name: "Open milestone tg-up" })).toHaveAttribute("href", "/projects/70?milestone=91");
  });

  test("a ghost bar is gray (ghost tone), emphasised, and says whose chain it is on - the team's projects it serves - and that it is read-only", () => {
    renderTimeline(viewOf(), true);
    const near = within(rowOf("tg-near")).getByRole("img", { name: "tg-near, Platform, Beta, 2042-01-26 to 2042-01-30, on the critical chain of Invoices, Payouts, read-only" });
    expect(near).toHaveAttribute("data-critical", "true");
    expect(near).toHaveAttribute("data-tone", "ghost");
    const whole = within(rowOf("Project Gamma")).getByRole("img", { name: "Project Gamma, 2042-01-05 to 2042-01-09, on the critical chain of Invoices, read-only" });
    expect(whole).toHaveAttribute("data-tone", "ghost");
    expect(whole).toHaveAttribute("data-critical", "true");
  });

  test("a member of a project the page does not know falls back to 'this team's projects' instead of a dangling phrase", () => {
    renderTimeline(viewOf({ criticalChain: { ...CHAIN, members: [member("MILESTONE", 91, "tg-up", "2042-01-12", "2042-01-16", { chainOf: [999] })], links: [] } }), true);
    expect(within(rowOf("tg-up")).getByRole("img", { name: /on the critical chain of this team's projects, read-only$/ })).toBeInTheDocument();
  });

  test("the team's own critical link to a ghost is drawn as it always was, and the block's links are critical arrows between ghost rows; none is violated", () => {
    renderTimeline(viewOf(), true);
    expect(arrows()).toEqual([
      ["41", "true", "false"],
      ["201", "true", "false"],
      ["202", "true", "false"],
    ]);
  });

  test("the team's own milestone bars are untouched by the chain: still editable, still critical by their own figure", () => {
    renderTimeline(viewOf(), true);
    expect(screen.getByRole("button", { name: /^tp-a, Invoices, 2042-02-02 to 2042-02-06, 4 man-days, on the critical path$/ })).toHaveAttribute("data-critical", "true");
  });
});

describe("TeamTimeline team colours (1.29)", () => {
  const TEAMS = {
    items: [{ id: 9, name: "Platform", description: null, managerPersonId: null, managerName: null, colour: "GRAPE", createdAt: 1, updatedAt: 2 }],
    page: 1,
    pageSize: 100,
    total: 1,
  };
  const NO_HOLIDAYS = { "GET /api/v1/public-holidays": { items: [] } };
  const tintOf = (name: string) => rowOf(name).querySelector("[data-tint]")?.getAttribute("data-tint") ?? null;

  test("the team's own bars take the page's team colour from the view itself, with no teams read at all, and the chain's ghost rows stay neutral until it answers", () => {
    renderTimeline(viewOf(), true);
    expect(tintOf("tp-a")).toBe("var(--astrolabe-team-indigo)");
    expect(tintOf("tp-b")).toBe("var(--astrolabe-team-indigo)");
    expect(tintOf("tg-near")).toBeNull();
  });

  test("a ghost row's bar takes its own team's colour from the teams read; a whole-project member has no team and stays neutral", async () => {
    vi.stubGlobal("fetch", routeFetch({ "GET /api/v1/teams": TEAMS, ...NO_HOLIDAYS }));
    renderTimeline(viewOf(), true);
    await waitFor(() => expect(tintOf("tg-near")).toBe("var(--astrolabe-team-grape)"));
    expect(tintOf("tg-up")).toBe("var(--astrolabe-team-grape)");
    expect(tintOf("Project Gamma")).toBeNull();
    // the team's own bars keep the view's colour, whatever the read says; the ghost keeps its tone and its critical outline
    expect(tintOf("tp-a")).toBe("var(--astrolabe-team-indigo)");
    const near = within(rowOf("tg-near")).getByRole("img", { name: /^tg-near/ });
    expect(near).toHaveAttribute("data-tone", "ghost");
    expect(near).toHaveAttribute("data-critical", "true");
  });

  test("a chain member of a team the read lacks stays neutral", async () => {
    vi.stubGlobal("fetch", routeFetch({ "GET /api/v1/teams": { ...TEAMS, items: [{ ...TEAMS.items[0], id: 10 }] }, ...NO_HOLIDAYS }));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderTimeline(viewOf(), true, queryClient);
    // the answer is in the query cache (the lookup has rebuilt from it) and still names no team of the chain
    await waitFor(() => expect(queryClient.getQueryData(["teams", "options"])).toBeDefined());
    await act(async () => {});
    expect(tintOf("tg-near")).toBeNull();
  });
});
