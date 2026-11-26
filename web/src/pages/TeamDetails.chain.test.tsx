import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { act, screen, waitFor, within } from "@testing-library/react";
import { DndContext } from "@dnd-kit/core";
import { Route, Routes } from "react-router-dom";
import TeamDetails from "./TeamDetails";
import type { DependencyEndpoint, ProjectDependency } from "../api/dependencies";
import type { ScheduleProposal, TeamChainLink, TeamChainMember, TeamCriticalChain, TeamMilestone, TeamView } from "../api/teams";
import { READ_ONLY_PANEL } from "../test/flow";
import { headingOutline } from "../test/headings";
import { jsonResponse } from "../test/http";
import { renderWithProviders } from "../test/render";
import { applyTeamOrder } from "../utils/teamViewUpdate";

// The team page's critical chain (1.27): asked for only while the Critical path toggle is on (that is a cache entry of its own), drawn as ghost rows and
// critical arrows, listed in a section, announced once, never written into the other document's entry, and the toggle locked while a write or a proposal runs.

// happy-dom has no layout, so a pointer drag cannot run here (the e2e drives the real one): the context is wrapped to hand the test its drag handlers.
let dndProps: ComponentProps<typeof DndContext> | null = null;
vi.mock("@dnd-kit/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dnd-kit/core")>();
  return {
    ...actual,
    DndContext: (props: ComponentProps<typeof actual.DndContext>) => {
      dndProps = props;
      return <actual.DndContext {...props} />;
    },
  };
});

const CRITICAL_KEY = "astrolabe.viewSettings.timeline.criticalPath";
const BASELINE_KEY = "astrolabe.viewSettings.timeline.baseline";

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
  programName: "Billing",
  workStreamName: "Platform",
  rankPosition: 1,
  ...over,
});

const TV_A = milestone(1, "tv-a", { startDate: "2027-02-08", endDate: "2027-02-12" });
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
const UP = member("MILESTONE", 91, "tg-up", "2027-01-25", "2027-01-29", { hops: 2 });
const link = (id: number, from: TeamChainMember, to: TeamChainMember): TeamChainLink => ({ id, predecessor: { kind: from.kind, id: from.id }, successor: { kind: to.kind, id: to.id }, type: "FS", lagDays: 0 });
const CHAIN: TeamCriticalChain = { members: [NEAR, UP], links: [link(201, UP, NEAR)], truncated: false };

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
const OWN_LINK: ProjectDependency = {
  id: 41,
  predecessor: endpoint(NEAR),
  successor: endpoint(TV_A),
  type: "FS",
  lagDays: 0,
  check: { status: "OK", shortfallDays: null, slackDays: 0, requiredDate: "2027-02-08", actualDate: "2027-02-08" },
  critical: true,
  can: { edit: false, delete: false },
};

