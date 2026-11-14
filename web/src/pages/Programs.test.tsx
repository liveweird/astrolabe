import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { screen, waitFor, within } from "@testing-library/react";
import Programs from "./Programs";
import type { ProgramsProgram, ProgramsView, ProgramsWorkStream } from "../api/programs";
import type { PlanFlag, RoadmapLink, RoadmapProject } from "../api/roadmap";
import { headingOutline } from "../test/headings";
import { jsonResponse } from "../test/http";
import { renderWithProviders } from "../test/render";

const PICK_KEY = "astrolabe.viewSettings.planning.programPick";
const ZOOM_KEY = "astrolabe.viewSettings.timeline.planZoom";

const flag = (kind: PlanFlag["kind"], severity: PlanFlag["severity"], days: number): PlanFlag => ({ kind, severity, days });

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

const INVOICES = project(1, "Invoices", {
  targetStart: "2026-02-01",
  targetEnd: "2026-03-31",
  span: { start: "2026-03-02", end: "2026-04-10" },
  drift: { startDays: 29, endDays: 10 },
  flags: [flag("DRIFT_END_LATE", "WARNING", 10), flag("DRIFT_START_LATE", "INFO", 29)],
});
const TAXES = project(2, "Taxes", { span: { start: "2026-05-04", end: "2026-06-05" } });
const DASHBOARDS = project(3, "Dashboards", { programId: 11, programName: "Reports", span: { start: "2026-08-03", end: "2026-09-04" }, flags: [flag("DRIFT_END_EARLY", "INFO", 3)] });
const UNSCHEDULED = project(4, "Drafts", { programId: 11, programName: "Reports" });

const BILLING: ProgramsProgram = { id: 10, name: "Billing", ownerName: "Pat Program", span: { start: "2026-03-02", end: "2026-06-05" }, flags: { warnings: 1, infos: 1 }, projects: [INVOICES, TAXES] };
const REPORTS: ProgramsProgram = { id: 11, name: "Reports", ownerName: "Rita Reports", span: { start: "2026-08-03", end: "2026-09-04" }, flags: { warnings: 0, infos: 1 }, projects: [DASHBOARDS, UNSCHEDULED] };
const LEGACY: ProgramsProgram = { id: 12, name: "Legacy", ownerName: "Leo Legacy", span: null, flags: { warnings: 0, infos: 0 }, projects: [] };

const PLATFORM: ProgramsWorkStream = {
  id: 1,
  name: "Platform",
  ownerName: "Sam Stream",
  startDate: "2026-01-05",
  endDate: null,
  span: { start: "2026-03-02", end: "2026-09-04" },
  flags: { warnings: 1, infos: 2 },
  programs: [BILLING, REPORTS],
};
const ARCHIVE: ProgramsWorkStream = { id: 2, name: "Archive", ownerName: "Ava Archive", startDate: "2025-01-06", endDate: "2025-12-19", span: null, flags: { warnings: 0, infos: 0 }, programs: [LEGACY] };

const okCheck = { status: "OK", shortfallDays: null, slackDays: 0, requiredDate: null, actualDate: null } as const;
const LINKS: RoadmapLink[] = [
  { predecessorProjectId: 1, successorProjectId: 2, direct: { id: 31, type: "FS", lagDays: 0, check: { ...okCheck, status: "VIOLATED", shortfallDays: 3, slackDays: -3 } }, milestoneLinks: { count: 0, violated: 0, unscheduled: 0 } },
  { predecessorProjectId: 2, successorProjectId: 3, direct: null, milestoneLinks: { count: 2, violated: 1, unscheduled: 0 } },
];

const viewOf = (over: Partial<ProgramsView> = {}): ProgramsView => ({ jiraSites: [], revision: 9, teams: [], links: LINKS, workStreams: [PLATFORM, ARCHIVE], ...over });

let mockFetch: ReturnType<typeof vi.fn>;
let view: ProgramsView;

