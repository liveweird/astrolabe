import { describe, expect, test } from "vitest";
import userEvent from "@testing-library/user-event";
import { screen, within } from "@testing-library/react";
import CriticalChain from "./CriticalChain";
import type { ProjectView, UpstreamEntity } from "../api/milestones";
import { renderWithProviders } from "../test/render";

const entry = (id: number, over: Partial<UpstreamEntity> = {}): UpstreamEntity => ({
  kind: "MILESTONE",
  id,
  name: `m${id}`,
  projectId: 90 + id,
  projectName: `P${id}`,
  startDate: "2027-02-01",
  endDate: "2027-02-05",
  slackDays: 0,
  critical: true,
  hops: 1,
  ...over,
});

/** `ghostIds`: milestones of other projects that a link names, i.e. drawn as ghost rows on the timeline (their upstream entries are not listed here). */
const viewOf = (upstream: UpstreamEntity[], upstreamTruncated = false, ghostIds: number[] = []) =>
  ({
    project: { id: 7 },
    dependencies: ghostIds.map((id) => ({
      id,
      predecessor: { kind: "MILESTONE", id, name: `m${id}`, projectId: 90 + id, projectName: `P${id}`, startDate: "2027-02-01", endDate: "2027-02-05" },
      successor: { kind: "PROJECT", id: 7, name: "Mine", projectId: 7, projectName: "Mine", startDate: null, endDate: null },
    })),
    criticalPath: { upstream, upstreamTruncated },
  }) as unknown as ProjectView;

const cells = (table: HTMLElement) => within(table).getAllByRole("row").slice(1).map((row) => within(row).getAllByRole("cell").map((cell) => cell.textContent));

describe("CriticalChain", () => {
  test("a chain inside the project: the empty state, no table, and the slack group says none", () => {
    renderWithProviders(<CriticalChain view={viewOf([])} />);
    expect(screen.getByRole("heading", { level: 3, name: "Critical chain" })).toBeInTheDocument();
    expect(screen.getByText("None: the chain lies inside this project.")).toBeInTheDocument();
    expect(screen.getByText("None.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByRole("button", { name: /Show the upstream entries/ })).toBeNull();
  });

  test("only a critical neighbour (a ghost row): the chain does NOT lie inside this project, so the empty state says there is nothing beyond the neighbours", () => {
    renderWithProviders(<CriticalChain view={viewOf([entry(1)], false, [1])} />);
    expect(screen.getByText("No further members beyond the neighbours shown on the timeline.")).toBeInTheDocument();
    expect(screen.queryByText("None: the chain lies inside this project.")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
  });

  test("the chain keeps the server's order, each name links into its project with the visible text in its accessible name", () => {
    renderWithProviders(<CriticalChain view={viewOf([entry(1, { hops: 2 }), entry(2, { kind: "PROJECT", name: "Gamma", projectName: "Gamma", projectId: 98 })])} />);
    expect(cells(screen.getByRole("table", { name: "Critical chain members in other projects" }))).toEqual([
      ["2", "m1", "Milestone", "P1", "2027-02-01 – 2027-02-05", "0 working days"],
      ["1", "Gamma", "Project", "Gamma", "2027-02-01 – 2027-02-05", "0 working days"],
    ]);
    const link = screen.getByRole("link", { name: "m1 - open project P1" });
    expect(link).toHaveAttribute("href", "/projects/91");
    expect(link).toHaveTextContent("m1");
    expect(screen.getByRole("link", { name: "Gamma - open project Gamma" })).toHaveAttribute("href", "/projects/98");
  });

  test("the entries with slack sit behind a disclosure, singular and plural working days; the truncation note counts the rows listed, ghost rows excluded", async () => {
    const user = userEvent.setup();
    // entry 4 has slack too but is a ghost row: sent by the server, not in the table, so not in the note
    const upstream = [entry(1), entry(2, { slackDays: 1, critical: false }), entry(3, { slackDays: 6, critical: false }), entry(4, { slackDays: 2, critical: false })];
    renderWithProviders(<CriticalChain view={viewOf(upstream, true, [4])} />);
    expect(screen.queryByRole("table", { name: "Upstream entries with slack" })).toBeNull();
    expect(screen.getByText("Showing the 2 entries with the least slack; more are not shown.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show the upstream entries with slack" }));
    expect(cells(await screen.findByRole("table", { name: "Upstream entries with slack" })).map((row) => row[5])).toEqual(["1 working day", "6 working days"]);
    await user.click(screen.getByRole("button", { name: "Hide the upstream entries with slack" }));
    expect(screen.queryByRole("table", { name: "Upstream entries with slack" })).toBeNull();
  });

  test("a cut list whose remaining entries are all ghost rows still says more are not shown, without a count", () => {
    renderWithProviders(<CriticalChain view={viewOf([entry(4, { slackDays: 2, critical: false })], true, [4])} />);
    expect(screen.getByText("More upstream entries with slack are not shown.")).toBeInTheDocument();
  });

  test("no truncation note unless the server cut the list", () => {
    renderWithProviders(<CriticalChain view={viewOf([entry(2, { slackDays: 1, critical: false })])} />);
    expect(screen.queryByText(/not shown/)).toBeNull();
  });
});
