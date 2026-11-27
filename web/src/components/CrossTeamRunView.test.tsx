import { describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { screen, within } from "@testing-library/react";
import CrossTeamRunView from "./CrossTeamRunView";
import type { CrossTeamProposal } from "../api/scheduleProposals";
import { block, move, RUN, violatedLink, week } from "../test/crossTeamRun";
import { headingOutline } from "../test/headings";
import { renderWithProviders } from "../test/render";
import type { ScheduleProposalEnd, ScheduleProposalLink } from "../api/teams";
import type { ScheduleCheckState } from "../utils/scheduleProposal";

const ALL: ScheduleCheckState = { mode: "all", byTeam: null, pending: false, failed: false };
// "some": the server's answer for the ticks - Payments' load lighter and its link fine; Platform's block must NOT take it (not the viewer's to accept).
const SOME: ScheduleCheckState = {
  mode: "some",
  byTeam: new Map([
    [1, { weeks: [{ ...week("2042-01-05", 1), overloaded: true }], weeksTruncated: false, dependencies: [] }],
    [2, { weeks: [week("2042-01-12", 2)], weeksTruncated: false, dependencies: [] }],
  ]),
  pending: false,
  failed: false,
};

function renderRun(over: Partial<Parameters<typeof CrossTeamRunView>[0]> = {}) {
  const handlers = { onToggle: vi.fn(), onSelectAll: vi.fn(), onSelectNone: vi.fn() };
  renderWithProviders(<CrossTeamRunView run={RUN} check={ALL} selected={new Set([21])} applying={false} {...handlers} {...over} />);
  return handlers;
}

describe("CrossTeamRunView for the viewer who manages one team", () => {
  test("the managed team's section is open and live; the other team's is collapsed (no table rendered) behind its name", () => {
    renderRun({ acceptable: new Set([2]) });
    expect(screen.getByRole("table", { name: "Proposed moves of Payments" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hide the moves of Payments" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Show the moves of Platform" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("table", { name: "Proposed moves of Platform" })).toBeNull();
    // one team is the viewer's, so no preview sentence; the read-only sentence is inside the closed section, not rendered
    expect(screen.queryByText(/This is a preview/)).toBeNull();
    expect(screen.queryByText(/if this team's manager accepts/i)).toBeNull();
    // both teams keep their h3 in the outline whatever is collapsed
    expect(headingOutline()).toEqual([
      [3, "Platform"],
      [3, "Payments"],
      [4, "Proposed load"],
    ]);
  });

  test("opening the other team shows the run 'if its manager accepts' with every checkbox disabled and a sentence saying so", async () => {
    const user = userEvent.setup();
    renderRun({ acceptable: new Set([2]) });
    await user.click(screen.getByRole("button", { name: "Show the moves of Platform" }));
    const table = screen.getByRole("table", { name: "Proposed moves of Platform" });
    expect(within(table).getByRole("checkbox", { name: "Accept x1" })).toBeDisabled();
    expect(within(table).getByRole("checkbox", { name: "Accept x1" })).not.toBeChecked();
    expect(within(table).getByRole("checkbox", { name: "Accept all" })).toBeDisabled();
    const note = screen.getByText(/if this team's manager accepts these moves/i);
    // the sentence describes the group holding the section's table
    expect(screen.getByRole("group", { name: "Platform" })).toHaveAccessibleDescription(note.textContent!);
    expect(within(screen.getByRole("group", { name: "Platform" })).getByRole("table", { name: "Proposed moves of Platform" })).toBeInTheDocument();
    // the viewer's own team still takes ticks
    expect(screen.getByRole("checkbox", { name: "Accept y1" })).toBeEnabled();
  });

  test("the check's verdicts and load overlay only the managed team: the other keeps the run's own", async () => {
    const user = userEvent.setup();
    renderRun({ acceptable: new Set([2]), check: SOME, selected: new Set([21]) });
    await user.click(screen.getByRole("button", { name: "Show the moves of Platform" }));
    // Platform's own block has no warning week; the check's answer for it (an overloaded week) is not drawn, so no badge anywhere
    expect(screen.queryByText(/week with a warning/)).toBeNull();
    // Payments shows the check's lighter week through its disclosure
    await user.click(screen.getByRole("button", { name: "Show the weekly figures of Payments" }));
    const payments = within(screen.getByRole("table", { name: "Proposed weekly load of Payments" }));
    expect(payments.getByText("2.00")).toBeInTheDocument();
    expect(payments.queryByText("8.00")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Show the weekly figures of Platform" }));
    const platform = within(screen.getByRole("table", { name: "Proposed weekly load of Platform" }));
    expect(platform.getByText("6.00")).toBeInTheDocument();
    expect(platform.queryByText("1.00")).toBeNull();
  });

  test("an orange badge counts the section's overloaded and over-WIP weeks, from the weeks shown", () => {
    const run: CrossTeamProposal = {
      ...RUN,
      teams: [
        block(1, "Platform", RUN.teams[0].moves, { weeks: [{ ...week("2042-01-05", 12), overloaded: true }, { ...week("2042-01-12", 6), wipExceeded: true }, { ...week("2042-01-19", 6) }] }),
        RUN.teams[1],
      ],
    };
    renderRun({ run, acceptable: new Set([1, 2]) });
    // only Platform has warning weeks: exactly one badge, in the page
    expect(screen.getAllByText(/with a warning/)).toHaveLength(1);
    expect(screen.getByText("2 weeks with a warning")).toBeInTheDocument();
  });
});

describe("CrossTeamRunView for the viewer who may accept nothing", () => {
  test("one preview sentence above the sections, none per section, every checkbox disabled, every section collapsed", async () => {
    const user = userEvent.setup();
    renderRun({ acceptable: new Set(), selected: new Set() });
    expect(screen.getAllByText(/This is a preview/)).toHaveLength(1);
    expect(screen.queryByText(/if this team's manager accepts/i)).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Show the moves of Platform" }));
    for (const checkbox of screen.getAllByRole("checkbox")) expect(checkbox).toBeDisabled();
    expect(screen.queryByText(/if this team's manager accepts/i)).toBeNull();
  });

  test("the run's own link verdicts stay (no overlay: nothing is ticked, yet nothing is stripped)", async () => {
    const user = userEvent.setup();
    const run: CrossTeamProposal = { ...RUN, teams: [block(1, "Platform", RUN.teams[0].moves), block(2, "Payments", [move(21, "y1", "2042-01-12", "2042-01-14")], { dependencies: [violatedLink()] })] };
    renderRun({ run, acceptable: new Set(), selected: new Set(), check: { mode: "none", byTeam: null, pending: false, failed: false } });
    await user.click(screen.getByRole("button", { name: "Show the moves of Payments" }));
    expect(screen.getByText("1 link would be violated")).toBeInTheDocument();
  });
});

describe("CrossTeamRunView without rights (the pages for managers)", () => {
  test("no collapse, no sentence, no badge: the sections as they have always been", () => {
    renderRun();
    expect(screen.getByRole("table", { name: "Proposed moves of Platform" })).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Proposed moves of Payments" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^(Show|Hide) the moves of/ })).toBeNull();
    expect(screen.queryByText(/This is a preview/)).toBeNull();
  });
});

describe("CrossTeamRunView preview sentence follows what can be ticked", () => {
  test("a project the run does not touch: an empty slice says nothing, even for an administrator", () => {
    renderRun({ acceptable: new Set([1, 2]), projectId: 1234 });
    expect(screen.queryByText(/This is a preview/)).toBeNull();
    expect(screen.queryByRole("heading", { level: 3 })).toBeNull();
  });

  test("the same for a viewer who manages nothing: an empty slice has no sections and no sentence", () => {
    renderRun({ acceptable: new Set(), projectId: 1234 });
    expect(screen.queryByText(/This is a preview/)).toBeNull();
    expect(screen.queryByRole("heading", { level: 3 })).toBeNull();
  });

  test("an acceptable team that holds only an UNPLACED milestone of the project: nothing to tick, so the one sentence", () => {
    const run: CrossTeamProposal = {
      ...RUN,
      teams: [block(1, "Platform", [move(11, "x1", "2042-01-06", "2042-01-08", { projectId: 9 })], { unplaced: [{ milestoneId: 15, name: "x5", projectId: 7, projectName: "Invoices", reason: "NO_CAPACITY" }] })],
    };
    renderRun({ run, acceptable: new Set([1]), projectId: 7, selected: new Set() });
    expect(screen.getAllByText(/This is a preview/)).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 3, name: "Platform" })).toBeInTheDocument();
  });
});

describe("CrossTeamRunView with a project", () => {
  const run: CrossTeamProposal = {
    ...RUN,
    teams: [
      block(1, "Platform", [move(11, "x1", "2042-01-06", "2042-01-08"), move(12, "x2", "2042-01-09", "2042-01-09", { projectId: 9, projectName: "Other" })], { unchanged: [13] }),
      block(2, "Payments", [move(22, "y2", "2042-01-12", "2042-01-14", { projectId: 9, projectName: "Other" })]),
    ],
  };

  test("only the project's moves, in the teams that have some, each keeping its place in the whole run", () => {
    renderRun({ run, acceptable: new Set([1, 2]), projectId: 7, selected: new Set([11]) });
    expect(screen.getByRole("table", { name: "Proposed moves of Platform" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Accept x1" })).toBeChecked();
    expect(screen.queryByRole("checkbox", { name: "Accept x2" })).toBeNull();
    expect(screen.queryByRole("heading", { level: 3, name: "Payments" })).toBeNull();
    expect(screen.getByText("placed 1 of 2")).toBeInTheDocument();
  });

  test("the other project's section keeps its real place (2 of 2)", () => {
    renderRun({ run, acceptable: new Set([1, 2]), projectId: 9, selected: new Set() });
    expect(screen.getByText("placed 2 of 2")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Accept y2" })).toBeInTheDocument();
  });
});

describe("CrossTeamRunView project slice: figures and links", () => {
  const end = (id: number): ScheduleProposalEnd => ({ kind: "MILESTONE", id, name: `m${id}`, projectId: 7, projectName: "Invoices" });
  const link = (id: number, predecessor: number, successor: number): ScheduleProposalLink => ({ ...violatedLink(), id, predecessor: end(predecessor), successor: end(successor) });
  const run: CrossTeamProposal = {
    ...RUN,
    teams: [
      block(1, "Platform", [move(11, "x1", "2042-01-06", "2042-01-08"), move(12, "x2", "2042-01-09", "2042-01-09", { projectId: 9, projectName: "Other" })], {
        unchanged: [13, 16],
        pinned: [14],
        dependencies: [link(1, 11, 40), link(2, 12, 41)],
      }),
    ],
  };

  test("the summary counts the project's own unchanged and pinned milestones; the links are those touching a kept move, also after the check's overlay", () => {
    const check: ScheduleCheckState = { mode: "some", byTeam: new Map([[1, { weeks: [week("2042-01-05", 3)], weeksTruncated: false, dependencies: [link(1, 11, 40), link(2, 12, 41)] }]]), pending: false, failed: false };
    renderRun({ run, acceptable: new Set([1]), projectId: 7, projectMilestoneIds: new Set([11, 13, 14]), check, selected: new Set([11]) });
    expect(screen.getByText("1 move · 1 newly scheduled · 1 stays · 0 could not be placed · 1 pinned")).toBeInTheDocument();
    // x1's link (11 -> 40) is shown, the other project's (12 -> 41) is not
    expect(screen.getByText("1 link would be violated")).toBeInTheDocument();
  });

  test("without the project's milestone ids the unchanged and pinned figures are dropped, not another project's", () => {
    renderRun({ run, acceptable: new Set([1]), projectId: 7, selected: new Set([11]) });
    expect(screen.getByText("1 move · 1 newly scheduled · 0 stay · 0 could not be placed")).toBeInTheDocument();
  });
});
