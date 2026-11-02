import { describe, expect, test } from "vitest";
import userEvent from "@testing-library/user-event";
import { screen, within } from "@testing-library/react";
import BaselineMovement from "./BaselineMovement";
import type { Movement } from "../api/baselines";
import { renderWithProviders } from "../test/render";
import type { LiveMilestone, MilestoneBaseline } from "../utils/baselineOverlay";

const move = (kind: Movement["kind"], startDays: number | null, endDays: number | null, estimateDelta: number | null = 0): Movement => ({ kind, startDays, endDays, estimateDelta });
const live = (id: number, name: string, over: Partial<LiveMilestone> = {}): LiveMilestone => ({
  id,
  name,
  projectId: 7,
  projectName: "Invoices",
  teamName: "Payments",
  estimateMd: 5,
  startDate: "2027-02-01",
  endDate: "2027-02-05",
  ...over,
});
const entry = (milestoneId: number, movement: Movement, estimateMd = 5) => ({ milestoneId, teamIdThen: 1, start: "2027-01-25", end: "2027-01-29", estimateMd, movement });

const BASELINE: MilestoneBaseline = {
  name: "Q1 plan",
  milestones: [entry(1, move("MOVED", 5, 5)), entry(2, move("UNCHANGED", 0, 0)), entry(3, move("UNCHANGED", 0, 0, 2.5), 4)],
  removed: [],
};
const LIVE = [live(1, "Late one"), live(2, "Steady one"), live(3, "Bigger one", { estimateMd: 6.5 })];

const names = (table: HTMLElement) => within(table).getAllByRole("row").slice(1).map((row) => within(row).getAllByRole("cell")[0].textContent);

describe("BaselineMovement", () => {
  test("a heading with the baseline's name, the totals first, the table behind a disclosure", async () => {
    const user = userEvent.setup();
    renderWithProviders(<BaselineMovement baseline={BASELINE} live={LIVE} scope="project" />);
    expect(screen.getByRole("heading", { level: 3, name: "Movement vs baseline Q1 plan" })).toBeInTheDocument();
    // ORANGE for the milestones whose end is later; an estimate-only change is not a schedule change, so it is not in the totals
    const later = screen.getByText("1 end later");
    expect(later.closest(".mantine-Badge-root")!.getAttribute("style") ?? "").toContain("orange");
    expect(screen.queryByRole("table")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Show the movement" }));
    expect(screen.getByRole("table", { name: "Movement since the baseline" })).toBeInTheDocument();
  });

  test("Changed only is on by default and treats an estimate-only change as changed", async () => {
    const user = userEvent.setup();
    renderWithProviders(<BaselineMovement baseline={BASELINE} live={LIVE} scope="project" />);
    await user.click(screen.getByRole("button", { name: "Show the movement" }));
    const table = screen.getByRole("table", { name: "Movement since the baseline" });
    expect(screen.getByRole("switch", { name: "Changed only" })).toBeChecked();
    expect(names(table)).toEqual(["Late one", "Bigger one"]);
    const estimate = within(table).getAllByRole("row")[2];
    expect(within(estimate).getAllByRole("cell").map((cell) => cell.textContent)).toEqual(["Bigger one", "2027-01-25 – 2027-01-29", "2027-02-01 – 2027-02-05", "0", "0", "4 → 6.5", "Re-estimated"]);
    await user.click(screen.getByRole("switch", { name: "Changed only" }));
    expect(names(table)).toEqual(["Late one", "Steady one", "Bigger one"]);
  });

  test("says so when nothing changed, and when there is nothing to compare", async () => {
    const user = userEvent.setup();
    const quiet: MilestoneBaseline = { name: "Q1 plan", milestones: [entry(2, move("UNCHANGED", 0, 0))], removed: [] };
    const { unmount } = renderWithProviders(<BaselineMovement baseline={quiet} live={[live(2, "Steady one")]} scope="project" />);
    expect(screen.getByText("No schedule changes")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show the movement" }));
    expect(screen.getByText("No changes since the baseline.")).toBeInTheDocument();
    unmount();
    renderWithProviders(<BaselineMovement baseline={{ name: "Q1 plan", milestones: [], removed: [] }} live={[]} scope="project" />);
    await user.click(screen.getByRole("button", { name: "Show the movement" }));
    expect(screen.getByText("No milestones to compare.")).toBeInTheDocument();
  });

  test("re-estimated rows are mentioned beside the totals: the line never says No schedule changes above a table that lists them", async () => {
    const user = userEvent.setup();
    const estimateOnly: MilestoneBaseline = { name: "Q1 plan", milestones: [entry(3, move("UNCHANGED", 0, 0, 2.5), 4)], removed: [] };
    renderWithProviders(<BaselineMovement baseline={estimateOnly} live={[live(3, "Bigger one", { estimateMd: 6.5 })]} scope="project" />);
    expect(screen.queryByText("No schedule changes")).toBeNull();
    expect(screen.getByText("1 re-estimated")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show the movement" }));
    expect(names(screen.getByRole("table", { name: "Movement since the baseline" }))).toEqual(["Bigger one"]);
  });

  test("the team page's table has a Project column with the project as a link", async () => {
    const user = userEvent.setup();
    renderWithProviders(<BaselineMovement baseline={BASELINE} live={LIVE} scope="team" />);
    await user.click(screen.getByRole("button", { name: "Show the movement" }));
    const table = screen.getByRole("table", { name: "Movement since the baseline" });
    expect(within(table).getAllByRole("columnheader").map((header) => header.textContent)).toContain("Project");
    expect(within(table).getAllByRole("link", { name: "Open project Invoices" })[0]).toHaveAttribute("href", "/projects/7");
  });
});
