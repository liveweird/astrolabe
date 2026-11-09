import { useState } from "react";
import { describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { screen, within } from "@testing-library/react";
import TeamProposal from "./TeamProposal";
import type { ScheduleProposal, ScheduleProposalMove } from "../api/teams";
import { renderWithProviders } from "../test/render";

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

const A = move(1, "tp-a", { from: { start: "2042-03-03", end: "2042-03-05" }, to: { start: "2042-02-03", end: "2042-02-05" }, workingDays: 3, shiftDays: -20 });
const B = move(2, "tp-b");
const C = move(3, "tp-c", { projectId: 8, projectName: "Checkout" });

const proposalOf = (over: Partial<ScheduleProposal> = {}): ScheduleProposal => ({
  revision: 10,
  scopeHash: "a".repeat(64),
  asOf: "2042-01-05",
  teamId: 1,
  moves: [A, B, C],
  unchanged: [9],
  unplaced: [],
  pinned: [],
  weeks: [],
  weeksTruncated: false,
  dependencies: [],
  ...over,
});

type Spies = { accept: () => void; discard: () => void };

/** The section with its selection held here, as the page's hook holds it; accept and discard are spied. */
function Harness({ proposal, initial, busy = false, applying = false, spies }: { proposal: ScheduleProposal; initial?: number[]; busy?: boolean; applying?: boolean; spies: Spies }) {
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set(initial ?? proposal.moves.map((m) => m.milestoneId)));
  return (
    <TeamProposal
      proposal={proposal}
      selected={selected}
      busy={busy}
      applying={applying}
      onToggle={(id) =>
        setSelected((current) => {
          const next = new Set(current);
          if (!next.delete(id)) next.add(id);
          return next;
        })
      }
      onSelectAll={() => setSelected(new Set(proposal.moves.map((m) => m.milestoneId)))}
      onSelectNone={() => setSelected(new Set())}
      onAccept={spies.accept}
      onDiscard={spies.discard}
    />
  );
}

const spies = (): Spies => ({ accept: vi.fn(), discard: vi.fn() });

describe("TeamProposal", () => {
  test("an h3, the intro, and the table of the proposal with one row per move", () => {
    renderWithProviders(<Harness proposal={proposalOf()} spies={spies()} />);
    expect(screen.getByRole("heading", { level: 3, name: "Proposed schedule" })).toBeInTheDocument();
    expect(screen.getByText(/Link warnings and the proposed load follow the moves you tick/)).toBeInTheDocument();
    expect(screen.getByText("3 moves · 2 newly scheduled · 1 stays · 0 could not be placed")).toBeInTheDocument();
    expect(within(screen.getByRole("table", { name: "Proposed schedule moves" })).getAllByRole("row")).toHaveLength(4);
  });
  test("every move is ticked: Accept all is checked and the action counts them", () => {
    renderWithProviders(<Harness proposal={proposalOf()} spies={spies()} />);
    expect(screen.getByRole("checkbox", { name: "Accept all" })).toBeChecked();
    expect(screen.getByRole("button", { name: "Accept selected (3)" })).toBeEnabled();
  });

  test("some: Accept all is indeterminate and the count follows each tick", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness proposal={proposalOf()} spies={spies()} />);
    await user.click(screen.getByRole("checkbox", { name: "Accept tp-b" }));
    const all = screen.getByRole("checkbox", { name: "Accept all" });
    expect(all).not.toBeChecked();
    expect(all).toHaveProperty("indeterminate", true);
    expect(screen.getByRole("checkbox", { name: "Accept tp-b" })).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Accept selected (2)" })).toBeEnabled();
  });

  test("none: Accept all unticks every row and Accept selected is disabled at zero; ticking again re-enables it", async () => {
    const user = userEvent.setup();
    const s = spies();
    renderWithProviders(<Harness proposal={proposalOf()} spies={s} />);
    await user.click(screen.getByRole("checkbox", { name: "Accept all" }));
    for (const name of ["tp-a", "tp-b", "tp-c"]) expect(screen.getByRole("checkbox", { name: `Accept ${name}` })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Accept all" })).toHaveProperty("indeterminate", false);
    const accept = screen.getByRole("button", { name: "Accept selected (0)" });
    expect(accept).toBeDisabled();
    await user.click(accept);
    expect(s.accept).not.toHaveBeenCalled();
    await user.click(screen.getByRole("checkbox", { name: "Accept all" }));
    expect(screen.getByRole("button", { name: "Accept selected (3)" })).toBeEnabled();
  });

  test("Accept selected and Discard call back; a busy page disables the accept, an accept in flight disables everything", async () => {
    const user = userEvent.setup();
    const s = spies();
    const first = renderWithProviders(<Harness proposal={proposalOf()} spies={s} initial={[1]} />);
    await user.click(screen.getByRole("button", { name: "Accept selected (1)" }));
    expect(s.accept).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(s.discard).toHaveBeenCalledTimes(1);
    first.unmount();
    const busy = renderWithProviders(<Harness proposal={proposalOf()} spies={spies()} busy />);
    expect(screen.getByRole("button", { name: "Accept selected (3)" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Discard" })).toBeEnabled();
    busy.unmount();
    renderWithProviders(<Harness proposal={proposalOf()} spies={spies()} busy applying />);
    expect(screen.getByRole("button", { name: "Discard" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Accept all" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Accept tp-a" })).toBeDisabled();
  });

  test("an accept failure renders inside the section above the actions and takes the focus", () => {
    renderWithProviders(<TeamProposal proposal={proposalOf()} selected={new Set([1])} busy={false} applying={false} onToggle={vi.fn()} onSelectAll={vi.fn()} onSelectNone={vi.fn()} onAccept={vi.fn()} onDiscard={vi.fn()} error="The proposal could not be applied" />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("The proposal could not be applied");
    expect(alert).toHaveFocus();
    expect(alert.compareDocumentPosition(screen.getByRole("button", { name: "Discard" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test("the check state reaches the table: checking and failure lines under the summary", () => {
    const view = renderWithProviders(<TeamProposal proposal={proposalOf()} selected={new Set([1])} busy={false} applying={false} onToggle={vi.fn()} onSelectAll={vi.fn()} onSelectNone={vi.fn()} onAccept={vi.fn()} onDiscard={vi.fn()} check={{ pending: true, failed: false }} />);
    expect(screen.getByText("Checking the ticked moves…")).toBeInTheDocument();
    view.unmount();
    renderWithProviders(<TeamProposal proposal={proposalOf()} selected={new Set([1])} busy={false} applying={false} onToggle={vi.fn()} onSelectAll={vi.fn()} onSelectNone={vi.fn()} onAccept={vi.fn()} onDiscard={vi.fn()} check={{ pending: false, failed: true }} />);
    expect(screen.getByText(/could not be checked/)).toBeInTheDocument();
  });
});
