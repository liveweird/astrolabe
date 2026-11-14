import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { screen, waitFor, within } from "@testing-library/react";
import Roadmap from "./Roadmap";
import type { Deviation } from "../api/deviations";
import type { PlanFlag, RoadmapProject, RoadmapView } from "../api/roadmap";
import { jsonResponse } from "../test/http";
import { renderWithProviders } from "../test/render";
import { detail, evidence } from "../test/deviations";

// The 1.3 Jira markers on the Roadmap page: the "Jira dates" toggle (on by default, remembered), the shadow bar of each bound project, and the flag
// panel's sentences (the deviation page's wording behind the key, the milestones roll-up) with the key as a link through the document's `jiraSites`.

const KEY = "astrolabe.viewSettings.timeline.jiraBars";

const flag = (kind: PlanFlag["kind"], severity: PlanFlag["severity"], over: Partial<PlanFlag> = {}): PlanFlag => ({ kind, severity, ...over });

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

// Jira ends a week before the plan's span (2026-04-10): the evidence of the open END deviation agrees with the dates on the bar.
const endLater: Deviation = { kind: "END_DIFFERS", severity: "WARNING", detail: detail({ plan: "2026-04-10", jira: "2026-04-03", days: 5 }) };

const link = (id: number, key: string, start: string | null, end: string | null, connectionId = 2) => ({ bindingId: id, connectionId, issueKey: key, start, end, rollup: null });

// Invoices: bound with both dates, one open END deviation and a milestones roll-up; Taxes: bound, Jira has no dates; Audit: bound, clean; Fresh: unbound.
const INVOICES = project(1, "Invoices", {
  rankPosition: 1,
  jira: link(11, "E2E-6", "2026-03-09", "2026-04-03"),
  flags: [flag("JIRA_DEVIATION", "WARNING", { deviation: evidence(endLater) }), flag("JIRA_MILESTONES", "INFO", { count: 3 })],
});
const TAXES = project(2, "Taxes", { rankPosition: 2, jira: link(12, "E2E-7", null, null) });
const AUDIT = project(3, "Audit", { rankPosition: 3, jira: link(13, "E2E-8", "2026-05-04", "2026-05-29") });
const FRESH = project(4, "Fresh", { span: { start: "2026-07-06", end: "2026-07-10" } });

const viewOf = (over: Partial<RoadmapView> = {}): RoadmapView => ({
  jiraSites: [{ connectionId: 2, siteUrl: "https://acme.atlassian.net", state: "CURRENT" as const, mappingOk: true }],
  revision: 7,
  can: { editRank: false },
  teams: [],
  links: [],
  ranked: [INVOICES, TAXES, AUDIT].map((p, index) => ({ position: index + 1, project: p })),
  unranked: [FRESH],
  ...over,
});

let view: RoadmapView;

