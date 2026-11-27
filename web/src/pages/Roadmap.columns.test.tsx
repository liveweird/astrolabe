import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { screen, within } from "@testing-library/react";
import Roadmap from "./Roadmap";
import type { RoadmapProject, RoadmapView } from "../api/roadmap";
import { jsonResponse } from "../test/http";
import { renderWithProviders } from "../test/render";

// The Roadmap's Prioritization mode hides only its Flags column (1.34, timeline.md "Hidden columns", decision D1): the rank is the mode's subject and the
// grid's row header, the project name is the row's identity, Operations is the way on. The choice is its own: the overview's lives under `programs`.

const KEY = "astrolabe.viewSettings.timeline.columns.roadmap";
const OVERVIEW_KEY = "astrolabe.viewSettings.timeline.columns.programs";

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
  span: { start: "2026-03-09", end: "2026-04-10" },
  drift: null,
  flags: [],
  can: { editTargetWindow: false },
  ...over,
});
const INVOICES = project(1, "Invoices", { rankPosition: 1, flags: [{ kind: "JIRA_MILESTONES", severity: "INFO", count: 3 }] });
const TAXES = project(2, "Taxes", { rankPosition: 2 });
const FRESH = project(4, "Fresh", { span: { start: "2026-07-06", end: "2026-07-10" } });
const VIEW: RoadmapView = {
  jiraSites: [],
  revision: 7,
  can: { editRank: false },
  teams: [],
  links: [],
  ranked: [INVOICES, TAXES].map((p, index) => ({ position: index + 1, project: p })),
  unranked: [FRESH],
};

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (url.startsWith("/api/v1/views/roadmap")) return Promise.resolve(jsonResponse(200, VIEW));
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

const timeline = () => screen.findByRole("grid", { name: "Roadmap timeline" });
const headers = (grid: HTMLElement) => within(grid).getAllByRole("columnheader").map((header) => header.textContent);
const toggle = () => screen.getByRole("button", { name: /^(Hide|Show) columns$/ });
const chevron = () => screen.getByRole("button", { name: /^Choose columns/ });
/** The cells of every body row: the left cells (row header and grid cells) plus the track. */
const cellCounts = (grid: HTMLElement) => within(grid).getAllByRole("row").slice(1).map((row) => row.querySelectorAll('[role="rowheader"], [role="gridcell"]').length);

describe("the Roadmap's Prioritization columns", () => {
  test("the menu offers Flags only: the rank, the project and Operations are never in it, and a first visit writes nothing", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Roadmap />);
    const grid = await timeline();
    expect(headers(grid)).toEqual(["#", "Project", "Flags", "Operations"]);
    await user.click(chevron());
    const menu = await screen.findByRole("menu", { name: /^Choose columns/ });
    expect(within(menu).getAllByRole("menuitemcheckbox").map((item) => [item.textContent, item.getAttribute("aria-checked")])).toEqual([["Flags", "true"]]);
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  test("hiding drops Flags from the header and every row (the unranked divider included), keeps the rest and writes the page's key", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Roadmap />);
    const grid = await timeline();
    // Invoices, Taxes, the divider and Fresh: rank, project, flags, operations + the track
    expect(cellCounts(grid)).toEqual([5, 5, 5, 5]);
    await user.click(toggle());
    expect(headers(grid)).toEqual(["#", "Project", "Operations"]);
    expect(cellCounts(grid)).toEqual([4, 4, 4, 4]);
    expect(within(grid).getByRole("link", { name: "Open project Invoices" })).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(KEY) ?? "null")).toEqual({ collapsed: true, hidden: [] });
    expect(localStorage.getItem(OVERVIEW_KEY)).toBeNull();
    await user.click(toggle());
    expect(headers(grid)).toEqual(["#", "Project", "Flags", "Operations"]);
  });

  test("a stored choice is read on the next visit, and the control follows Scroll to today before the page's own controls", async () => {
    localStorage.setItem(KEY, JSON.stringify({ collapsed: false, hidden: ["flags"] }));
    renderWithProviders(<Roadmap />);
    const grid = await timeline();
    expect(headers(grid)).toEqual(["#", "Project", "Operations"]);
    const today = screen.getByRole("button", { name: "Scroll to today" });
    const group = screen.getByRole("group", { name: "Columns" });
    const picker = screen.getByRole("combobox", { name: "Baseline" });
    const follows = (a: Element, b: Element) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    expect(follows(today, group)).toBe(true);
    expect(follows(group, picker)).toBe(true);
    expect(group.parentElement).toBe(today.parentElement);
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
  });
});