beforeEach(() => {
  view = viewOf();
  mockFetch = vi.fn((url: string) => {
    if (url === "/api/v1/public-holidays") return Promise.resolve(jsonResponse(200, { items: [{ id: 1, date: "2026-03-18", name: "Founders' Day" }] }));
    return Promise.resolve(url === "/api/v1/views/programs" ? jsonResponse(200, view) : jsonResponse(404, { title: "x", status: 404 }));
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
/** The rows of the grid below the header, as the name of each: a node's button, a project's link. */
const rowLabels = () =>
  within(grid())
    .getAllByRole("row")
    .slice(1)
    .map((row) => row.querySelector("[role='rowheader'] button[aria-expanded]")?.getAttribute("aria-label") ?? row.querySelector("a[href^='/projects/']")?.textContent ?? row.querySelector("[role='rowheader']")?.textContent?.trim());
const rowOfLeaf = (name: string) => within(grid()).getAllByRole("row").find((row) => row.querySelector("[role='rowheader']")?.textContent?.startsWith(name)) as HTMLElement;
const rowOfNode = (label: string) => within(grid()).getByRole("button", { name: label }).closest('[role="row"]') as HTMLElement;
/** A node with nothing under it has no button, so its row reads as its cell text: the name, then the owner. */
const LEGACY_ROW = "Legacy Leo Legacy";
const liveText = () => screen.getAllByRole("status").map((region) => region.textContent).join(" | ");

describe("Programs page", () => {
  test("at Month zoom the dictionary's holidays are listed for assistive technology", async () => {
    localStorage.setItem(ZOOM_KEY, JSON.stringify("month"));
    renderWithProviders(<Programs />);
    await waitForGrid();
    expect(await screen.findByText(/Public holidays shown: 2026-03-18 Founders' Day/)).toBeInTheDocument();
  });

  test("renders the work streams open and the programs folded, with the facts, the roll-up counts and the summary bars; the heading outline is pinned", async () => {
    renderWithProviders(<Programs />);
    await waitForGrid();
    expect(headingOutline()).toEqual([
      [2, "Programs"],
      [3, "Timeline"],
    ]);
    expect(rowLabels()).toEqual(["Work stream Platform", "Program Billing", "Program Reports", "Work stream Archive", LEGACY_ROW]);
    const facts = screen.getByRole("group", { name: "Programs facts" });
    expect(within(facts).getByText("2 work streams")).toBeInTheDocument();
    expect(within(facts).getByText("3 programs")).toBeInTheDocument();
    expect(within(facts).getByText("4 projects")).toBeInTheDocument();
    expect(within(facts).getByText("1 warning")).toBeInTheDocument();
    expect(within(facts).getByText("2 infos")).toBeInTheDocument();
    // A work stream's and a program's counts are the server's roll-ups; the words are for assistive technology.
    const platform = rowOfNode("Work stream Platform");
    expect(platform.querySelector("[data-flags]")).toHaveAttribute("data-flags", "1,2");
    expect(within(platform).getByText("1 warning, 2 infos")).toBeInTheDocument();
    expect(rowOfNode("Program Reports").querySelector("[data-flags]")).toHaveAttribute("data-flags", "0,1");
    expect(rowOfLeaf("Legacy").querySelector("[data-flags]")).toBeNull();
    // The summary bars of the streams and programs: read-only, their span as the server derived it; a node with nothing scheduled has none.
    expect(within(platform).getByRole("img", { name: "Platform, work stream span 2026-03-02 to 2026-09-04, read-only" })).toHaveAttribute("data-tone", "summary");
    expect(within(rowOfNode("Program Billing")).getByRole("img", { name: "Billing, program span 2026-03-02 to 2026-06-05, 1 conflict, read-only" })).toBeInTheDocument();
    expect(within(rowOfNode("Work stream Archive")).queryByRole("img")).toBeNull();
    // Owners are dimmed after the names; a closed stream says so.
    expect(platform).toHaveTextContent("Sam Stream");
    expect(rowOfNode("Work stream Archive")).toHaveTextContent("(closed)");
  });

  test("a node's chevron is a button with aria-expanded: it opens a program's projects, says so, and folds them again from the keyboard", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Programs />);
    await waitForGrid();
    const billing = within(grid()).getByRole("button", { name: "Program Billing" });
    expect(billing).toHaveAttribute("aria-expanded", "false");
    await user.click(billing);
    expect(billing).toHaveAttribute("aria-expanded", "true");
    expect(rowLabels()).toEqual(["Work stream Platform", "Program Billing", "Invoices", "Taxes", "Program Reports", "Work stream Archive", LEGACY_ROW]);
    expect(liveText()).toContain("Billing expanded, 2 projects");
    // The keyboard path: the button is a tab stop of the grid and Enter flips it; it keeps the focus through the change.
    billing.focus();
    await user.keyboard("{Enter}");
    expect(billing).toHaveAttribute("aria-expanded", "false");
    expect(billing).toHaveFocus();
    expect(rowLabels()).toEqual(["Work stream Platform", "Program Billing", "Program Reports", "Work stream Archive", LEGACY_ROW]);
    expect(liveText()).toContain("Billing collapsed");
    await user.keyboard(" ");
    expect(billing).toHaveAttribute("aria-expanded", "true");
  });

  test("folding a work stream hides its programs and projects; a node with nothing under it has no button", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Programs />);
    await waitForGrid();
    await user.click(within(grid()).getByRole("button", { name: "Program Billing" }));
    await user.click(within(grid()).getByRole("button", { name: "Work stream Platform" }));
    expect(rowLabels()).toEqual(["Work stream Platform", "Work stream Archive", LEGACY_ROW]);
    expect(liveText()).toContain("Platform collapsed");
    // Legacy has no projects: its row shows the name and no button; opening Platform again keeps Billing open as it was.
    expect(within(rowOfNode("Work stream Archive")).getByRole("button", { name: "Work stream Archive" })).toBeInTheDocument();
    await user.click(within(grid()).getByRole("button", { name: "Work stream Platform" }));
    expect(liveText()).toContain("Platform expanded, 2 programs");
    expect(rowLabels()).toEqual(["Work stream Platform", "Program Billing", "Invoices", "Taxes", "Program Reports", "Work stream Archive", LEGACY_ROW]);
    expect(within(rowOfLeaf("Legacy")).queryByRole("button")).toBeNull();
  });

  test("Expand all opens every node, Collapse all folds even the work streams, and both are announced", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Programs />);
    await waitForGrid();
    await user.click(screen.getByRole("button", { name: "Expand all" }));
    expect(rowLabels()).toEqual([
      "Work stream Platform",
      "Program Billing",
      "Invoices",
      "Taxes",
      "Program Reports",
      "Dashboards",
      "Drafts",
      "Work stream Archive",
      LEGACY_ROW,
    ]);
    expect(liveText()).toContain("Every work stream and program expanded");
    await user.click(screen.getByRole("button", { name: "Collapse all" }));
    expect(rowLabels()).toEqual(["Work stream Platform", "Work stream Archive"]);
    expect(liveText()).toContain("Every work stream and program collapsed");
  });

  test("a project row is the roadmap's: the window band, the span bar, the drift band, the flag icons, a menu with only Open project, nothing editable without the right", async () => {
    // A viewer who may change no window (the view's per-project `can`): the band is an image, there is no draw surface and the menu only opens the project.
    view = viewOf({
      workStreams: [PLATFORM, ARCHIVE].map((stream) => ({
        ...stream,
        programs: stream.programs.map((program) => ({ ...program, projects: program.projects.map((p) => ({ ...p, can: { editTargetWindow: false } })) })),
      })),
    });
    const user = userEvent.setup();
    renderWithProviders(<Programs />);
    await waitForGrid();
    await user.click(screen.getByRole("button", { name: "Expand all" }));
    const invoices = within(grid()).getByRole("link", { name: "Open Invoices" }).closest('[role="row"]') as HTMLElement;
    expect(within(invoices).getByRole("img", { name: "Invoices, 2026-03-02 to 2026-04-10, 1 conflict, read-only" })).toHaveAttribute("data-tone", "summary");
    expect(within(invoices).getByRole("img", { name: "Invoices, target window 2026-02-01 to 2026-03-31, read-only" })).toHaveAttribute("data-tone", "window");
    expect(invoices.querySelector('[title="10 days past the target end"]')).not.toBeNull();
    expect(invoices.querySelector("[data-flags]")).toHaveAttribute("data-flags", "1,1");
    expect(invoices).toHaveTextContent("Ola Owner");
    expect(within(grid()).getByRole("link", { name: "Open Invoices" })).toHaveAttribute("href", "/projects/1");
    // No handle, no button-like bar, no draw surface, one menu item.
    expect(document.querySelectorAll("[data-row-handle]")).toHaveLength(0);
    expect(document.querySelectorAll("[data-draw-surface]")).toHaveLength(0);
    expect(within(grid()).queryByRole("button", { name: /^Invoices, / })).toBeNull();
    expect(within(within(grid()).getByRole("link", { name: "Open Drafts" }).closest('[role="row"]') as HTMLElement).queryByRole("img")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Operations for Invoices" }));
    expect(await screen.findByRole("menuitem", { name: "Open project Invoices" })).toBeInTheDocument();
    expect(screen.getAllByRole("menuitem")).toHaveLength(1);
  });

  test("Month / Quarter / Year with Quarter by default, remembered under the plan pages' own zoom key", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Programs />);
    await waitForGrid();
    const zoom = screen.getByRole("radiogroup", { name: "Zoom" });
    expect(within(zoom).getAllByRole("radio").map((radio) => radio.getAttribute("value"))).toEqual(["month", "quarter", "year"]);
    expect(within(zoom).getByRole("radio", { name: "Quarter" })).toBeChecked();
    await user.click(screen.getByText("Year"));
    expect(JSON.parse(localStorage.getItem(ZOOM_KEY) ?? "null")).toBe("year");
    expect(localStorage.getItem("astrolabe.viewSettings.timeline.zoom")).toBeNull();
    // At Year zoom the header's groups are years.
    expect(within(grid()).getAllByText("2026").length).toBeGreaterThan(0);
  });
});