const BASELINE: NonNullable<TeamView["baseline"]> = {
  id: 5,
  name: "Q1 plan",
  planRevision: 4,
  milestones: [{ milestoneId: 1, teamIdThen: 1, start: "2027-02-01", end: "2027-02-05", estimateMd: 4, movement: { kind: "MOVED", startDays: 5, endDays: 5, estimateDelta: 0 } }],
  removed: [],
  capacity: { captured: false, periods: [] },
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

type FetchMock = ReturnType<typeof vi.fn>;
let mockFetch: FetchMock;
/** The server's document: the chain block is added only to an answer to `?criticalChain=true`, the baseline block only to one for `baseline=5`. */
let server: TeamView;
let chain: TeamCriticalChain;
/** Answers by URL pattern that a test holds back or turns into a failure. */
let gate: { match: (url: string) => boolean; answer: () => Promise<Response> } | null;
let orderPut: Promise<Response> | null;
let viewUrls: string[];

const documentFor = (url: string): TeamView => ({ ...server, ...(url.includes("baseline=5") ? { baseline: BASELINE } : {}), ...(url.includes("criticalChain=true") ? { criticalChain: chain } : {}) });

beforeEach(() => {
  server = plainView();
  chain = CHAIN;
  gate = null;
  orderPut = null;
  viewUrls = [];
  mockFetch = vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "GET" && url.startsWith("/api/v1/views/team/1")) {
      viewUrls.push(url);
      return gate?.match(url) ? gate.answer() : Promise.resolve(jsonResponse(200, documentFor(url)));
    }
    if (method === "GET" && url === "/api/v1/teams/1/flow") return Promise.resolve(jsonResponse(200, READ_ONLY_PANEL));
    if (method === "GET" && url === "/api/v1/public-holidays") return Promise.resolve(jsonResponse(200, { items: [] }));
    if (method === "GET" && url === "/api/v1/baselines") return Promise.resolve(jsonResponse(200, { items: [{ id: 5, name: "Q1 plan", description: null, planRevision: 4, createdAt: 2, createdBy: null, milestoneCount: 1, projectCount: 1 }], can: { manage: false } }));
    if (method === "PUT" && url === "/api/v1/teams/1/milestone-order") {
      const body = JSON.parse(init?.body as string) as { milestoneIds: number[] };
      server = { ...applyTeamOrder(server, body.milestoneIds), revision: server.revision + 1 };
      return orderPut ?? Promise.resolve(jsonResponse(200, { revision: server.revision }));
    }
    if (method === "POST" && url === "/api/v1/teams/1/schedule-proposal") return Promise.resolve(jsonResponse(200, PROPOSAL));
    return Promise.resolve(jsonResponse(404, { title: "Not Found", status: 404 }));
  });
  vi.stubGlobal("fetch", mockFetch);
  localStorage.setItem("astrolabe.auth.token", "fake-token");
  localStorage.setItem("astrolabe.auth.roles", JSON.stringify(["ADMIN"]));
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

const renderPage = () => renderWithProviders(<Routes><Route path="/teams/:id" element={<TeamDetails />} /></Routes>, { route: "/teams/1" });
const grid = () => screen.getByRole("grid", { name: "Team milestone timeline" });
const toggle = () => screen.getByRole("button", { name: "Critical path" });
const rowHeaders = () => within(grid()).getAllByRole("row").slice(1).map((row) => row.querySelector('[role="rowheader"]')?.textContent);
const arrows = () => [...document.querySelectorAll("[data-arrow]")].map((arrow) => arrow.getAttribute("data-arrow"));
const live = () => screen.getAllByRole("status").map((region) => region.textContent).join(" | ");
const section = () => screen.queryByRole("heading", { level: 3, name: "Critical chain" });

async function openPage(on: boolean) {
  if (on) localStorage.setItem(CRITICAL_KEY, "true");
  renderPage();
  await screen.findByRole("grid", { name: "Team milestone timeline" });
}

