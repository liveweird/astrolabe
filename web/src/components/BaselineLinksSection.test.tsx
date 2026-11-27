import { describe, expect, test } from "vitest";
import { screen, within } from "@testing-library/react";
import BaselineLinksSection from "./BaselineLinksSection";
import type { BaselineLinks } from "../api/baselines";
import { renderWithProviders } from "../test/render";

const milestone = (id: number, name: string, projectName: string | null = "Checkout") => ({ kind: "MILESTONE" as const, id, name, projectId: projectName === null ? null : 9, projectName });
const project = (id: number, name: string) => ({ kind: "PROJECT" as const, id, name, projectId: null, projectName: null });

const LINKS: BaselineLinks = {
  captured: true,
  totals: { added: 1, removed: 1, changed: 1, unchanged: 7 },
  items: [
    { dependencyId: 3, change: "ADDED", predecessor: milestone(30, "Cart"), successor: project(2, "Ledger"), then: null, now: { type: "FS", lagDays: 2 } },
    { dependencyId: 4, change: "REMOVED", predecessor: project(1, "Checkout"), successor: milestone(41, "Pay", null), then: { type: "SS", lagDays: 0 }, now: null },
    { dependencyId: 5, change: "CHANGED", predecessor: milestone(50, "Refund"), successor: milestone(51, "Receipt"), then: { type: "FS", lagDays: 1 }, now: { type: "FF", lagDays: -2 } },
  ],
  truncated: false,
};
const NOT_CAPTURED: BaselineLinks = { captured: false, totals: { added: 0, removed: 0, changed: 0, unchanged: 0 }, items: [], truncated: false };

const rows = () => within(screen.getByRole("table", { name: "Changed links" })).getAllByRole("row").slice(1);
const cellTexts = (row: HTMLElement) => within(row).getAllByRole("cell").map((cell) => cell.textContent);

describe("BaselineLinksSection (1.26)", () => {
  test("an h3 'Links', the totals as gray badges and one row per changed link with both ends, then and now", () => {
    renderWithProviders(<BaselineLinksSection links={LINKS} sides={null} />);
    expect(screen.getByRole("heading", { level: 3, name: "Links" })).toBeInTheDocument();
    for (const label of ["1 added", "1 removed", "1 changed", "7 unchanged"]) {
      expect(screen.getByText(label).closest(".mantine-Badge-root")!.getAttribute("style") ?? "").toContain("gray");
    }
    expect(within(screen.getByRole("table", { name: "Changed links" })).getAllByRole("columnheader").map((header) => header.textContent)).toEqual(["Change", "Predecessor", "Successor", "Baseline", "Current"]);
    expect(cellTexts(rows()[0])).toEqual(["Added", "Cart · Checkout", "Project Ledger", "—", "Finish → Start (FS) · 2 working days"]);
    expect(cellTexts(rows()[1])).toEqual(["Removed", "Project Checkout", "Pay", "Start → Start (SS) · 0 working days", "—"]);
    expect(cellTexts(rows()[2])).toEqual(["Changed", "Refund · Checkout", "Receipt · Checkout", "Finish → Start (FS) · 1 working day", "Finish → Finish (FF) · -2 working days (lead)"]);
    expect(screen.queryByRole("note")).toBeNull();
  });

  test("against another baseline the column headers name both sides", () => {
    renderWithProviders(<BaselineLinksSection links={LINKS} sides={{ then: "Q2", now: "Q3" }} />);
    expect(within(screen.getByRole("table", { name: "Changed links" })).getAllByRole("columnheader").map((header) => header.textContent)).toEqual(["Change", "Predecessor", "Successor", "Then: Q2", "Now: Q3"]);
  });

  test("no changed link: the totals say so and there is no table; the unchanged count stays", () => {
    renderWithProviders(<BaselineLinksSection links={{ ...LINKS, totals: { added: 0, removed: 0, changed: 0, unchanged: 7 }, items: [] }} sides={null} />);
    expect(screen.getByText("No link changes")).toBeInTheDocument();
    expect(screen.getByText("7 unchanged")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });

  test("truncated: a note with the count listed, the totals still the whole", () => {
    renderWithProviders(<BaselineLinksSection links={{ ...LINKS, truncated: true, totals: { added: 1500, removed: 0, changed: 0, unchanged: 0 } }} sides={null} />);
    expect(screen.getByRole("note")).toHaveTextContent("More links changed than fit here: the first 3 by id are listed, and the totals count them all.");
    expect(screen.getByText("1500 added")).toBeInTheDocument();
  });

  test("not captured is unknown, not 'no changes': a note, no totals and no table (one wording per mode)", () => {
    const { rerender } = renderWithProviders(<BaselineLinksSection links={NOT_CAPTURED} sides={null} />);
    expect(screen.getByText(/This baseline was taken before baselines froze links/)).toBeInTheDocument();
    expect(screen.queryByText("No link changes")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
    rerender(<BaselineLinksSection links={NOT_CAPTURED} sides={{ then: "Q2", now: "Q3" }} />);
    expect(screen.getByText(/One of the two baselines was taken before baselines froze links/)).toBeInTheDocument();
  });
});
