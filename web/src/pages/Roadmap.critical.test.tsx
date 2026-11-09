import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { screen, waitFor, within } from "@testing-library/react";
import Roadmap from "./Roadmap";
import type { RoadmapCriticalPath, RoadmapLink, RoadmapProject, RoadmapView } from "../api/roadmap";
import { headingOutline } from "../test/headings";
import { jsonResponse } from "../test/http";
import { renderWithProviders } from "../test/render";

// The 1.7 critical path toward a picked project on the Roadmap page: the toolbar picker and the row menu set a PAGE-LOCAL target, ?criticalPath=N
// fetches the chain, the target and the chain's span bars and arrows are emphasised, the panel lists the chain, and a 400 clears the selection.

const ANNOUNCE = "Showing the critical path to Audit";

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

const link = (pred: number, succ: number, over: Partial<RoadmapLink> = {}): RoadmapLink => ({ predecessorProjectId: pred, successorProjectId: succ, direct: null, milestoneLinks: { count: 0, violated: 0, unscheduled: 0 }, ...over });

/** Invoices -> Audit is a direct link on the chain; Taxes -> Invoices is a bundle (Taxes has slack); Ledger (no span) stands apart. */
const plainView = (): RoadmapView => ({
  jiraSites: [],
  revision: 7,
  can: { editRank: false },
  teams: [],
  links: [
    link(1, 3, { direct: { id: 41, type: "FS", lagDays: 0, check: { status: "OK", shortfallDays: null, slackDays: 0, requiredDate: null, actualDate: null } } }),
    link(2, 1, { milestoneLinks: { count: 2, violated: 0, unscheduled: 0 } }),
  ],
  ranked: [
    { position: 1, project: project(1, "Invoices", { rankPosition: 1, span: { start: "2026-03-09", end: "2026-04-10" } }) },
    { position: 2, project: project(2, "Taxes", { rankPosition: 2, workStreamId: 2, workStreamName: "Finance", span: { start: "2026-02-02", end: "2026-02-27" } }) },
    { position: 3, project: project(3, "Audit", { rankPosition: 3, span: { start: "2026-05-04", end: "2026-06-05" } }) },
  ],
  unranked: [project(4, "Ledger")],
});

const CHAIN: RoadmapCriticalPath = {
  projectId: 3,
  projects: [
    { projectId: 1, slackDays: 0, critical: true, hops: 1 },
    { projectId: 2, slackDays: 4, critical: false, hops: 2 },
  ],
  pairs: [{ predecessorProjectId: 1, successorProjectId: 3 }],
};

const GONE = { type: "about:blank", title: "Bad Request", status: 400, detail: "Unknown or deleted project id: 3" };

let view: RoadmapView;
let mockFetch: ReturnType<typeof vi.fn>;
let viewUrls: string[];
/** The project 3 vanished server-side: ?criticalPath=3 answers the plain 400. */
let threeIsGone: boolean;
/** When set, ?criticalPath=1 waits for it (the target switched A -> B while B's chain is on its way). */
let holdOne: Promise<void> | null;

