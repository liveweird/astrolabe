import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { screen, within } from "@testing-library/react";
import TeamTimeline, { TeamTray, type TeamActions } from "./TeamTimeline";
import TimelineDndContext from "./TimelineDndContext";
import type { DependencyEndpoint, ProjectDependency } from "../api/dependencies";
import type { ScheduleProposalMove, TeamMilestone, TeamView, WeekLoad } from "../api/teams";
import { jsonResponse } from "../test/http";
import { renderWithProviders } from "../test/render";
import { makeScale, toEpochDay } from "../utils/timelineScale";

const milestone = (id: number, name: string, over: Partial<TeamMilestone> = {}): TeamMilestone => ({
  jira: null,
  flags: [],
  slackDays: null,
  critical: false,
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

const A = milestone(1, "tp-a", { startDate: "2042-02-02", endDate: "2042-02-06" });
const B = milestone(2, "tp-b", { startDate: "2042-02-09", endDate: "2042-02-10" });
const NEW_X = milestone(3, "tp-x");
const NEW_Y = milestone(4, "tp-y");

const week = (weekStart: string, load: number): WeekLoad => ({ weekStart, load, capacity: 10, overloaded: false, overloadMd: null, maxWip: 1, wipExceeded: false });

const viewOf = (over: Partial<TeamView> = {}): TeamView => ({
  jiraSites: [],
  revision: 10,
  team: {
    id: 1,
    name: "Payments",
    description: null,
    managerPersonId: 12,
    managerName: "Cara New",
    createdAt: 1,
    updatedAt: 2,
    can: { schedule: true, editCapacity: true, editOrder: true },
  },
  order: { custom: false, revision: 4, milestoneIds: [] },
  capacity: { periods: [] },
  weeks: [week("2042-02-02", 8.5)],
  weeksTruncated: false,
  scheduled: [A, B],
  unscheduled: [NEW_X, NEW_Y],
  dependencies: [],
  idleGaps: [{ start: "2042-02-11", end: "2042-02-17", workingDays: 5 }],
  ...over,
});

const move = (milestoneId: number, name: string, over: Partial<ScheduleProposalMove> = {}): ScheduleProposalMove => ({
  milestoneId,
  name,
  projectId: 7,
  projectName: "Invoices",
  estimateMd: 4,
  from: null,
  to: { start: "2042-01-07", end: "2042-01-10" },
  workingDays: 4,
  shiftDays: null,
  ...over,
});

const PROPOSED_WEEKS = [week("2042-01-07", 9)];
const PROPOSAL = {
  moves: [
    move(2, "tp-b", { from: { start: "2042-02-09", end: "2042-02-10" }, to: { start: "2042-01-15", end: "2042-01-16" }, workingDays: 2, shiftDays: -17 }),
    move(4, "tp-y"),
    move(3, "tp-x", { to: { start: "2042-01-07", end: "2042-01-08" }, workingDays: 2 }),
  ],
  weeks: PROPOSED_WEEKS,
};

const ACTIONS: TeamActions = { editSchedule: vi.fn(), unschedule: vi.fn(), schedule: vi.fn(), move: vi.fn(), moveTo: vi.fn() };

function renderTimeline(view: TeamView, proposal?: typeof PROPOSAL, criticalPath?: boolean) {
  const scale = makeScale("week", { from: toEpochDay("2042-01-05"), to: toEpochDay("2042-02-22") });
  return renderWithProviders(
    <TimelineDndContext scale={scale} onSchedule={vi.fn(() => true)} onReorder={vi.fn(() => true)}>
      <TeamTimeline view={view} scale={scale} onZoomChange={vi.fn()} today="2042-01-06" busy={false} actions={ACTIONS} label="Team milestone timeline" proposal={proposal} criticalPath={criticalPath} />
      <TeamTray view={view} actions={ACTIONS} label="Unscheduled milestones of the team" previewing={proposal !== undefined} />
    </TimelineDndContext>,
  );
}

const grid = () => screen.getByRole("grid", { name: "Team milestone timeline" });
const bodyRows = () => within(grid()).getAllByRole("row").slice(1);
const rowOf = (name: string) => bodyRows().find((row) => row.textContent?.includes(name)) as HTMLElement;
const proposalBars = () => [...document.querySelectorAll('[data-tone="proposal"]')];

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonResponse(200, { items: [] }))));
  localStorage.setItem("astrolabe.auth.token", "fake-token");
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("TeamTimeline without a proposal", () => {
  test("is the page it was: editable bars, the row handle, idle bands, the weekly strip, no proposal bar", () => {
    renderTimeline(viewOf());
    expect(bodyRows()).toHaveLength(2);
    expect(screen.getByRole("button", { name: /^tp-a, Invoices/ })).toBeInTheDocument();
    expect(screen.getByText("Weekly load")).toBeInTheDocument();
    expect(screen.queryByText("Proposed load")).toBeNull();
    expect(document.querySelectorAll('[data-band-tone="idle"]')).toHaveLength(1);
    expect(proposalBars()).toHaveLength(0);
    expect(document.querySelectorAll("[data-row-handle]")).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: /^Schedule tp-/ })[0]).toBeEnabled();
  });
});

