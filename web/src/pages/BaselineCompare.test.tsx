import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { screen, within } from "@testing-library/react";
import { Link, Route, Routes } from "react-router-dom";
import BaselineCompare from "./BaselineCompare";
import { headingOutline } from "../test/headings";
import { jsonResponse } from "../test/http";
import { renderWithProviders } from "../test/render";

type FetchMock = ReturnType<typeof vi.fn>;

const NONE = { unchanged: 0, moved: 0, later: 0, earlier: 0, scheduled: 0, unscheduled: 0, added: 0, removed: 0 };
const BASELINE = { id: 5, name: "Q2 commitment", description: "After replanning", planRevision: 40, createdAt: Date.UTC(2026, 10, 2, 14, 30), createdBy: { userId: 1, name: "Ada Admin" }, milestoneCount: 120, projectCount: 12 };
const FIG = (start: string | null, end: string | null, estimateMd = 3) => ({ start, end, estimateMd });

const VIEW = {
  revision: 44,
  baseline: BASELINE,
  totals: {
    milestones: { ...NONE, unchanged: 100, moved: 3, later: 2, earlier: 1, added: 1, removed: 1 },
    projects: { ...NONE, unchanged: 8, moved: 1, later: 1 },
  },
  projects: [
    {
      projectId: 1,
      name: "Checkout",
      programName: "Payments",
      workStreamName: "Commerce",
      rankThen: 1,
      rankNow: 1,
      baselineSpan: { start: "2043-01-05", end: "2043-01-16" },
      span: { start: "2043-01-12", end: "2043-01-21" },
      movement: { kind: "MOVED", startDays: 5, endDays: 3, estimateDelta: null },
      counts: { ...NONE, moved: 2, later: 1, earlier: 1, added: 1, removed: 1 },
    },
    {
      projectId: 2,
      name: "Ledger",
      programName: "Finance",
      workStreamName: "Commerce",
      rankThen: 2,
      rankNow: 2,
      baselineSpan: { start: "2043-02-02", end: "2043-02-06" },
      span: { start: "2043-02-02", end: "2043-02-06" },
      movement: { kind: "UNCHANGED", startDays: 0, endDays: 0, estimateDelta: null },
      counts: { ...NONE, unchanged: 3 },
    },
    {
      projectId: 3,
      name: "Estimates only",
      programName: "Finance",
      workStreamName: "Commerce",
      rankThen: null,
      rankNow: null,
      baselineSpan: null,
      span: null,
      movement: { kind: "UNCHANGED", startDays: null, endDays: null, estimateDelta: null },
      counts: { ...NONE, unchanged: 1 },
    },
  ],
  milestones: [
    { milestoneId: 10, name: "Cart", projectId: 1, teamId: 1, teamName: "Web", frozen: FIG("2043-01-05", "2043-01-09"), live: FIG("2043-01-12", "2043-01-16", 4.5), movement: { kind: "MOVED", startDays: 5, endDays: 5, estimateDelta: 1.5 } },
    { milestoneId: 11, name: "Pay", projectId: 1, teamId: 2, teamName: "Payments team", frozen: FIG("2043-01-12", "2043-01-16"), live: FIG("2043-01-12", "2043-01-14"), movement: { kind: "MOVED", startDays: 0, endDays: -2, estimateDelta: 0 } },
    { milestoneId: 12, name: "Receipt", projectId: 1, teamId: 1, teamName: "Web", frozen: null, live: FIG("2043-01-19", "2043-01-21", 2), movement: { kind: "ADDED", startDays: null, endDays: null, estimateDelta: null } },
    { milestoneId: 13, name: "Refund", projectId: 1, teamId: 2, teamName: "Payments team", frozen: FIG("2043-01-14", "2043-01-16"), live: null, movement: { kind: "REMOVED", startDays: null, endDays: null, estimateDelta: null } },
    { milestoneId: 20, name: "Sizing", projectId: 3, teamId: 1, teamName: "Web", frozen: FIG("2043-03-01", "2043-03-05", 3), live: FIG("2043-03-01", "2043-03-05", 5), movement: { kind: "UNCHANGED", startDays: 0, endDays: 0, estimateDelta: 2 } },
  ],
};

function renderPage(route = "/baselines/5") {
  return renderWithProviders(
    <Routes>
      <Route path="/baselines" element={<p>registry</p>} />
      <Route path="/projects/:id" element={<p>project page</p>} />
      <Route path="/roadmap" element={<p>roadmap page</p>} />
      <Route path="/baselines/:id" element={<BaselineCompare />} />
    </Routes>,
    { route },
  );
}

const rowOf = (name: string) => screen.getByText(name).closest("tr")!;

