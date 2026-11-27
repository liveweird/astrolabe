import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { screen, within } from "@testing-library/react";
import Programs from "./Programs";
import type { ProgramsProgram, ProgramsView, ProgramsWorkStream } from "../api/programs";
import type { RoadmapProject } from "../api/roadmap";
import { jsonResponse } from "../test/http";
import { renderWithProviders } from "../test/render";

// The Roadmap overview (the Programs page) hides only its Flags column (1.34, timeline.md "Hidden columns"): the name and Operations stay. The choice is
// its own: the Prioritization mode's lives under `roadmap`.

const KEY = "astrolabe.viewSettings.timeline.columns.programs";
const PRIORITIZATION_KEY = "astrolabe.viewSettings.timeline.columns.roadmap";

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
  span: { start: "2026-03-02", end: "2026-04-10" },
  drift: null,
  flags: [],
  can: { editTargetWindow: false },
  ...over,
});
const INVOICES = project(1, "Invoices", { flags: [{ kind: "JIRA_MILESTONES", severity: "INFO", count: 3 }] });
const TAXES = project(2, "Taxes");
const BILLING: ProgramsProgram = { id: 10, name: "Billing", ownerPersonId: 1, ownerName: "Pat Program", span: { start: "2026-03-02", end: "2026-04-10" }, flags: { warnings: 0, infos: 1 }, projects: [INVOICES, TAXES] };
const PLATFORM: ProgramsWorkStream = {
  id: 1,
  name: "Platform",
  ownerPersonId: 1,
  ownerName: "Sam Stream",
  startDate: "2026-01-05",
  endDate: null,
  span: { start: "2026-03-02", end: "2026-04-10" },
  flags: { warnings: 0, infos: 1 },
  programs: [BILLING],
};
const VIEW: ProgramsView = { jiraSites: [], revision: 9, teams: [], links: [], workStreams: [PLATFORM] };

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (url.startsWith("/api/v1/views/programs")) return Promise.resolve(jsonResponse(200, VIEW));
      if (url === "/api/v1/baselines") return Promise.resolve(jsonResponse(200, { items: [], can: { manage: false } }));
      if (url === "/api/v1/public-holidays") return Promise.resolve(jsonResponse(200, { items: [] }));
      return Promise.resolve(jsonResponse(404, { title: "x", status: 404 }));
    }),
  );
  localStorage.setItem("astrolabe.auth.token", "fake-token");
});
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

const timeline = () => screen.findByRole("grid", { name: "Programs timeline" });
const headers = (grid: HTMLElement) => within(grid).getAllByRole("columnheader").map((header) => header.textContent);
const toggle = () => screen.getByRole("button", { name: /^(Hide|Show) columns$/ });
const chevron = () => screen.getByRole("button", { name: "Choose columns" });
/** The cells of every body row: the left cells (row header and grid cells) plus the track. */
const cellCounts = (grid: HTMLElement) => within(grid).getAllByRole("row").slice(1).map((row) => row.querySelectorAll('[role="rowheader"], [role="gridcell"]').length);

describe("the Roadmap overview's columns", () => {
  test("the menu offers Flags only: the name and Operations are never in it, and a first visit writes nothing", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Programs />);
    const grid = await timeline();
    expect(headers(grid)).toEqual(["Work stream, program, project", "Flags", "Operations"]);
    await user.click(chevron());
    const menu = await screen.findByRole("menu", { name: "Choose columns" });
    expect(within(menu).getAllByRole("menuitemcheckbox").map((item) => [item.textContent, item.getAttribute("aria-checked")])).toEqual([["Flags", "true"]]);
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  test("hiding drops Flags from the header and every row, including the projects of an opened program, and writes the page's key", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Programs />);
    const grid = await timeline();
    await user.click(screen.getByRole("button", { name: "Program Billing" }));
    // the work stream, its program and the program's two projects: name, flags, operations + the track
    expect(cellCounts(grid)).toEqual([4, 4, 4, 4]);
    await user.click(toggle());
    expect(headers(grid)).toEqual(["Work stream, program, project", "Operations"]);
    expect(cellCounts(grid)).toEqual([3, 3, 3, 3]);
    expect(within(grid).getByRole("link", { name: "Open project Invoices" })).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(KEY) ?? "null")).toEqual({ collapsed: true, hidden: [] });
    expect(localStorage.getItem(PRIORITIZATION_KEY)).toBeNull();
    await user.click(toggle());
    expect(headers(grid)).toEqual(["Work stream, program, project", "Flags", "Operations"]);
  });

  test("the control follows Scroll to today before the page's own controls", async () => {
    renderWithProviders(<Programs />);
    await timeline();
    const today = screen.getByRole("button", { name: "Scroll to today" });
    const group = screen.getByRole("group", { name: "Columns" });
    const picker = screen.getByRole("combobox", { name: "Baseline" });
    const follows = (a: Element, b: Element) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    expect(follows(today, group)).toBe(true);
    expect(follows(group, picker)).toBe(true);
    expect(group.parentElement).toBe(today.parentElement);
  });
});
