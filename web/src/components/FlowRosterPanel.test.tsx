import { describe, expect, test } from "vitest";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, within } from "../test/render";
import { linkedPanel } from "../test/flow";
import FlowRosterPanel from "./FlowRosterPanel";

const OBSERVED = Date.UTC(2026, 10, 8, 9, 40);

describe("FlowRosterPanel", () => {
  test("lists the current members with the day each joined and when the mirror saw the team; the former ones wait behind a disclosure", async () => {
    renderWithProviders(<FlowRosterPanel roster={linkedPanel().roster} observedAt={OBSERVED} />);
    const current = screen.getByRole("table", { name: "Current members of the Flow team" });
    expect(within(current).getAllByRole("row").map((row) => row.textContent)).toEqual(["NameMember since", "Ada Lovelace2026-01-05", "Unknown account2026-03-02"]);
    expect(screen.getByText("Observed (UTC): 2026-11-08 09:40")).toBeInTheDocument();
    // Closed: the former table is not rendered at all.
    expect(screen.queryByRole("table", { name: "Former members of the Flow team" })).not.toBeInTheDocument();
    const toggle = screen.getByRole("button", { name: "1 former member" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(toggle);
    const former = screen.getByRole("table", { name: "Former members of the Flow team" });
    expect(within(former).getAllByRole("row").map((row) => row.textContent)).toEqual(["NameFromTo", "Grace Hopper2025-02-032026-04-01"]);
    expect(screen.getByRole("button", { name: "Hide 1 former member" })).toHaveAttribute("aria-expanded", "true");
  });

  test("an empty roster says so and offers no former-members button", () => {
    renderWithProviders(<FlowRosterPanel roster={{ current: [], former: [] }} observedAt={null} />);
    expect(screen.getByText("Flow lists no current members for this team.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByText("Observed (UTC): —")).toBeInTheDocument();
  });

  test("the plural of the former-members button follows the count", () => {
    const former = [1, 2, 3].map((n) => ({ displayName: `Former ${n}`, from: "2025-01-01", to: "2025-06-01" }));
    renderWithProviders(<FlowRosterPanel roster={{ current: [], former }} observedAt={OBSERVED} />);
    expect(screen.getByRole("button", { name: "3 former members" })).toBeInTheDocument();
  });

  test("a team that is gone from the last read has no roster to show", () => {
    renderWithProviders(<FlowRosterPanel roster={null} observedAt={OBSERVED} />);
    expect(screen.getByText("The roster is not available: the Flow team is gone from the last read.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});
