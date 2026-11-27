import { describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { screen } from "@testing-library/react";
import CrossTeamProposalSection from "./CrossTeamProposalSection";
import { block, move, week } from "../test/crossTeamRun";
import { renderWithProviders } from "../test/render";

const TEAM = block(2, "Payments", [move(21, "y1", "2042-01-12", "2042-01-14")], { weeks: [{ ...week("2042-01-12", 12), overloaded: true }] });
const IDLE = { pending: false, failed: false };

function renderSection(over: Partial<Parameters<typeof CrossTeamProposalSection>[0]> = {}) {
  const handlers = { onToggle: vi.fn(), onSelectAll: vi.fn(), onSelectNone: vi.fn() };
  renderWithProviders(<CrossTeamProposalSection team={TEAM} asOf="2042-01-05" position={1} total={2} selected={new Set([21])} applying={false} check={IDLE} {...handlers} {...over} />);
  return handlers;
}

describe("CrossTeamProposalSection with the viewer's right to accept", () => {
  test("an acceptable section is open, collapses on demand and renders no table while closed", async () => {
    const user = userEvent.setup();
    renderSection({ acceptable: true });
    expect(screen.getByRole("table", { name: "Proposed moves of Payments" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Hide the moves of Payments" }));
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByRole("button", { name: "Show the moves of Payments" })).toHaveAttribute("aria-expanded", "false");
  });

  test("a section that is not the viewer's starts closed; opened it is read-only with the sentence, and the header badge counts its warning weeks", async () => {
    const user = userEvent.setup();
    renderSection({ acceptable: false });
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByText("1 week with a warning")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show the moves of Payments" }));
    expect(screen.getByRole("checkbox", { name: "Accept y1" })).toBeDisabled();
    expect(screen.getByText(/You don't manage this team/)).toBeInTheDocument();
  });

  test("the sentence is left to the run when it says once that nothing is the viewer's", async () => {
    const user = userEvent.setup();
    renderSection({ acceptable: false, readOnlyNote: false });
    await user.click(screen.getByRole("button", { name: "Show the moves of Payments" }));
    expect(screen.queryByText(/You don't manage this team/)).toBeNull();
    expect(screen.getByRole("checkbox", { name: "Accept y1" })).toBeDisabled();
  });

  test("without the prop nothing changes: no toggle and no badge even over an overloaded week", () => {
    renderSection();
    expect(screen.queryByRole("button", { name: /the moves of/ })).toBeNull();
    expect(screen.queryByText(/with a warning/)).toBeNull();
    expect(screen.getByRole("checkbox", { name: "Accept y1" })).toBeEnabled();
  });
});
