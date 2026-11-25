import { describe, expect, test } from "vitest";
import userEvent from "@testing-library/user-event";
import { screen, within } from "@testing-library/react";
import TeamCriticalChain, { TeamCriticalNote } from "./TeamCriticalChain";
import type { ProjectDependency } from "../api/dependencies";
import type { TeamChainMember, TeamCriticalChain as ChainBlock } from "../api/teams";
import { renderWithProviders } from "../test/render";

// The Critical chain section (the accessible surface of the critical arrows) and the note under the timeline's title.

const member = (kind: "MILESTONE" | "PROJECT", id: number, name: string, projectName: string, teamName: string | null, start: string): TeamChainMember => ({
  kind,
  id,
  name,
  projectId: kind === "PROJECT" ? id : 70 + id,
  projectName: kind === "PROJECT" ? name : projectName,
  teamId: teamName === null ? null : 9,
  teamName,
  startDate: start,
  endDate: start,
  hops: 1,
  chainOf: [7],
});

const UP = member("MILESTONE", 1, "tg-up", "Alpha", "Platform", "2027-01-04");
const NEAR = member("MILESTONE", 2, "tg-near", "Beta", "Platform", "2027-01-11");
const WHOLE = member("PROJECT", 3, "Gamma", "Gamma", null, "2026-12-28");

const CHAIN: ChainBlock = {
  members: [NEAR, UP, WHOLE],
  links: [
    { id: 201, predecessor: { kind: "MILESTONE", id: 1 }, successor: { kind: "MILESTONE", id: 2 }, type: "FS", lagDays: 0 },
    { id: 202, predecessor: { kind: "PROJECT", id: 3 }, successor: { kind: "MILESTONE", id: 1 }, type: "SS", lagDays: -2 },
  ],
  truncated: false,
};

const ownLink = (id: number, critical: boolean): ProjectDependency =>
  ({
    id,
    predecessor: { kind: "MILESTONE", id: 2, name: "tg-near", projectId: 72, projectName: "Beta", teamId: 9, teamName: "Platform", startDate: "2027-01-11", endDate: "2027-01-11" },
    successor: { kind: "MILESTONE", id: 8, name: "tv-a", projectId: 7, projectName: "Invoices", teamId: 1, teamName: "Payments", startDate: "2027-01-18", endDate: "2027-01-18" },
    type: "FS",
    lagDays: 0,
    critical,
  }) as unknown as ProjectDependency;

const renderSection = (chain: ChainBlock | undefined = CHAIN, dependencies: ProjectDependency[] = []) => renderWithProviders(<TeamCriticalChain view={{ dependencies }} chain={chain} />);

