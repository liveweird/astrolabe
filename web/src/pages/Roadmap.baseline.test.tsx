import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { screen, waitFor, within } from "@testing-library/react";
import Roadmap from "./Roadmap";
import type { Movement } from "../api/baselines";
import type { RoadmapProject, RoadmapView } from "../api/roadmap";
import { jsonResponse } from "../test/http";
import { renderWithProviders } from "../test/render";

// The v0.9 baseline overlay on the Roadmap page: the picker in the timeline toolbar, a shadow bar under each baselined project's span bar,
// the totals line, the typed 400 that clears the pick. The pick is the one the other timeline pages share.

const PICK_KEY = "astrolabe.viewSettings.timeline.baseline";
const UNKNOWN = { type: "urn:astrolabe:problem:unknown-baseline", title: "Bad Request", status: 400, detail: "unknown baseline" };

const move = (kind: Movement["kind"], startDays: number | null, endDays: number | null): Movement => ({ kind, startDays, endDays, estimateDelta: null });

const project = (id: number, name: string, over: Partial<RoadmapProject> = {}): RoadmapProject => ({
  jira: null,
  id,
  name,
  programId: 10,
  programName: "Billing",
  workStreamId: 1,
  workStreamName: "Platform",
  ownerPersonId: 5,
  ownerName: "Ola Owner",
  targetStart: null,
  targetEnd: null,
  rankPosition: null,
  teamIds: [],
  span: null,
  drift: null,
  flags: [],
  can: { editTargetWindow: false },
  ...over,
});

const plainView = (): RoadmapView => ({
  jiraSites: [],
  revision: 7,
  can: { editRank: false },
  teams: [],
  links: [],
  ranked: [
    { position: 1, project: project(1, "Invoices", { rankPosition: 1, span: { start: "2026-03-09", end: "2026-04-10" } }) },
    { position: 2, project: project(2, "Taxes", { rankPosition: 2, span: { start: "2026-05-04", end: "2026-06-05" } }) },
    { position: 3, project: project(3, "Audit", { rankPosition: 3, span: { start: "2026-06-08", end: "2026-06-19" } }) },
  ],
  unranked: [project(4, "Fresh", { span: { start: "2026-07-06", end: "2026-07-10" } })],
});

/** Invoices ends 5 working days later, Taxes did not move, Audit ended later too, Fresh is new, one project is gone. */
const withBaseline = (view = plainView()): RoadmapView => {
  const baselineOf = (span: { start: string; end: string } | null, movement: Movement) => ({ span, movement, rankPosition: null, targetStart: null, targetEnd: null });
  const [invoices, taxes, audit] = view.ranked;
  return {
    ...view,
    ranked: [
      { ...invoices, project: { ...invoices.project, baseline: baselineOf({ start: "2026-03-09", end: "2026-04-03" }, move("MOVED", 0, 5)) } },
      { ...taxes, project: { ...taxes.project, baseline: baselineOf({ start: "2026-05-04", end: "2026-06-05" }, move("UNCHANGED", 0, 0)) } },
      { ...audit, project: { ...audit.project, baseline: baselineOf({ start: "2026-06-08", end: "2026-06-12" }, move("MOVED", 0, 5)) } },
    ],
    baseline: { id: 5, name: "Q1 plan", planRevision: 4, removedProjects: [{ projectId: 9, name: "Old", programName: "Billing", workStreamName: "Platform", span: null }] },
  };
};

const BASELINES = {
  items: [
    { id: 5, name: "Q1 plan", description: null, planRevision: 4, createdAt: 2, createdBy: null, milestoneCount: 3, projectCount: 3 },
    { id: 6, name: "Q0 plan", description: null, planRevision: 3, createdAt: 1, createdBy: null, milestoneCount: 3, projectCount: 3 },
  ],
  can: { manage: false },
};

let view: RoadmapView;
let mockFetch: ReturnType<typeof vi.fn>;
let viewUrls: string[];

