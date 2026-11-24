import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import BaselineCompare from "./BaselineCompare";
import { headingOutline } from "../test/headings";
import { jsonResponse } from "../test/http";
import { renderWithProviders } from "../test/render";

// 1.26: the Links and Capacity sections as the comparison page wires them (the sections' own branches: components/Baseline{Links,Capacity}Section.test.tsx).

const NONE = { unchanged: 0, moved: 0, later: 0, earlier: 0, scheduled: 0, unscheduled: 0, added: 0, removed: 0 };
const BASELINE = { id: 5, name: "Q2 commitment", description: null, planRevision: 40, createdAt: Date.UTC(2026, 10, 2, 14, 30), createdBy: null, milestoneCount: 3, projectCount: 1, dependencyCount: 4, capacityPeriodCount: 2 };
const OTHER = { ...BASELINE, id: 9, name: "Q3 commitment", planRevision: 52 };
const LINKS = {
  captured: true,
  totals: { added: 1, removed: 0, changed: 1, unchanged: 2 },
  items: [
    { dependencyId: 3, change: "ADDED", predecessor: { kind: "PROJECT", id: 1, name: "Checkout", projectName: null }, successor: { kind: "PROJECT", id: 2, name: "Ledger", projectName: null }, then: null, now: { type: "FS", lagDays: 0 } },
    { dependencyId: 4, change: "CHANGED", predecessor: { kind: "MILESTONE", id: 7, name: "Cart", projectName: "Checkout" }, successor: { kind: "MILESTONE", id: 8, name: "Pay", projectName: "Checkout" }, then: { type: "FS", lagDays: 0 }, now: { type: "SS", lagDays: 1 } },
  ],
  truncated: false,
};
const CAPACITY = {
  captured: true,
  totals: { teams: 3, changedTeams: 1 },
  teams: [{ teamId: 1, teamName: "Payments", changes: [{ from: "2043-02-02", to: null, then: { mdPerWeek: 20, wipLimit: null }, now: { mdPerWeek: 10, wipLimit: null } }] }],
  truncated: false,
};
const EMPTY_LINKS = { captured: true, totals: { added: 0, removed: 0, changed: 0, unchanged: 4 }, items: [], truncated: false };
const NO_CAPACITY = { captured: true, totals: { teams: 3, changedTeams: 0 }, teams: [], truncated: false };
const view = (over: Record<string, unknown> = {}) => ({
  revision: 44,
  baseline: BASELINE,
  totals: { milestones: { ...NONE, unchanged: 3 }, projects: { ...NONE, unchanged: 1 } },
  projects: [],
  milestones: [],
  links: LINKS,
  capacity: CAPACITY,
  ...over,
});

function serve(documents: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => Promise.resolve(url in documents ? jsonResponse(200, documents[url]) : jsonResponse(404, { title: "x", status: 404 }))),
  );
}

function renderPage(route = "/baselines/5") {
  return renderWithProviders(
    <Routes>
      <Route path="/baselines/:id" element={<BaselineCompare />} />
    </Routes>,
    { route },
  );
}

describe("The comparison page's frozen links and capacity (1.26)", () => {
  beforeEach(() => localStorage.setItem("astrolabe.auth.token", "fake-token"));
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  test("two h3 sections after the Changes, each with its changed rows", async () => {
    serve({ "/api/v1/views/baseline/5": view() });
    renderPage();
    await screen.findByRole("heading", { level: 3, name: "Links" });
    expect(headingOutline()).toEqual([[2, "Q2 commitment"], [3, "Totals"], [3, "Changes"], [3, "Links"], [3, "Capacity"]]);
    const links = within(screen.getByRole("table", { name: "Changed links" }));
    expect(links.getAllByRole("row")).toHaveLength(3);
    expect(links.getByText("Cart · Checkout")).toBeInTheDocument();
    expect(within(screen.getByRole("table", { name: "Capacity changes" })).getByText("Payments")).toBeInTheDocument();
  });

  test("a baseline from before 1.26 reads 'not captured' in both sections, never 'no changes'", async () => {
    const none = { captured: false, totals: { added: 0, removed: 0, changed: 0, unchanged: 0 }, items: [], truncated: false };
    serve({ "/api/v1/views/baseline/5": view({ baseline: { ...BASELINE, dependencyCount: null, capacityPeriodCount: null }, links: none, capacity: { captured: false, totals: { teams: 0, changedTeams: 0 }, teams: [], truncated: false } }) });
    renderPage();
    expect(await screen.findByText(/taken before baselines froze links/)).toBeInTheDocument();
    expect(screen.getByText(/taken before baselines froze capacity/)).toBeInTheDocument();
    expect(screen.queryByText("No link changes")).toBeNull();
    expect(screen.queryByText("No capacity changes")).toBeNull();
    expect(screen.queryByRole("table", { name: "Changed links" })).toBeNull();
  });

  test("?against: the sections name both sides and ask the server for the other baseline", async () => {
    serve({ "/api/v1/views/baseline/5?against=9": view({ against: OTHER }) });
    renderPage("/baselines/5?against=9");
    const links = await screen.findByRole("table", { name: "Changed links" });
    expect(within(links).getByRole("columnheader", { name: "Then: Q2 commitment" })).toBeInTheDocument();
    expect(within(screen.getByRole("table", { name: "Capacity changes" })).getByRole("columnheader", { name: "Now: Q3 commitment" })).toBeInTheDocument();
  });

  test("the same plan revision claims 'nothing changed' only while the capacity agrees: a capacity write bumps no revision", async () => {
    serve({ "/api/v1/views/baseline/5": view({ revision: 40, links: EMPTY_LINKS, capacity: NO_CAPACITY }) });
    const { unmount } = renderPage();
    expect(await screen.findByText("The plan has not changed since this baseline.")).toBeInTheDocument();
    unmount();
    serve({ "/api/v1/views/baseline/5": view({ revision: 40, links: EMPTY_LINKS }) });
    renderPage();
    expect(await screen.findByText("The plan has not moved since this baseline; the capacity has changed.")).toBeInTheDocument();
    expect(screen.queryByText("The plan has not changed since this baseline.")).toBeNull();
  });

  test("an older baseline at the same revision keeps the plain sentence: its capacity is unknown, not changed", async () => {
    serve({ "/api/v1/views/baseline/5": view({ revision: 40, links: { ...EMPTY_LINKS, captured: false }, capacity: { ...NO_CAPACITY, captured: false } }) });
    renderPage();
    expect(await screen.findByText("The plan has not changed since this baseline.")).toBeInTheDocument();
  });
});