describe("Baseline comparison page", () => {
  let mockFetch: FetchMock;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    localStorage.setItem("astrolabe.auth.token", "fake-token");
    mockFetch.mockImplementation((url: string) => Promise.resolve(url === "/api/v1/views/baseline/5" ? jsonResponse(200, VIEW) : jsonResponse(404, { title: "x", status: 404 })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  test("shows the header facts and the totals, the rows whose end is later in ORANGE", async () => {
    renderPage();
    expect(await screen.findByRole("heading", { level: 2, name: "Q2 commitment" })).toBeInTheDocument();
    expect(screen.getByText("After replanning")).toBeInTheDocument();
    expect(screen.getByText("Taken 2026-11-02 14:30 UTC by Ada Admin · Plan revision 40 · 120 milestones · 12 projects")).toBeInTheDocument();
    expect(screen.queryByText("The plan has not changed since this baseline.")).not.toBeInTheDocument();
    const later = screen.getAllByText("2 end later")[0];
    expect(later.closest(".mantine-Badge-root")).toHaveAttribute("data-variant", "light");
    expect(later.closest(".mantine-Badge-root")!.getAttribute("style") ?? "").toContain("orange");
    const earlier = screen.getAllByText("1 end earlier")[0];
    expect(earlier.closest(".mantine-Badge-root")!.getAttribute("style") ?? "").toContain("gray");
    expect(headingOutline()).toEqual([[2, "Q2 commitment"], [3, "Totals"], [3, "Changes"]]);
  });

  test("Show on timeline remembers this baseline as the pick of every timeline page and opens the project's page; the header action opens the roadmap", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Show on timeline: Checkout" }));
    expect(await screen.findByText("project page")).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("astrolabe.viewSettings.timeline.baseline") ?? "null")).toBe(5);
  });

  test("the header's Show on the roadmap remembers the pick too", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Show on the roadmap" }));
    expect(await screen.findByText("roadmap page")).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("astrolabe.viewSettings.timeline.baseline") ?? "null")).toBe(5);
  });

  test("says when the plan is exactly the baseline", async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, { ...VIEW, revision: 40, totals: { milestones: { ...NONE, unchanged: 3 }, projects: { ...NONE, unchanged: 1 } }, projects: [], milestones: [] }));
    renderPage();
    expect(await screen.findByText("The plan has not changed since this baseline.")).toBeInTheDocument();
    expect(screen.getAllByText("No schedule changes")).toHaveLength(2);
    expect(screen.getByText("No changes since this baseline")).toBeInTheDocument();
  });

  test("groups the changed milestones under their project, with working-day deltas for start and end", async () => {
    renderPage();
    const project = (await screen.findByRole("link", { name: "Open project Checkout" })).closest("tr")!;
    expect(screen.getByRole("link", { name: "Open project Checkout" })).toHaveAttribute("href", "/projects/1");
    expect(within(project).getByText("Payments › Commerce")).toBeInTheDocument();
    expect(within(project).getByText("start 5 working days later, end 3 working days later")).toBeInTheDocument();
    expect(project).toHaveTextContent("2043-01-05 – 2043-01-16");
    expect(project).toHaveTextContent("2043-01-12 – 2043-01-21");
    expect(within(project).getByText("+5")).toBeInTheDocument();
    expect(within(project).getByText("+3")).toBeInTheDocument();
    expect(within(project).getByText("Later")).toBeInTheDocument();

    const cart = rowOf("Cart");
    expect(within(cart).getByText("Web")).toBeInTheDocument();
    expect(within(cart).getAllByText("+5")).toHaveLength(2);
    expect(within(cart).getByText("3 → 4.5")).toBeInTheDocument();
    expect(within(cart).getByText("Later")).toBeInTheDocument();
    expect(within(cart).getByText("Later").closest(".mantine-Badge-root")!.getAttribute("style") ?? "").toContain("orange");

    const pay = rowOf("Pay");
    expect(within(pay).getByText("0")).toBeInTheDocument();
    expect(within(pay).getByText("−2")).toBeInTheDocument();
    const earlier = within(pay).getByText("Earlier");
    expect(earlier.closest(".mantine-Badge-root")!.getAttribute("style") ?? "").toContain("gray");

    // Rows for the new and the removed milestones: one side of the dates is a dash.
    const added = rowOf("Receipt");
    expect(within(added).getByText("New")).toBeInTheDocument();
    expect(added).toHaveTextContent("2043-01-19 – 2043-01-21");
    const removed = rowOf("Refund");
    expect(within(removed).getByText("Removed")).toBeInTheDocument();
    expect(removed).toHaveTextContent("2043-01-14 – 2043-01-16");
  });

  test("an estimate-only change is a changed row", async () => {
    renderPage();
    await screen.findByText("Sizing");
    const sizing = rowOf("Sizing");
    expect(within(sizing).getByText("3 → 5")).toBeInTheDocument();
    expect(within(sizing).getByText("Re-estimated")).toBeInTheDocument();
  });

  test("'changed projects only' is on by default; switching it off lists the unchanged project too", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("link", { name: "Open project Checkout" });
    expect(screen.queryByRole("link", { name: "Open project Ledger" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("switch", { name: "Changed projects only" }));
    const ledger = screen.getByRole("link", { name: "Open project Ledger" }).closest("tr")!;
    expect(within(ledger).getByText("Unchanged")).toBeInTheDocument();
  });

  test("the team filter keeps that team's rows and the projects that have one; the project filter matches the name", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("link", { name: "Open project Checkout" });
    await user.click(screen.getByRole("combobox", { name: "Team" }));
    await user.click(await screen.findByRole("option", { name: "Payments team" }));
    expect(screen.getByText("Pay")).toBeInTheDocument();
    expect(screen.getByText("Refund")).toBeInTheDocument();
    expect(screen.queryByText("Cart")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Open project Estimates only" })).not.toBeInTheDocument();
    expect(screen.getByText("Projects shown: 1 · milestone rows: 2")).toBeInTheDocument();

    await user.click(screen.getByLabelText("Clear the team filter"));
    await user.type(screen.getByRole("textbox", { name: "Project" }), "estim");
    expect(screen.queryByRole("link", { name: "Open project Checkout" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open project Estimates only" })).toBeInTheDocument();
    await user.clear(screen.getByRole("textbox", { name: "Project" }));
    await user.type(screen.getByRole("textbox", { name: "Project" }), "nothing like this");
    expect(await screen.findByText("No rows match these filters")).toBeInTheDocument();
  });

  test("the table is a named, focusable scroll region", async () => {
    renderPage();
    const region = await screen.findByRole("region", { name: "Changes since the baseline" });
    expect(region).toHaveAttribute("tabindex", "0");
    expect(within(region).getByRole("table", { name: "Changes since the baseline" })).toBeInTheDocument();
  });

  test("an unknown baseline is a not-found alert with the way back, under the page's h2", async () => {
    renderPage("/baselines/77");
    expect(await screen.findByText("This baseline does not exist (or was deleted).")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to baselines" })).toHaveAttribute("href", "/baselines");
    expect(headingOutline()).toEqual([[2, "Baseline"]]);
  });

  test("another failure is a status-tagged message, not the not-found one", async () => {
    mockFetch.mockResolvedValue(jsonResponse(500, { title: "x", status: 500 }));
    renderPage();
    expect(await screen.findByText(/500/)).toBeInTheDocument();
    expect(screen.queryByText("This baseline does not exist (or was deleted).")).not.toBeInTheDocument();
  });
  test("each project is its own rowgroup with the project as the row header; milestone rows say which project they are in", async () => {
    renderPage();
    const project = (await screen.findByRole("link", { name: "Open project Checkout" })).closest("tr")!;
    expect(within(project).getByRole("rowheader")).toContainElement(screen.getByRole("link", { name: "Open project Checkout" }));
    // thead + one tbody per shown project (Checkout, Estimates only).
    expect(screen.getAllByRole("rowgroup")).toHaveLength(3);
    expect(within(rowOf("Cart")).getByText("in Checkout")).toBeInTheDocument();
    expect(within(rowOf("Sizing")).getByText("in Estimates only")).toBeInTheDocument();
  });

  test("with 'changed projects only' off on a plan with nothing listed, the empty text is the plain one", async () => {
    const user = userEvent.setup();
    mockFetch.mockResolvedValue(jsonResponse(200, { ...VIEW, projects: [], milestones: [] }));
    renderPage();
    await user.click(await screen.findByRole("switch", { name: "Changed projects only" }));
    expect(screen.getByText("No changes since this baseline")).toBeInTheDocument();
    expect(screen.queryByText("No rows match these filters")).not.toBeInTheDocument();
  });

  test("the filters are reset when another baseline opens", async () => {
    const user = userEvent.setup();
    mockFetch.mockImplementation((url: string) =>
      Promise.resolve(/\/views\/baseline\/[56]$/.test(url) ? jsonResponse(200, { ...VIEW, baseline: { ...BASELINE, id: Number(url.at(-1)) } }) : jsonResponse(404, { title: "x", status: 404 })),
    );
    renderWithProviders(
      <Routes>
        <Route
          path="/baselines/:id"
          element={
            <>
              <Link to="/baselines/6">next</Link>
              <BaselineCompare />
            </>
          }
        />
      </Routes>,
      { route: "/baselines/5" },
    );
    await user.type(await screen.findByRole("textbox", { name: "Project" }), "estim");
    await user.click(screen.getByRole("switch", { name: "Changed projects only" }));
    await user.click(screen.getByRole("link", { name: "next" }));
    await screen.findByText("Projects shown: 2 · milestone rows: 5");
    expect(screen.getByRole("textbox", { name: "Project" })).toHaveValue("");
    expect(screen.getByRole("switch", { name: "Changed projects only" })).toBeChecked();
  });

  test.each(["1abc", "0", "-3", "5.0", "007", "2147483648", "99999999999"])("the id %s is malformed: not found, and no request", async (raw) => {
    renderPage(`/baselines/${raw}`);
    expect(await screen.findByText("This baseline does not exist (or was deleted).")).toBeInTheDocument();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("the largest int32 id is well-formed and asked for", async () => {
    renderPage("/baselines/2147483647");
    await screen.findByText("This baseline does not exist (or was deleted).");
    expect(mockFetch).toHaveBeenCalledWith("/api/v1/views/baseline/2147483647", expect.anything());
  });
});