beforeEach(() => {
  view = plainView();
  viewUrls = [];
  mockFetch = vi.fn((url: string) => {
    if (url.startsWith("/api/v1/views/roadmap")) {
      viewUrls.push(url);
      if (url.endsWith("?baseline=5")) return Promise.resolve(jsonResponse(200, withBaseline(view)));
      if (url.endsWith("?baseline=6")) return Promise.resolve(jsonResponse(200, { ...withBaseline(view), baseline: { ...withBaseline(view).baseline!, id: 6, name: "Q0 plan" } }));
      if (url.endsWith("?baseline=99")) return Promise.resolve(jsonResponse(400, UNKNOWN));
      return Promise.resolve(jsonResponse(200, view));
    }
    if (url === "/api/v1/baselines") return Promise.resolve(jsonResponse(200, BASELINES));
    if (url === "/api/v1/public-holidays") return Promise.resolve(jsonResponse(200, { items: [] }));
    return Promise.resolve(jsonResponse(404, { title: "x", status: 404 }));
  });
  vi.stubGlobal("fetch", mockFetch);
  localStorage.setItem("astrolabe.auth.token", "fake-token");
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

const waitForGrid = () => screen.findByRole("grid", { name: "Roadmap timeline" });
const shadows = () => [...document.querySelectorAll('[data-tone="baseline"]')].map((bar) => bar.getAttribute("aria-label"));


/** Holds the answer of the view requests `matches` selects until the returned function releases them (the next pick still loading). */
function holdViews(matches: (url: string) => boolean): () => void {
  const base = mockFetch.getMockImplementation() as (url: string, init?: RequestInit) => Promise<Response>;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  mockFetch.mockImplementation((url: string, init?: RequestInit) => (matches(url) ? gate.then(() => base(url, init)) : base(url, init)));
  return release;
}

describe("Roadmap page with a baseline", () => {
  test("no baseline by default: the plain view, the picker reads None, no shadow bar and no totals line", async () => {
    renderPage();
    await waitForGrid();
    expect(viewUrls).toEqual(["/api/v1/views/roadmap"]);
    expect(await screen.findByRole("combobox", { name: "Baseline" })).toHaveValue("None");
    expect(shadows()).toEqual([]);
    expect(screen.queryByText(/vs baseline/)).toBeNull();
  });

  test("a remembered pick draws a shadow bar under each baselined project's span and one totals line counts them (the removed one included)", async () => {
    localStorage.setItem(PICK_KEY, "5");
    renderPage();
    await waitForGrid();
    expect(viewUrls).toEqual(["/api/v1/views/roadmap?baseline=5"]);
    await waitFor(() => expect(shadows()).toHaveLength(3));
    expect(shadows()).toEqual([
      "Baseline: Invoices, 2026-03-09 to 2026-04-03, start unchanged, end 5 working days later, read-only",
      "Baseline: Taxes, 2026-05-04 to 2026-06-05, read-only",
      "Baseline: Audit, 2026-06-08 to 2026-06-12, start unchanged, end 5 working days later, read-only",
    ]);
    const note = screen.getByRole("note");
    expect(note).toHaveTextContent("vs baseline Q1 plan:");
    expect(within(note).getAllByText(/./).map((node) => node.textContent)).toEqual(expect.arrayContaining(["2 end later", "1 new", "1 removed"]));
    // the span bars keep their own tone; the baseline never makes a project row editable
    expect(screen.getByRole("img", { name: /^Invoices, / })).toHaveAttribute("data-tone", "summary");
  });

  test("picking a baseline from the toolbar fetches it and remembers it", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitForGrid();
    await user.click(await screen.findByRole("combobox", { name: "Baseline" }));
    await user.click(screen.getByRole("option", { name: "Q1 plan (latest)" }));
    await waitFor(() => expect(viewUrls.at(-1)).toBe("/api/v1/views/roadmap?baseline=5"));
    expect(JSON.parse(localStorage.getItem(PICK_KEY) ?? "null")).toBe(5);
    await waitFor(() => expect(shadows()).toHaveLength(3));
  });

  test.each([
    ["another baseline B", "Q0 plan", "/api/v1/views/roadmap?baseline=6"],
    ["no baseline", "None", "/api/v1/views/roadmap"],
  ])("changing to %s: while it loads no project row still draws the old pick's shadow bar or totals line", async (_name, option, url) => {
    const user = userEvent.setup();
    localStorage.setItem(PICK_KEY, "5");
    renderPage();
    await waitForGrid();
    await waitFor(() => expect(shadows()).toHaveLength(3));
    const release = holdViews((requested) => requested === url);
    await user.click(screen.getByRole("combobox", { name: "Baseline" }));
    await user.click(await screen.findByRole("option", { name: option }));
    await waitFor(() => expect(mockFetch.mock.calls.some(([requested]) => requested === url)).toBe(true));
    expect(shadows()).toEqual([]);
    expect(screen.queryByRole("note")).toBeNull();
    release();
    await waitFor(() => expect(screen.getByRole("grid", { name: "Roadmap timeline" })).toBeInTheDocument());
    if (option === "None") await waitFor(() => expect(JSON.parse(localStorage.getItem(PICK_KEY) ?? "null")).toBeNull());
    else await waitFor(() => expect(shadows()).toHaveLength(3));
  });

  test("the rank cell says what the rank was (a smaller number is better), the totals line counts the rank movement", async () => {
    localStorage.setItem(PICK_KEY, "5");
    // Invoices 1 (was 3: up), Taxes 2 (was 2: unchanged), Audit 3 (was unranked: newly ranked), Fresh unranked (was 4: no longer ranked)
    const ranked = withBaseline(view);
    const rank = (rankPosition: number | null, entry: RoadmapProject) => ({ ...entry, baseline: { ...(entry.baseline ?? ({} as NonNullable<RoadmapProject["baseline"]>)), rankPosition } });
    const [invoices, taxes, audit] = ranked.ranked;
    view = {
      ...ranked,
      ranked: [
        { ...invoices, project: rank(3, invoices.project) },
        { ...taxes, project: rank(2, taxes.project) },
        { ...audit, project: rank(null, audit.project) },
      ],
      unranked: [rank(4, { ...project(4, "Fresh", { span: { start: "2026-07-06", end: "2026-07-10" } }), baseline: ranked.ranked[0].project.baseline })],
    };
    mockFetch.mockImplementation((url: string) =>
      Promise.resolve(url.startsWith("/api/v1/views/roadmap") ? jsonResponse(200, view) : url === "/api/v1/baselines" ? jsonResponse(200, BASELINES) : url === "/api/v1/public-holidays" ? jsonResponse(200, { items: [] }) : jsonResponse(404, { title: "x", status: 404 })),
    );
    renderPage();
    await waitForGrid();
    const cellOf = (name: string) => screen.getByRole("link", { name: new RegExp(name) }).closest('[role="row"]')!.querySelector('[role="gridcell"], [role="rowheader"]')!;
    await waitFor(() => expect(screen.getAllByText(/^\(was /)).toHaveLength(3));
    expect(screen.getByText("(was 3)")).toBeInTheDocument();
    expect(screen.getByText("(was unranked)")).toBeInTheDocument();
    expect(screen.getByText("(was 4)")).toBeInTheDocument();
    // one sentence per changed row for assistive technology; the unchanged row and the plain number add nothing
    expect(screen.getByText("Rank 1, was rank 3 in the baseline")).toBeInTheDocument();
    expect(screen.getByText("Rank 3, was unranked in the baseline")).toBeInTheDocument();
    expect(screen.getByText("Unranked, was rank 4 in the baseline")).toBeInTheDocument();
    expect(screen.queryByText(/Rank 2/)).toBeNull();
    expect(cellOf("Taxes")).toHaveTextContent(/^2$/);
    const note = screen.getByRole("note");
    expect(within(note).getAllByText(/./).map((node) => node.textContent)).toEqual(expect.arrayContaining(["1 moved up in rank", "1 newly ranked", "1 no longer ranked"]));
    expect(within(note).queryByText(/moved down in rank/)).toBeNull();
  });

  test("without a baseline the rank cell is the plain position and the totals line is absent", async () => {
    renderPage();
    await waitForGrid();
    expect(screen.queryByText(/\(was /)).toBeNull();
    expect(screen.queryByRole("note")).toBeNull();
  });

  test("the typed 400 clears a pick that is gone and fetches the plain view once", async () => {
    localStorage.setItem(PICK_KEY, "99");
    renderPage();
    await waitForGrid();
    expect(viewUrls).toEqual(["/api/v1/views/roadmap?baseline=99", "/api/v1/views/roadmap"]);
    expect(JSON.parse(localStorage.getItem(PICK_KEY) ?? "null")).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(viewUrls).toHaveLength(2);
    expect(screen.queryByText(/Could not load the roadmap/)).toBeNull();
  });
});

function renderPage() {
  return renderWithProviders(<Roadmap />);
}
