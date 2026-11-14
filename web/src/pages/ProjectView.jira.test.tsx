import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { screen, waitFor, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import ProjectView from "./ProjectView";
import type { Deviation } from "../api/deviations";
import type { ProjectMilestone, ProjectView as ProjectViewDocument } from "../api/milestones";
import type { JiraLink, PlanFlag } from "../api/roadmap";
import { DEV_CONNECTION, detail, endLater, evidence, view as deviationsView } from "../test/deviations";
import { jsonResponse } from "../test/http";
import { renderWithProviders } from "../test/render";

// The Jira markers of the project page (1.3), all read from the project VIEW: the chip, the Flags column, the tray rows' icon and note, the shadow bars
// and their toggle, the milestone menu's Link/Unlink item. The one request left is the bind dialog's `connections[]`, asked while it is open.

const BARS_KEY = "astrolabe.viewSettings.timeline.jiraBars";

const link = (bindingId: number, key: string, start: string | null = null, end: string | null = null): JiraLink => ({ bindingId, connectionId: DEV_CONNECTION.id, issueKey: key, start, end, rollup: null });
const flag = (deviation: Deviation, severity: PlanFlag["severity"] = deviation.severity): PlanFlag => ({ kind: "JIRA_DEVIATION", severity, deviation: evidence(deviation) });
const unscheduledInPlan: Deviation = { kind: "UNSCHEDULED_IN_PLAN", severity: "INFO", detail: detail({ jira: "2027-03-01" }) };

const milestone = (id: number, name: string, over: Partial<ProjectMilestone> = {}): ProjectMilestone => ({
  jira: null,
  flags: [],
  id,
  projectId: 7,
  name,
  description: null,
  teamId: 3,
  teamName: "Backend",
  estimateMd: 5,
  startDate: "2027-01-11",
  endDate: "2027-01-15",
  createdAt: 1,
  updatedAt: 2,
  slackDays: null,
  critical: false,
  pinned: false,
  can: { edit: true, delete: true, schedule: false },
  ...over,
});

const SITES = [{ connectionId: DEV_CONNECTION.id, siteUrl: DEV_CONNECTION.siteUrl }];
const projectCan = { edit: true, delete: true, editTargetWindow: false, createMilestone: true, createDependency: false };
const DISCOVERY = milestone(1, "Discovery");
// Build: linked, Jira has both dates (the end three working days earlier than the plan's), one open END deviation.
const BUILD = milestone(2, "Build", { startDate: "2027-01-18", endDate: "2027-01-22", jira: link(6, "E2E-3", "2027-01-18", "2027-01-19"), flags: [flag(endLater(3))] });

const viewOf = (over: Partial<ProjectViewDocument> = {}, can: Partial<ProjectViewDocument["project"]["can"]> = {}, projectJira: JiraLink | null = link(5, "E2E-1")): ProjectViewDocument => ({
  revision: 10,
  jiraSites: SITES,
  project: {
    jira: projectJira,
    flags: [],
    id: 7, programId: 70, workStreamId: 700, programName: "Billing", workStreamName: "Platform", name: "Invoices", description: null,
    ownerPersonId: 5, ownerName: "Ola Owner", targetStart: null, targetEnd: null, createdAt: 1, updatedAt: 2, can: { ...projectCan, ...can },
  },
  span: { start: "2027-01-11", end: "2027-01-22" },
  drift: null,
  scheduled: [DISCOVERY, BUILD],
  unscheduled: [],
  dependencies: [],
  idleGaps: [],
  criticalPath: { upstream: [], upstreamTruncated: false },
  ...over,
});

type FetchMock = ReturnType<typeof vi.fn>;
let project: ProjectViewDocument;
let deviations: { status: number; body: unknown };
let post: { status: number; body: unknown };
let del: { status: number };
/** What a successful unlink does to the next read of the view. */
let afterUnlink: (() => void) | null;

function serve(mockFetch: FetchMock) {
  mockFetch.mockImplementation((url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "GET" && url === "/api/v1/views/project/7") return Promise.resolve(jsonResponse(200, project));
    if (method === "GET" && url === "/api/v1/public-holidays") return Promise.resolve(jsonResponse(200, { items: [] }));
    if (method === "GET" && url === "/api/v1/views/deviations?projectId=7") return Promise.resolve(jsonResponse(deviations.status, deviations.body));
    if (method === "DELETE" && url.startsWith("/api/v1/integrations/jira/bindings/")) {
      if (del.status === 204) afterUnlink?.();
      return Promise.resolve(del.status === 204 ? new Response(null, { status: 204 }) : jsonResponse(del.status, { title: "x", status: del.status }));
    }
    if (method === "POST" && url === "/api/v1/integrations/jira/bindings") return Promise.resolve(jsonResponse(post.status, post.body));
    return Promise.resolve(jsonResponse(404, { title: "Not Found", status: 404 }));
  });
}

