import { describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { screen, within } from "@testing-library/react";
import CrossTeamProposalSection from "./CrossTeamProposalSection";
import { block, move, week } from "../test/crossTeamRun";
import { headingOutline } from "../test/headings";
import { renderWithProviders } from "../test/render";

const TEAM = block(2, "Payments", [move(21, "y1", "2042-01-12", "2042-01-14"), move(22, "y2", "2042-01-15", "2042-01-16")], { weeks: [week("2042-01-12", 8)] });
const IDLE = { pending: false, failed: false };

function renderSection(over: Partial<Parameters<typeof CrossTeamProposalSection>[0]> = {}) {
  const handlers = { onToggle: vi.fn(), onSelectAll: vi.fn(), onSelectNone: vi.fn() };
  renderWithProviders(
    <CrossTeamProposalSection team={TEAM} asOf="2042-01-05" position={2} total={3} selected={new Set([21])} applying={false} check={IDLE} {...handlers} {...over} />,
  );
  return handlers;
}

describe("CrossTeamProposalSection", () => {
  test("the team is an h3 with its place in the placement order; its table is named for the team; the load is an h4 under it", () => {
    renderSection();
    expect(headingOutline()).toEqual([
      [3, "Payments"],
      [4, "Proposed load"],
    ]);
    expect(screen.getByText("placed 2 of 3")).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Proposed moves of Payments" })).toBeInTheDocument();
    // the weekly figures are collapsed behind a disclosure
    expect(screen.getByRole("button", { name: "Show the weekly figures of Payments" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("table", { name: "Proposed weekly load of Payments" })).toBeNull();
  });

  test("the move rows show the server's dates; a checkbox toggles ITS milestone", async () => {
    const user = userEvent.setup();
    const { onToggle } = renderSection();
    const table = screen.getByRole("table", { name: "Proposed moves of Payments" });
    expect(within(table).getByText("2042-01-12 to 2042-01-14")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Accept y1" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Accept y2" })).not.toBeChecked();
    await user.click(screen.getByRole("checkbox", { name: "Accept y2" }));
    expect(onToggle).toHaveBeenCalledWith(22);
  });

  test("Accept all in the header acts on THIS team (its id), indeterminate while only some of its moves are ticked", async () => {
    const user = userEvent.setup();
    const { onSelectAll, onSelectNone } = renderSection();
    const all = screen.getByRole("checkbox", { name: "Accept all" });
    expect(all).toHaveProperty("indeterminate", true);
    await user.click(all);
    expect(onSelectAll).toHaveBeenCalledWith(2);
    expect(onSelectNone).not.toHaveBeenCalled();
  });

  test("with every move of the team ticked the header unticks them for this team", async () => {
    const user = userEvent.setup();
    const { onSelectNone } = renderSection({ selected: new Set([21, 22, 99]) });
    await user.click(screen.getByRole("checkbox", { name: "Accept all" }));
    expect(onSelectNone).toHaveBeenCalledWith(2);
  });

  test("the weekly load opens on demand with the team's name on its table", async () => {
    const user = userEvent.setup();
    renderSection();
    await user.click(screen.getByRole("button", { name: "Show the weekly figures of Payments" }));
    expect(screen.getByRole("table", { name: "Proposed weekly load of Payments" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hide the weekly figures of Payments" })).toHaveAttribute("aria-expanded", "true");
  });

  test("none ticked anywhere: no load to show, and the section says so", () => {
    renderSection({ team: { ...TEAM, weeks: undefined }, selected: new Set() });
    expect(screen.getByText("Tick a move to see the load after accepting it.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show the weekly figures of Payments" })).toBeNull();
  });

  test("the check's state is worded under the summary", () => {
    renderSection({ check: { pending: true, failed: false } });
    expect(screen.getByText("Checking the ticked moves…")).toBeInTheDocument();
  });
});
