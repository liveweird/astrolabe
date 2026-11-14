import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { screen, waitFor, within } from "@testing-library/react";
import Programs from "./Programs";
import type { ProgramsProgram, ProgramsView } from "../api/programs";
import type { RoadmapCriticalPath, RoadmapLink, RoadmapProject } from "../api/roadmap";
import { headingOutline } from "../test/headings";
import { jsonResponse } from "../test/http";
import { renderWithProviders } from "../test/render";
import { applyProgramsWindow } from "../utils/targetWindowUpdate";

// The 1.16 critical path toward a picked project on the Programs page: the toolbar picker and the row menu set a PAGE-LOCAL target, ?criticalPath=N
// fetches the roadmap's block, the emphasis lands on the row that STANDS for each chain project (a folded program, an open project's own row), the
// arrows of the chain's pairs (rolled-up ones included) are marked and the panel lists the chain with "(folded or not picked)".

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
  can: { editTargetWindow: true },
  ...over,
});

const INVOICES = project(1, "Invoices", { targetStart: "2026-02-02", targetEnd: "2026-03-31", span: { start: "2026-03-02", end: "2026-04-10" } });
const TAXES = project(2, "Taxes", { span: { start: "2026-05-04", end: "2026-06-05" } });
const DASHBOARDS = project(3, "Dashboards", { programId: 11, programName: "Reports", span: { start: "2026-08-03", end: "2026-09-04" } });
const DRAFTS = project(4, "Drafts", { programId: 11, programName: "Reports" });

const BILLING: ProgramsProgram = { id: 10, name: "Billing", ownerName: "Pat Program", span: { start: "2026-03-02", end: "2026-06-05" }, flags: { warnings: 0, infos: 0 }, projects: [INVOICES, TAXES] };
const REPORTS: ProgramsProgram = { id: 11, name: "Reports", ownerName: "Rita Reports", span: { start: "2026-08-03", end: "2026-09-04" }, flags: { warnings: 0, infos: 0 }, projects: [DASHBOARDS, DRAFTS] };

const okCheck = { status: "OK", shortfallDays: null, slackDays: 0, requiredDate: null, actualDate: null } as const;
/** Invoices -> Taxes is a direct link inside Billing; Taxes -> Dashboards is a bundle of two milestone links between the two programs. */
const LINKS: RoadmapLink[] = [
  { predecessorProjectId: 1, successorProjectId: 2, direct: { id: 31, type: "FS", lagDays: 0, check: okCheck }, milestoneLinks: { count: 0, violated: 0, unscheduled: 0 } },
  { predecessorProjectId: 2, successorProjectId: 3, direct: null, milestoneLinks: { count: 2, violated: 0, unscheduled: 0 } },
];

const plainView = (): ProgramsView => ({
  jiraSites: [],
  revision: 9,
  teams: [],
  links: LINKS,
  workStreams: [
    {
      id: 1,
      name: "Platform",
      ownerName: "Sam Stream",
      startDate: "2026-01-05",
      endDate: null,
      span: { start: "2026-03-02", end: "2026-09-04" },
      flags: { warnings: 0, infos: 0 },
      programs: [BILLING, REPORTS],
    },
  ],
});

/** Toward Dashboards: Taxes (1 hop) and Invoices (2 hops) are on the chain; the pairs are Taxes -> Dashboards and Invoices -> Taxes. */
const TOWARD_DASHBOARDS: RoadmapCriticalPath = {
  projectId: 3,
  projects: [
    { projectId: 2, slackDays: 0, critical: true, hops: 1 },
    { projectId: 1, slackDays: 0, critical: true, hops: 2 },
  ],
  pairs: [
    { predecessorProjectId: 2, successorProjectId: 3 },
    { predecessorProjectId: 1, successorProjectId: 2 },
  ],
};
const TOWARD_TAXES: RoadmapCriticalPath = { projectId: 2, projects: [{ projectId: 1, slackDays: 0, critical: true, hops: 1 }], pairs: [{ predecessorProjectId: 1, successorProjectId: 2 }] };

const GONE = { type: "about:blank", title: "Bad Request", status: 400, detail: "Unknown or deleted project id: 3" };
const ANNOUNCE = "Showing the critical path to Dashboards";

