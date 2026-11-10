import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { screen, waitFor, within } from "@testing-library/react";
import Programs from "./Programs";
import type { Movement } from "../api/baselines";
import type { ProgramsProgram, ProgramsView, ProgramsWorkStream } from "../api/programs";
import type { RemovedProject, RoadmapProject } from "../api/roadmap";
import { jsonResponse } from "../test/http";
import { renderWithProviders } from "../test/render";

// The v0.9 baseline overlay on the Programs page: the picker, shadow bars on project, program and work stream rows, the totals line, the typed
// 400 that clears the pick; and (1.10) the dimmed rows for the baseline's deleted projects under their expanded program, counted by the totals line.

const PICK_KEY = "astrolabe.viewSettings.timeline.baseline";
const PROGRAM_PICK_KEY = "astrolabe.viewSettings.planning.programPick";
const UNKNOWN = { type: "urn:astrolabe:problem:unknown-baseline", title: "Bad Request", status: 400, detail: "unknown baseline" };

const move = (kind: Movement["kind"], startDays: number | null, endDays: number | null): Movement => ({ kind, startDays, endDays, estimateDelta: null });
const frozen = (span: { start: string; end: string }, movement: Movement) => ({ span, movement });

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

const baselineOf = (span: { start: string; end: string }, movement: Movement) => ({ span, movement, rankPosition: null, targetStart: null, targetEnd: null });
const INVOICES = project(1, "Invoices", { span: { start: "2026-03-02", end: "2026-04-10" }, baseline: baselineOf({ start: "2026-03-02", end: "2026-04-03" }, move("MOVED", 0, 5)) });
const TAXES = project(2, "Taxes", { span: { start: "2026-05-04", end: "2026-06-05" }, baseline: baselineOf({ start: "2026-05-04", end: "2026-06-05" }, move("UNCHANGED", 0, 0)) });
const FRESH = project(3, "Fresh", { programId: 11, programName: "Reports", span: { start: "2026-08-03", end: "2026-09-04" } });

// Reports (the second program) has no project the baseline froze: its row has no `baseline`.
const BILLING: ProgramsProgram = { id: 10, name: "Billing", ownerName: "Pat Program", span: { start: "2026-03-02", end: "2026-06-05" }, flags: { warnings: 0, infos: 0 }, projects: [INVOICES, TAXES], baseline: frozen({ start: "2026-03-02", end: "2026-06-05" }, move("UNCHANGED", 0, 0)) };
const REPORTS: ProgramsProgram = { id: 11, name: "Reports", ownerName: "Rita Reports", span: { start: "2026-08-03", end: "2026-09-04" }, flags: { warnings: 0, infos: 0 }, projects: [FRESH] };
const PLATFORM: ProgramsWorkStream = {
  id: 1,
  name: "Platform",
  ownerName: "Sam Stream",
  startDate: "2026-01-05",
  endDate: null,
  span: { start: "2026-03-02", end: "2026-09-04" },
  flags: { warnings: 0, infos: 0 },
  programs: [BILLING, REPORTS],
  baseline: frozen({ start: "2026-03-02", end: "2026-06-05" }, move("MOVED", 0, 63)),
};

const viewOf = (): ProgramsView => ({ jiraSites: [], revision: 9, teams: [], links: [], workStreams: [PLATFORM], baseline: { id: 5, name: "Q1 plan", planRevision: 4, removedProjects: [] } });
const gone = (projectId: number, name: string, over: Partial<RemovedProject> = {}): RemovedProject => ({
  projectId,
  name,
  programId: 10,
  programName: "Billing",
  workStreamId: 1,
  workStreamName: "Platform",
  span: { start: "2026-02-02", end: "2026-02-27" },
  ...over,
});
/** Baseline 7: Billing lost "Retired" (and a project with no span), Reports lost "Reaped", a program that is gone lost "Orphan". */
const withRemoved = (): ProgramsView => ({
  ...viewOf(),
  baseline: {
    id: 7,
    name: "Q2 plan",
    planRevision: 5,
    removedProjects: [gone(11, "Retired"), gone(12, "Spanless", { span: null }), gone(13, "Reaped", { programId: 11, programName: "Reports" }), gone(14, "Orphan", { programId: 99, programName: "Gone" })],
  },
});
/** The plain document: no `baseline` anywhere. */
const plainOf = (): ProgramsView => {
  const strip = <T extends { baseline?: unknown }>(item: T): T => ({ ...item, baseline: undefined });
  return {
    ...viewOf(),
    baseline: undefined,
    workStreams: [{ ...strip(PLATFORM), programs: [{ ...strip(BILLING), projects: [strip(INVOICES), strip(TAXES)] }, { ...strip(REPORTS), projects: [strip(FRESH)] }] }],
  };
};