describe("Programs page: arrows", () => {
  const arrowIds = () => [...document.querySelectorAll("[data-arrow]")].map((arrow) => arrow.getAttribute("data-arrow"));

  test("a folded program still shows its dependencies: one arrow between the rows that stand for the projects, at every fold state", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Programs />);
    await waitForGrid();
    // Streams open, programs folded: Invoices -> Taxes sits inside Billing (nothing); Taxes -> Dashboards is ONE arrow between the two program rows.
    expect(arrowIds()).toEqual(["rollup:pg:10-pg:11"]);
    const rollup = () => document.querySelector('[data-arrow="rollup:pg:10-pg:11"]');
    expect(rollup()).toHaveAttribute("data-violated", "true");
    expect(rollup()?.querySelector("title")).toHaveTextContent("Billing → Reports, 2 links (1 violated)");
    // The violated link ends both program bars' names; a program with no violated link ending on it keeps the plain name.
    expect(within(rowOfNode("Program Billing")).getByRole("img", { name: "Billing, program span 2026-03-02 to 2026-06-05, 1 conflict, read-only" })).toBeInTheDocument();
    expect(within(rowOfNode("Program Reports")).getByRole("img", { name: "Reports, program span 2026-08-03 to 2026-09-04, 1 conflict, read-only" })).toBeInTheDocument();

    // Billing open, Reports folded: the direct link between its two project rows, and Taxes' row to Reports' row.
    await user.click(within(grid()).getByRole("button", { name: "Program Billing" }));
    await waitFor(() => expect(arrowIds()).toEqual(["31", "rollup:2-pg:11"]));
    expect(document.querySelector('[data-arrow="31"]')).toHaveAttribute("data-violated", "true");
    expect(document.querySelector('[data-arrow="rollup:2-pg:11"] title')).toHaveTextContent("Taxes → Reports, 2 links (1 violated)");
    expect(within(rowOfNode("Program Reports")).getByRole("img", { name: "Reports, program span 2026-08-03 to 2026-09-04, 1 conflict, read-only" })).toBeInTheDocument();
    expect(within(rowOfNode("Program Billing")).getByRole("img", { name: "Billing, program span 2026-03-02 to 2026-06-05, read-only" })).toBeInTheDocument();

    // Both open: the arrows between the projects themselves, today's, and no roll-up.
    await user.click(within(grid()).getByRole("button", { name: "Program Reports" }));
    await waitFor(() => expect(arrowIds()).toEqual(["31", "bundle:2-3"]));
    expect(document.querySelector('[data-arrow="bundle:2-3"]')).toHaveAttribute("data-violated", "true");
    expect(document.querySelector('[data-arrow="bundle:2-3"] title')).toHaveTextContent("Taxes → Dashboards, 2 milestone links (1 violated)");

    // Billing folded, Reports open: Billing's row to Dashboards' row.
    await user.click(within(grid()).getByRole("button", { name: "Program Billing" }));
    await waitFor(() => expect(arrowIds()).toEqual(["rollup:pg:10-3"]));
    expect(document.querySelector('[data-arrow="rollup:pg:10-3"] title')).toHaveTextContent("Billing → Dashboards, 2 links (1 violated)");

    // Collapse all: every project stands on the one work stream's bar, so every link is inside it.
    await user.click(screen.getByRole("button", { name: "Collapse all" }));
    await waitFor(() => expect(arrowIds()).toEqual([]));
  });

  test("a rolled-up arrow holding no violated link is not red and puts no conflict on the bars", async () => {
    view = viewOf({ links: [{ ...LINKS[1], milestoneLinks: { count: 2, violated: 0, unscheduled: 0 } }] });
    renderWithProviders(<Programs />);
    await waitForGrid();
    await waitFor(() => expect(arrowIds()).toEqual(["rollup:pg:10-pg:11"]));
    expect(document.querySelector('[data-arrow="rollup:pg:10-pg:11"]')).toHaveAttribute("data-violated", "false");
    expect(within(rowOfNode("Program Billing")).getByRole("img", { name: "Billing, program span 2026-03-02 to 2026-06-05, read-only" })).toBeInTheDocument();
  });

  test("a violated link ends its project's span bar name with the conflict count", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Programs />);
    await waitForGrid();
    await user.click(screen.getByRole("button", { name: "Expand all" }));
    expect(within(grid()).getByRole("img", { name: "Invoices, 2026-03-02 to 2026-04-10, 1 conflict, read-only" })).toBeInTheDocument();
  });
});

