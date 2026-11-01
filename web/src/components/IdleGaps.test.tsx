import { describe, expect, test } from "vitest";
import userEvent from "@testing-library/user-event";
import { screen, within } from "@testing-library/react";
import IdleGaps from "./IdleGaps";
import { headingOutline } from "../test/headings";
import { renderWithProviders } from "../test/render";

const GAPS = [
  { start: "2027-02-01", end: "2027-02-05", workingDays: 5 },
  { start: "2027-02-10", end: "2027-02-12", workingDays: 3 },
];

describe("IdleGaps", () => {
  test("an h3 section whose table is behind a disclosure: from, to and the length in working days, in the server's order", async () => {
    const user = userEvent.setup();
    renderWithProviders(<IdleGaps gaps={GAPS} scope="project" />);
    expect(headingOutline()).toEqual([[3, "Idle gaps"]]);
    expect(screen.getByText(/none of its milestones is in progress/)).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "Idle gaps" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Show the idle gaps" }));
    const table = await screen.findByRole("table", { name: "Idle gaps" });
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["From", "To", "Working days"]);
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((row) => within(row).getAllByRole("cell").map((c) => c.textContent))).toEqual([
      ["2027-02-01", "2027-02-05", "5"],
      ["2027-02-10", "2027-02-12", "3"],
    ]);
    await user.click(screen.getByRole("button", { name: "Hide the idle gaps" }));
    expect(screen.queryByRole("table", { name: "Idle gaps" })).toBeNull();
  });

  test("the team scope says the team's schedule", () => {
    renderWithProviders(<IdleGaps gaps={GAPS} scope="team" />);
    expect(screen.getByText(/inside the team's schedule/)).toBeInTheDocument();
  });

  test("no gaps: the section says so and offers no disclosure", () => {
    renderWithProviders(<IdleGaps gaps={[]} scope="team" />);
    expect(screen.getByText("No idle gaps of 3 or more working days.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show the idle gaps" })).toBeNull();
  });
});
