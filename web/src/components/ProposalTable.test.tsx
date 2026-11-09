import { useState } from "react";
import { describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { cleanup, screen, within } from "@testing-library/react";
import ProposalTable from "./ProposalTable";
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
  check: { status, shortfallDays: status === "VIOLATED" ? 2 : null, slackDays: status === "VIOLATED" ? -2 : status === "OK" ? 0 : null, requiredDate: status === "UNSCHEDULED" ? null : "2042-02-26", actualDate: null },
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

/** The table with its selection held here, as the owner's hook holds it; the callbacks are spied. */
function Harness({
  proposal,
  initial,
  applying = false,
  check,
  onSelectAll,
}: {
  proposal: ScheduleProposal;
  initial?: number[];
  applying?: boolean;
  check?: { pending: boolean; failed: boolean };
  onSelectAll?: () => void;
}) {
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set(initial ?? proposal.moves.map((m) => m.milestoneId)));
  return (
    <ProposalTable
      proposal={proposal}
      selected={selected}
      applying={applying}
      check={check}
      onToggle={(id) =>
        setSelected((current) => {
          const next = new Set(current);
          if (!next.delete(id)) next.add(id);
          return next;
        })
      }
      onSelectAll={() => {
        onSelectAll?.();
        setSelected(new Set(proposal.moves.map((m) => m.milestoneId)));
      }}
      onSelectNone={() => setSelected(new Set())}
    />
  );
}

const rowOf = (name: string) => screen.getByRole("checkbox", { name: `Accept ${name}` }).closest("tr") as HTMLElement;