describe("Programs page: the program pick", () => {
  async function openFilters(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole("button", { name: /^Filters/ }));
  }

  test("picking a program narrows the tree and is stored under the ONE shared key; a picked program keeps its work stream", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Programs />);
    await waitForGrid();
    await openFilters(user);
    await user.click(screen.getByRole("combobox", { name: "Programs" }));
    await user.click(await screen.findByRole("option", { name: "Reports" }));
    expect(JSON.parse(localStorage.getItem(PICK_KEY) ?? "null")).toEqual([11]);
    expect(rowLabels()).toEqual(["Work stream Platform", "Program Reports"]);
    // The work stream shown in part rolls up over the program that remains.
    const platform = rowOfNode("Work stream Platform");
    expect(within(platform).getByRole("img", { name: "Platform, work stream span 2026-08-03 to 2026-09-04, read-only" })).toBeInTheDocument();
    expect(platform.querySelector("[data-flags]")).toHaveAttribute("data-flags", "0,1");
    const facts = screen.getByRole("group", { name: "Programs facts" });
    expect(within(facts).getByText("1 work stream")).toBeInTheDocument();
    expect(within(facts).getByText("1 program")).toBeInTheDocument();
    expect(within(facts).getByText("2 projects")).toBeInTheDocument();
  });

  test("a pick made on the roadmap (the shared key) is in force here; an id the plan no longer has filters nothing", async () => {
    localStorage.setItem(PICK_KEY, JSON.stringify([12, 99]));
    const { unmount } = renderWithProviders(<Programs />);
    await waitForGrid();
    expect(rowLabels()).toEqual(["Work stream Archive", LEGACY_ROW]);
    unmount();
    localStorage.setItem(PICK_KEY, JSON.stringify([99]));
    renderWithProviders(<Programs />);
    await waitForGrid();
    expect(rowLabels()).toEqual(["Work stream Platform", "Program Billing", "Program Reports", "Work stream Archive", LEGACY_ROW]);
  });
});

describe("Programs page: states", () => {
  test("a plan with no work streams says so", async () => {
    view = viewOf({ workStreams: [], links: [] });
    renderWithProviders(<Programs />);
    expect(await screen.findByText("No work streams yet")).toBeInTheDocument();
    expect(screen.queryByRole("grid")).toBeNull();
    expect(headingOutline()).toEqual([[2, "Programs"]]);
  });

  test("a failed load shows the error alert", async () => {
    mockFetch.mockImplementation(() => Promise.resolve(jsonResponse(500, { title: "x", status: 500 })));
    renderWithProviders(<Programs />);
    expect(await screen.findByText("Could not load the programs")).toBeInTheDocument();
  });
});