let view: ProgramsView;
let mockFetch: ReturnType<typeof vi.fn>;
let viewUrls: string[];
let puts: string[];
/** The project 3 vanished server-side: ?criticalPath=3 answers the plain 400. */
let threeIsGone: boolean;
/** When set, ?criticalPath=2 waits for it (the target switched while the new chain is on its way). */
let holdTwo: Promise<void> | null;
/** When set, the baseline-picked documents wait for it (the next baseline pick still loading). */
let holdBaseline: Promise<void> | null;
const BASELINES = {
  items: [6, 5].map((id) => ({ id, name: `Plan ${id}`, description: null, planRevision: 4, createdAt: id, createdBy: null, milestoneCount: 3, projectCount: 3 })),
  can: { manage: false },
};

beforeEach(() => {
  holdBaseline = null;
  view = plainView();
  viewUrls = [];
  puts = [];
  threeIsGone = false;
  holdTwo = null;
  mockFetch = vi.fn((url: string, init?: RequestInit) => {
    if (url.startsWith("/api/v1/views/programs")) {
      viewUrls.push(url);
      const params = new URLSearchParams(url.split("?")[1]);
      if (params.has("baseline"))
        return (holdBaseline ?? Promise.resolve()).then(() =>
          jsonResponse(200, {
            ...view,
            baseline: { id: Number(params.get("baseline")), name: `Plan ${params.get("baseline")}`, planRevision: 4, removedProjects: [] },
            ...(params.get("criticalPath") === "3" ? { criticalPath: TOWARD_DASHBOARDS } : {}),
          }),
        );
      if (url.endsWith("?criticalPath=3") && threeIsGone) return Promise.resolve(jsonResponse(400, GONE));
      if (url.endsWith("?criticalPath=3")) return Promise.resolve(jsonResponse(200, { ...view, criticalPath: TOWARD_DASHBOARDS }));
      if (url.endsWith("?criticalPath=2")) return (holdTwo ?? Promise.resolve()).then(() => jsonResponse(200, { ...view, criticalPath: TOWARD_TAXES }));
      return Promise.resolve(jsonResponse(200, view));
    }
    if (/^\/api\/v1\/projects\/\d+\/target-window$/.test(url) && init?.method === "PUT") {
      puts.push(url);
      view = applyProgramsWindow(view, Number(/projects\/(\d+)\//.exec(url)?.[1]), null, null);
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    if (url === "/api/v1/baselines") return Promise.resolve(jsonResponse(200, localStorage.getItem("test.withBaselines") ? BASELINES : { items: [], can: { manage: false } }));
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

const grid = () => screen.getByRole("grid", { name: "Programs timeline" });
const waitForGrid = () => screen.findByRole("grid", { name: "Programs timeline" });
const picker = () => screen.findByRole("combobox", { name: "Critical path to…" });
const liveText = () => screen.getAllByRole("status").map((region) => region.textContent).join("|");
/** The names of the outlined summary bars (a folded node's, an open project's span bar). */
const criticalBars = () => [...document.querySelectorAll('[data-tone="summary"][data-critical="true"]')].map((bar) => bar.getAttribute("aria-label"));
const arrows = () => [...document.querySelectorAll("[data-arrow]")].map((arrow) => [arrow.getAttribute("data-arrow"), arrow.getAttribute("data-critical")]);
const projectRows = () => within(grid()).queryAllByRole("link", { name: /^Open / }).map((link) => link.textContent);

async function pickFromToolbar(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(await picker());
  await user.click(await screen.findByRole("option", { name }));
}
const openProgram = async (user: ReturnType<typeof userEvent.setup>, name: string) => {
  await user.click(within(grid()).getByRole("button", { name: `Program ${name}` }));
};

describe("Programs page: the critical path to a picked project", () => {
  test("off by default: the plain view is fetched, the picker reads None, nothing is emphasised, there is no panel and the menu offers Show", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Programs />);
    await waitForGrid();
    expect(viewUrls).toEqual(["/api/v1/views/programs"]);
    expect(await picker()).toHaveValue("None");
    expect(document.querySelector("[data-critical]")).toBeNull();
    expect(screen.queryByRole("heading", { name: /Critical path to/ })).toBeNull();
    expect(headingOutline()).toEqual([
      [2, "Programs"],
      [3, "Timeline"],
    ]);
    await openProgram(user, "Billing");
    await user.click(await screen.findByRole("button", { name: "Operations for Taxes" }));
    expect(await screen.findByRole("menuitem", { name: "Show critical path to this project: Taxes" })).toBeInTheDocument();
  });

  test("the picker lists the projects with a span, and a pick sends ?criticalPath= and stores nothing", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Programs />);
    await waitForGrid();
    await user.click(await picker());
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["None", "Dashboards", "Invoices", "Taxes"]);
    await user.click(screen.getByRole("option", { name: "Dashboards" }));
    await waitFor(() => expect(viewUrls.at(-1)).toBe("/api/v1/views/programs?criticalPath=3"));
    await screen.findByRole("heading", { level: 3, name: "Critical path to Dashboards" });
    expect(Object.keys(localStorage).filter((key) => key.includes("ritical"))).toEqual([]);
  });

  test("at the default fold the program rows that stand for the chain carry the emphasis and the new name, no project row exists, and the chain's rolled-up arrow is critical", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Programs />);
    await waitForGrid();
    await pickFromToolbar(user, "Dashboards");
    await waitFor(() => expect(criticalBars()).toHaveLength(2));
    // Billing stands for Invoices and Taxes, Reports for Dashboards; the work stream is open, so its own bar is not emphasised.
    expect(criticalBars()).toEqual([
      "Billing, program span 2026-03-02 to 2026-06-05, holds a project on the critical path, read-only",
      "Reports, program span 2026-08-03 to 2026-09-04, holds a project on the critical path, read-only",
    ]);
    expect(within(grid()).getByRole("img", { name: "Platform, work stream span 2026-03-02 to 2026-09-04, read-only" })).not.toHaveAttribute("data-critical");
    expect(projectRows()).toEqual([]);
    // Invoices -> Taxes sits inside Billing (no arrow); Taxes -> Dashboards is the one rolled-up arrow, on the chain.
    expect(arrows()).toEqual([["rollup:pg:10-pg:11", "true"]]);
    // The panel names the whole chain; every project is in a folded row.
    const table = screen.getByRole("table", { name: "Projects upstream of Dashboards" });
    expect(within(table).getAllByRole("row").slice(1).map((row) => within(row).getAllByRole("cell").map((cell) => cell.textContent))).toEqual([
      ["1", "Taxes (folded or not picked)", "Billing", "2026-05-04 – 2026-06-05", "0 working days", "On the chain"],
      ["2", "Invoices (folded or not picked)", "Billing", "2026-03-02 – 2026-04-10", "0 working days", "On the chain"],
    ]);
    expect(screen.getByText(/Projects in a folded row or outside the program pick are listed too\./)).toBeInTheDocument();
    await waitFor(() => expect(liveText()).toContain(ANNOUNCE));
  });

  test("opening a program moves the emphasis to its project rows (the program row loses it), the other folded program keeps it, and the project arrows are critical", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Programs />);
    await waitForGrid();
    await pickFromToolbar(user, "Dashboards");
    await waitFor(() => expect(criticalBars()).toHaveLength(2));
    await openProgram(user, "Billing");
    await waitFor(() => expect(projectRows()).toEqual(["Invoices", "Taxes"]));
    expect(criticalBars()).toEqual([
      "Invoices, 2026-03-02 to 2026-04-10, on the critical path, read-only",
      "Taxes, 2026-05-04 to 2026-06-05, on the critical path, read-only",
      "Reports, program span 2026-08-03 to 2026-09-04, holds a project on the critical path, read-only",
    ]);
    expect(within(grid()).getByRole("img", { name: "Billing, program span 2026-03-02 to 2026-06-05, read-only" })).not.toHaveAttribute("data-critical");
    expect(arrows()).toEqual([
      ["31", "true"],
      ["rollup:2-pg:11", "true"],
    ]);
    // The panel now finds both rows on the timeline: only the target-side wording is gone.
    const table = screen.getByRole("table", { name: "Projects upstream of Dashboards" });
    expect(within(table).queryByText(/folded or not picked/)).toBeNull();
    // Both open: five critical elements in all (three span bars, two bundle-or-direct arrows); no program row is emphasised.
    await openProgram(user, "Reports");
    await waitFor(() => expect(arrows()).toEqual([["31", "true"], ["bundle:2-3", "true"]]));
    expect(criticalBars()).toEqual([
      "Invoices, 2026-03-02 to 2026-04-10, on the critical path, read-only",
      "Taxes, 2026-05-04 to 2026-06-05, on the critical path, read-only",
      "Dashboards, 2026-08-03 to 2026-09-04, on the critical path, read-only",
    ]);
    expect(document.querySelectorAll("[data-critical]")).toHaveLength(5);
  });

  test("a program the program pick hides is no anchor: the chain project in it is listed in the panel as not shown and no row stands for it", async () => {
    localStorage.setItem("astrolabe.viewSettings.planning.programPick", JSON.stringify([10]));
    const user = userEvent.setup();
    renderWithProviders(<Programs />);
    await waitForGrid();
    await pickFromToolbar(user, "Dashboards");
    await screen.findByRole("heading", { level: 3, name: "Critical path to Dashboards" });
    // only Billing is shown (folded) and it stands for Taxes and Invoices; Dashboards (the target) has no row
    expect(criticalBars()).toEqual(["Billing, program span 2026-03-02 to 2026-06-05, holds a project on the critical path, read-only"]);
    expect(arrows()).toEqual([]);
    expect(screen.getByText("Target: Dashboards, 2026-08-03 to 2026-09-04.")).toBeInTheDocument();
  });

  test("the row menu's Show critical path sets the target, says so in the live region, and the item then reads Hide, which clears it at once", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Programs />);
    await waitForGrid();
    await openProgram(user, "Billing");
    await user.click(await screen.findByRole("button", { name: "Operations for Taxes" }));
    await user.click(await screen.findByRole("menuitem", { name: "Show critical path to this project: Taxes" }));
    await waitFor(() => expect(viewUrls.at(-1)).toBe("/api/v1/views/programs?criticalPath=2"));
    await screen.findByRole("heading", { level: 3, name: "Critical path to Taxes" });
    await waitFor(() => expect(liveText()).toContain("Showing the critical path to Taxes"));
    expect(await picker()).toHaveValue("Taxes");
    await user.click(screen.getByRole("button", { name: "Operations for Taxes" }));
    await user.click(await screen.findByRole("menuitem", { name: "Hide critical path: Taxes" }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: /Critical path to/ })).toBeNull());
    expect(viewUrls.at(-1)).toBe("/api/v1/views/programs");
    expect(document.querySelector("[data-critical]")).toBeNull();
    expect(liveText()).toContain("Critical path hidden");
    expect(await picker()).toHaveValue("None");
  });

  test("switching the target: no stale emphasis, panel or announcement while the new chain loads, then the new chain is drawn and announced", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Programs />);
    await waitForGrid();
    await pickFromToolbar(user, "Dashboards");
    await waitFor(() => expect(criticalBars()).toHaveLength(2));
    await waitFor(() => expect(liveText()).toContain(ANNOUNCE));
    let release = () => {};
    holdTwo = new Promise<void>((resolve) => {
      release = resolve;
    });
    await pickFromToolbar(user, "Taxes");
    await waitFor(() => expect(viewUrls.at(-1)).toBe("/api/v1/views/programs?criticalPath=2"));
    await waitFor(() => expect(criticalBars()).toEqual([]));
    expect(document.querySelector("[data-critical]")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Critical path to Dashboards" })).toBeNull();
    expect(liveText()).not.toContain("Showing the critical path to Taxes");
    release();
    await screen.findByRole("heading", { level: 3, name: "Critical path to Taxes" });
    // Taxes and Invoices are both in Billing, folded: only Billing is outlined; Taxes -> Dashboards is no pair of this chain
    expect(criticalBars()).toEqual(["Billing, program span 2026-03-02 to 2026-06-05, holds a project on the critical path, read-only"]);
    expect(arrows()).toEqual([["rollup:pg:10-pg:11", null]]);
    await waitFor(() => expect(liveText()).toContain("Showing the critical path to Taxes"));
  });

  test("another baseline picked under a target does not say the sentence again; None and the same project again does", async () => {
    localStorage.setItem("test.withBaselines", "1");
    const user = userEvent.setup();
    renderWithProviders(<Programs />);
    await waitForGrid();
    await pickFromToolbar(user, "Dashboards");
    await waitFor(() => expect(liveText()).toContain(ANNOUNCE));
    // a baseline picked under the target: the kept copy shows no chain while the new document loads, which brings the same chain back
    let release = () => {};
    holdBaseline = new Promise<void>((resolve) => {
      release = resolve;
    });
    await user.click(await screen.findByRole("combobox", { name: "Baseline" }));
    await user.click(await screen.findByRole("option", { name: "Plan 5" }));
    await waitFor(() => expect(viewUrls.at(-1)).toBe("/api/v1/views/programs?baseline=5&criticalPath=3"));
    await waitFor(() => expect(criticalBars()).toEqual([]));
    const before = liveText();
    release();
    await screen.findByText("vs baseline Plan 5:"); // only the new document brings the totals note
    await waitFor(() => expect(criticalBars()).toHaveLength(2));
    expect(liveText()).toBe(before); // equal, byte for byte: a sentence said again would have flipped the re-read suffix
    // a second baseline pick, the same way
    holdBaseline = null;
    await user.click(await screen.findByRole("combobox", { name: "Baseline" }));
    await user.click(await screen.findByRole("option", { name: "Plan 6 (latest)" }));
    await screen.findByText("vs baseline Plan 6:");
    await waitFor(() => expect(criticalBars()).toHaveLength(2));
    expect(liveText()).toBe(before);
    // None, then the same project: a new pick, said again
    await pickFromToolbar(user, "None");
    await waitFor(() => expect(liveText()).toContain("Critical path hidden"));
    await pickFromToolbar(user, "Dashboards");
    await waitFor(() => expect(liveText()).toContain(ANNOUNCE));
  });

  test("a 400 for the target clears the selection, says so inline with no error flash, and fetches the plain view", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Programs />);
    await waitForGrid();
    threeIsGone = true; // the project vanishes server-side after the picker listed it
    await pickFromToolbar(user, "Dashboards");
    expect(await screen.findByText("The project chosen for the critical path is no longer in the plan, so the choice was cleared.")).toBeInTheDocument();
    await waitForGrid();
    expect(await picker()).toHaveValue("None");
    expect(liveText()).not.toContain("Showing the critical path");
    expect(screen.queryByText(/Could not load the programs/)).toBeNull();
    expect(viewUrls.filter((url) => url.endsWith("?criticalPath=3"))).toHaveLength(1);
    expect(viewUrls.at(-1)).toBe("/api/v1/views/programs");
    // the next pick clears the notice
    await pickFromToolbar(user, "Taxes");
    await waitFor(() => expect(screen.queryByText(/no longer in the plan/)).toBeNull());
  });

  test("a window write under a target hits the keyed entry and keeps the chain on screen, also after the refetch", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Programs />);
    await waitForGrid();
    await pickFromToolbar(user, "Dashboards");
    await waitFor(() => expect(criticalBars()).toHaveLength(2));
    await openProgram(user, "Billing");
    await user.click(await screen.findByRole("button", { name: "Operations for Invoices" }));
    await user.click(await screen.findByRole("menuitem", { name: "Clear target window of Invoices" }));
    // the optimistic step lands on the entry on screen: the window band is gone and the block (outline, panel) is still there
    expect(within(grid()).queryByLabelText(/Invoices, target window/)).toBeNull();
    expect(criticalBars()).toContain("Invoices, 2026-03-02 to 2026-04-10, on the critical path, read-only");
    expect(screen.getByRole("heading", { level: 3, name: "Critical path to Dashboards" })).toBeInTheDocument();
    await waitFor(() => expect(puts).toEqual(["/api/v1/projects/1/target-window"]));
    await waitFor(() => expect(grid()).toHaveAttribute("aria-busy", "false"));
    // the refetch brought the server's block again (the keyed entry's own), not a plain document
    await waitFor(() => expect(viewUrls.filter((url) => url.endsWith("?criticalPath=3")).length).toBeGreaterThan(1));
    expect(criticalBars()).toContain("Invoices, 2026-03-02 to 2026-04-10, on the critical path, read-only");
    expect(within(grid()).queryByLabelText(/Invoices, target window/)).toBeNull();
  });
});
