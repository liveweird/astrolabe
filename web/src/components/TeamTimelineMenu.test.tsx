import { describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { screen } from "@testing-library/react";
import MilestoneMenu, { type TeamActions } from "./TeamTimelineMenu";
import type { TeamMilestone, TeamView } from "../api/teams";
import { renderWithProviders } from "../test/render";

const milestone = (over: Partial<TeamMilestone> = {}): TeamMilestone => ({
  jira: null,
  flags: [],
  slackDays: null,
  critical: false,
  pinned: false,
  id: 5,
  projectId: 7,
  name: "tm-a",
  description: null,
  teamId: 1,
  teamName: "Payments",
  estimateMd: 4,
  startDate: "2042-02-02",
  endDate: "2042-02-06",
  createdAt: 1,
  updatedAt: 2,
  projectName: "Invoices",
  programName: "Billing",
  workStreamName: "Platform",
  rankPosition: 1,
  ...over,
});

const viewOf = (schedule: boolean) => ({ team: { can: { schedule, editCapacity: false, editOrder: false } } }) as unknown as TeamView;

const actions = (): TeamActions => ({ editSchedule: vi.fn(), unschedule: vi.fn(), pin: vi.fn(), schedule: vi.fn(), move: vi.fn(), moveTo: vi.fn() });

async function open(m: TeamMilestone, view: TeamView, a: TeamActions, previewing = false) {
  const user = userEvent.setup();
  renderWithProviders(<MilestoneMenu milestone={m} view={view} actions={a} previewing={previewing} />);
  await user.click(screen.getByRole("button", { name: "Operations for tm-a" }));
  await screen.findByRole("menuitem", { name: "Open project Invoices" });
  return user;
}

describe("the team row menu's pin item", () => {
  test("a scheduled, unpinned row offers Pin dates, which asks the page to pin", async () => {
    const a = actions();
    const m = milestone();
    const user = await open(m, viewOf(true), a);
    const item = screen.getByRole("menuitem", { name: "Pin dates of tm-a" });
    expect(item).toHaveTextContent("Pin dates");
    await user.click(item);
    expect(a.pin).toHaveBeenCalledWith(m, true);
  });

  test("a pinned row offers Unpin dates instead, which asks the page to unpin", async () => {
    const a = actions();
    const m = milestone({ pinned: true });
    const user = await open(m, viewOf(true), a);
    expect(screen.queryByRole("menuitem", { name: "Pin dates of tm-a" })).toBeNull();
    const item = screen.getByRole("menuitem", { name: "Unpin dates of tm-a" });
    expect(item).toHaveTextContent("Unpin dates");
    await user.click(item);
    expect(a.pin).toHaveBeenCalledWith(m, false);
  });

  test("no item without can.schedule", async () => {
    await open(milestone({ pinned: true }), viewOf(false), actions());
    expect(screen.queryByRole("menuitem", { name: /pin dates/i })).toBeNull();
  });

  test("no item for an unscheduled row", async () => {
    await open(milestone({ startDate: null, endDate: null }), viewOf(true), actions());
    expect(screen.getByRole("menuitem", { name: "Edit schedule of tm-a" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /pin dates/i })).toBeNull();
  });

  test("no item while a proposal previews (the page is read-only)", async () => {
    await open(milestone({ pinned: true }), viewOf(true), actions(), true);
    expect(screen.queryByRole("menuitem", { name: /pin dates/i })).toBeNull();
  });
});
