import { describe, expect, test } from "vitest";
import { renderWithProviders, screen } from "../test/render";
import type { JiraLink, PlanFlag } from "../api/roadmap";
import { endLater } from "../test/deviations";
import { MilestoneFlags, NameWithFlags } from "./MilestoneFlags";

// The roll-up text after the Jira key (1.4): "5/12 · 34 pt", dimmed, its accessible name the full sentence. The page tests carry one fixture row each.

const SITES = new Map([[1, "https://acme.atlassian.net"]]);
const link = (rollup: JiraLink["rollup"]): JiraLink => ({ bindingId: 1, connectionId: 1, issueKey: "COV-3", start: null, end: null, rollup });
const rollup = (over: Partial<NonNullable<JiraLink["rollup"]>> = {}): NonNullable<JiraLink["rollup"]> => ({ children: 12, done: 5, points: 34, observedAt: 1, ...over });
const flag: PlanFlag = { kind: "JIRA_DEVIATION", severity: "WARNING", days: null, teamId: null, otherProjectId: null, deviation: endLater(3), count: null };

describe("MilestoneFlags - the roll-up", () => {
  test("the compact text after the key, its name the full sentence (the text itself is hidden from assistive technology)", () => {
    const { container } = renderWithProviders(<MilestoneFlags flags={[]} link={link(rollup())} sites={SITES} />);
    const text = screen.getByText("5/12 · 34 pt");
    expect(text).toHaveAttribute("aria-hidden", "true");
    const sentence = "12 child issues in Jira, done: 5, story points: 34";
    expect(screen.getByText(sentence)).toBeInTheDocument();
    expect(container.querySelector(`[title="${sentence}"]`)).not.toBeNull();
    // after the key, in the same cell
    expect(screen.getByRole("link", { name: /COV-3/ }).compareDocumentPosition(text) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test("null points omit the points part, in the text and in the sentence; one child reads in the singular; decimals drop trailing zeros", () => {
    const { rerender } = renderWithProviders(<MilestoneFlags flags={[]} link={link(rollup({ points: null, children: 1, done: 0 }))} sites={SITES} />);
    expect(screen.getByText("0/1")).toBeInTheDocument();
    expect(screen.getByText("1 child issue in Jira, done: 0")).toBeInTheDocument();
    expect(screen.queryByText(/pt/)).not.toBeInTheDocument();
    rerender(<MilestoneFlags flags={[]} link={link(rollup({ points: 7.5 }))} sites={SITES} />);
    expect(screen.getByText("5/12 · 7.5 pt")).toBeInTheDocument();
    rerender(<MilestoneFlags flags={[]} link={link(rollup({ points: 13.0 }))} sites={SITES} />);
    expect(screen.getByText("5/12 · 13 pt")).toBeInTheDocument();
    rerender(<MilestoneFlags flags={[]} link={link(rollup({ points: 0.125 }))} sites={SITES} />);
    expect(screen.getByText("5/12 · 0.13 pt")).toBeInTheDocument();
  });

  test("a link without a roll-up renders the key and nothing else of it; an unlinked row renders nothing", () => {
    const { container, rerender } = renderWithProviders(<MilestoneFlags flags={[]} link={link(null)} sites={SITES} />);
    expect(screen.getByRole("link", { name: /COV-3/ })).toBeInTheDocument();
    expect(container.querySelector("[title]")).toBeNull();
    expect(screen.queryByText(/\d\/\d/)).not.toBeInTheDocument();
    rerender(<MilestoneFlags flags={[]} link={null} sites={SITES} />);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(container.querySelector("[title], [data-flags]")).toBeNull();
  });

  test("beside the flag icon: both stay", () => {
    const { container } = renderWithProviders(<MilestoneFlags flags={[flag]} link={link(rollup())} sites={SITES} />);
    expect(container.querySelector("[data-flags]")).toHaveAttribute("data-flags", "1,0");
    expect(screen.getByText("5/12 · 34 pt")).toBeInTheDocument();
  });

  test("an unlinked row with only the calendar flag shows the triangle, the sentence as its label", () => {
    const calendar: PlanFlag = { kind: "NO_WORKING_DAY", severity: "WARNING", days: null, teamId: null, otherProjectId: null, deviation: null, count: null };
    const { container } = renderWithProviders(<MilestoneFlags flags={[calendar]} link={null} sites={SITES} />);
    expect(container.querySelector("[data-flags]")).toHaveAttribute("data-flags", "1,0");
    expect(screen.getByText("Covers no working day: only weekends or holidays")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  test("the tray's name cell carries it too (NameWithFlags)", () => {
    renderWithProviders(
      <NameWithFlags flags={[]} link={link(rollup())} sites={SITES}>
        <span>Rollout</span>
      </NameWithFlags>,
    );
    expect(screen.getByText("Rollout")).toBeInTheDocument();
    expect(screen.getByText("5/12 · 34 pt")).toBeInTheDocument();
  });
});
