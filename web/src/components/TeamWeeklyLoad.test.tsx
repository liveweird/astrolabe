import { describe, expect, test } from "vitest";
import userEvent from "@testing-library/user-event";
import { screen, within } from "@testing-library/react";
import TeamWeeklyLoad from "./TeamWeeklyLoad";
import type { WeekLoad } from "../api/teams";
import { renderWithProviders } from "../test/render";

const week = (over: Partial<WeekLoad> = {}): WeekLoad => ({
  weekStart: "2027-02-01",
  load: 8,
  capacity: 10,
  overloaded: false,
  overloadMd: null,
  maxWip: 1,
  wipExceeded: false,
  ...over,
});

async function rowsOf(weeks: WeekLoad[]) {
  renderWithProviders(<TeamWeeklyLoad weeks={weeks} truncated={false} />);
  await userEvent.click(screen.getByRole("button", { name: "Show the weekly figures" }));
  const table = await screen.findByRole("table", { name: "Weekly load of the team" });
  return within(table).getAllByRole("row").slice(1);
}

describe("TeamWeeklyLoad: the Flow capacity verdict (1.9)", () => {
  test("a marked week reads 'Differs from Flow' beside its own verdict, orange for a warning and gray for an info; an unmarked week has none", async () => {
    const rows = await rowsOf([
      week({ weekStart: "2027-02-01", flowCapacity: "WARNING" }),
      week({ weekStart: "2027-02-08", load: 20, overloaded: true, overloadMd: 10, flowCapacity: "INFO" }),
      week({ weekStart: "2027-02-15" }),
    ]);
    const statuses = rows.map((r) => within(r).getAllByRole("cell")[4].textContent);
    expect(statuses).toEqual(["OKDiffers from Flow", "Overloaded · +10.00 MDDiffers from Flow", "OK"]);
    expect(within(rows[0]).getByText("Differs from Flow").closest("[data-flow-badge]")).toHaveAttribute("data-flow-badge", "WARNING");
    expect(within(rows[1]).getByText("Differs from Flow").closest("[data-flow-badge]")).toHaveAttribute("data-flow-badge", "INFO");
    expect(within(rows[2]).queryByText("Differs from Flow")).toBeNull();
  });

  test("the intro tells the corner mark", () => {
    renderWithProviders(<TeamWeeklyLoad weeks={[]} truncated={false} />);
    expect(screen.getByText(/a corner mark .* capacity differs from Flow/)).toBeInTheDocument();
  });
});