const BASELINES = {
  items: [
    { id: 5, name: "Q1 plan", description: null, planRevision: 4, createdAt: 2, createdBy: null, milestoneCount: 3, projectCount: 2 },
    { id: 6, name: "Q0 plan", description: null, planRevision: 3, createdAt: 1, createdBy: null, milestoneCount: 3, projectCount: 2 },
  ],
  can: { manage: false },
};

let mockFetch: ReturnType<typeof vi.fn>;
let viewUrls: string[];

beforeEach(() => {
  viewUrls = [];
  mockFetch = vi.fn((url: string) => {
    if (url.startsWith("/api/v1/views/programs")) {
      viewUrls.push(url);
      if (url.endsWith("?baseline=5")) return Promise.resolve(jsonResponse(200, viewOf()));
      if (url.endsWith("?baseline=6")) return Promise.resolve(jsonResponse(200, { ...viewOf(), baseline: { id: 6, name: "Q0 plan", planRevision: 3, removedProjects: [] } }));
      if (url.endsWith("?baseline=7")) return Promise.resolve(jsonResponse(200, withRemoved()));
      if (url.endsWith("?baseline=99")) return Promise.resolve(jsonResponse(400, UNKNOWN));
      return Promise.resolve(jsonResponse(200, plainOf()));
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

const waitForGrid = () => screen.findByRole("grid", { name: "Programs timeline" });
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

describe("Programs page with a baseline", () => {
  test("no baseline by default: the plain view, the picker reads None, no shadow bar and no totals line", async () => {
    renderWithProviders(<Programs />);
    await waitForGrid();
    expect(viewUrls).toEqual(["/api/v1/views/programs"]);
    expect(await screen.findByRole("combobox", { name: "Baseline" })).toHaveValue("None");
    expect(shadows()).toEqual([]);
    expect(screen.queryByText(/vs baseline/)).toBeNull();
  });

  test("the work stream row and its baselined program row carry a shadow bar and the totals line counts the projects", async () => {
    localStorage.setItem(PICK_KEY, "5");
    renderWithProviders(<Programs />);
    await waitForGrid();
    expect(viewUrls).toEqual(["/api/v1/views/programs?baseline=5"]);
    // the streams open expanded: Platform and its programs; Reports has no project the baseline froze, so no bar
    await waitFor(() => expect(shadows()).toHaveLength(2));
    expect(shadows()).toEqual([
      "Baseline: Platform, 2026-03-02 to 2026-06-05, start unchanged, end 63 working days later, read-only",
      "Baseline: Billing, 2026-03-02 to 2026-06-05, read-only",
    ]);
    const note = screen.getByRole("note");
    expect(note).toHaveTextContent("vs baseline Q1 plan:");
    expect(within(note).getAllByText(/./).map((node) => node.textContent)).toEqual(expect.arrayContaining(["1 end later", "1 new"]));
    expect(within(note).queryByText(/removed/)).toBeNull();
  });

  test("a deleted project the baseline froze shows dimmed under its program once that program is expanded; the totals line counts every removed project", async () => {
    const user = userEvent.setup();
    localStorage.setItem(PICK_KEY, "7");
    renderWithProviders(<Programs />);
    await waitForGrid();
    expect(await screen.findByText("4 removed")).toBeInTheDocument();
    // Billing and Reports are folded: nothing is drawn for the deleted projects yet
    expect(screen.queryByText(/\(removed\)/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Program Billing" }));
    const name = await screen.findByText("Retired (removed)");
    const row = name.closest('[role="row"]')!;
    expect(row).toBe(screen.getByRole("link", { name: /Taxes/ }).closest('[role="row"]')!.nextElementSibling);
    expect(name.closest("[title]")).toHaveAttribute("title", "Billing · Platform");
    expect(within(row as HTMLElement).queryByRole("link")).toBeNull();
    expect(within(row as HTMLElement).queryByRole("button")).toBeNull();
    expect(row.querySelector('[data-tone="baseline"]')).toHaveAttribute("aria-label", "Baseline: Retired, 2026-02-02 to 2026-02-27, read-only");
    // a project without a span, one of another (still folded) program and one whose program is gone have no row
    expect(screen.queryByText(/Spanless|Reaped|Orphan/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Program Reports" }));
    expect(await screen.findByText("Reaped (removed)")).toBeInTheDocument();
    expect(screen.queryByText(/Orphan/)).toBeNull();
  });

  test("a program whose live projects are all deleted still has its chevron: it expands and shows the removed row, announced with the count", async () => {
    const user = userEvent.setup();
    const empty: ProgramsProgram = { id: 12, name: "Legacy", ownerName: "Lea Legacy", span: null, flags: { warnings: 0, infos: 0 }, projects: [] };
    mockFetch.mockImplementation((url: string) => {
      if (url.startsWith("/api/v1/views/programs")) {
        const base = withRemoved();
        const stream = { ...PLATFORM, programs: [...PLATFORM.programs, empty] };
        return Promise.resolve(jsonResponse(200, { ...base, workStreams: [stream], baseline: { ...base.baseline!, removedProjects: [gone(15, "Lost", { programId: 12, programName: "Legacy" })] } }));
      }
      return Promise.resolve(url === "/api/v1/baselines" ? jsonResponse(200, BASELINES) : url === "/api/v1/public-holidays" ? jsonResponse(200, { items: [] }) : jsonResponse(404, { title: "x", status: 404 }));
    });
    localStorage.setItem(PICK_KEY, "7");
    renderWithProviders(<Programs />);
    await waitForGrid();
    await user.click(await screen.findByRole("button", { name: "Program Legacy" }));
    expect(await screen.findByText("Lost (removed)")).toBeInTheDocument();
    expect(screen.getByText("Legacy expanded, 1 project")).toBeInTheDocument();
  });

  test("a program the pick hides draws none of its deleted projects, and the one the pick keeps does", async () => {
    const user = userEvent.setup();
    localStorage.setItem(PICK_KEY, "7");
    localStorage.setItem(PROGRAM_PICK_KEY, JSON.stringify([11]));
    renderWithProviders(<Programs />);
    await waitForGrid();
    await user.click(await screen.findByRole("button", { name: "Program Reports" }));
    expect(await screen.findByText("Reaped (removed)")).toBeInTheDocument();
    expect(screen.queryByText(/Retired/)).toBeNull();
    expect(screen.getByText("4 removed")).toBeInTheDocument();
  });

  test("an expanded program shows its projects' shadow bars", async () => {
    const user = userEvent.setup();
    localStorage.setItem(PICK_KEY, "5");
    renderWithProviders(<Programs />);
    await waitForGrid();
    await user.click(screen.getByRole("button", { name: "Program Billing" }));
    await waitFor(() => expect(shadows()).toHaveLength(4));
    expect(shadows()).toEqual(
      expect.arrayContaining([
        "Baseline: Billing, 2026-03-02 to 2026-06-05, read-only",
        "Baseline: Invoices, 2026-03-02 to 2026-04-03, start unchanged, end 5 working days later, read-only",
        "Baseline: Taxes, 2026-05-04 to 2026-06-05, read-only",
      ]),
    );
  });

  test("a pick that shows the work stream in part draws the union of the shown programs' frozen spans, without a movement sentence", async () => {
    localStorage.setItem(PICK_KEY, "5");
    localStorage.setItem(PROGRAM_PICK_KEY, JSON.stringify([10]));
    renderWithProviders(<Programs />);
    await waitForGrid();
    await waitFor(() => expect(shadows()).toHaveLength(2));
    // the stream's bar is rolled up over the programs that remain (no movement sentence: the server's belongs to the whole stream); the program keeps its own
    expect(shadows()).toEqual(["Baseline: Platform, 2026-03-02 to 2026-06-05, read-only", "Baseline: Billing, 2026-03-02 to 2026-06-05, read-only"]);
  });

  test.each([
    ["another baseline B", "Q0 plan", "/api/v1/views/programs?baseline=6"],
    ["no baseline", "None", "/api/v1/views/programs"],
  ])("changing to %s: while it loads no work stream, program or project row draws the old pick's shadow bar, and no totals line shows", async (_name, option, url) => {
    const user = userEvent.setup();
    localStorage.setItem(PICK_KEY, "5");
    renderWithProviders(<Programs />);
    await waitForGrid();
    await user.click(screen.getByRole("button", { name: "Program Billing" }));
    await waitFor(() => expect(shadows()).toHaveLength(4));
    const release = holdViews((requested) => requested === url);
    await user.click(screen.getByRole("combobox", { name: "Baseline" }));
    await user.click(await screen.findByRole("option", { name: option }));
    await waitFor(() => expect(mockFetch.mock.calls.some(([requested]) => requested === url)).toBe(true));
    expect(shadows()).toEqual([]);
    expect(screen.queryByRole("note")).toBeNull();
    release();
    await waitFor(() => expect(screen.getByRole("grid", { name: "Programs timeline" })).toBeInTheDocument());
    if (option === "None") await waitFor(() => expect(JSON.parse(localStorage.getItem(PICK_KEY) ?? "null")).toBeNull());
    else await waitFor(() => expect(shadows().length).toBeGreaterThan(0));
  });

  test("the typed 400 clears a pick that is gone and fetches the plain view once", async () => {
    localStorage.setItem(PICK_KEY, "99");
    renderWithProviders(<Programs />);
    await waitForGrid();
    expect(viewUrls).toEqual(["/api/v1/views/programs?baseline=99", "/api/v1/views/programs"]);
    expect(JSON.parse(localStorage.getItem(PICK_KEY) ?? "null")).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(viewUrls).toHaveLength(2);
  });
});
