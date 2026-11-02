import { useState } from "react";
import { describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { screen, within } from "@testing-library/react";
import TeamProposal from "./TeamProposal";
import type { ScheduleProposal, ScheduleProposalEnd, ScheduleProposalLink, ScheduleProposalMove } from "../api/teams";
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

const end = (id: number, name: string, over: Partial<ScheduleProposalEnd> = {}): ScheduleProposalEnd => ({
  kind: "MILESTONE",
  id,
  name,
  projectName: "Web",
  ...over,
});

const link = (
  id: number,
  predecessor: ScheduleProposalEnd,
  successor: ScheduleProposalEnd,
  before: ScheduleProposalLink["before"],
  status: ScheduleProposalLink["before"],
): ScheduleProposalLink => ({
  id,
  predecessor,
  successor,
  type: "FS",
  lagDays: 0,
  before,
  check: { status, shortfallDays: status === "VIOLATED" ? 2 : null, requiredDate: status === "UNSCHEDULED" ? null : "2042-02-26", actualDate: null },
});

const A = move(1, "tp-a", { from: { start: "2042-03-03", end: "2042-03-05" }, to: { start: "2042-02-03", end: "2042-02-05" }, workingDays: 3, shiftDays: -20 });
const B = move(2, "tp-b");
const C = move(3, "tp-c", { projectId: 8, projectName: "Checkout" });

const proposalOf = (over: Partial<ScheduleProposal> = {}): ScheduleProposal => ({
  revision: 10,
  asOf: "2042-01-05",
  teamId: 1,
  moves: [A, B, C],
  unchanged: [9],
  unplaced: [],
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
const rowOf = (name: string) => screen.getByRole("checkbox", { name: `Accept ${name}` }).closest("tr") as HTMLElement;

describe("TeamProposal", () => {
  test("an h3, the summary figures and a labelled table with the five columns and one row per move", () => {
    renderWithProviders(<Harness proposal={proposalOf()} spies={spies()} />);
    expect(screen.getByRole("heading", { level: 3, name: "Proposed schedule" })).toBeInTheDocument();
    expect(screen.getByText("3 moves · 2 newly scheduled · 1 stays · 0 could not be placed")).toBeInTheDocument();
    const table = screen.getByRole("table", { name: "Proposed schedule moves" });
    expect(
      within(table)
        .getAllByRole("columnheader")
        .slice(1)
        .map((h) => h.textContent),
    ).toEqual(["Milestone", "Current", "Proposed", "Change", "Links"]);
    expect(within(table).getAllByRole("row")).toHaveLength(4);
    const a = rowOf("tp-a");
    expect(within(a).getByText("2042-03-03 to 2042-03-05")).toBeInTheDocument();
    expect(within(a).getByText("2042-02-03 to 2042-02-05")).toBeInTheDocument();
    expect(within(a).getByText("3 working days")).toBeInTheDocument();
    expect(within(a).getByText("20 working days earlier")).toBeInTheDocument();
    const b = rowOf("tp-b");
    expect(within(b).getByText("Unscheduled")).toBeInTheDocument();
    expect(within(b).getByText("Unscheduled → 2042-01-07 to 2042-01-10, 4 working days")).toBeInTheDocument();
    expect(within(rowOf("tp-c")).getByRole("link", { name: "Open project Checkout" })).toHaveAttribute("href", "/projects/8");
  });

  test("the table takes the theme's hover rule: body rows carry the hover mark, no per-table opt-out", () => {
    renderWithProviders(<Harness proposal={proposalOf()} spies={spies()} />);
    expect(rowOf("tp-a")).toHaveAttribute("data-hover", "true");
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

  test("a link the proposal would newly break reads in words with a red badge, and the summary counts it; one it mends reads gray", () => {
    const broken = link(1, end(2, "tp-b", { projectName: "Invoices" }), end(50, "Checkout page"), "OK", "VIOLATED");
    const mended = link(2, end(51, "Design"), end(1, "tp-a", { projectName: "Invoices" }), "VIOLATED", "OK");
    const unchanged = link(3, end(52, "Old"), end(53, "Older"), "VIOLATED", "VIOLATED");
    renderWithProviders(<Harness proposal={proposalOf({ dependencies: [broken, mended, unchanged] })} spies={spies()} />);
    expect(screen.getByText("1 link would be violated")).toBeInTheDocument();
    expect(screen.getByText("1 link stays violated")).toBeInTheDocument();
    const b = rowOf("tp-b");
    expect(within(b).getByText("would violate: Web › Checkout page must start on 2042-02-26 or later")).toBeInTheDocument();
    expect(within(b).getByText("Conflict")).toBeInTheDocument();
    const a = rowOf("tp-a");
    expect(within(a).getByText("resolves: link with Web › Design")).toBeInTheDocument();
    expect(within(a).queryByText("Conflict")).toBeNull();
    // a milestone no link touches says nothing
    expect(within(rowOf("tp-c")).queryByText(/violate|resolves/)).toBeNull();
  });

  test("a milestone that is the successor of the broken link names the predecessor", () => {
    const broken = link(1, end(50, "Design"), end(3, "tp-c", { projectName: "Checkout" }), "OK", "VIOLATED");
    renderWithProviders(<Harness proposal={proposalOf({ dependencies: [broken] })} spies={spies()} />);
    expect(within(rowOf("tp-c")).getByText("would violate: must start on 2042-02-26 or later (link from Web › Design)")).toBeInTheDocument();
  });

  test("a project end of the link is named by the project alone (the wire carries no project name for it)", () => {
    const broken = link(1, end(2, "tp-b", { projectName: "Invoices" }), end(60, "Checkout", { kind: "PROJECT", projectName: null }), "OK", "VIOLATED");
    renderWithProviders(<Harness proposal={proposalOf({ dependencies: [broken] })} spies={spies()} />);
    expect(within(rowOf("tp-b")).getByText("would violate: Checkout must start on 2042-02-26 or later")).toBeInTheDocument();
  });

  test("the violation names the successor's start or end by the link type", () => {
    const base = link(1, end(2, "tp-b", { projectName: "Invoices" }), end(50, "Checkout page"), "OK", "VIOLATED");
    const { unmount } = renderWithProviders(<Harness proposal={proposalOf({ dependencies: [{ ...base, type: "SS" }] })} spies={spies()} />);
    expect(within(rowOf("tp-b")).getByText("would violate: Web › Checkout page must start on 2042-02-26 or later")).toBeInTheDocument();
    unmount();
    renderWithProviders(<Harness proposal={proposalOf({ dependencies: [{ ...base, type: "FF" }] })} spies={spies()} />);
    expect(within(rowOf("tp-b")).getByText("would violate: Web › Checkout page must end on 2042-02-26 or later")).toBeInTheDocument();
  });

  test("the checkbox-only header cell has a visually hidden label, and the intro says the link warnings assume every move", () => {
    renderWithProviders(<Harness proposal={proposalOf()} spies={spies()} />);
    const table = screen.getByRole("table", { name: "Proposed schedule moves" });
    expect(within(table).getAllByRole("columnheader")[0]).toHaveTextContent("Accept");
    expect(screen.getByText(/Link warnings assume every move is accepted/)).toBeInTheDocument();
  });

  test("an accept failure renders inside the section above the actions and takes the focus", () => {
    renderWithProviders(<TeamProposal proposal={proposalOf()} selected={new Set([1])} busy={false} applying={false} onToggle={vi.fn()} onSelectAll={vi.fn()} onSelectNone={vi.fn()} onAccept={vi.fn()} onDiscard={vi.fn()} error="The proposal could not be applied" />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("The proposal could not be applied");
    expect(alert).toHaveFocus();
    expect(alert.compareDocumentPosition(screen.getByRole("button", { name: "Discard" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test("no badges and no link text when no link changes for the worse or the better", () => {
    renderWithProviders(<Harness proposal={proposalOf({ dependencies: [link(1, end(2, "tp-b"), end(50, "X"), "OK", "OK")] })} spies={spies()} />);
    expect(screen.queryByText(/would be violated|stay violated|stays violated/)).toBeNull();
    expect(within(rowOf("tp-b")).queryByText(/violate|resolves/)).toBeNull();
  });

  test("milestones that could not be placed get a row group with the reason in words and no checkbox", () => {
    const unplaced = [
      { milestoneId: 20, name: "tp-x", projectId: 7, projectName: "Invoices", reason: "NO_CAPACITY" as const },
      { milestoneId: 21, name: "tp-y", projectId: 7, projectName: "Invoices", reason: "NO_ROOM" as const },
    ];
    renderWithProviders(<Harness proposal={proposalOf({ unplaced })} spies={spies()} />);
    const table = screen.getByRole("table", { name: "Proposed schedule moves" });
    expect(within(table).getByText("Could not be placed")).toBeInTheDocument();
    const x = within(table).getByText("tp-x").closest("tr") as HTMLElement;
    expect(within(x).getByText("no capacity after 2042-01-05")).toBeInTheDocument();
    expect(within(x).queryByRole("checkbox")).toBeNull();
    const y = within(table).getByText("tp-y").closest("tr") as HTMLElement;
    expect(within(y).getByText("no room within the 520-week horizon")).toBeInTheDocument();
    // the header's, and one per move
    expect(screen.getAllByRole("checkbox")).toHaveLength(4);
  });

  test("with only unplaced milestones there is nothing to accept: Accept all and Accept selected are disabled", () => {
    const unplaced = [{ milestoneId: 21, name: "tp-y", projectId: 7, projectName: "Invoices", reason: "NO_ROOM" as const }];
    renderWithProviders(<Harness proposal={proposalOf({ moves: [], unchanged: [], unplaced })} spies={spies()} />);
    expect(screen.getByRole("checkbox", { name: "Accept all" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Accept selected (0)" })).toBeDisabled();
  });
});