describe("TeamTimeline previewing a proposal", () => {
  test("a moved milestone gets a second, proposal-toned bar in its row; the current bar stays but is read-only", () => {
    renderTimeline(viewOf(), PROPOSAL);
    const row = rowOf("tp-b");
    expect(within(row).getByRole("img", { name: "tp-b, Invoices, 2042-02-09 to 2042-02-10, 4 man-days, read-only" })).toBeInTheDocument();
    const proposed = within(row).getByRole("img", { name: "Proposed: tp-b, 2042-01-15 to 2042-01-16, read-only" });
    expect(proposed).toHaveAttribute("data-tone", "proposal");
    // an unmoved row gets only its (read-only) current bar
    expect(within(rowOf("tp-a")).queryByRole("img", { name: /^Proposed/ })).toBeNull();
    expect(within(rowOf("tp-a")).getByRole("img", { name: /^tp-a, Invoices/ })).toBeInTheDocument();
  });

  test("tray milestones the proposal schedules get rows APPENDED in the tray's order with only the proposal bar and a '(new)' mark", () => {
    renderTimeline(viewOf(), PROPOSAL);
    const rows = bodyRows();
    expect(rows).toHaveLength(4);
    expect(rows.map((row) => /tp-[a-z]/.exec(row.textContent ?? "")?.[0])).toEqual(["tp-a", "tp-b", "tp-x", "tp-y"]);
    const appended = rowOf("tp-x");
    expect(within(appended).getByText("(new)")).toBeInTheDocument();
    expect(within(appended).getAllByRole("img")).toHaveLength(1);
    expect(within(appended).getByRole("img", { name: "Proposed: tp-x, 2042-01-07 to 2042-01-08, read-only" })).toHaveAttribute("data-tone", "proposal");
    expect(proposalBars()).toHaveLength(3);
  });

  test("the strip is overridden with the proposed load under its own caption", () => {
    renderTimeline(viewOf(), PROPOSAL);
    expect(screen.getByText("Proposed load")).toBeInTheDocument();
    expect(screen.queryByText("Weekly load")).toBeNull();
    expect(document.querySelector('[data-week="2042-01-07"]')).not.toBeNull();
    // the CURRENT week row is not drawn
    expect(document.querySelector('[data-week="2042-02-02"]')).toBeNull();
  });

  test("the idle bands are hidden, the bars have no handles and the rows no drag handle; the menu offers only the project", async () => {
    const user = userEvent.setup();
    renderTimeline(viewOf(), PROPOSAL);
    expect(document.querySelectorAll("[data-band-tone]")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /^Resize/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^tp-a, Invoices/ })).toBeNull();
    expect(document.querySelector("[data-row-handle]")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Operations for tp-a" }));
    expect(screen.getByRole("menuitem", { name: "Open project Invoices" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /schedule/i })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: /Move up/ })).toBeNull();
  });

  test("the tray's Schedule buttons are disabled while previewing", () => {
    renderTimeline(viewOf(), PROPOSAL);
    for (const button of screen.getAllByRole("button", { name: /^Schedule tp-/ })) expect(button).toBeDisabled();
  });

  test("a move whose milestone has no row in the view (it left the team meanwhile) draws nothing", () => {
    renderTimeline(viewOf(), { moves: [move(99, "tp-gone")], weeks: [] });
    expect(proposalBars()).toHaveLength(0);
    expect(bodyRows()).toHaveLength(2);
  });
});

