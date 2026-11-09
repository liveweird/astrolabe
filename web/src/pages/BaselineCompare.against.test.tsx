import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { screen, waitFor, within } from "@testing-library/react";
import { Route, Routes, useLocation } from "react-router-dom";
import BaselineCompare from "./BaselineCompare";
import { headingOutline } from "../test/headings";
import { jsonResponse } from "../test/http";
import { renderWithProviders } from "../test/render";

// 1.7: the comparison page's "Compare against" picker - the page's baseline is "then", the URL's ?against= is "now" (another baseline), the
// sides are named, the timeline shortcuts are hidden, the rank movement is a sentence on the project row.

const NONE = { unchanged: 0, moved: 0, later: 0, earlier: 0, scheduled: 0, unscheduled: 0, added: 0, removed: 0 };
const THEN = { id: 5, name: "Q2 commitment", description: null, planRevision: 40, createdAt: Date.UTC(2026, 10, 2, 14, 30), createdBy: { userId: 1, name: "Ada Admin" }, milestoneCount: 120, projectCount: 12 };
const NOW = { id: 9, name: "Q3 commitment", description: null, planRevision: 52, createdAt: Date.UTC(2026, 10, 9, 8, 0), createdBy: null, milestoneCount: 130, projectCount: 13 };
const OTHER = { id: 7, name: "Q2.5 draft", description: null, planRevision: 46, createdAt: Date.UTC(2026, 10, 5, 8, 0), createdBy: null, milestoneCount: 125, projectCount: 12 };
// newest first, the page's own baseline included
const LIST = { items: [NOW, OTHER, THEN], can: { manage: false } };
const UNKNOWN = { type: "urn:astrolabe:problem:unknown-baseline", title: "Bad Request", status: 400, detail: "unknown baseline" };

const project = (over: object) => ({
  projectId: 1,
  name: "Checkout",
  programName: "Payments",
  workStreamName: "Commerce",
  rankThen: 3,
  rankNow: 5,
  baselineSpan: { start: "2043-01-05", end: "2043-01-16" },
  span: { start: "2043-01-12", end: "2043-01-21" },
  movement: { kind: "MOVED", startDays: 5, endDays: 3, estimateDelta: null },
  counts: { ...NONE, moved: 1, later: 1 },
  ...over,
});

const LIVE_VIEW = { revision: 44, baseline: THEN, totals: { milestones: { ...NONE, unchanged: 3 }, projects: { ...NONE, moved: 1, later: 1 } }, projects: [project({})], milestones: [] };
const AGAINST_VIEW = {
  ...LIVE_VIEW,
  revision: 60,
  against: NOW,
  projects: [project({ rankThen: null, rankNow: 2 }), project({ projectId: 2, name: "Ledger", rankThen: 4, rankNow: 4 }), project({ projectId: 3, name: "Fresh", rankThen: null, rankNow: 1, movement: { kind: "ADDED", startDays: null, endDays: null, estimateDelta: null } })],
};

function Where() {
  const { search, state } = useLocation();
  return <output aria-label="location">{`${search}|${JSON.stringify(state)}`}</output>;
}

function renderPage(route: string) {
  return renderWithProviders(
    <Routes>
      <Route
        path="/baselines/:id"
        element={
          <>
            <Where />
            <BaselineCompare />
          </>
        }
      />
    </Routes>,
    { route },
  );
}