describe("the team page and the critical chain request", () => {
  test("off, the page asks for the plain document and shows none of the chain; the toggle is enabled", async () => {
    await openPage(false);
    expect(viewUrls).toEqual(["/api/v1/views/team/1"]);
    expect(toggle()).toBeEnabled();
    expect(rowHeaders()).toEqual(["tv-a", "tv-b"]);
    expect(section()).toBeNull();
    expect(headingOutline()).not.toContainEqual([3, "Critical chain"]);
  });

  test("on, it asks with ?criticalChain=true: the members are rows after the team's own, the arrows are critical, the section follows the Unscheduled tray", async () => {
    await openPage(true);
    expect(viewUrls).toEqual(["/api/v1/views/team/1?criticalChain=true"]);
    expect(rowHeaders()).toEqual(["tv-a", "tv-b", "tg-upPlatform", "tg-nearPlatform"]);
    expect(arrows().sort()).toEqual(["201", "41"]);
    expect([...document.querySelectorAll("[data-arrow]")].every((arrow) => arrow.getAttribute("data-critical") === "true")).toBe(true);
    expect(headingOutline()).toEqual([
      [2, "Payments"],
      [3, "Timeline"],
      [3, "Unscheduled"],
      [3, "Critical chain"],
      [3, "Capacity"],
      [3, "Flow"],
      [3, "Weekly load"],
      [3, "Idle gaps"],
    ]);
    // the section's one sentence counts the rows; its table (behind the disclosure) lists the two critical arrows: the team's own and the block's
    expect(screen.getByText(/^2 dimmed rows on the timeline/)).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "Show the critical arrows" }));
    const table = screen.getByRole("table", { name: "Critical arrows on this page" });
    expect(within(table).getAllByRole("row").slice(1).map((row) => [within(row).getAllByRole("cell")[0].textContent, within(row).getAllByRole("cell")[1].textContent])).toEqual([
      ["tg-upAlphaPlatform", "tg-nearBetaPlatform"],
      ["tg-nearBetaPlatform", "tv-aInvoicesPayments"],
    ]);
  });

  test("turning the toggle on and off switches the entry: the chain arrives, then goes with the section; the page never shows the stored copy of the other", async () => {
    const user = userEvent.setup();
    await openPage(false);
    await user.click(toggle());
    await waitFor(() => expect(rowHeaders()).toHaveLength(4));
    expect(viewUrls).toEqual(["/api/v1/views/team/1", "/api/v1/views/team/1?criticalChain=true"]);
    expect(section()).not.toBeNull();
    await user.click(toggle());
    // the plain entry is cached: no request, and nothing of the chain is left, even while the chain's copy could still be the kept one
    await waitFor(() => expect(rowHeaders()).toEqual(["tv-a", "tv-b"]));
    expect(section()).toBeNull();
    expect(arrows()).toEqual([]);
    expect(document.querySelector("[data-critical]")).toBeNull();
  });

  test("switched off while the plain document is still on its way, the kept copy is the chain's: nothing of it is drawn or said (rows, arrows, the cut line, the section)", async () => {
    chain = { ...CHAIN, truncated: true };
    await openPage(true);
    expect(screen.getAllByText(/The chain is longer than the page shows/)).toHaveLength(2);
    gate = { match: (url) => !url.includes("criticalChain"), answer: () => new Promise(() => undefined) };
    await userEvent.setup().click(toggle());
    await waitFor(() => expect(viewUrls).toContain("/api/v1/views/team/1"));
    expect(rowHeaders()).toEqual(["tv-a", "tv-b"]);
    expect(screen.queryByText(/The chain is longer than the page shows/)).toBeNull();
    expect(section()).toBeNull();
    expect(arrows()).toEqual([]);
  });

  test("the cut is said under the timeline's title and in the section; a whole chain says nothing", async () => {
    chain = { ...CHAIN, truncated: true };
    await openPage(true);
    expect(screen.getAllByText("The chain is longer than the page shows: the 2 members nearest to this team's milestones are drawn.")).toHaveLength(2);
  });

  test("a member's dates widen the page's range: a far-off upstream member's bar starts inside the track", async () => {
    chain = { members: [member("MILESTONE", 93, "tg-far", "2026-06-01", "2026-06-05", { hops: 1 })], links: [], truncated: false };
    await openPage(true);
    const bar = within(grid()).getByRole("img", { name: /^tg-far, Platform, Alpha, 2026-06-01 to 2026-06-05/ });
    expect(parseFloat((bar.parentElement as HTMLElement).style.left)).toBeGreaterThanOrEqual(0);
  });
});