describe("ProposalTable", () => {
  test("the summary figures and a labelled table with the five columns and one row per move", () => {
    renderWithProviders(<Harness proposal={proposalOf()} />);
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

  test("pinned milestones the proposal keeps are counted in the figures and explained in a dimmed sentence; none = neither", () => {
    const { unmount } = renderWithProviders(<Harness proposal={proposalOf({ pinned: [8, 9] })} />);
    expect(screen.getByText("3 moves · 2 newly scheduled · 1 stays · 0 could not be placed · 2 pinned")).toBeInTheDocument();
    expect(screen.getByText("2 milestones keep their dates because they are pinned")).toBeInTheDocument();
    unmount();
    renderWithProviders(<Harness proposal={proposalOf({ pinned: [8] })} />);
    expect(screen.getByText("1 milestone keeps its dates because it is pinned")).toBeInTheDocument();
    cleanup();
    renderWithProviders(<Harness proposal={proposalOf()} />);
    expect(screen.queryByText(/because (it is|they are) pinned/)).toBeNull();
    expect(screen.queryByText(/ pinned/)).toBeNull();
  });

  test("the table takes the theme's hover rule: body rows carry the hover mark, no per-table opt-out", () => {
    renderWithProviders(<Harness proposal={proposalOf()} />);
    expect(rowOf("tp-a")).toHaveAttribute("data-hover", "true");
  });

  test("every move is ticked: Accept all is checked", () => {
    renderWithProviders(<Harness proposal={proposalOf()} />);
    expect(screen.getByRole("checkbox", { name: "Accept all" })).toBeChecked();
  });

  test("some: Accept all is indeterminate and a tick off leaves the row unticked", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness proposal={proposalOf()} />);
    await user.click(screen.getByRole("checkbox", { name: "Accept tp-b" }));
    const all = screen.getByRole("checkbox", { name: "Accept all" });
    expect(all).not.toBeChecked();
    expect(all).toHaveProperty("indeterminate", true);
    expect(screen.getByRole("checkbox", { name: "Accept tp-b" })).not.toBeChecked();
  });

  test("none: Accept all unticks every row; ticking it again ticks them all", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness proposal={proposalOf()} />);
    await user.click(screen.getByRole("checkbox", { name: "Accept all" }));
    for (const name of ["tp-a", "tp-b", "tp-c"]) expect(screen.getByRole("checkbox", { name: `Accept ${name}` })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Accept all" })).toHaveProperty("indeterminate", false);
    await user.click(screen.getByRole("checkbox", { name: "Accept all" }));
    expect(screen.getByRole("checkbox", { name: "Accept all" })).toBeChecked();
  });

  test("a link the proposal would newly break reads in words with a red badge, and the summary counts it; one it mends reads gray", () => {
    const broken = link(1, end(2, "tp-b", { projectName: "Invoices" }), end(50, "Checkout page"), "OK", "VIOLATED");
    const mended = link(2, end(51, "Design"), end(1, "tp-a", { projectName: "Invoices" }), "VIOLATED", "OK");
    const unchanged = link(3, end(52, "Old"), end(53, "Older"), "VIOLATED", "VIOLATED");
    renderWithProviders(<Harness proposal={proposalOf({ dependencies: [broken, mended, unchanged] })} />);
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
    renderWithProviders(<Harness proposal={proposalOf({ dependencies: [broken] })} />);
    expect(within(rowOf("tp-c")).getByText("would violate: must start on 2042-02-26 or later (link from Web › Design)")).toBeInTheDocument();
  });

  test("a project end of the link is named by the project alone (the wire carries no project name for it)", () => {
    const broken = link(1, end(2, "tp-b", { projectName: "Invoices" }), end(60, "Checkout", { kind: "PROJECT", projectName: null }), "OK", "VIOLATED");
    renderWithProviders(<Harness proposal={proposalOf({ dependencies: [broken] })} />);
    expect(within(rowOf("tp-b")).getByText("would violate: Checkout must start on 2042-02-26 or later")).toBeInTheDocument();
  });

  test("the violation names the successor's start or end by the link type", () => {
    const base = link(1, end(2, "tp-b", { projectName: "Invoices" }), end(50, "Checkout page"), "OK", "VIOLATED");
    const { unmount } = renderWithProviders(<Harness proposal={proposalOf({ dependencies: [{ ...base, type: "SS" }] })} />);
    expect(within(rowOf("tp-b")).getByText("would violate: Web › Checkout page must start on 2042-02-26 or later")).toBeInTheDocument();
    unmount();
    renderWithProviders(<Harness proposal={proposalOf({ dependencies: [{ ...base, type: "FF" }] })} />);
    expect(within(rowOf("tp-b")).getByText("would violate: Web › Checkout page must end on 2042-02-26 or later")).toBeInTheDocument();
  });

  test("the checkbox-only header cell has a visually hidden label", () => {
    renderWithProviders(<Harness proposal={proposalOf()} />);
    const table = screen.getByRole("table", { name: "Proposed schedule moves" });
    expect(within(table).getAllByRole("columnheader")[0]).toHaveTextContent("Accept");
  });

  test("no badges and no link text when no link changes for the worse or the better", () => {
    renderWithProviders(<Harness proposal={proposalOf({ dependencies: [link(1, end(2, "tp-b"), end(50, "X"), "OK", "OK")] })} />);
    expect(screen.queryByText(/would be violated|stay violated|stays violated/)).toBeNull();
    expect(within(rowOf("tp-b")).queryByText(/violate|resolves/)).toBeNull();
  });

  test("milestones that could not be placed get a row group with the reason in words and no checkbox", () => {
    const unplaced = [
      { milestoneId: 20, name: "tp-x", projectId: 7, projectName: "Invoices", reason: "NO_CAPACITY" as const },
      { milestoneId: 21, name: "tp-y", projectId: 7, projectName: "Invoices", reason: "NO_ROOM" as const },
    ];
    renderWithProviders(<Harness proposal={proposalOf({ unplaced })} />);
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

  test("with only unplaced milestones there is nothing to accept: Accept all is disabled", () => {
    const unplaced = [{ milestoneId: 21, name: "tp-y", projectId: 7, projectName: "Invoices", reason: "NO_ROOM" as const }];
    renderWithProviders(<Harness proposal={proposalOf({ moves: [], unchanged: [], unplaced })} />);
    expect(screen.getByRole("checkbox", { name: "Accept all" })).toBeDisabled();
  });

  test("a selection held for several tables is counted over THIS table's moves: other tables' ticks leave it unticked, and Accept all calls back", async () => {
    const user = userEvent.setup();
    const onSelectAll = vi.fn();
    const other = new Set([98, 99]);
    renderWithProviders(<ProposalTable proposal={proposalOf()} selected={other} applying={false} onToggle={vi.fn()} onSelectAll={onSelectAll} onSelectNone={vi.fn()} />);
    const all = screen.getByRole("checkbox", { name: "Accept all" });
    expect(all).not.toBeChecked();
    expect(all).toHaveProperty("indeterminate", false);
    await user.click(all);
    expect(onSelectAll).toHaveBeenCalledTimes(1);
  });

  test("the ticked-subset check is worded under the summary: checking while it is on its way, a failure line when it failed, nothing otherwise", () => {
    const view = renderWithProviders(<Harness proposal={proposalOf()} check={{ pending: true, failed: false }} />);
    expect(screen.getByText("Checking the ticked moves…")).toBeInTheDocument();
    expect(screen.queryByText(/could not be checked/)).toBeNull();
    view.unmount();
    const failed = renderWithProviders(<Harness proposal={proposalOf()} check={{ pending: false, failed: true }} />);
    expect(screen.getByText("The ticked moves could not be checked; the warnings describe all moves.")).toBeInTheDocument();
    expect(screen.queryByText(/Checking/)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    failed.unmount();
    renderWithProviders(<Harness proposal={proposalOf()} check={{ pending: false, failed: false }} />);
    expect(screen.queryByText(/Checking|could not be checked/)).toBeNull();
  });

  test("while applying, every checkbox of the table is disabled", () => {
    renderWithProviders(<Harness proposal={proposalOf()} applying />);
    expect(screen.getByRole("checkbox", { name: "Accept all" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Accept tp-a" })).toBeDisabled();
  });
});