describe("Baseline comparison page, two baselines", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  let viewUrls: string[];

  beforeEach(() => {
    viewUrls = [];
    mockFetch = vi.fn((url: string) => {
      if (url === "/api/v1/baselines") return Promise.resolve(jsonResponse(200, LIST));
      if (url.startsWith("/api/v1/views/baseline/5")) {
        viewUrls.push(url);
        if (url === "/api/v1/views/baseline/5?against=9") return Promise.resolve(jsonResponse(200, AGAINST_VIEW));
        if (url === "/api/v1/views/baseline/5?against=7") return Promise.resolve(jsonResponse(200, { ...AGAINST_VIEW, against: OTHER }));
        if (url === "/api/v1/views/baseline/5?against=99") return Promise.resolve(jsonResponse(400, UNKNOWN));
        if (url === "/api/v1/views/baseline/5") return Promise.resolve(jsonResponse(200, LIVE_VIEW));
      }
      return Promise.resolve(jsonResponse(404, { title: "x", status: 404 }));
    });
    vi.stubGlobal("fetch", mockFetch);
    localStorage.setItem("astrolabe.auth.token", "fake-token");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  test("by default the live plan is picked and offered beside every OTHER baseline, newest first with its plan revision", async () => {
    const user = userEvent.setup();
    renderPage("/baselines/5");
    const picker = await screen.findByRole("combobox", { name: "Compare against" });
    expect(picker).toHaveValue("The live plan");
    expect(viewUrls).toEqual(["/api/v1/views/baseline/5"]);
    await user.click(picker);
    const options = await screen.findAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual(["The live plan", "Q3 commitment (plan revision 52)", "Q2.5 draft (plan revision 46)"]);
    // the live comparison keeps its shortcuts and its column names
    expect(screen.getByRole("button", { name: "Show on the roadmap" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show on timeline: Checkout" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Baseline" })).toBeInTheDocument();
  });

  test("a link with ?against= asks for it, names both sides in the facts and the column headers and hides the timeline shortcuts", async () => {
    renderPage("/baselines/5?against=9");
    expect(await screen.findByText(/^Then: Q2 commitment · Taken 2026-11-02 14:30 UTC by Ada Admin · Plan revision 40 · 120 milestones · 12 projects$/)).toBeInTheDocument();
    expect(screen.getByText("Now: Q3 commitment · Taken 2026-11-09 08:00 UTC · Plan revision 52 · 130 milestones · 13 projects")).toBeInTheDocument();
    expect(viewUrls).toEqual(["/api/v1/views/baseline/5?against=9"]);
    expect(await screen.findByDisplayValue("Q3 commitment (plan revision 52)")).toBe(screen.getByRole("combobox", { name: "Compare against" }));
    expect(screen.getByRole("heading", { level: 2, name: "Q2 commitment" })).toBeInTheDocument();
    expect(headingOutline()).toEqual([[2, "Q2 commitment"], [3, "Totals"], [3, "Changes"]]);
    expect(screen.getByRole("columnheader", { name: "Then: Q2 commitment" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Now: Q3 commitment" })).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Changes between the two baselines" })).toBeInTheDocument();
    expect(screen.getByText(/a positive figure means later in "Q3 commitment" than in "Q2 commitment"/)).toBeInTheDocument();
    expect(screen.queryByText("The plan has not changed since this baseline.")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show on the roadmap" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Show on timeline/ })).not.toBeInTheDocument();
  });

  test("the rank movement is a sentence on the project row: both ranked, from unranked; unchanged and new projects say nothing", async () => {
    renderPage("/baselines/5?against=9");
    await screen.findByText("Then: Q2 commitment · Taken 2026-11-02 14:30 UTC by Ada Admin · Plan revision 40 · 120 milestones · 12 projects");
    const rowgroup = (name: string) => screen.getByRole("link", { name: `Open project ${name}` }).closest("tbody")!;
    expect(within(rowgroup("Checkout")).getByText("Unranked → rank 2")).toBeInTheDocument();
    expect(within(rowgroup("Ledger")).queryByText(/Rank|rank/)).toBeNull();
    expect(within(rowgroup("Fresh")).queryByText(/→/)).toBeNull();
  });

  test("the live comparison shows the rank sentence too", async () => {
    renderPage("/baselines/5");
    expect(await screen.findByText("Rank 3 → 5")).toBeInTheDocument();
  });

  test("two baselines at the same plan revision say that nothing moved", async () => {
    mockFetch.mockImplementation((url: string) =>
      Promise.resolve(
        url === "/api/v1/baselines" ? jsonResponse(200, LIST) : url === "/api/v1/views/baseline/5?against=9" ? jsonResponse(200, { ...AGAINST_VIEW, against: { ...NOW, planRevision: 40 } }) : jsonResponse(404, { title: "x", status: 404 }),
      ),
    );
    renderPage("/baselines/5?against=9");
    expect(await screen.findByText("The two baselines are at the same plan revision: nothing moved.")).toBeInTheDocument();
  });

  test("picking another baseline puts it in the URL and asks for it; picking the live plan takes it out again", async () => {
    const user = userEvent.setup();
    renderPage("/baselines/5");
    await user.click(await screen.findByRole("combobox", { name: "Compare against" }));
    await user.click(await screen.findByRole("option", { name: "Q2.5 draft (plan revision 46)" }));
    await waitFor(() => expect(viewUrls).toContain("/api/v1/views/baseline/5?against=7"));
    expect(screen.getByLabelText("location")).toHaveTextContent("?against=7");
    await screen.findByText(/^Now: Q2.5 draft · Taken/);
    await user.click(screen.getByRole("combobox", { name: "Compare against" }));
    await user.click(await screen.findByRole("option", { name: "The live plan" }));
    await waitFor(() => expect(screen.getByLabelText("location")).toHaveTextContent(/^\|/));
    await screen.findByRole("button", { name: "Show on the roadmap" });
    expect(viewUrls.at(-1)).toBe("/api/v1/views/baseline/5");
  });

  test("an against baseline that was deleted (the typed 400) is dropped: the live comparison loads and an inline note says so", async () => {
    renderPage("/baselines/5?against=99");
    expect(await screen.findByText("The baseline you compared against no longer exists; showing the comparison with the live plan instead.")).toBeInTheDocument();
    expect(viewUrls).toEqual(["/api/v1/views/baseline/5?against=99", "/api/v1/views/baseline/5"]);
    expect(screen.getByLabelText("location")).toHaveTextContent('|{"againstDropped":true}');
    expect(screen.getByRole("combobox", { name: "Compare against" })).toHaveValue("The live plan");
    expect(screen.getByRole("button", { name: "Show on the roadmap" })).toBeInTheDocument();
  });

  test("a newly picked baseline that fails to load (a 500) keeps the page chrome and the picker with the error inline; picking the live plan recovers", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url === "/api/v1/baselines") return Promise.resolve(jsonResponse(200, LIST));
      if (url === "/api/v1/views/baseline/5?against=7") return Promise.resolve(jsonResponse(500, { title: "x", status: 500 }));
      if (url === "/api/v1/views/baseline/5") return Promise.resolve(jsonResponse(200, LIVE_VIEW));
      return Promise.resolve(jsonResponse(404, { title: "x", status: 404 }));
    });
    const user = userEvent.setup();
    renderPage("/baselines/5");
    await user.click(await screen.findByRole("combobox", { name: "Compare against" }));
    await user.click(await screen.findByRole("option", { name: "Q2.5 draft (plan revision 46)" }));
    expect(await screen.findByRole("alert", {}, { timeout: 5000 })).toHaveTextContent(/Could not load the comparison/);
    expect(screen.getByRole("combobox", { name: "Compare against" })).toHaveValue("Q2.5 draft (plan revision 46)");
    expect(screen.getByRole("heading", { level: 2, name: "Baseline" })).toBeInTheDocument();
    await user.click(screen.getByRole("combobox", { name: "Compare against" }));
    await user.click(await screen.findByRole("option", { name: "The live plan" }));
    await screen.findByRole("button", { name: "Show on the roadmap" });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("heading", { level: 2, name: "Q2 commitment" })).toBeInTheDocument();
  });

  test.each(["abc", "5", "0", "9999999999"])("a ?against=%s that is no other baseline's id is ignored: the live comparison, no such request", async (raw) => {
    renderPage(`/baselines/5?against=${raw}`);
    expect(await screen.findByRole("combobox", { name: "Compare against" })).toHaveValue("The live plan");
    expect(viewUrls).toEqual(["/api/v1/views/baseline/5"]);
  });

  test("when the list of baselines cannot be loaded the picker is disabled and says so; the live comparison still works", async () => {
    mockFetch.mockImplementation((url: string) => Promise.resolve(url === "/api/v1/views/baseline/5" ? jsonResponse(200, LIVE_VIEW) : jsonResponse(500, { title: "x", status: 500 })));
    renderPage("/baselines/5");
    expect(await screen.findByText("The list of baselines could not be loaded; only the live plan is available.")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Compare against" })).toBeDisabled();
  });
});
