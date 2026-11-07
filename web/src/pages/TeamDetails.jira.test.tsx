import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { screen, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import TeamDetails from "./TeamDetails";
import type { Deviation } from "../api/deviations";
import type { JiraLink, PlanFlag } from "../api/roadmap";
import type { TeamMilestone, TeamView } from "../api/teams";
import { detail, endLater } from "../test/deviations";
import { headingOutline } from "../test/headings";
import { jsonResponse } from "../test/http";
import { renderWithProviders } from "../test/render";

// The Jira markers of the team page (1.3), all read from the team VIEW: the chip, the Flags column, the tray rows' icon and note, the shadow bars and
// their toggle. The page makes no request of its own for any of them.

const BARS_KEY = "astrolabe.viewSettings.timeline.jiraBars";

const link = (bindingId: number, key: string, start: string | null = null, end: string | null = null): JiraLink => ({ bindingId, connectionId: 1, issueKey: key, start, end });
const flag = (deviation: Deviation): PlanFlag => ({ kind: "JIRA_DEVIATION", severity: deviation.severity, days: null, teamId: null, otherProjectId: null, deviation, count: null });
const unscheduledInPlan: Deviation = { kind: "UNSCHEDULED_IN_PLAN", severity: "INFO", detail: detail({ jira: "2027-03-01", plan: null }) };

const milestone = (id: number, name: string, over: Partial<TeamMilestone> = {}): TeamMilestone => ({
  jira: null,
  flags: [],
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
  jiraSites: [{ connectionId: 1, siteUrl: "https://acme.atlassian.net" }],
  revision: 10,
  team: { id: 1, name: "Payments", description: null, managerPersonId: 12, managerName: "Cara New", createdAt: 1, updatedAt: 2, can: { schedule: false, editCapacity: false, editOrder: false } },
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

describe("the team page's Jira markers", () => {
  let mockFetch: FetchMock;
  beforeEach(() => {
    mockFetch = vi.fn((url: string) => {
      if (url === "/api/v1/views/team/1") return Promise.resolve(jsonResponse(200, teamView));
      if (url === "/api/v1/public-holidays") return Promise.resolve(jsonResponse(200, { items: [] }));
      return Promise.resolve(jsonResponse(404, { title: "Not Found", status: 404 }));
    });
    vi.stubGlobal("fetch", mockFetch);
    localStorage.setItem("astrolabe.auth.token", "fake-token");
    localStorage.setItem("astrolabe.auth.roles", JSON.stringify(["USER"]));
    teamView = TEAM_VIEW;
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
      teamView = { ...TEAM_VIEW, jiraSites: [{ connectionId: 1, siteUrl: "http://plain.example" }] };
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
