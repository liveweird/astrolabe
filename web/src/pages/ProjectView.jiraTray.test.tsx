import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { screen, waitFor, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import ProjectView from "./ProjectView";
import type { Deviation } from "../api/deviations";
import type { ProjectMilestone, ProjectView as ProjectViewDocument } from "../api/milestones";
import type { JiraLink, PlanFlag } from "../api/roadmap";
import { DEV_CONNECTION, detail, evidence } from "../test/deviations";
import { jsonResponse } from "../test/http";
import { renderWithProviders } from "../test/render";

// The tray milestones that Jira dates (1.16) on the project page: an appended timeline row for their dashed Jira bar (`jira-unscheduled:<id>`), read from
// the project VIEW. The page's other Jira markers are `ProjectView.jira.test.tsx`.

const link = (bindingId: number, key: string, start: string | null = null, end: string | null = null): JiraLink => ({ bindingId, connectionId: DEV_CONNECTION.id, issueKey: key, start, end, rollup: null });
const unscheduledInPlan: Deviation = { kind: "UNSCHEDULED_IN_PLAN", severity: "INFO", detail: detail({ jira: "2027-03-01" }) };
const flag = (deviation: Deviation): PlanFlag => ({ kind: "JIRA_DEVIATION", severity: deviation.severity, deviation: evidence(deviation) });

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

const SITES = [{ connectionId: DEV_CONNECTION.id, siteUrl: DEV_CONNECTION.siteUrl, state: "CURRENT" as const, mappingOk: true }];
const DISCOVERY = milestone(1, "Discovery");
// Build: linked, Jira has both dates, so the Flags column exists and the scheduled row carries its own Jira bar.
const BUILD = milestone(2, "Build", { startDate: "2027-01-18", endDate: "2027-01-22", jira: link(6, "E2E-3", "2027-01-18", "2027-01-19") });

const viewOf = (over: Partial<ProjectViewDocument> = {}): ProjectViewDocument => ({
  revision: 10,
  jiraSites: SITES,
  project: {
    jira: null,
    flags: [],
    id: 7, programId: 70, workStreamId: 700, programName: "Billing", workStreamName: "Platform", name: "Invoices", description: null,
    ownerPersonId: 5, ownerName: "Ola Owner", targetStart: null, targetEnd: null, createdAt: 1, updatedAt: 2,
    can: { edit: true, delete: true, editTargetWindow: false, createMilestone: true, createDependency: false },
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

let project: ProjectViewDocument;
/** What an accepted schedule PUT does to the next read of the view (the stand-in server applies the dates). */
let afterSchedule: ((body: { startDate: string | null; endDate: string | null }) => void) | null;
/** The schedule PUTs the page sent (url and body), and what the stand-in server answers them (`null` = accept; `"hang"` = never answer). */
let puts: { url: string; body: { startDate: string | null; endDate: string | null; expectedRevision: number } }[];
let putAnswer: { status: number } | "hang" | null;

describe("the project page's tray milestones that Jira dates (1.16)", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        if (method === "GET" && url.startsWith("/api/v1/views/project/7")) return Promise.resolve(jsonResponse(200, project));
        if (method === "GET" && url === "/api/v1/baselines") return Promise.resolve(jsonResponse(200, { items: [], can: { manage: false } }));
        if (method === "GET" && url === "/api/v1/public-holidays") return Promise.resolve(jsonResponse(200, { items: [] }));
        if (method === "PUT" && /^\/api\/v1\/milestones\/\d+\/schedule$/.test(url)) {
          puts.push({ url, body: JSON.parse(init?.body as string) as (typeof puts)[number]["body"] });
          if (putAnswer === "hang") return new Promise<Response>(() => undefined);
          if (putAnswer !== null) return Promise.resolve(jsonResponse(putAnswer.status, { title: "x", status: putAnswer.status }));
          afterSchedule?.(JSON.parse(init?.body as string) as { startDate: string | null; endDate: string | null });
          return Promise.resolve(jsonResponse(200, { revision: 11 }));
        }
        return Promise.resolve(jsonResponse(404, { title: "Not Found", status: 404 }));
      }),
    );
    localStorage.setItem("astrolabe.auth.token", "fake-token");
    localStorage.setItem("astrolabe.auth.roles", JSON.stringify(["USER"]));
    project = viewOf();
    afterSchedule = null;
    puts = [];
    putAnswer = null;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });
  const renderPage = () => renderWithProviders(<Routes><Route path="/projects/:id" element={<ProjectView />} /></Routes>, { route: "/projects/7" });
  const timeline = () => screen.findByRole("grid", { name: "Milestone timeline" });
  const jiraBars = () => [...document.querySelectorAll('[data-tone="jira"]')].map((bar) => bar.getAttribute("aria-label"));
  const toggle = () => screen.getByRole("button", { name: "Jira dates" });

  const MARK = "(unscheduled; dates from Jira)";
  const trayMilestone = (id: number, name: string, over: Partial<ProjectMilestone> = {}) => milestone(id, name, { startDate: null, endDate: null, ...over });
  const ROLLOUT = trayMilestone(3, "Rollout", { jira: link(7, "E2E-8", "2027-03-01", "2027-03-05"), flags: [flag(unscheduledInPlan)] });
  /** The Jira bars other than Build's own (the scheduled, linked row every view here carries). */
  const trayBars = () => jiraBars().filter((name) => !name?.includes("E2E-3"));
  const appendedRows = (grid: HTMLElement) => within(grid).queryAllByRole("row").filter((row) => row.textContent?.includes(MARK));

  test("a tray milestone with both Jira dates has a dimmed row of its own with the mark and ONE dashed bar named with the key and the dates; its tray row and note are unchanged", async () => {
    project = viewOf({ unscheduled: [ROLLOUT] });
    renderPage();
    const grid = await timeline();
    const [row] = appendedRows(grid);
    expect(appendedRows(grid)).toHaveLength(1);
    expect(row).toHaveTextContent(`Rollout ${MARK}`);
    expect(row).toHaveTextContent("Backend");
    expect(row).toHaveTextContent("5 man-days");
    expect(trayBars()).toEqual(["Jira E2E-8: 2027-03-01 to 2027-03-05, read-only"]);
    expect([...row.querySelectorAll('[data-tone="jira"]')]).toHaveLength(1);
    // no menu, no Flags content, no key link: the row is the bar only, and its Flags cell is empty although the column exists (Build is linked)
    expect(within(grid).getByRole("columnheader", { name: "Flags" })).toBeInTheDocument();
    expect(row.querySelector("button")).toBeNull();
    expect(row.querySelector("a")).toBeNull();
    expect(row.querySelector("[data-flags]")).toBeNull();
    // it comes after the scheduled rows
    const texts = within(grid).getAllByRole("row").map((r) => r.textContent ?? "");
    expect(texts.findIndex((text) => text.includes(MARK))).toBeGreaterThan(texts.findIndex((text) => text.startsWith("Build")));
    // the tray row and its note are as before
    const tray = within(screen.getByRole("table", { name: "Unscheduled milestones" })).getByRole("row", { name: /Rollout/ });
    expect(tray).toHaveTextContent("Jira: 2027-03-01 to 2027-03-05");
    expect(within(tray).getByRole("link", { name: /E2E-8/ })).toBeInTheDocument();
  });

  test("nothing for one date, no dates, or a range wholly outside the window", async () => {
    project = viewOf({
      unscheduled: [
        trayMilestone(3, "OneDate", { jira: link(7, "E2E-8", "2027-03-01", null) }),
        trayMilestone(4, "NoDates", { jira: link(8, "E2E-9") }),
        trayMilestone(5, "Outside", { jira: link(9, "E2E-10", "2040-03-01", "2040-03-05") }),
        trayMilestone(6, "Unlinked"),
      ],
    });
    renderPage();
    const grid = await timeline();
    expect(trayBars()).toEqual([]);
    expect(appendedRows(grid)).toEqual([]);
  });

  test("the toggle off removes the row and the bar, on again brings them back", async () => {
    const user = userEvent.setup();
    project = viewOf({ unscheduled: [ROLLOUT] });
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

  test("the rows come in (start, end, name) order of the drawn Jira dates", async () => {
    project = viewOf({
      unscheduled: [
        trayMilestone(3, "Zeta", { jira: link(7, "E2E-8", "2027-03-01", "2027-03-05") }),
        trayMilestone(4, "Beta", { jira: link(8, "E2E-9", "2027-03-01", "2027-03-05") }),
        trayMilestone(5, "Early", { jira: link(9, "E2E-10", "2027-02-01", "2027-02-02") }),
      ],
    });
    renderPage();
    const grid = await timeline();
    expect(appendedRows(grid).map((row) => /^(\w+) /.exec(row.textContent ?? "")?.[1])).toEqual(["Early", "Beta", "Zeta"]);
  });

  test("the page's range follows the tray's Jira dates inside the window: the track grows to take the bar", async () => {
    const trackWidth = async () => {
      const grid = await timeline();
      return parseFloat(grid.style.width) - parseFloat(grid.style.getPropertyValue("--timeline-left"));
    };
    project = viewOf();
    const { unmount } = renderPage();
    const plain = await trackWidth();
    unmount();
    project = viewOf({ unscheduled: [trayMilestone(3, "Rollout", { jira: link(7, "E2E-8", "2027-12-06", "2027-12-10") })] });
    renderPage();
    await waitFor(() => expect(document.querySelector('[data-tone="jira"][aria-label*="E2E-8"]')).not.toBeNull());
    expect(await trackWidth()).toBeGreaterThan(plain);
  });

  test("a milestone the picked baseline had scheduled keeps its 'unscheduled since the baseline' row and gets the Jira bar on THAT row: one row, two bars; another gets a row of its own", async () => {
    localStorage.setItem("astrolabe.viewSettings.timeline.baseline", "5");
    const unchanged = { kind: "UNSCHEDULED" as const, startDays: null, endDays: null, estimateDelta: 0 };
    project = viewOf({
      unscheduled: [ROLLOUT, trayMilestone(4, "Cleanup", { jira: link(8, "E2E-9", "2027-03-08", "2027-03-09") })],
      baseline: {
        id: 5,
        name: "Q1 plan",
        planRevision: 4,
        project: { span: { start: "2027-01-04", end: "2027-01-22" }, movement: { kind: "UNCHANGED", startDays: 0, endDays: 0, estimateDelta: 0 } },
        milestones: [{ milestoneId: 3, teamIdThen: 3, start: "2027-02-01", end: "2027-02-05", estimateMd: 5, movement: unchanged }],
        removed: [],
      },
    });
    renderPage();
    const grid = await timeline();
    await waitFor(() => expect(within(grid).getAllByRole("row").some((row) => row.textContent?.includes("Rollout (unscheduled since the baseline)"))).toBe(true));
    const rows = within(grid).getAllByRole("row");
    expect(rows.filter((row) => row.textContent?.includes("Rollout"))).toHaveLength(1);
    const rollout = rows.find((row) => row.textContent?.includes("Rollout")) as HTMLElement;
    expect(within(rollout).getAllByRole("img").map((bar) => bar.getAttribute("data-tone"))).toEqual(["baseline", "jira"]);
    expect(rollout).not.toHaveTextContent(MARK);
    expect(appendedRows(grid).map((row) => row.textContent)).toEqual([expect.stringContaining(`Cleanup ${MARK}`)]);
    // the baseline's row comes first, then the row of its own
    expect(rows.indexOf(rollout)).toBeLessThan(rows.indexOf(appendedRows(grid)[0]));
  });

  test("scheduling the milestone (optimistic) removes the appended row and puts the one dashed bar on the milestone's own row", async () => {
    const user = userEvent.setup();
    const can = { edit: true, delete: true, schedule: true };
    project = viewOf({ unscheduled: [{ ...ROLLOUT, can }] });
    afterSchedule = (body) => {
      project = viewOf({ revision: 11, scheduled: [DISCOVERY, BUILD, { ...ROLLOUT, startDate: body.startDate, endDate: body.endDate, can }] });
    };
    renderPage();
    const grid = await timeline();
    expect(appendedRows(grid)).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Schedule Rollout" }));
    await waitFor(() => expect(appendedRows(grid)).toEqual([]));
    const own = within(grid).getByRole("row", { name: /Rollout/ });
    expect([...own.querySelectorAll('[data-tone="jira"]')]).toHaveLength(1);
    expect(trayBars()).toHaveLength(1);
  });

  describe("Schedule on Jira's dates (1.17)", () => {
    const can = { edit: true, delete: true, schedule: true };
    const SCHEDULER = { ...ROLLOUT, can };
    const kebab = (name: string) => screen.getByRole("button", { name: `Operations for ${name} (dates from Jira)` });
    const scheduledAfterPut = () => {
      afterSchedule = (body) => {
        project = viewOf({ revision: 11, scheduled: [DISCOVERY, BUILD, { ...SCHEDULER, startDate: body.startDate, endDate: body.endDate }] });
      };
    };

    test("the dashed row of a milestone the caller may schedule has a kebab named apart, holding ONE item named with the real dates; the tray row's kebab keeps its own name", async () => {
      const user = userEvent.setup();
      project = viewOf({ unscheduled: [SCHEDULER] });
      renderPage();
      const grid = await timeline();
      const [row] = appendedRows(grid);
      expect(within(row).getAllByRole("button")).toHaveLength(1);
      expect(screen.getByRole("button", { name: "Operations for Rollout" })).toBeInTheDocument();
      await user.click(kebab("Rollout"));
      const items = await screen.findAllByRole("menuitem");
      expect(items.map((item) => item.textContent)).toEqual(["Schedule on Jira's dates"]);
      expect(items[0]).toHaveAccessibleName("Schedule on Jira's dates: Rollout, 2027-03-01 to 2027-03-05");
    });

    test("the click writes Jira's two real dates with the view's revision; at once the dashed row is gone, the milestone's own row has its plan bar and ONE dashed bar, the page says so and the focus is on that row", async () => {
      const user = userEvent.setup();
      project = viewOf({ unscheduled: [SCHEDULER] });
      scheduledAfterPut();
      renderPage();
      const grid = await timeline();
      await user.click(kebab("Rollout"));
      await user.click(await screen.findByRole("menuitem", { name: /^Schedule on Jira's dates/ }));
      await waitFor(() => expect(appendedRows(grid)).toEqual([]));
      expect(puts).toEqual([{ url: "/api/v1/milestones/3/schedule", body: { startDate: "2027-03-01", endDate: "2027-03-05", expectedRevision: 10 } }]);
      const own = within(grid).getByRole("row", { name: /Rollout/ });
      expect(within(own).getByRole("button", { name: /^Rollout, Backend, 2027-03-01 to 2027-03-05/ })).toBeInTheDocument();
      expect([...own.querySelectorAll('[data-tone="jira"]')]).toHaveLength(1);
      expect(trayBars()).toHaveLength(1);
      expect(screen.getAllByRole("status").map((region) => region.textContent).join(" | ")).toContain("Rollout scheduled: 2027-03-01 to 2027-03-05");
      expect(screen.queryByRole("table", { name: "Unscheduled milestones" })).toBeNull();
      await waitFor(() => expect(own).toContainElement(document.activeElement as HTMLElement));
    });

    test("the real dates are written even when the bar is drawn cut at the window", async () => {
      const user = userEvent.setup();
      project = viewOf({ unscheduled: [{ ...SCHEDULER, jira: link(7, "E2E-8", "2027-03-01", "2090-03-05") }] });
      renderPage();
      await timeline();
      await user.click(kebab("Rollout"));
      await user.click(await screen.findByRole("menuitem", { name: /^Schedule on Jira's dates/ }));
      await waitFor(() => expect(puts).toHaveLength(1));
      expect(puts[0].body).toMatchObject({ startDate: "2027-03-01", endDate: "2090-03-05" });
    });

    test("a 400 rolls the change back (the dashed row and the tray row return) and shows the working-day sentence", async () => {
      const user = userEvent.setup();
      project = viewOf({ unscheduled: [SCHEDULER] });
      putAnswer = { status: 400 };
      renderPage();
      const grid = await timeline();
      await user.click(kebab("Rollout"));
      await user.click(await screen.findByRole("menuitem", { name: /^Schedule on Jira's dates/ }));
      expect((await screen.findAllByText(/These dates cannot be saved/)).length).toBeGreaterThan(0);
      await waitFor(() => expect(appendedRows(grid)).toHaveLength(1));
      expect(within(screen.getByRole("table", { name: "Unscheduled milestones" })).getByRole("row", { name: /Rollout/ })).toBeInTheDocument();
    });

    test("a click while a save runs is refused out loud and writes nothing", async () => {
      const user = userEvent.setup();
      const other = trayMilestone(4, "Cleanup", { jira: link(8, "E2E-9", "2027-03-08", "2027-03-09"), can });
      project = viewOf({ unscheduled: [SCHEDULER, other] });
      putAnswer = "hang";
      renderPage();
      await timeline();
      await user.click(kebab("Rollout"));
      await user.click(await screen.findByRole("menuitem", { name: /^Schedule on Jira's dates/ }));
      await waitFor(() => expect(puts).toHaveLength(1));
      await user.click(kebab("Cleanup"));
      await user.click(await screen.findByRole("menuitem", { name: /^Schedule on Jira's dates/ }));
      expect((await screen.findAllByText(/A save is still running/)).length).toBeGreaterThan(0);
      expect(puts).toHaveLength(1);
    });

    test("with a baseline picked the item sits on the 'unscheduled since the baseline' row", async () => {
      const user = userEvent.setup();
      localStorage.setItem("astrolabe.viewSettings.timeline.baseline", "5");
      const unchanged = { kind: "UNSCHEDULED" as const, startDays: null, endDays: null, estimateDelta: 0 };
      project = viewOf({
        unscheduled: [SCHEDULER],
        baseline: {
          id: 5,
          name: "Q1 plan",
          planRevision: 4,
          project: { span: { start: "2027-01-04", end: "2027-01-22" }, movement: { kind: "UNCHANGED", startDays: 0, endDays: 0, estimateDelta: 0 } },
          milestones: [{ milestoneId: 3, teamIdThen: 3, start: "2027-02-01", end: "2027-02-05", estimateMd: 5, movement: unchanged }],
          removed: [],
        },
      });
      renderPage();
      const grid = await timeline();
      const row = await waitFor(() => {
        const found = within(grid).getAllByRole("row").find((r) => r.textContent?.includes("Rollout (unscheduled since the baseline)"));
        expect(found).toBeDefined();
        return found as HTMLElement;
      });
      await user.click(within(row).getByRole("button", { name: "Operations for Rollout (dates from Jira)" }));
      await user.click(await screen.findByRole("menuitem", { name: /^Schedule on Jira's dates/ }));
      await waitFor(() => expect(puts).toHaveLength(1));
    });

    test("a reversed pair of Jira dates offers no item: the row has no button", async () => {
      project = viewOf({ unscheduled: [{ ...SCHEDULER, jira: link(7, "E2E-8", "2027-03-05", "2027-03-01") }] });
      renderPage();
      const grid = await timeline();
      const [row] = appendedRows(grid);
      expect(row.querySelector("button")).toBeNull();
    });

    test("without can.schedule on the milestone the row holds no button, whatever the project's other rights", async () => {
      project = viewOf({ unscheduled: [ROLLOUT] });
      renderPage();
      const grid = await timeline();
      expect(appendedRows(grid)[0].querySelector("button")).toBeNull();
      expect(screen.queryByRole("button", { name: /\(dates from Jira\)/ })).toBeNull();
    });
  });
});