describe("TeamCriticalChain", () => {
  test("an h3 'Critical chain', one sentence with the member count, and the table behind a disclosure (closed: no table in the DOM)", async () => {
    renderSection();
    expect(screen.getByRole("heading", { level: 3, name: "Critical chain" })).toBeInTheDocument();
    expect(screen.getByText(/^3 dimmed rows on the timeline \(milestones of other teams, or whole projects\) lie on the critical chain/)).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
    const button = screen.getByRole("button", { name: "Show the critical arrows" });
    expect(button).toHaveAttribute("aria-expanded", "false");
    await userEvent.setup().click(button);
    expect(screen.getByRole("button", { name: "Hide the critical arrows" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("table", { name: "Critical arrows on this page" })).toBeInTheDocument();
  });

  test("the intro never claims every listed dependency is drawn", () => {
    renderSection();
    expect(screen.getByText(/The table below lists the critical dependencies of this chain; an arrow is drawn only between rows on the timeline\./)).toBeInTheDocument();
  });

  test("no sentence about a chain that has not arrived (the team's own critical link alone makes the section); an empty chain has a sentence of its own", () => {
    const { unmount } = renderWithProviders(<TeamCriticalChain view={{ dependencies: [ownLink(41, true)] }} chain={undefined} />);
    expect(screen.getByRole("heading", { level: 3, name: "Critical chain" })).toBeInTheDocument();
    expect(screen.queryByText(/dimmed row/)).toBeNull();
    expect(screen.queryByText(/No milestone of another team/)).toBeNull();
    unmount();
    renderSection({ members: [], links: [], truncated: false }, [ownLink(41, true)]);
    expect(screen.getByText(/^No milestone of another team and no whole project lies on the critical chain through this team's work\./)).toBeInTheDocument();
    expect(screen.queryByText(/^0 dimmed rows/)).toBeNull();
  });

  test("the sentence is singular for one row", () => {
    // one member and no block link: the team's own critical link alone makes the section
    renderSection({ members: [UP], links: [], truncated: false }, [ownLink(41, true)]);
    expect(screen.getByText(/^1 dimmed row on the timeline \(a milestone of another team, or a whole project\) lies on the critical chain/)).toBeInTheDocument();
  });

  test("one table row per critical arrow: predecessor and successor with their project and team as links, the type and the lag (a lead worded as such)", async () => {
    renderSection();
    await userEvent.setup().click(screen.getByRole("button", { name: "Show the critical arrows" }));
    const rows = within(screen.getByRole("table", { name: "Critical arrows on this page" })).getAllByRole("row");
    // chain order: the whole project (it starts first) before the milestone that follows it
    expect(rows.map((row) => within(row).getAllByRole(row === rows[0] ? "columnheader" : "cell").map((cell) => cell.textContent))).toEqual([
      ["Predecessor", "Successor", "Type", "Lag"],
      ["Project GammaGamma", "tg-upAlphaPlatform", "Start → Start (SS)", "-2 working days (lead)"],
      ["tg-upAlphaPlatform", "tg-nearBetaPlatform", "Finish → Start (FS)", "0 working days"],
    ]);
    expect(within(rows[2]).getAllByRole("link").map((link) => [link.getAttribute("href"), link.getAttribute("aria-label")])).toEqual([
      ["/projects/71", "Open project Alpha"],
      ["/teams/9", "Open team Platform"],
      ["/projects/72", "Open project Beta"],
      ["/teams/9", "Open team Platform"],
    ]);
    // a whole project has its project link and no team link
    expect(within(rows[1]).getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual(["/projects/3", "/projects/71", "/teams/9"]);
  });

  test("the team's own critical link is listed beside the block's; one that is not critical is not", async () => {
    renderSection(CHAIN, [ownLink(41, true), ownLink(42, false)]);
    await userEvent.setup().click(screen.getByRole("button", { name: "Show the critical arrows" }));
    expect(within(screen.getByRole("table", { name: "Critical arrows on this page" })).getAllByRole("row")).toHaveLength(4); // the header, the two chain links and the one own link
  });

  test("with no critical arrow there is no section", () => {
    renderSection({ members: [], links: [], truncated: false }, [ownLink(42, false)]);
    expect(screen.queryByRole("heading")).toBeNull();
  });

  test("the cut line only when the server cut the chain, naming how many members are drawn", () => {
    const { rerender } = renderSection();
    expect(screen.queryByText(/The chain is longer than the page shows/)).toBeNull();
    rerender(<TeamCriticalChain view={{ dependencies: [] }} chain={{ ...CHAIN, truncated: true }} />);
    expect(screen.getByText("The chain is longer than the page shows: the 3 members nearest to this team's milestones are drawn.")).toBeInTheDocument();
  });
});

describe("TeamCriticalNote", () => {
  test("the note carries the id the toggle describes itself by; the cut line follows only for a cut chain", () => {
    const { rerender } = renderWithProviders(<TeamCriticalNote id="note" chain={CHAIN} />);
    expect(document.getElementById("note")).toHaveTextContent(/measured toward the end of the milestone's own project/);
    expect(document.getElementById("note")).toHaveTextContent(/The dimmed rows below the team's own are the milestones of other teams/);
    expect(screen.queryByText(/longer than the page shows/)).toBeNull();
    rerender(<TeamCriticalNote id="note" chain={{ ...CHAIN, truncated: true }} />);
    expect(screen.getByText(/longer than the page shows/)).toBeInTheDocument();
    // no block yet: the note alone
    rerender(<TeamCriticalNote id="note" chain={undefined} />);
    expect(screen.queryByText(/longer than the page shows/)).toBeNull();
  });
});