beforeEach(() => {
  view = plainView();
  viewUrls = [];
  threeIsGone = false;
  holdOne = null;
  mockFetch = vi.fn((url: string) => {
    if (url.startsWith("/api/v1/views/roadmap")) {
      viewUrls.push(url);
      if (url.endsWith("?criticalPath=3") && threeIsGone) return Promise.resolve(jsonResponse(400, GONE));
      if (url.endsWith("?criticalPath=3")) return Promise.resolve(jsonResponse(200, { ...view, criticalPath: CHAIN }));
      if (url.endsWith("?criticalPath=1"))
        return (holdOne ?? Promise.resolve()).then(() => jsonResponse(200, { ...view, criticalPath: { projectId: 1, projects: [{ projectId: 2, slackDays: 0, critical: true, hops: 1 }], pairs: [{ predecessorProjectId: 2, successorProjectId: 1 }] } }));
      if (url.endsWith("?criticalPath=4")) return Promise.resolve(jsonResponse(200, { ...view, criticalPath: { projectId: 4, projects: [], pairs: [] } }));
      if (url.endsWith("?criticalPath=99")) return Promise.resolve(jsonResponse(400, GONE));
      return Promise.resolve(jsonResponse(200, view));
    }
    if (url === "/api/v1/baselines") return Promise.resolve(jsonResponse(200, { items: [], can: { manage: false } }));
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
const criticalBars = () => [...document.querySelectorAll('[data-tone="summary"][data-critical="true"]')].map((bar) => bar.getAttribute("aria-label"));
const arrows = () => [...document.querySelectorAll("[data-arrow]")].map((arrow) => [arrow.getAttribute("data-arrow"), arrow.getAttribute("data-critical")]);
const picker = () => screen.findByRole("combobox", { name: "Critical path to…" });

async function pickFromToolbar(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(await picker());
  await user.click(await screen.findByRole("option", { name }));
}

describe("Roadmap page: the critical path to a picked project", () => {
  test("off by default: the plain view is fetched, the picker reads None, nothing is emphasised and there is no panel", async () => {
    renderWithProviders(<Roadmap />);
    await waitForGrid();
    expect(viewUrls).toEqual(["/api/v1/views/roadmap"]);
    expect(await picker()).toHaveValue("None");
    expect(document.querySelector("[data-critical]")).toBeNull();
    expect(screen.queryByRole("heading", { name: /Critical path to/ })).toBeNull();
    expect(headingOutline()).toEqual([
      [2, "Roadmap"],
      [3, "Timeline"],
      [3, "Flags"],
    ]);
  });

  test("the picker offers the projects with a span (not Ledger), and picking one fetches ?criticalPath=, emphasises the target, the chain and their arrows, and lists the chain", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Roadmap />);
    await waitForGrid();
    await user.click(await picker());
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["None", "Audit", "Invoices", "Taxes"]);
    await user.click(screen.getByRole("option", { name: "Audit" }));
    await waitFor(() => expect(viewUrls.at(-1)).toBe("/api/v1/views/roadmap?criticalPath=3"));
    // the target and the critical chain member are outlined and say so; Taxes (slack 4) is not
    await waitFor(() => expect(criticalBars()).toHaveLength(2));
    expect(criticalBars()).toEqual(["Invoices, 2026-03-09 to 2026-04-10, on the critical path, read-only", "Audit, 2026-05-04 to 2026-06-05, on the critical path, read-only"]);
    expect(screen.getByRole("img", { name: "Taxes, 2026-02-02 to 2026-02-27, read-only" })).not.toHaveAttribute("data-critical");
    // only the pair on the chain is a critical arrow
    expect(arrows()).toEqual([
      ["41", "true"],
      ["bundle:2-1", null],
    ]);
    // the panel: under the flag panel, the server's order, Taxes with its slack and no badge
    expect(headingOutline()).toEqual([
      [2, "Roadmap"],
      [3, "Timeline"],
      [3, "Flags"],
      [3, "Critical path to Audit"],
    ]);
    const table = screen.getByRole("table", { name: "Projects upstream of Audit" });
    expect(within(table).getAllByRole("row").slice(1).map((row) => within(row).getAllByRole("cell").map((cell) => cell.textContent))).toEqual([
      ["1", "Invoices", "Billing", "2026-03-09 – 2026-04-10", "0 working days", "On the chain"],
      ["2", "Taxes", "Billing", "2026-02-02 – 2026-02-27", "4 working days", ""],
    ]);
    // the choice is a question, not a setting: nothing is stored
    expect(Object.keys(localStorage).filter((key) => key.includes("ritical"))).toEqual([]);
  });

  test("switching the target A -> B: no stale A emphasis and no announcement while B loads, then B's chain is drawn, A's is gone and B is announced", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Roadmap />);
    await waitForGrid();
    await pickFromToolbar(user, "Audit");
    await waitFor(() => expect(criticalBars()).toHaveLength(2));
    const said = () => screen.getAllByRole("status").map((region) => region.textContent).join("|");
    await waitFor(() => expect(said()).toContain(ANNOUNCE));
    let release = () => {};
    holdOne = new Promise<void>((resolve) => {
      release = resolve;
    });
    await pickFromToolbar(user, "Invoices");
    await waitFor(() => expect(viewUrls.at(-1)).toBe("/api/v1/views/roadmap?criticalPath=1"));
    // B is still loading: the kept A view carries none of A's chain and nothing says B is shown yet
    await waitFor(() => expect(criticalBars()).toEqual([]));
    expect(document.querySelector("[data-critical]")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Critical path to Audit" })).toBeNull();
    expect(said()).not.toContain("Showing the critical path to Invoices");
    release();
    await screen.findByRole("heading", { level: 3, name: "Critical path to Invoices" });
    expect(criticalBars()).toEqual(["Invoices, 2026-03-09 to 2026-04-10, on the critical path, read-only", "Taxes, 2026-02-02 to 2026-02-27, on the critical path, read-only"]);
    expect(screen.getByRole("img", { name: "Audit, 2026-05-04 to 2026-06-05, read-only" })).not.toHaveAttribute("data-critical");
    expect(arrows()).toEqual([
      ["41", null],
      ["bundle:2-1", "true"],
    ]);
    await waitFor(() => expect(said()).toContain("Showing the critical path to Invoices"));
  });

  test("the row menu's Show critical path to this project sets it, says so in the live region, and the item then reads Hide critical path", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Roadmap />);
    await waitForGrid();
    await user.click(screen.getByRole("button", { name: "Operations for Audit" }));
    await user.click(screen.getByRole("menuitem", { name: "Show critical path to this project: Audit" }));
    await waitFor(() => expect(viewUrls.at(-1)).toBe("/api/v1/views/roadmap?criticalPath=3"));
    await screen.findByRole("heading", { level: 3, name: "Critical path to Audit" });
    expect(screen.getAllByRole("status").map((region) => region.textContent).join("|")).toContain(ANNOUNCE);
    expect(await picker()).toHaveValue("Audit");
    await user.click(screen.getByRole("button", { name: "Operations for Audit" }));
    await user.click(screen.getByRole("menuitem", { name: "Hide critical path: Audit" }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: /Critical path to/ })).toBeNull());
    expect(viewUrls.at(-1)).toBe("/api/v1/views/roadmap");
    expect(document.querySelector("[data-critical]")).toBeNull();
    expect(await picker()).toHaveValue("None");
  });

  test("a target with no span (picked from its menu): the picker keeps it as an option and the panel says nothing is scheduled", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Roadmap />);
    await waitForGrid();
    await user.click(screen.getByRole("button", { name: "Operations for Ledger" }));
    await user.click(screen.getByRole("menuitem", { name: "Show critical path to this project: Ledger" }));
    await screen.findByText("Nothing is scheduled in Ledger, so no chain drives its end.");
    expect(await picker()).toHaveValue("Ledger");
    // the live region says what the panel says, not "Showing the critical path to Ledger"
    await waitFor(() => expect(screen.getAllByRole("status").map((region) => region.textContent).join("|")).toContain("Nothing is scheduled in Ledger, so no chain drives its end."));
    expect(screen.getAllByRole("status").map((region) => region.textContent).join("|")).not.toContain("Showing the critical path");
    expect(screen.queryByRole("table", { name: /Projects upstream/ })).toBeNull();
    expect(document.querySelector("[data-critical]")).toBeNull();
  });

  test("a filter hides an upstream project's row, but the panel still lists it, marked (not shown)", async () => {
    localStorage.setItem("astrolabe.viewSettings.roadmap.filter.workStream", "1");
    const user = userEvent.setup();
    renderWithProviders(<Roadmap />);
    await waitForGrid();
    expect(screen.queryByRole("link", { name: "Open Taxes" })).toBeNull();
    await pickFromToolbar(user, "Audit");
    const table = await screen.findByRole("table", { name: "Projects upstream of Audit" });
    expect(within(table).getByRole("link", { name: "Open Taxes" }).closest("tr")).toHaveTextContent("Taxes (not shown)");
    expect(within(table).getByRole("link", { name: "Open Invoices" }).closest("tr")).not.toHaveTextContent("(not shown)");
  });

  test("a 400 for the target clears the selection, says so inline and fetches the plain view once", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Roadmap />);
    await waitForGrid();
    threeIsGone = true; // the project vanishes server-side after the picker listed it
    await pickFromToolbar(user, "Audit");
    expect(await screen.findByText("The project chosen for the critical path is no longer in the plan, so the choice was cleared.")).toBeInTheDocument();
    await waitForGrid();
    expect(await picker()).toHaveValue("None");
    expect(screen.getAllByRole("status").map((region) => region.textContent).join("|")).not.toContain("Showing the critical path");
    expect(screen.queryByText(/Could not load the roadmap/)).toBeNull();
    expect(viewUrls.filter((url) => url.endsWith("?criticalPath=3"))).toHaveLength(1);
    expect(viewUrls.at(-1)).toBe("/api/v1/views/roadmap");
    // the next pick clears the notice
    await pickFromToolbar(user, "Invoices");
    await waitFor(() => expect(screen.queryByText(/no longer in the plan/)).toBeNull());
  });
  test("the typed unknown-baseline 400 under a target drops the baseline pick and KEEPS the target: the next fetch carries criticalPath= and no baseline=", async () => {
    localStorage.setItem("astrolabe.viewSettings.timeline.baseline", "5");
    const base = mockFetch.getMockImplementation() as (url: string) => Promise<Response>;
    // the stored pick is sent first (the plain document answers it); with the target too, the baseline is gone
    mockFetch.mockImplementation((url: string) => {
      if (!url.startsWith("/api/v1/views/roadmap")) return base(url);
      viewUrls.push(url);
      if (url === "/api/v1/views/roadmap?baseline=5&criticalPath=3") return Promise.resolve(jsonResponse(400, { type: "urn:astrolabe:problem:unknown-baseline", title: "Bad Request", status: 400, detail: "unknown baseline" }));
      if (url.endsWith("criticalPath=3")) return Promise.resolve(jsonResponse(200, { ...view, criticalPath: CHAIN }));
      return Promise.resolve(jsonResponse(200, view));
    });
    const user = userEvent.setup();
    renderWithProviders(<Roadmap />);
    await waitForGrid();
    await pickFromToolbar(user, "Audit");
    await waitFor(() => expect(viewUrls.at(-1)).toBe("/api/v1/views/roadmap?criticalPath=3"));
    expect(viewUrls).toContain("/api/v1/views/roadmap?baseline=5&criticalPath=3");
    // the pick is gone (stored too), the target is kept: its chain is shown and nothing says the target was rejected
    await screen.findByRole("heading", { level: 3, name: "Critical path to Audit" });
    expect(JSON.parse(localStorage.getItem("astrolabe.viewSettings.timeline.baseline") ?? "null")).toBeNull();
    expect(await picker()).toHaveValue("Audit");
    expect(screen.queryByText(/no longer in the plan/)).toBeNull();
    expect(viewUrls.filter((url) => url.includes("baseline=5") && url.includes("criticalPath=3"))).toHaveLength(1);
  });
});