describe("TeamTimeline with a baseline (v0.9)", () => {
  const baseline = {
    id: 5,
    name: "Q1",
    planRevision: 4,
    milestones: [
      { milestoneId: 1, teamIdThen: 1, start: "2042-01-26", end: "2042-01-30", estimateMd: 4, movement: { kind: "MOVED" as const, startDays: 5, endDays: 5, estimateDelta: 0 } },
      { milestoneId: 3, teamIdThen: 1, start: "2042-02-16", end: "2042-02-18", estimateMd: 4, movement: { kind: "UNSCHEDULED" as const, startDays: null, endDays: null, estimateDelta: 0 } },
    ],
    removed: [{ milestoneId: 8, projectId: 7, name: "tp-gone", teamId: 1, teamName: "Payments", estimateMd: 2, start: "2042-02-02", end: "2042-02-03" }],
  };
  const shadows = () => [...document.querySelectorAll('[data-tone="baseline"]')];

  test("without a baseline nothing changes: no shadow bar, the rows are the schedule's", () => {
    renderTimeline(viewOf());
    expect(shadows()).toHaveLength(0);
    expect(bodyRows()).toHaveLength(2);
  });

  test("a shadow bar follows the current bar in its row; the appended rows come after the scheduled ones and are read-only with a menu of one item", () => {
    renderTimeline(viewOf({ baseline }));
    expect(shadows()).toHaveLength(3);
    const row = rowOf("tp-a");
    expect(within(row).getByRole("img", { name: /^Baseline: tp-a, 2042-01-26 to 2042-01-30, 5 working days later \(start and end\), read-only$/ })).toBeInTheDocument();
    // the current bar stays editable
    expect(within(row).getByRole("button", { name: /^tp-a, Invoices/ })).toBeInTheDocument();
    expect(bodyRows().map((r) => /tp-[a-z]+/.exec(r.textContent ?? "")?.[0])).toEqual(["tp-a", "tp-b", "tp-gone", "tp-x"]);
    expect(rowOf("tp-gone")).toHaveTextContent("tp-gone (removed)");
    expect(rowOf("tp-b")).toHaveTextContent("tp-b (new since the baseline)");
    expect(within(rowOf("tp-gone")).queryByRole("button", { name: /^tp-gone, / })).toBeNull();
  });

  test("it coexists with a proposal preview: three bars in a row, the tones tell them apart", () => {
    renderTimeline(viewOf({ baseline }), PROPOSAL);
    const row = rowOf("tp-b");
    expect(within(row).getAllByRole("img").map((bar) => bar.getAttribute("data-tone"))).toEqual([null, "proposal"]);
    const a = rowOf("tp-a");
    expect(within(a).getAllByRole("img").map((bar) => bar.getAttribute("data-tone"))).toEqual([null, "baseline"]);
    expect(proposalBars()).toHaveLength(3);
    expect(shadows()).toHaveLength(3);
  });
});