beforeEach(() => {
  view = viewOf();
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (url.startsWith("/api/v1/views/roadmap")) return Promise.resolve(jsonResponse(200, view));
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

const waitForGrid = () => screen.findByRole("grid", { name: "Roadmap timeline" });
const jiraBars = () => [...document.querySelectorAll('[data-tone="jira"]')].map((bar) => bar.getAttribute("aria-label"));
const toggle = () => screen.getByRole("button", { name: "Jira dates" });

describe("Roadmap page: the Jira dates", () => {
  test("on by default: a shadow bar for each project whose Jira has both dates, named with the key, the dates and the date deviation", async () => {
    renderWithProviders(<Roadmap />);
    await waitForGrid();
    expect(toggle()).toHaveAttribute("aria-pressed", "true");
    expect(jiraBars()).toEqual([
      "Jira E2E-6: 2026-03-09 to 2026-04-03, Ends 5 working days later than Jira (plan 2026-04-10, Jira 2026-04-03), read-only",
      "Jira E2E-8: 2026-05-04 to 2026-05-29, read-only",
    ]);
    // the bar rides in its project's row, after the span bar
    const row = screen.getByRole("link", { name: "Open Invoices" }).closest('[role="row"]') as HTMLElement;
    expect([...row.querySelectorAll("[data-tone]")].map((el) => el.getAttribute("data-tone"))).toEqual(["summary", "jira"]);
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  test("the toggle hides the bars and remembers it; the next visit starts hidden, and showing again draws them", async () => {
    const user = userEvent.setup();
    const first = renderWithProviders(<Roadmap />);
    await waitForGrid();
    await user.click(toggle());
    expect(toggle()).toHaveAttribute("aria-pressed", "false");
    expect(jiraBars()).toEqual([]);
    expect(JSON.parse(localStorage.getItem(KEY) ?? "null")).toBe(false);
    first.unmount();

    renderWithProviders(<Roadmap />);
    await waitForGrid();
    expect(toggle()).toHaveAttribute("aria-pressed", "false");
    expect(jiraBars()).toEqual([]);
    await user.click(toggle());
    expect(jiraBars()).toHaveLength(2);
    expect(JSON.parse(localStorage.getItem(KEY) ?? "null")).toBe(true);
  });

  test("a stored false is honoured on the first render", async () => {
    localStorage.setItem(KEY, "false");
    renderWithProviders(<Roadmap />);
    await waitForGrid();
    expect(toggle()).toHaveAttribute("aria-pressed", "false");
    expect(jiraBars()).toEqual([]);
  });

  test("the toggle sits in the timeline's toolbar after the baseline picker", async () => {
    renderWithProviders(<Roadmap />);
    await waitForGrid();
    const picker = screen.getByRole("combobox", { name: "Baseline" });
    const today = screen.getByRole("button", { name: "Today" });
    expect(today.compareDocumentPosition(picker) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(picker.compareDocumentPosition(toggle()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test("a mistyped Jira date does not stretch the track: the bar is cut at the window and its name keeps the real dates", async () => {
    view = viewOf({ ranked: [{ position: 1, project: { ...INVOICES, jira: link(11, "E2E-6", "2026-03-09", "2206-04-03") } }], unranked: [] });
    renderWithProviders(<Roadmap />);
    await waitForGrid();
    const bar = document.querySelector('[data-tone="jira"]') as HTMLElement;
    expect(bar).toHaveAttribute("aria-label", expect.stringContaining("Jira E2E-6: 2026-03-09 to 2206-04-03"));
    // the plan runs to 2026-04-10: the window ends a year later, and the bar stops there (about 2 years at 3 px a day), not at the year 2206
    expect(parseFloat((bar.parentElement as HTMLElement).style.width)).toBeLessThan(3000);
  });

  test("without a Jira site in the view there is no toggle, and the remembered choice is left alone", async () => {
    localStorage.setItem(KEY, "false");
    view = viewOf({ jiraSites: [], ranked: [{ position: 1, project: INVOICES }], unranked: [] });
    renderWithProviders(<Roadmap />);
    await waitForGrid();
    expect(screen.queryByRole("button", { name: "Jira dates" })).toBeNull();
    expect(screen.getByRole("combobox", { name: "Baseline" })).toBeInTheDocument();
    expect(localStorage.getItem(KEY)).toBe("false");
  });

  test("the flag icons and counts are unchanged: severity-driven, Jira kinds included", async () => {
    renderWithProviders(<Roadmap />);
    await waitForGrid();
    const row = screen.getByRole("link", { name: "Open Invoices" }).closest('[role="row"]') as HTMLElement;
    expect(row.querySelector("[data-flags]")).toHaveAttribute("data-flags", "1,1");
  });
});

describe("Roadmap page: the Jira flags in the panel", () => {
  test("a deviation reads the deviation page's sentence behind the key; the roll-up counts the milestones; the key links to the issue", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Roadmap />);
    await waitForGrid();
    await user.click(screen.getByRole("button", { name: "Show the 2 flags" }));
    const table = await screen.findByRole("table", { name: "Flags of the projects shown" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((row) => within(row).getAllByRole("cell").slice(0, 3).map((cell) => cell.textContent))).toEqual([
      ["Warning", "Invoices", "Jira E2E-6: Ends 5 working days later than Jira (plan 2026-04-10, Jira 2026-04-03)Open E2E-6 in Jira"],
      ["Info", "Invoices", "3 milestones deviate from Jira"],
    ]);
    const open = within(rows[0]).getByRole("link", { name: "Open E2E-6 in Jira" });
    expect(open).toHaveAttribute("href", "https://acme.atlassian.net/browse/E2E-6");
    // the roll-up names no single issue: no link
    expect(within(rows[1]).queryByRole("link", { name: /in Jira/ })).toBeNull();
  });

  test("one milestone is singular; a deviation without evidence degrades to the bare sentence; a site the document does not list gives no link", async () => {
    const user = userEvent.setup();
    view = viewOf({
      jiraSites: [],
      ranked: [
        { position: 1, project: { ...INVOICES, flags: [flag("JIRA_DEVIATION", "WARNING"), flag("JIRA_MILESTONES", "WARNING", { count: 1 })] } },
        { position: 2, project: TAXES },
      ],
      unranked: [],
    });
    renderWithProviders(<Roadmap />);
    await waitForGrid();
    await user.click(screen.getByRole("button", { name: "Show the 2 flags" }));
    const table = await screen.findByRole("table", { name: "Flags of the projects shown" });
    const sentences = within(table).getAllByRole("row").slice(1).map((row) => within(row).getAllByRole("cell")[2].textContent);
    expect(sentences).toEqual(["Jira E2E-6: Differs from Jira", "1 milestone deviates from Jira"]);
    expect(within(table).queryByRole("link", { name: /in Jira/ })).toBeNull();
  });

  test("other kinds of evidence phrase through the same sentences (a level mismatch)", async () => {
    const user = userEvent.setup();
    const level = flag("JIRA_DEVIATION", "WARNING", { deviation: { kind: "LEVEL_MISMATCH", detail: detail({ jira: "3", plan: "2" }) } });
    view = viewOf({ ranked: [{ position: 1, project: { ...INVOICES, flags: [level] } }], unranked: [] });
    renderWithProviders(<Roadmap />);
    await waitForGrid();
    await user.click(screen.getByRole("button", { name: "Show the 1 flag" }));
    const table = await screen.findByRole("table", { name: "Flags of the projects shown" });
    await waitFor(() => expect(within(table).getAllByRole("row")).toHaveLength(2));
    expect(within(table).getAllByRole("cell")[2]).toHaveTextContent("Jira E2E-6: The Jira item is at hierarchy level 3, but the mapping expects level 2 here");
  });
});