describe("the page's announcement", () => {
  test("once per switch-on, when the document has arrived: how many rows were added - not for the plain copy on its way, not again on a refetch", async () => {
    const user = userEvent.setup();
    await openPage(false);
    expect(live()).not.toMatch(/Critical chain shown/);
    // the chain's answer is held: the plain copy is on screen, and nothing is said about data that has not arrived
    let release!: () => void;
    gate = { match: (url) => url.includes("criticalChain=true"), answer: () => new Promise((resolve) => { release = () => resolve(jsonResponse(200, documentFor("?criticalChain=true"))); }) };
    await user.click(toggle());
    await waitFor(() => expect(release).toBeDefined());
    expect(live()).not.toMatch(/Critical chain shown/);
    await act(async () => release());
    await waitFor(() => expect(live()).toMatch(/Critical chain shown: 2 rows were added to the timeline\./));
    // off and on again: said again, once
    gate = null;
    await user.click(toggle());
    await user.click(toggle());
    await waitFor(() => expect(live().match(/Critical chain shown/g)).toHaveLength(1));
  });

  test("a first load with the toggle already on (the remembered choice) says nothing: it is not a switch-on; after off and on it does", async () => {
    await openPage(true);
    await waitFor(() => expect(rowHeaders()).toHaveLength(4));
    expect(live()).not.toMatch(/Critical chain shown/);
    const user = userEvent.setup();
    await user.click(toggle());
    await user.click(toggle());
    await waitFor(() => expect(live()).toMatch(/Critical chain shown: 2 rows were added to the timeline\./));
  });

  test("a chain that adds no row says so", async () => {
    chain = { members: [], links: [], truncated: false };
    await openPage(false);
    await userEvent.setup().click(toggle());
    await waitFor(() => expect(live()).toMatch(/Critical chain shown: no rows were added to the timeline\./));
  });

  test("a chain that adds only a whole project does not say 'no rows': the project is a row and is counted", async () => {
    chain = { members: [member("PROJECT", 94, "Gamma", "2027-01-04", "2027-01-08")], links: [], truncated: false };
    await openPage(false);
    await userEvent.setup().click(toggle());
    await waitFor(() => expect(live()).toMatch(/Critical chain shown: 1 row was added to the timeline\./));
    expect(live()).not.toMatch(/no rows/);
    expect(rowHeaders()).toContain("Project Gamma");
  });
});

describe("the toggle selects a cache entry, so it is locked while a write or a proposal runs", () => {
  test("while a save is in flight the toggle is disabled; when it settles it is enabled again, and the optimistic order shows with its ghost rows at once", async () => {
    const user = userEvent.setup();
    let settle!: () => void;
    orderPut = new Promise<Response>((resolve) => {
      settle = () => resolve(jsonResponse(200, { revision: 11 }));
    });
    await openPage(true);
    await user.click(screen.getByRole("button", { name: "Operations for tv-b" }));
    await user.click(await screen.findByRole("menuitem", { name: /Move up/ }));
    // the step is in the entry the page shows (the chain's), so the rows are reordered at once and the ghost rows stayed
    expect(rowHeaders()).toEqual(["tv-b", "tv-a", "tg-upPlatform", "tg-nearPlatform"]);
    expect(toggle()).toBeDisabled();
    await act(async () => settle());
    await waitFor(() => expect(toggle()).toBeEnabled());
    expect(rowHeaders()).toEqual(["tv-b", "tv-a", "tg-upPlatform", "tg-nearPlatform"]);
    expect(mockFetch.mock.calls.filter(([url, init]) => url === "/api/v1/teams/1/milestone-order" && (init as RequestInit).method === "PUT")).toHaveLength(1);
  });

  test("while a proposal is open the toggle is disabled; Discard frees it", async () => {
    const user = userEvent.setup();
    await openPage(true);
    await user.click(screen.getByRole("button", { name: "Propose schedule" }));
    await screen.findByRole("button", { name: "Discard" });
    expect(toggle()).toBeDisabled();
    expect(rowHeaders()).toContain("tg-upPlatform");
    await user.click(screen.getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(toggle()).toBeEnabled());
  });
});