describe("TeamTimeline with the critical path (1.7)", () => {
  const endOf = (m: TeamMilestone): DependencyEndpoint => ({
    kind: "MILESTONE",
    id: m.id,
    name: m.name,
    projectId: m.projectId,
    projectName: m.projectName,
    teamId: 1,
    teamName: "Payments",
    startDate: m.startDate,
    endDate: m.endDate,
  });
  const linkOf = (id: number, from: TeamMilestone, to: TeamMilestone, over: Partial<ProjectDependency> = {}): ProjectDependency => ({
    id,
    predecessor: endOf(from),
    successor: endOf(to),
    type: "FS",
    lagDays: 0,
    check: { status: "OK", shortfallDays: null, slackDays: 0, requiredDate: "2042-02-09", actualDate: "2042-02-09" },
    critical: false,
    can: { edit: false, delete: false },
    ...over,
  });
  // tp-a drives its project's end (slack 0, critical) and tp-b has 3 working days; the link a -> b is critical, the one b -> a (a cycle in a fixture is fine: it is only drawn) is not.
  const CA = { ...A, slackDays: 0, critical: true };
  const CB = { ...B, slackDays: 3, critical: false };
  const critical = () => viewOf({ scheduled: [CA, CB], dependencies: [linkOf(41, CA, CB, { critical: true }), linkOf(42, CB, CA)] });
  const dom = (container: HTMLElement) => container.innerHTML.replace(/<style[\s\S]*?<\/style>/g, "").replace(/mantine-[a-z0-9]{9}(?![a-z0-9])|DndDescribedBy-\d+|DndLiveRegion-\d+|:r[0-9a-z]+:|_r_[0-9a-z]+_/g, "ID");

  test("off: no Slack column, no emphasis, no critical arrow, the bar names as before - and the DOM equals the one without any critical data", () => {
    const stripped = () => viewOf({ scheduled: [A, B], dependencies: [linkOf(41, CA, CB), linkOf(42, CB, CA)] });
    const plain = renderTimeline(stripped());
    const before = dom(plain.container);
    plain.unmount();
    const { container } = renderTimeline(critical());
    expect(within(grid()).queryByRole("columnheader", { name: "Slack" })).toBeNull();
    expect(document.querySelector("[data-critical]")).toBeNull();
    expect(screen.getByRole("button", { name: /^tp-a, Invoices/ })).not.toHaveAccessibleName(/critical/);
    expect(dom(container)).toBe(before);
  });

  test("on: a Slack column before Operations; a critical row reads 0 plus the hidden words, the other its working days", () => {
    renderTimeline(critical(), undefined, true);
    expect(within(grid()).getAllByRole("columnheader").map((header) => header.textContent)).toEqual(["Milestone", "Project", "Estimate", "Slack", "Operations"]);
    // the name is the row header: project, estimate, slack, operations
    expect(within(rowOf("tp-a")).getAllByRole("gridcell")[2].textContent).toBe("0 critical path");
    expect(within(rowOf("tp-b")).getAllByRole("gridcell")[2].textContent).toBe("3 working days");
  });

  test("on: only the critical milestone's bar is emphasised and its accessible name says so, after any conflict count", () => {
    renderTimeline(critical(), undefined, true);
    const a = screen.getByRole("button", { name: /^tp-a, Invoices/ });
    expect(a).toHaveAttribute("data-critical", "true");
    expect(a).toHaveAccessibleName("tp-a, Invoices, 2042-02-02 to 2042-02-06, 4 man-days, on the critical path");
    expect(screen.getByRole("button", { name: /^tp-b, Invoices/ })).not.toHaveAttribute("data-critical");
  });

  test("on: only the arrow of the critical link is flagged", () => {
    renderTimeline(critical(), undefined, true);
    expect([...document.querySelectorAll("[data-arrow]")].map((arrow) => [arrow.getAttribute("data-arrow"), arrow.getAttribute("data-critical")])).toEqual([
      ["41", "true"],
      ["42", null],
    ]);
  });

  test("on: a tray milestone a preview appends has an empty Slack cell, in line with the other rows", () => {
    renderTimeline(critical(), PROPOSAL, true);
    expect(within(rowOf("tp-x")).getAllByRole("gridcell")[2].textContent).toBe("");
    expect(within(rowOf("tp-x")).getAllByRole("gridcell")).toHaveLength(within(rowOf("tp-a")).getAllByRole("gridcell").length);
  });
});
