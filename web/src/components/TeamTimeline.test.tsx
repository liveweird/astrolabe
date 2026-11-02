import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { screen, within } from "@testing-library/react";
import TeamTimeline, { TeamTray, type TeamActions } from "./TeamTimeline";
import TimelineDndContext from "./TimelineDndContext";
import type { ScheduleProposalMove, TeamMilestone, TeamView, WeekLoad } from "../api/teams";
import { jsonResponse } from "../test/http";
import { renderWithProviders } from "../test/render";
import { makeScale, toEpochDay } from "../utils/timelineScale";

const milestone = (id: number, name: string, over: Partial<TeamMilestone> = {}): TeamMilestone => ({
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

function renderTimeline(view: TeamView, proposal?: typeof PROPOSAL) {
  const scale = makeScale("week", { from: toEpochDay("2042-01-05"), to: toEpochDay("2042-02-22") });
  return renderWithProviders(
    <TimelineDndContext scale={scale} onSchedule={vi.fn(() => true)} onReorder={vi.fn(() => true)}>
      <TeamTimeline view={view} scale={scale} onZoomChange={vi.fn()} today="2042-01-06" busy={false} actions={ACTIONS} label="Team milestone timeline" proposal={proposal} />
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
