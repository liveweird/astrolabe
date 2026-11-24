import { describe, expect, test } from "vitest";
import { screen, within } from "@testing-library/react";
import BaselineCapacitySection from "./BaselineCapacitySection";
import type { BaselineCapacity } from "../api/baselines";
import { renderWithProviders } from "../test/render";

const CAPACITY: BaselineCapacity = {
  captured: true,
  totals: { teams: 5, changedTeams: 2 },
  teams: [
    {
      teamId: 1,
      teamName: "Payments",
      changes: [
        { from: "2043-02-02", to: "2043-02-27", then: { mdPerWeek: 20, wipLimit: 3 }, now: { mdPerWeek: 10, wipLimit: 3 } },
        { from: "2043-03-02", to: null, then: { mdPerWeek: 20, wipLimit: null }, now: null },
      ],
    },
    { teamId: 2, teamName: "Web", changes: [{ from: "2043-01-05", to: "2043-01-30", then: null, now: { mdPerWeek: 7.5, wipLimit: 2 } }] },
  ],
  truncated: false,
};
const NOT_CAPTURED: BaselineCapacity = { captured: false, totals: { teams: 0, changedTeams: 0 }, teams: [], truncated: false };

const table = () => screen.getByRole("table", { name: "Capacity changes" });
const lines = () => within(table()).getAllByRole("row").slice(1).map((row) => [...row.children].map((cell) => cell.textContent));

describe("BaselineCapacitySection (1.26)", () => {
  test("an h3 'Capacity', the team count as a gray badge and the ranges grouped by team, then and now", () => {
    renderWithProviders(<BaselineCapacitySection capacity={CAPACITY} sides={null} />);
    expect(screen.getByRole("heading", { level: 3, name: "Capacity" })).toBeInTheDocument();
    expect(screen.getByText("Teams with changed capacity: 2 of 5").closest(".mantine-Badge-root")!.getAttribute("style") ?? "").toContain("gray");
    expect(within(table()).getAllByRole("columnheader").map((header) => header.textContent)).toEqual(["From", "To (inclusive)", "Baseline", "Current"]);
    expect(lines()).toEqual([
      ["Payments"],
      ["2043-02-02", "2043-02-27", "20 MD/week · WIP 3", "10 MD/week · WIP 3"],
      ["2043-03-02", "no end", "20 MD/week · no WIP limit", "No capacity"],
      ["Web"],
      ["2043-01-05", "2043-01-30", "No capacity", "7.5 MD/week · WIP 2"],
    ]);
    expect(screen.queryByRole("note")).toBeNull();
  });

  test("against another baseline the column headers name both sides", () => {
    renderWithProviders(<BaselineCapacitySection capacity={CAPACITY} sides={{ then: "Q2", now: "Q3" }} />);
    expect(within(table()).getAllByRole("columnheader").map((header) => header.textContent)).toEqual(["From", "To (inclusive)", "Then: Q2", "Now: Q3"]);
  });

  test("captured with no changed team: the totals line and 'No capacity changes', no table", () => {
    renderWithProviders(<BaselineCapacitySection capacity={{ ...CAPACITY, totals: { teams: 5, changedTeams: 0 }, teams: [] }} sides={null} />);
    expect(screen.getByText("Teams with changed capacity: 0 of 5")).toBeInTheDocument();
    expect(screen.getByText("No capacity changes")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });

  test("truncated: a note counting the change rows listed", () => {
    renderWithProviders(<BaselineCapacitySection capacity={{ ...CAPACITY, truncated: true }} sides={null} />);
    expect(screen.getByRole("note")).toHaveTextContent("More capacity changes than fit here: the first 3 are listed (the last team may be cut), and the totals count every team.");
  });

  test("not captured is unknown, not 'no changes': a note, no totals and no table (one wording per mode)", () => {
    const { rerender } = renderWithProviders(<BaselineCapacitySection capacity={NOT_CAPTURED} sides={null} />);
    expect(screen.getByText(/This baseline was taken before baselines froze capacity/)).toBeInTheDocument();
    expect(screen.queryByText("No capacity changes")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
    rerender(<BaselineCapacitySection capacity={NOT_CAPTURED} sides={{ then: "Q2", now: "Q3" }} />);
    expect(screen.getByText(/One of the two baselines was taken before baselines froze capacity/)).toBeInTheDocument();
  });
});