describe("a row drag with the chain's rows appended", () => {
  test("a drop below every row (the ghost rows included) puts the milestone last among the TEAM's rows, and the ghost rows stay after them", async () => {
    await openPage(true);
    expect(rowHeaders()).toHaveLength(4);
    // the pointer went down on tv-a (position 1) and is released far below all four rows: the slot clamps to the end of the team's two scheduled rows
    const dragged = { id: "row:1", data: { current: { kind: "row", barId: 1, label: "tv-a", position: 1, count: 2 } } };
    const zone = { id: "timeline-rows", data: { current: { zoneTop: () => 100, rowBounds: () => ({ left: 0, right: 900, top: 100, bottom: 600 }), rowCount: 4 } } };
    const event = { active: dragged, delta: { x: 0, y: 0 }, over: zone, activatorEvent: { clientX: 40, clientY: 500 } };
    act(() => dndProps?.onDragStart?.(event as never));
    act(() => dndProps?.onDragEnd?.(event as never));
    await waitFor(() => expect(mockFetch.mock.calls.filter(([url, init]) => url === "/api/v1/teams/1/milestone-order" && (init as RequestInit).method === "PUT")).toHaveLength(1));
    const put = mockFetch.mock.calls.find(([url, init]) => url === "/api/v1/teams/1/milestone-order" && (init as RequestInit).method === "PUT");
    expect(JSON.parse((put?.[1] as RequestInit).body as string)).toEqual({ expectedRevision: 4, milestoneIds: [2, 1] });
    expect(rowHeaders()).toEqual(["tv-b", "tv-a", "tg-upPlatform", "tg-nearPlatform"]);
  });
});

describe("the baseline overlay across the toggle", () => {
  test("the shadow bars of the picked baseline stay while the chain loads (only the key changed, not the pick)", async () => {
    localStorage.setItem(BASELINE_KEY, "5");
    const user = userEvent.setup();
    await openPage(false);
    await waitFor(() => expect(document.querySelectorAll('[data-tone="baseline"]').length).toBeGreaterThan(0));
    const shadows = document.querySelectorAll('[data-tone="baseline"]').length;
    gate = { match: (url) => url.includes("criticalChain=true"), answer: () => new Promise(() => undefined) };
    await user.click(toggle());
    await waitFor(() => expect(viewUrls).toContain("/api/v1/views/team/1?baseline=5&criticalChain=true"));
    // the plain copy of the same pick is still on screen, overlay and all
    expect(document.querySelectorAll('[data-tone="baseline"]')).toHaveLength(shadows);
    expect(screen.getByRole("heading", { level: 3, name: /Movement vs baseline/ })).toBeInTheDocument();
  });
});

describe("a chain request that fails", () => {
  test("with the toggle on the failure offers 'Show without the critical chain', which turns the toggle off and loads the plain page", async () => {
    gate = { match: (url) => url.includes("criticalChain=true"), answer: () => Promise.resolve(jsonResponse(500, { title: "Internal Server Error", status: 500 })) };
    localStorage.setItem(CRITICAL_KEY, "true");
    renderPage();
    const button = await screen.findByRole("button", { name: "Show without the critical chain" });
    expect(screen.queryByRole("grid", { name: "Team milestone timeline" })).toBeNull();
    await userEvent.setup().click(button);
    expect(await screen.findByRole("grid", { name: "Team milestone timeline" })).toBeInTheDocument();
    expect(localStorage.getItem(CRITICAL_KEY)).toBe("false");
    expect(toggle()).toHaveAttribute("aria-pressed", "false");
  });

  test("with the toggle off, no such button: the plain failure has no chain to drop", async () => {
    gate = { match: () => true, answer: () => Promise.resolve(jsonResponse(500, { title: "Internal Server Error", status: 500 })) };
    renderPage();
    await screen.findByRole("link", { name: "Back to teams" });
    expect(screen.queryByRole("button", { name: "Show without the critical chain" })).toBeNull();
  });
});
