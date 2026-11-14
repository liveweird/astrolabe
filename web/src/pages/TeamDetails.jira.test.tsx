import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { screen, waitFor, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import TeamDetails from "./TeamDetails";
import type { Deviation } from "../api/deviations";
import type { JiraLink, PlanFlag } from "../api/roadmap";
import type { TeamMilestone, TeamView } from "../api/teams";
import { detail, endLater, evidence } from "../test/deviations";
import { headingOutline } from "../test/headings";
import { jsonResponse } from "../test/http";
import { READ_ONLY_PANEL } from "../test/flow";
import { renderWithProviders } from "../test/render";

// The Jira markers of the team page (1.3), all read from the team VIEW: the chip, the Flags column, the tray rows' icon and note, the shadow bars and
// their toggle. The page makes no request of its own for any of them.

const BARS_KEY = "astrolabe.viewSettings.timeline.jiraBars";

const link = (bindingId: number, key: string, start: string | null = null, end: string | null = null): JiraLink => ({ bindingId, connectionId: 1, issueKey: key, start, end, rollup: null });
const flag = (deviation: Deviation): PlanFlag => ({ kind: "JIRA_DEVIATION", severity: deviation.severity, deviation: evidence(deviation) });
const unscheduledInPlan: Deviation = { kind: "UNSCHEDULED_IN_PLAN", severity: "INFO", detail: detail({ jira: "2027-03-01" }) };

const milestone = (id: number, name: string, over: Partial<TeamMilestone> = {}): TeamMilestone => ({
  jira: null,
  flags: [],
  slackDays: null,
  critical: false,
  pinned: false,
  id,
  projectId: 7,
  name,
  description: null,
  teamId: 1,
  teamName: "Payments",
  estimateMd: 10,
  startDate: "2027-02-01",
  endDate: "2027-02-05",
  createdAt: 1,
  updatedAt: 2,
  projectName: "Invoices",
  programName: "Billing",
  workStreamName: "Platform",
  rankPosition: 1,
  ...over,
});

const TEAM_VIEW: TeamView = {
  jiraSites: [{ connectionId: 1, siteUrl: "https://acme.atlassian.net", state: "CURRENT" as const, mappingOk: true }],
  revision: 10,
  team: { id: 1, name: "Payments", description: null, managerPersonId: 12, managerName: "Cara New", createdAt: 1, updatedAt: 2, can: { schedule: false, editCapacity: false, editOrder: false }, flags: [] },
  order: { custom: false, revision: 4, milestoneIds: [] },
  capacity: { periods: [] },
  weeks: [],
  weeksTruncated: false,
  // tv-a: linked, an open END deviation, Jira holds both dates; tv-b: linked, clean, Jira has no dates; tv-c: unlinked.
  scheduled: [
    milestone(1, "tv-a", { jira: link(1, "E2E-3", "2027-02-01", "2027-02-02"), flags: [flag(endLater(3))] }),
    milestone(2, "tv-b", { startDate: "2027-02-08", endDate: "2027-02-10", jira: link(2, "E2E-4") }),
    milestone(3, "tv-c", { startDate: "2027-02-15", endDate: "2027-02-17" }),
  ],
  unscheduled: [],
  dependencies: [],
  idleGaps: [],
};

type FetchMock = ReturnType<typeof vi.fn>;
let teamView: TeamView;
/** What an accepted schedule PUT does to the next read of the view (the stand-in server applies the dates). */
let afterSchedule: ((body: { startDate: string | null; endDate: string | null }) => void) | null;

describe("the team page's Jira markers", () => {
  let mockFetch: FetchMock;
  beforeEach(() => {
    mockFetch = vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/v1/views/team/1") return Promise.resolve(jsonResponse(200, teamView));
      if (url === "/api/v1/teams/1/flow") return Promise.resolve(jsonResponse(200, READ_ONLY_PANEL));
      if (url === "/api/v1/public-holidays") return Promise.resolve(jsonResponse(200, { items: [] }));
      if (init?.method === "PUT" && /^\/api\/v1\/milestones\/\d+\/schedule$/.test(url)) {
        afterSchedule?.(JSON.parse(init.body as string) as { startDate: string | null; endDate: string | null });
        return Promise.resolve(jsonResponse(200, { revision: 11 }));
      }
      return Promise.resolve(jsonResponse(404, { title: "Not Found", status: 404 }));
    });
    vi.stubGlobal("fetch", mockFetch);
    localStorage.setItem("astrolabe.auth.token", "fake-token");
    localStorage.setItem("astrolabe.auth.roles", JSON.stringify(["USER"]));
    teamView = TEAM_VIEW;
    afterSchedule = null;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });
  const renderPage = () => renderWithProviders(<Routes><Route path="/teams/:id" element={<TeamDetails />} /></Routes>, { route: "/teams/1" });
  const timeline = () => screen.findByRole("grid", { name: "Team milestone timeline" });
  const jiraBars = () => [...document.querySelectorAll('[data-tone="jira"]')].map((bar) => bar.getAttribute("aria-label"));
  const toggle = () => screen.getByRole("button", { name: "Jira dates" });
  const requested = () => mockFetch.mock.calls.map(([url]) => url as string);

  describe("the chip, from the view", () => {
    test("shows how many milestones are linked and an open-flag count that opens the page filtered to the team - without asking the deviations list", async () => {
      renderPage();
      const group = await screen.findByRole("group", { name: "Links to Jira" });
      expect(within(group).getByText("2 milestones linked to Jira")).toBeInTheDocument();
      expect(within(group).getByRole("link", { name: "1 Jira deviation" })).toHaveAttribute("href", "/deviations?teamId=1");
      expect(requested().filter((url) => url.includes("views/deviations"))).toEqual([]);
      // The outline is the page's own: the chip adds no heading.
      expect(headingOutline().filter(([level]) => level === 2)).toEqual([[2, "Payments"]]);
    });

    test("with nothing linked there is no chip, no Flags column and no Jira toggle", async () => {
      teamView = { ...TEAM_VIEW, jiraSites: [], scheduled: TEAM_VIEW.scheduled.map((m) => ({ ...m, jira: null, flags: [] })) };
      renderPage();
      const grid = await timeline();
      expect(screen.queryByRole("group", { name: "Links to Jira" })).not.toBeInTheDocument();
      expect(within(grid).queryByRole("columnheader", { name: "Flags" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Jira dates" })).not.toBeInTheDocument();
    });

    test("the Flags cell and the tray row show a milestone's roll-up after its key (1.4)", async () => {
      const rollup = { children: 4, done: 2, points: null, observedAt: 1 };
      teamView = {
        ...TEAM_VIEW,
        scheduled: TEAM_VIEW.scheduled.map((m) => (m.id === 2 ? { ...m, jira: { ...link(2, "E2E-4"), rollup } } : m)),
        unscheduled: [milestone(4, "tv-tray", { startDate: null, endDate: null, jira: { ...link(4, "E2E-9"), rollup: { ...rollup, children: 1, done: 1, points: 8 } } })],
      };
      renderPage();
      const grid = await timeline();
      const rowB = within(grid).getByRole("row", { name: /tv-b/ });
      expect(within(rowB).getByText("2/4")).toBeInTheDocument();
      expect(within(rowB).getByText("4 child issues in Jira, done: 2")).toBeInTheDocument();
      const tray = screen.getByRole("table", { name: "Unscheduled milestones of the team" });
      expect(within(tray).getByText("1/1 · 8 pt")).toBeInTheDocument();
    });

    test("a linked tray milestone is counted by the chip", async () => {
      teamView = { ...TEAM_VIEW, unscheduled: [milestone(4, "tv-tray", { startDate: null, endDate: null, jira: link(4, "E2E-9") })] };
      renderPage();
      expect(await screen.findByText("3 milestones linked to Jira")).toBeInTheDocument();
    });
  });

  describe("the Flags column", () => {
    test("exists while a scheduled milestone is linked, before Operations; the row's icon with its sentences as the label, an empty cell for a clean or unlinked row", async () => {
      renderPage();
      const grid = await timeline();
      expect(within(grid).getAllByRole("columnheader").map((header) => header.textContent)).toEqual(["Milestone", "Project", "Estimate", "Flags", "Operations"]);
      const rowA = within(grid).getByRole("row", { name: /tv-a/ });
      expect(rowA.querySelector("[data-flags]")).toHaveAttribute("data-flags", "1,0");
      expect(rowA).toHaveTextContent("Jira E2E-3: Ends 3 working days later than Jira (plan 2044-03-07, Jira 2044-03-04)");
      expect(within(rowA).getByRole("link", { name: /E2E-3/ })).toHaveAttribute("href", "https://acme.atlassian.net/browse/E2E-3");
      // tv-b is linked and clean: no icon, but its key (and the words for a screen reader) tell it from the unlinked tv-c
      const rowB = within(grid).getByRole("row", { name: /tv-b/ });
      expect(rowB.querySelector("[data-flags]")).toBeNull();
      expect(within(rowB).getByRole("link", { name: /E2E-4/ })).toHaveAttribute("href", "https://acme.atlassian.net/browse/E2E-4");
      expect(rowB).toHaveTextContent("Linked to Jira: E2E-4");
      const rowC = within(grid).getByRole("row", { name: /tv-c/ });
      expect(rowC.querySelector("[data-flags]")).toBeNull();
      expect(within(rowC).queryByRole("link", { name: /E2E-/ })).not.toBeInTheDocument();
    });

    test("the key is a link only for an https site", async () => {
      teamView = { ...TEAM_VIEW, jiraSites: [{ connectionId: 1, siteUrl: "http://plain.example", state: "CURRENT" as const, mappingOk: true }] };
      renderPage();
      const rowB = within(await timeline()).getByRole("row", { name: /tv-b/ });
      expect(within(rowB).queryByRole("link", { name: /E2E-4/ })).not.toBeInTheDocument();
      expect(rowB).toHaveTextContent("E2E-4");
    });

    test("nothing of the old remembered 'Jira' column is left: no stored answer is read or written", async () => {
      localStorage.setItem("astrolabe.viewSettings.teams.jiraColumn.1", "true");
      teamView = { ...TEAM_VIEW, jiraSites: [], scheduled: [milestone(1, "tv-a")] };
      renderPage();
      const grid = await timeline();
      expect(within(grid).queryByRole("columnheader", { name: /Jira|Flags/ })).not.toBeInTheDocument();
      expect(localStorage.getItem("astrolabe.viewSettings.teams.jiraColumn.1")).toBe("true");
    });
  });

  describe("the Unscheduled tray", () => {
    const tray = () => screen.getByRole("table", { name: "Unscheduled milestones of the team" });

    test("a row whose Jira item has dates the plan lacks shows the flag icon beside the name and 'Jira: start to end'; the tray has no Flags column", async () => {
      teamView = {
        ...TEAM_VIEW,
        unscheduled: [
          milestone(4, "tv-rollout", { startDate: null, endDate: null, jira: link(4, "E2E-8", "2027-03-01", "2027-03-05"), flags: [flag(unscheduledInPlan)] }),
          milestone(5, "tv-docs", { startDate: null, endDate: null }),
        ],
      };
      renderPage();
      await timeline();
      const rollout = within(tray()).getByRole("row", { name: /tv-rollout/ });
      expect(rollout).toHaveTextContent("Jira: 2027-03-01 to 2027-03-05");
      expect(rollout.querySelector("[data-flags]")).toHaveAttribute("data-flags", "0,1");
      expect(rollout).toHaveTextContent("Jira E2E-8: Jira has dates, but the plan item is not scheduled");
      expect(within(rollout).getByRole("link", { name: /E2E-8/ })).toHaveAttribute("href", "https://acme.atlassian.net/browse/E2E-8");
      expect(within(tray()).getByRole("row", { name: /tv-docs/ }).querySelector("[data-flags]")).toBeNull();
      expect(within(within(tray()).getByRole("row", { name: /tv-docs/ })).queryByRole("link", { name: /E2E-/ })).not.toBeInTheDocument();
      expect(within(tray()).queryByRole("columnheader", { name: /Flags|Jira/ })).not.toBeInTheDocument();
    });

    test("a clean linked tray row shows its key too, so what the chip counts is what is visible", async () => {
      teamView = { ...TEAM_VIEW, unscheduled: [milestone(4, "tv-clean", { startDate: null, endDate: null, jira: link(4, "E2E-9") })] };
      renderPage();
      await timeline();
      const row = within(tray()).getByRole("row", { name: /tv-clean/ });
      expect(within(row).getByRole("link", { name: /E2E-9/ })).toHaveAttribute("href", "https://acme.atlassian.net/browse/E2E-9");
      expect(row.querySelector("[data-flags]")).toBeNull();
    });

    test("an acknowledged deviation is no flag, so its note goes with it", async () => {
      teamView = { ...TEAM_VIEW, unscheduled: [milestone(4, "tv-rollout", { startDate: null, endDate: null, jira: link(4, "E2E-8", "2027-03-01", "2027-03-05"), flags: [] })] };
      renderPage();
      await timeline();
      expect(within(tray()).getByRole("row", { name: /tv-rollout/ })).not.toHaveTextContent("Jira: 2027-03-01");
    });
  });

  describe("the tray milestones that Jira dates (1.16)", () => {
    const MARK = "(unscheduled; dates from Jira)";
    const trayMilestone = (id: number, name: string, over: Partial<TeamMilestone> = {}) => milestone(id, name, { startDate: null, endDate: null, ...over });
    const ROLLOUT = trayMilestone(4, "tv-rollout", { jira: link(4, "E2E-8", "2027-03-01", "2027-03-05"), flags: [flag(unscheduledInPlan)] });
    /** The Jira bars other than the scheduled tv-a's own. */
    const trayBars = () => jiraBars().filter((name) => !name?.includes("E2E-3"));
    const appendedRows = (grid: HTMLElement) => within(grid).queryAllByRole("row").filter((row) => row.textContent?.includes(MARK));

    test("a tray milestone with both Jira dates has a dimmed row after the scheduled ones with the mark, the project, the estimate, ONE dashed bar and only 'Open project' in its menu; the tray row and its note are unchanged", async () => {
      const user = userEvent.setup();
      teamView = { ...TEAM_VIEW, unscheduled: [ROLLOUT] };
      renderPage();
      const grid = await timeline();
      const [row] = appendedRows(grid);
      expect(appendedRows(grid)).toHaveLength(1);
      expect(row).toHaveTextContent(`tv-rollout ${MARK}`);
      expect(row).toHaveTextContent("Invoices");
      expect(row).toHaveTextContent("10 man-days");
      expect(trayBars()).toEqual(["Jira E2E-8: 2027-03-01 to 2027-03-05, read-only"]);
      expect([...row.querySelectorAll('[data-tone="jira"]')]).toHaveLength(1);
      // the Flags column exists (tv-a is linked) and this row's cell is empty
      expect(within(grid).getByRole("columnheader", { name: "Flags" })).toBeInTheDocument();
      expect(row.querySelector("[data-flags]")).toBeNull();
      expect(row.querySelector("a[href^='https://']")).toBeNull();
      const texts = within(grid).getAllByRole("row").map((r) => r.textContent ?? "");
      expect(texts.findIndex((text) => text.includes(MARK))).toBeGreaterThan(texts.findIndex((text) => text.includes("tv-c")));
      await user.click(within(row).getByRole("button", { name: "Operations for tv-rollout" }));
      expect((await screen.findAllByRole("menuitem")).map((item) => item.textContent)).toEqual(["Open project"]);
      const tray = within(screen.getByRole("table", { name: "Unscheduled milestones of the team" })).getByRole("row", { name: /tv-rollout/ });
      expect(tray).toHaveTextContent("Jira: 2027-03-01 to 2027-03-05");
    });

    test("nothing for one date, no dates, or a range wholly outside the window", async () => {
      teamView = {
        ...TEAM_VIEW,
        unscheduled: [
          trayMilestone(4, "tv-one", { jira: link(4, "E2E-8", "2027-03-01", null) }),
          trayMilestone(5, "tv-none", { jira: link(5, "E2E-9") }),
          trayMilestone(6, "tv-far", { jira: link(6, "E2E-10", "2040-03-01", "2040-03-05") }),
          trayMilestone(7, "tv-plain"),
        ],
      };
      renderPage();
      const grid = await timeline();
      expect(trayBars()).toEqual([]);
      expect(appendedRows(grid)).toEqual([]);
    });

    test("the toggle off removes the row and the bar, on again brings them back", async () => {
      const user = userEvent.setup();
      teamView = { ...TEAM_VIEW, unscheduled: [ROLLOUT] };
      renderPage();
      const grid = await timeline();
      expect(appendedRows(grid)).toHaveLength(1);
      await user.click(toggle());
      expect(appendedRows(grid)).toEqual([]);
      expect(trayBars()).toEqual([]);
      await user.click(toggle());
      expect(appendedRows(grid)).toHaveLength(1);
      expect(trayBars()).toHaveLength(1);
    });

    test("the page's range follows the tray's Jira dates inside the window: the bar lies inside the track", async () => {
      teamView = { ...TEAM_VIEW, unscheduled: [trayMilestone(4, "tv-rollout", { jira: link(4, "E2E-8", "2027-08-02", "2027-08-06") })] };
      renderPage();
      const grid = await timeline();
      const frame = document.querySelector('[data-tone="jira"][aria-label*="E2E-8"]')?.parentElement as HTMLElement;
      const track = parseFloat(grid.style.width) - parseFloat(grid.style.getPropertyValue("--timeline-left"));
      expect(parseFloat(frame.style.left) + parseFloat(frame.style.width)).toBeLessThanOrEqual(track);
    });

    test("scheduling the milestone (optimistic) removes the appended row and puts the one dashed bar on the milestone's own row", async () => {
      const user = userEvent.setup();
      teamView = { ...TEAM_VIEW, team: { ...TEAM_VIEW.team, can: { ...TEAM_VIEW.team.can, schedule: true } }, unscheduled: [ROLLOUT] };
      afterSchedule = (body) => {
        teamView = { ...teamView, revision: 11, scheduled: [...TEAM_VIEW.scheduled, { ...ROLLOUT, startDate: body.startDate, endDate: body.endDate }], unscheduled: [] };
      };
      renderPage();
      const grid = await timeline();
      expect(appendedRows(grid)).toHaveLength(1);
      await user.click(screen.getByRole("button", { name: "Schedule tv-rollout" }));
      await waitFor(() => expect(appendedRows(grid)).toEqual([]));
      const own = within(grid).getByRole("row", { name: /tv-rollout/ });
      expect([...own.querySelectorAll('[data-tone="jira"]')]).toHaveLength(1);
      expect(trayBars()).toHaveLength(1);
    });
  });

  describe("a binding through a disabled connection", () => {
    test("the server keeps the link (null dates, no flag): the chip counts it with no deviations, the row shows its key, no bar is drawn", async () => {
      teamView = { ...TEAM_VIEW, scheduled: [milestone(1, "tv-a", { jira: link(1, "E2E-3") })] };
      renderPage();
      const group = await screen.findByRole("group", { name: "Links to Jira" });
      expect(within(group).getByText("1 milestone linked to Jira")).toBeInTheDocument();
      expect(within(group).getByRole("link", { name: "No deviations seen" })).toBeInTheDocument();
      expect(within(within(await timeline()).getByRole("row", { name: /tv-a/ })).getByRole("link", { name: /E2E-3/ })).toBeInTheDocument();
      expect(jiraBars()).toEqual([]);
    });
  });

  describe("the Jira dates", () => {
    test("on by default: a shadow bar for the linked row with both dates, none for a link without dates or an unlinked row", async () => {
      renderPage();
      await timeline();
      expect(toggle()).toHaveAttribute("aria-pressed", "true");
      expect(jiraBars()).toEqual(["Jira E2E-3: 2027-02-01 to 2027-02-02, Ends 3 working days later than Jira (plan 2044-03-07, Jira 2044-03-04), read-only"]);
      const row = screen.getByRole("row", { name: /tv-a/ });
      expect([...row.querySelectorAll("[data-tone]")].map((el) => el.getAttribute("data-tone"))).toEqual(["jira"]);
      expect(localStorage.getItem(BARS_KEY)).toBeNull();
    });

    test("the toggle hides the bars and remembers it; a later visit starts hidden", async () => {
      const user = userEvent.setup();
      const first = renderPage();
      await timeline();
      await user.click(toggle());
      expect(toggle()).toHaveAttribute("aria-pressed", "false");
      expect(jiraBars()).toEqual([]);
      expect(JSON.parse(localStorage.getItem(BARS_KEY) ?? "null")).toBe(false);
      first.unmount();

      renderPage();
      await timeline();
      expect(toggle()).toHaveAttribute("aria-pressed", "false");
      expect(jiraBars()).toEqual([]);
      await user.click(toggle());
      expect(jiraBars()).toHaveLength(1);
    });

    test("the toggle sits in the timeline's toolbar after the baseline picker", async () => {
      renderPage();
      await timeline();
      const picker = screen.getByRole("combobox", { name: "Baseline" });
      expect(picker.compareDocumentPosition(toggle()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    test("a mistyped Jira date does not stretch the track: the bar is cut at the window and its name keeps the real dates", async () => {
      teamView = { ...TEAM_VIEW, scheduled: [milestone(1, "tv-a", { jira: link(1, "E2E-3", "2027-02-01", "2206-04-03") })] };
      renderPage();
      await timeline();
      const bar = document.querySelector('[data-tone="jira"]') as HTMLElement;
      expect(bar).toHaveAttribute("aria-label", expect.stringContaining("Jira E2E-3: 2027-02-01 to 2206-04-03"));
      // the plan ends 2027-02-05: the window ends a year later, so at 28 px a day the bar is about 10,000 px - not 2,000,000 px to the year 2206
      expect(parseFloat((bar.parentElement as HTMLElement).style.width)).toBeLessThan(12_000);
    });
  });
});