describe("the project page's Jira markers", () => {
  let mockFetch: FetchMock;
  const gets = (matcher: RegExp) => mockFetch.mock.calls.filter(([url, init]) => matcher.test(url as string) && ((init as RequestInit | undefined)?.method ?? "GET") === "GET").length;
  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    localStorage.setItem("astrolabe.auth.token", "fake-token");
    localStorage.setItem("astrolabe.auth.roles", JSON.stringify(["USER"]));
    project = viewOf();
    deviations = { status: 200, body: deviationsView({ items: [] }) };
    post = { status: 201, body: { id: 90 } };
    del = { status: 204 };
    afterUnlink = null;
    serve(mockFetch);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });
  const renderPage = () => renderWithProviders(<Routes><Route path="/projects/:id" element={<ProjectView />} /></Routes>, { route: "/projects/7" });
  const timeline = () => screen.findByRole("grid", { name: "Milestone timeline" });
  const jiraBars = () => [...document.querySelectorAll('[data-tone="jira"]')].map((bar) => bar.getAttribute("aria-label"));
  const toggle = () => screen.getByRole("button", { name: "Jira dates" });

  describe("the chip, from the view", () => {
    test("the facts line shows 'Jira: KEY' for the linked project, how many milestones are linked and the open-flag count, which opens the page filtered to the project - without asking the deviations list", async () => {
      renderPage();
      const group = await screen.findByRole("group", { name: "Links to Jira" });
      expect(within(group).getByRole("link", { name: /E2E-1/ })).toHaveAttribute("href", "https://acme.atlassian.net/browse/E2E-1");
      expect(within(group).getByText("1 milestone linked to Jira")).toBeInTheDocument();
      expect(within(group).getByRole("link", { name: "1 Jira deviation" })).toHaveAttribute("href", "/deviations?projectId=7");
      expect(within(screen.getByRole("group", { name: "Project facts" })).getByRole("group", { name: "Links to Jira" })).toBe(group);
      expect(gets(/views\/deviations/)).toBe(0);
    });

    test("the count is the project's own and the milestones' deviations; the JIRA_MILESTONES roll-up is not counted again", async () => {
      const rollUp: PlanFlag = { kind: "JIRA_MILESTONES", severity: "WARNING", count: 1 };
      project = viewOf();
      project.project.flags = [flag({ kind: "START_DIFFERS", severity: "INFO", detail: detail({ days: -1 }) }), rollUp];
      renderPage();
      expect(await screen.findByRole("link", { name: "2 Jira deviations" })).toHaveAttribute("href", "/deviations?projectId=7");
    });

    test("nothing is linked: no chip, no Flags column, no Jira toggle - and no request for the deviations", async () => {
      project = viewOf({ jiraSites: [], scheduled: [DISCOVERY, milestone(2, "Build", { startDate: "2027-01-18", endDate: "2027-01-22" })] }, {}, null);
      renderPage();
      const grid = await timeline();
      expect(screen.queryByRole("group", { name: "Links to Jira" })).not.toBeInTheDocument();
      expect(within(grid).queryByRole("columnheader", { name: "Flags" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Jira dates" })).not.toBeInTheDocument();
      expect(gets(/views\/deviations/)).toBe(0);
    });

    test("a linked project whose milestones are not: the key and a count, but no Flags column", async () => {
      project = viewOf({ scheduled: [DISCOVERY, milestone(2, "Build")] });
      renderPage();
      const grid = await timeline();
      const group = screen.getByRole("group", { name: "Links to Jira" });
      expect(within(group).getByRole("link", { name: /E2E-1/ })).toBeInTheDocument();
      expect(within(group).queryByText(/milestones? linked/)).not.toBeInTheDocument();
      expect(within(grid).queryByRole("columnheader", { name: "Flags" })).not.toBeInTheDocument();
    });
  });

  describe("the Flags column", () => {
    test("exists while a scheduled milestone is linked, before Operations: the row's icon, the sentences as its label; an unlinked row's cell is empty", async () => {
      renderPage();
      const grid = await timeline();
      expect(within(grid).getAllByRole("columnheader").map((header) => header.textContent)).toEqual(["Milestone", "Team", "Estimate", "Flags", "Operations"]);
      const build = within(grid).getByRole("row", { name: /Build/ });
      expect(build.querySelector("[data-flags]")).toHaveAttribute("data-flags", "1,0");
      expect(build).toHaveTextContent("Jira E2E-3: Ends 3 working days later than Jira (plan 2044-03-07, Jira 2044-03-04)");
      // the key is an external link out of the tab order, beside the icon
      expect(within(build).getByRole("link", { name: /E2E-3/ })).toHaveAttribute("href", "https://acme.atlassian.net/browse/E2E-3");
      expect(within(build).getByRole("link", { name: /E2E-3/ })).toHaveAttribute("tabindex", "-1");
      const discovery = within(grid).getByRole("row", { name: /Discovery/ });
      expect(discovery.querySelector("[data-flags]")).toBeNull();
      expect(within(discovery).queryByRole("link", { name: /E2E-/ })).not.toBeInTheDocument();
    });

    test("a linked row with a roll-up shows it after the key, its name the sentence; a row without one shows only the key (1.4)", async () => {
      const rollup = { children: 12, done: 5, points: 34, observedAt: 1 };
      project = viewOf({ scheduled: [DISCOVERY, { ...BUILD, jira: { ...link(6, "E2E-3", "2027-01-18", "2027-01-19"), rollup } }, { ...DISCOVERY, id: 9, name: "Plain", jira: link(9, "E2E-9") }] });
      renderPage();
      const grid = await timeline();
      const build = within(grid).getByRole("row", { name: /Build/ });
      expect(within(build).getByText("5/12 · 34 pt")).toBeInTheDocument();
      expect(within(build).getByText("12 child issues in Jira, done: 5, story points: 34")).toBeInTheDocument();
      expect(build.querySelector("[data-flags]")).toHaveAttribute("data-flags", "1,0");
      const plain = within(grid).getByRole("row", { name: /Plain/ });
      expect(plain).toHaveTextContent("E2E-9");
      expect(plain).not.toHaveTextContent("child issues");
    });

    test("a clean or acknowledged linked row (no open flag) shows its key link, told apart from an unlinked one, and no icon", async () => {
      project = viewOf({ scheduled: [DISCOVERY, { ...BUILD, flags: [] }] });
      renderPage();
      const grid = await timeline();
      expect(within(grid).getByRole("columnheader", { name: "Flags" })).toBeInTheDocument();
      const build = within(grid).getByRole("row", { name: /Build/ });
      expect(within(build).getByRole("link", { name: /E2E-3/ })).toHaveAttribute("href", "https://acme.atlassian.net/browse/E2E-3");
      expect(build).toHaveTextContent("Linked to Jira: E2E-3");
      expect(grid.querySelector("[data-flags]")).toBeNull();
    });

    test("the key is a link only for an https site: a site that is not https (or unknown) leaves plain text", async () => {
      project = viewOf({ jiraSites: [{ connectionId: DEV_CONNECTION.id, siteUrl: "http://plain.example" }] });
      renderPage();
      const grid = await timeline();
      const build = within(grid).getByRole("row", { name: /Build/ });
      expect(within(build).queryByRole("link", { name: /E2E-3/ })).not.toBeInTheDocument();
      expect(build).toHaveTextContent("E2E-3");
    });

    test("the Slack column of the critical-path toggle sits after Flags, and Operations stays the last", async () => {
      localStorage.setItem("astrolabe.viewSettings.timeline.criticalPath", "true");
      renderPage();
      const grid = await timeline();
      expect(within(grid).getAllByRole("columnheader").map((header) => header.textContent)).toEqual(["Milestone", "Team", "Estimate", "Flags", "Slack", "Operations"]);
    });
  });

  describe("the Unscheduled tray", () => {
    const tray = () => screen.getByRole("table", { name: "Unscheduled milestones" });
    const trayMilestone = (id: number, name: string, over: Partial<ProjectMilestone> = {}) => milestone(id, name, { startDate: null, endDate: null, ...over });

    test("a row whose Jira item has dates the plan lacks shows the flag icon beside the name and 'Jira: start to end'; the tray has no Flags column", async () => {
      project = viewOf({
        unscheduled: [
          trayMilestone(3, "Rollout", { jira: link(7, "E2E-8", "2027-03-01", "2027-03-05"), flags: [flag(unscheduledInPlan)] }),
          trayMilestone(4, "Cleanup", { jira: link(8, "E2E-9", "2027-04-01", "2027-04-02"), flags: [flag(endLater(2))] }),
          trayMilestone(5, "Docs"),
        ],
      });
      renderPage();
      await timeline();
      const rollout = within(tray()).getByRole("row", { name: /Rollout/ });
      expect(rollout).toHaveTextContent("Jira: 2027-03-01 to 2027-03-05");
      expect(rollout.querySelector("[data-flags]")).toHaveAttribute("data-flags", "0,1");
      expect(rollout).toHaveTextContent("Jira E2E-8: Jira has dates, but the plan item is not scheduled");
      // the key is a link in the name cell, clean linked rows included
      expect(within(rollout).getByRole("link", { name: /E2E-8/ })).toHaveAttribute("href", "https://acme.atlassian.net/browse/E2E-8");
      // another deviation: the icon, not the note
      const cleanup = within(tray()).getByRole("row", { name: /Cleanup/ });
      expect(cleanup.querySelector("[data-flags]")).toHaveAttribute("data-flags", "1,0");
      expect(cleanup).not.toHaveTextContent("Jira: 2027-04-01");
      // an unlinked row is as it was
      expect(within(tray()).getByRole("row", { name: /Docs/ }).querySelector("[data-flags]")).toBeNull();
      expect(within(tray()).getByRole("row", { name: /Docs/ }).querySelector("a")).toBeNull();
      expect(within(tray()).queryByRole("columnheader", { name: "Flags" })).not.toBeInTheDocument();
    });

    test("an acknowledged deviation is no flag, so its note goes with it; a tray row alone does not create the timeline's Flags column", async () => {
      project = viewOf({ scheduled: [DISCOVERY], unscheduled: [trayMilestone(3, "Rollout", { jira: link(7, "E2E-8", "2027-03-01", "2027-03-05"), flags: [] })] });
      renderPage();
      const grid = await timeline();
      expect(within(tray()).getByRole("row", { name: /Rollout/ })).not.toHaveTextContent("Jira: 2027-03-01");
      expect(within(grid).queryByRole("columnheader", { name: "Flags" })).not.toBeInTheDocument();
    });
  });

  describe("a binding through a disabled connection", () => {
    // The server keeps the link (the page can show and unlink it, and never offers a second one) with null dates and no flag.
    const disabledBuild = { ...BUILD, jira: link(6, "E2E-3"), flags: [] };

    test("still counts as linked: the chip counts it with no deviations, the row has its key, the menu offers Unlink (never Link) and no bar is drawn", async () => {
      project = viewOf({ scheduled: [DISCOVERY, disabledBuild] }, {}, null);
      const user = userEvent.setup();
      renderPage();
      const group = await screen.findByRole("group", { name: "Links to Jira" });
      expect(within(group).getByText("1 milestone linked to Jira")).toBeInTheDocument();
      expect(within(group).getByRole("link", { name: "No deviations seen" })).toBeInTheDocument();
      expect(within(screen.getByRole("row", { name: /Build/ })).getByRole("link", { name: /E2E-3/ })).toBeInTheDocument();
      expect(jiraBars()).toEqual([]);
      await user.click(screen.getByRole("button", { name: "Operations for Build" }));
      expect(await screen.findByRole("menuitem", { name: "Unlink from Jira: E2E-3 (Build)" })).toBeEnabled();
      expect(screen.queryByRole("menuitem", { name: /Link to Jira…/ })).not.toBeInTheDocument();
    });

    test("the Unlink goes to that binding", async () => {
      project = viewOf({ scheduled: [DISCOVERY, disabledBuild] }, {}, null);
      const user = userEvent.setup();
      renderPage();
      await screen.findByRole("group", { name: "Links to Jira" });
      await user.click(screen.getByRole("button", { name: "Operations for Build" }));
      await user.click(await screen.findByRole("menuitem", { name: "Unlink from Jira: E2E-3 (Build)" }));
      await user.click(within(await screen.findByRole("dialog", { name: "Unlink from Jira?" })).getByRole("button", { name: "Unlink" }));
      await waitFor(() => expect(mockFetch.mock.calls.some(([url, init]) => url === "/api/v1/integrations/jira/bindings/6" && (init as RequestInit).method === "DELETE")).toBe(true));
    });
  });

  describe("the Jira dates", () => {
    test("on by default: one dashed shadow bar for the scheduled, linked row with both dates, named with the key, the real dates and the date deviation, riding in its row", async () => {
      renderPage();
      await timeline();
      expect(toggle()).toHaveAttribute("aria-pressed", "true");
      expect(jiraBars()).toEqual(["Jira E2E-3: 2027-01-18 to 2027-01-19, Ends 3 working days later than Jira (plan 2044-03-07, Jira 2044-03-04), read-only"]);
      const row = screen.getByRole("row", { name: /Build/ });
      expect([...row.querySelectorAll("[data-tone]")].map((el) => el.getAttribute("data-tone"))).toEqual(["jira"]);
      expect(localStorage.getItem(BARS_KEY)).toBeNull();
    });

    test("a date deviation's sentence is appended to the bar's name", async () => {
      const dated: Deviation = { kind: "END_DIFFERS", severity: "WARNING", detail: detail({ jira: "2027-01-19", plan: "2027-01-22", days: 3 }) };
      project = viewOf({ scheduled: [DISCOVERY, { ...BUILD, flags: [flag(dated)] }] });
      renderPage();
      await timeline();
      expect(jiraBars()).toEqual(["Jira E2E-3: 2027-01-18 to 2027-01-19, Ends 3 working days later than Jira (plan 2027-01-22, Jira 2027-01-19), read-only"]);
    });

    test("the toggle hides the bars and remembers it; a later visit starts hidden, and showing again draws them", async () => {
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

    test("a link with only one date, or a tray row, draws no bar", async () => {
      project = viewOf({
        scheduled: [DISCOVERY, { ...BUILD, jira: link(6, "E2E-3", "2027-01-18", null) }],
        unscheduled: [milestone(3, "Rollout", { startDate: null, endDate: null, jira: link(7, "E2E-8", "2027-03-01", "2027-03-05") })],
      });
      renderPage();
      await timeline();
      expect(jiraBars()).toEqual([]);
    });

    test("the toggle sits in the timeline's toolbar after the critical-path toggle", async () => {
      renderPage();
      await timeline();
      const critical = screen.getByRole("button", { name: "Critical path" });
      expect(critical.compareDocumentPosition(toggle()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    test("a mistyped Jira date does not stretch the track: the bar is cut at the window and its name keeps the real dates", async () => {
      project = viewOf({ scheduled: [DISCOVERY, { ...BUILD, jira: link(6, "E2E-3", "2027-01-18", "2206-04-03") }] });
      renderPage();
      await timeline();
      const bar = document.querySelector('[data-tone="jira"]') as HTMLElement;
      expect(bar).toHaveAttribute("aria-label", expect.stringContaining("Jira E2E-3: 2027-01-18 to 2206-04-03"));
      // the plan ends 2027-01-22: the window ends a year later, so at 28 px a day the bar is a little over 10,000 px - not 2,000,000 px to the year 2206
      expect(parseFloat((bar.parentElement as HTMLElement).style.width)).toBeLessThan(12_000);
    });
  });

  describe("linking and unlinking, with what the view says is linked", () => {
    test("a milestone's menu offers the link with its own can.edit; a linked one offers Unlink instead, and the milestone dialog has the node fixed", async () => {
      const user = userEvent.setup();
      renderPage();
      await timeline();
      await user.click(screen.getByRole("button", { name: "Operations for Build" }));
      // Linked and editable: not the link, but the unlink.
      expect(await screen.findByRole("menuitem", { name: "Unlink from Jira: E2E-3 (Build)" })).toBeEnabled();
      expect(screen.queryByRole("menuitem", { name: /Link to Jira…/ })).not.toBeInTheDocument();
      await user.keyboard("{Escape}");
      expect(gets(/views\/deviations/)).toBe(0);
      await user.click(screen.getByRole("button", { name: "Operations for Discovery" }));
      await user.click(await screen.findByRole("menuitem", { name: "Link to Jira…: Discovery" }));
      const dialog = await screen.findByRole("dialog", { name: "Link to Jira" });
      // The dialog is what asks for the connections to offer, and only now.
      await waitFor(() => expect(gets(/views\/deviations\?projectId=7/)).toBe(1));
      expect(await within(dialog).findByRole("textbox", { name: "Plan item" })).toHaveValue("Discovery");
      expect(within(dialog).queryByRole("combobox", { name: "Plan item type" })).not.toBeInTheDocument();
      await user.type(within(dialog).getByRole("textbox", { name: "Jira issue key" }), "e2e-9");
      await user.click(within(dialog).getByRole("button", { name: "Link" }));
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "Link to Jira" })).not.toBeInTheDocument());
      const posted = mockFetch.mock.calls.find(([url, init]) => url === "/api/v1/integrations/jira/bindings" && (init as RequestInit).method === "POST");
      expect(JSON.parse((posted?.[1] as RequestInit).body as string)).toEqual({ connectionId: DEV_CONNECTION.id, level: "MILESTONE", nodeId: 1, issueKey: "E2E-9" });
    });

    test("the header offers 'Link to Jira…' with the project's can.edit while the view says the project is not linked, and no Unlink", async () => {
      project = viewOf({}, {}, null);
      renderPage();
      expect(await screen.findByRole("button", { name: "Link to Jira…" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Unlink from Jira" })).not.toBeInTheDocument();
    });

    test("a project already linked has no Link button, at once; a viewer without can.edit (a team manager who owns nothing here) sees none and no milestone link item either", async () => {
      const first = renderPage();
      expect(await screen.findByRole("button", { name: "Unlink from Jira" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Link to Jira…" })).not.toBeInTheDocument();
      first.unmount();

      project = viewOf({ scheduled: [milestone(1, "Discovery", { can: { edit: false, delete: false, schedule: true } })] }, { edit: false }, null);
      renderPage();
      await screen.findByRole("heading", { level: 2, name: "Invoices" });
      expect(screen.queryByRole("button", { name: /Link to Jira|Unlink from Jira/ })).not.toBeInTheDocument();
      await userEvent.setup().click(screen.getByRole("button", { name: "Operations for Discovery" }));
      expect(screen.queryByRole("menuitem", { name: /Link to Jira/ })).not.toBeInTheDocument();
    });

    test("linking refreshes the Jira queries AND the project view (it carries the link's flags and bar)", async () => {
      project = viewOf({}, {}, null);
      const user = userEvent.setup();
      renderPage();
      await user.click(await screen.findByRole("button", { name: "Link to Jira…" }));
      const dialog = await screen.findByRole("dialog", { name: "Link to Jira" });
      await user.type(await within(dialog).findByRole("textbox", { name: "Jira issue key" }), "E2E-1");
      const viewReads = gets(/views\/project\/7$/);
      project = viewOf();
      await user.click(within(dialog).getByRole("button", { name: "Link" }));
      await waitFor(() => expect(gets(/views\/project\/7$/)).toBeGreaterThan(viewReads));
      // the chip appears from the re-read view
      expect(await screen.findByRole("group", { name: "Links to Jira" })).toBeInTheDocument();
      const posted = mockFetch.mock.calls.find(([url, init]) => url === "/api/v1/integrations/jira/bindings" && (init as RequestInit).method === "POST");
      expect(JSON.parse((posted?.[1] as RequestInit).body as string)).toMatchObject({ level: "PROJECT", nodeId: 7 });
    });

    test("a failed connections request is the dialog's own inline note with a Retry, and the page is untouched", async () => {
      project = viewOf({}, {}, null);
      deviations = { status: 500, body: { title: "x", status: 500 } };
      const user = userEvent.setup();
      renderPage();
      await user.click(await screen.findByRole("button", { name: "Link to Jira…" }));
      const dialog = await screen.findByRole("dialog", { name: "Link to Jira" });
      await within(dialog).findByRole("button", { name: "Retry" });
      expect(screen.getByRole("grid", { name: "Milestone timeline" })).toBeInTheDocument();
    });

    test("the refused link (409 already-bound) stays in the dialog on the project page", async () => {
      project = viewOf({}, {}, null);
      post = { status: 409, body: { type: "urn:astrolabe:problem:already-bound", title: "Conflict", status: 409, detail: "E2E-1 is already linked to project Other" } };
      const user = userEvent.setup();
      renderPage();
      await user.click(await screen.findByRole("button", { name: "Link to Jira…" }));
      const dialog = await screen.findByRole("dialog", { name: "Link to Jira" });
      await user.type(await within(dialog).findByRole("textbox", { name: "Jira issue key" }), "E2E-1");
      await user.click(within(dialog).getByRole("button", { name: "Link" }));
      expect(await within(dialog).findByText("E2E-1 is already linked to project Other")).toBeInTheDocument();
      expect(within(dialog).getByRole("textbox", { name: "Jira issue key" })).toHaveValue("E2E-1");
    });

    const unlinkCalls = () => mockFetch.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "DELETE").map(([url]) => url as string);

    test("the owner unlinks the project from the header: confirm names the item and the key, DELETEs that binding, re-reads the view (which then drops the chip), focus goes to the heading", async () => {
      const user = userEvent.setup();
      renderPage();
      await user.click(await screen.findByRole("button", { name: "Unlink from Jira" }));
      const dialog = await screen.findByRole("dialog", { name: "Unlink from Jira?" });
      expect(within(dialog).getByText(/Invoices will no longer be linked to E2E-1/)).toBeInTheDocument();
      const viewReads = gets(/views\/project\/7$/);
      afterUnlink = () => {
        project = viewOf({}, {}, null);
      };
      await user.click(within(dialog).getByRole("button", { name: "Unlink" }));
      await waitFor(() => expect(unlinkCalls()).toEqual(["/api/v1/integrations/jira/bindings/5"]));
      await waitFor(() => expect(screen.getByRole("button", { name: "Link to Jira…" })).toBeInTheDocument());
      await waitFor(() => expect(gets(/views\/project\/7$/)).toBeGreaterThan(viewReads));
      await waitFor(() => expect(screen.getByRole("heading", { level: 2, name: "Invoices" })).toHaveFocus());
      expect(gets(/views\/deviations/)).toBe(0);
    });

    test("the owner unlinks a milestone from its row menu (the right binding id), and a refusal (403) or a vanished link (404) stays inline", async () => {
      const user = userEvent.setup();
      del = { status: 403 };
      renderPage();
      await timeline();
      await user.click(screen.getByRole("button", { name: "Operations for Build" }));
      await user.click(await screen.findByRole("menuitem", { name: "Unlink from Jira: E2E-3 (Build)" }));
      const dialog = await screen.findByRole("dialog", { name: "Unlink from Jira?" });
      expect(within(dialog).getByText(/Build will no longer be linked to E2E-3/)).toBeInTheDocument();
      await user.click(within(dialog).getByRole("button", { name: "Unlink" }));
      expect(await within(dialog).findByText("Only the item's owners and administrators can unlink it.")).toBeInTheDocument();
      del = { status: 404 };
      await user.click(within(dialog).getByRole("button", { name: "Unlink" }));
      expect(await within(dialog).findByText("This link no longer exists.")).toBeInTheDocument();
      expect(unlinkCalls()).toEqual(["/api/v1/integrations/jira/bindings/6", "/api/v1/integrations/jira/bindings/6"]);
    });

    test("a team manager who owns nothing here sees no unlink - only the linked milestone's key, disabled", async () => {
      project = viewOf({ scheduled: [milestone(1, "Discovery", { can: { edit: false, delete: false, schedule: true }, jira: link(7, "E2E-8") })] }, { edit: false });
      const user = userEvent.setup();
      renderPage();
      await screen.findByRole("group", { name: "Links to Jira" });
      expect(screen.queryByRole("button", { name: /Unlink from Jira|Link to Jira/ })).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Operations for Discovery" }));
      expect(await screen.findByRole("menuitem", { name: "Linked to Jira: E2E-8 (Discovery)" })).toHaveAttribute("data-disabled", "true");
      expect(screen.queryByRole("menuitem", { name: /Unlink from Jira/ })).not.toBeInTheDocument();
    });
  });
});

