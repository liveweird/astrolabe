import { describe, expect, test } from "vitest";
import { screen, within } from "@testing-library/react";
import TeamBaselineCapacity from "./TeamBaselineCapacity";
import type { TeamView } from "../api/teams";
import { renderWithProviders } from "../test/render";

type Baseline = NonNullable<TeamView["baseline"]>;
const baseline = (capacity: Baseline["capacity"]): Baseline => ({ id: 5, name: "Q2 commitment", planRevision: 40, milestones: [], removed: [], capacity });

describe("TeamBaselineCapacity (1.26)", () => {
  test("the frozen periods as ranges: an h4 naming the baseline, an open last range", () => {
    renderWithProviders(
      <TeamBaselineCapacity
        baseline={baseline({
          captured: true,
          periods: [
            { from: "2043-01-05", to: "2043-02-27", mdPerWeek: 20, wipLimit: 3 },
            { from: "2043-03-02", to: null, mdPerWeek: 7.5, wipLimit: null },
          ],
        })}
      />,
    );
    expect(screen.getByRole("heading", { level: 4, name: "Capacity in baseline Q2 commitment" })).toBeInTheDocument();
    const table = screen.getByRole("table", { name: "Capacity periods in baseline Q2 commitment" });
    expect(within(table).getAllByRole("columnheader").map((header) => header.textContent)).toEqual(["From", "To (inclusive)", "Man-days per week", "WIP limit"]);
    const rows = within(table).getAllByRole("row").slice(1).map((row) => within(row).getAllByRole("cell").map((cell) => cell.textContent));
    expect(rows).toEqual([
      ["2043-01-05", "2043-02-27", "20", "3"],
      ["2043-03-02", "no end", "7.5", "—"],
    ]);
  });

  test("captured with no periods: the team had no capacity then, and no table", () => {
    renderWithProviders(<TeamBaselineCapacity baseline={baseline({ captured: true, periods: [] })} />);
    expect(screen.getByText("The team had no capacity set then.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });

  test("not captured (a baseline from before 1.26): one dimmed note, no heading, no table", () => {
    renderWithProviders(<TeamBaselineCapacity baseline={baseline({ captured: false, periods: [] })} />);
    expect(screen.getByText("Baseline Q2 commitment was taken before baselines froze capacity, so its capacity cannot be shown beside the current one.")).toBeInTheDocument();
    expect(screen.queryByRole("heading")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
  });
});
