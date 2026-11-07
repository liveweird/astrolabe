// Axe accessibility smoke: WCAG 2.0/2.1 A+AA scans over the login screen, the authenticated list
// and form pages, the detail pages of one API-seeded fixture team, and the overlays (a registry
// editor modal) — where focus traps, aria-modal and labels actually live, and the app shell at a
// phone width (the burger); the page sets run in the light scheme and again in the dark one.
// Owns: the fixture team and the fixture plan (a person, work stream, program and project with two milestones, one scheduled past the
// project's target end and one in the Unscheduled tray, plus a second project with one milestone linked as the fixture milestone's
// violated predecessor, plus a chain project of two back-to-back milestones whose second one drives the fixture milestone (the zero-slack
// links of the critical path); unique `e2e-axe-*` names), created and deleted via the API. The fixture team carries one capacity period with a
// WIP limit of 1 (deleted with the team), so its page shows the strip's overload and WIP marks. The open-schedule-proposal scans (the last describe)
// own their own team pair and plan (unique `e2e-axe-prop-*` names, all dated in 2042), created and deleted via the API. The baseline scans (the very last
// describe) own a team, a plan and one baseline of their own (unique `e2e-axe-bl-*` names, dated in 2026), created and deleted via the API; the
// baseline is soft-deleted FIRST in the afterAll, so the stack holds none of it afterwards.
// The Jira pages (the very last describe) own a team, a plan, a Jira connection scoped to the stub's `E2E` project and one binding of their own (unique
// `e2e-axe-jira-*` names, dated in 2044), created and deleted via the API; the connection is deleted FIRST in the afterAll (its binding goes with it).
import type { APIRequestContext, Locator, Page } from "@playwright/test";
import {
  apiAsAdmin,
  axeViolations,
  deleteViaApi,
  expect,
  expectScheme,
  login,
  openFilters,
  rowOperation,
  type Scheme,
  test,
  uniqueText,
  updateRankingViaApi,
} from "./helpers";

// No waivers: the theme's text/dimmed/ink tokens are AA-tested in web/src/theme.test.ts, so
// the color-contrast rule runs for real here . Fix a
// finding at the token level — never by patching single elements.
async function scan(page: Page, include?: string): Promise<void> {
  // Keep the assert readable on failure: one line per violation with the offending nodes.
  expect(await axeViolations(page, include)).toEqual([]);
}

/**
 * A chain project of two milestones back to back (c0 2026-01-26..30, c1 2026-02-02..06) and finish-to-start links c0 -> c1 -> the fixture
 * milestone (which starts the next Monday): every link holds with no spare day, so the fixture project's critical path has a driving
 * neighbour (c1, a ghost row) and a member beyond it (c0, the Critical chain list) - the violated link of the fixture stays off the path.
 * Answers the chain project's id; `track` is told the project's delete path the moment it exists (its milestones and links go with it), so a
 * failure further down still leaves the caller something to clean up.
 */
async function seedChain(
  api: APIRequestContext,
  fixture: { programId: number; personId: number; teamId: number; projectId: number; scheduledId: number },
  track: (deletePath: string) => void,
): Promise<number> {
  async function create(path: string, data: object): Promise<number> {
    const created = await api.post(path, { data });
    expect(created.status(), await created.text()).toBe(201);
    return ((await created.json()) as { id: number }).id;
  }
  const chainProjectId = await create(`/api/v1/programs/${fixture.programId}/projects`, { name: uniqueText("e2e-axe-chain"), ownerPersonId: fixture.personId });
  track(`/api/v1/projects/${chainProjectId}`);
  const chainStart = await create(`/api/v1/projects/${chainProjectId}/milestones`, { name: uniqueText("e2e-axe-chain-a"), teamId: fixture.teamId, estimateMd: 1 });
  const chainEnd = await create(`/api/v1/projects/${chainProjectId}/milestones`, { name: uniqueText("e2e-axe-chain-b"), teamId: fixture.teamId, estimateMd: 1 });
  for (const [id, startDate, endDate] of [[chainStart, "2026-01-26", "2026-01-30"], [chainEnd, "2026-02-02", "2026-02-06"]] as const) {
    const view = (await (await api.get(`/api/v1/views/project/${chainProjectId}`)).json()) as { revision: number };
    const placed = await api.put(`/api/v1/milestones/${id}/schedule`, { data: { expectedRevision: view.revision, startDate, endDate } });
    expect(placed.status(), await placed.text()).toBe(200);
  }
  await create(`/api/v1/projects/${chainProjectId}/dependencies`, { predecessor: { kind: "MILESTONE", id: chainStart }, successor: { kind: "MILESTONE", id: chainEnd }, type: "FS", lagDays: 0 });
  await create(`/api/v1/projects/${fixture.projectId}/dependencies`, { predecessor: { kind: "MILESTONE", id: chainEnd }, successor: { kind: "MILESTONE", id: fixture.scheduledId }, type: "FS", lagDays: 0 });
  return chainProjectId;
}

test("login screen has no WCAG A/AA violations", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  await scan(page);
});

// One test per page keeps the report line-per-page.
const AUTHED_PAGES: { path: string; heading: string }[] = [
  { path: "/", heading: "Astrolabe" },
  { path: "/teams", heading: "Teams" },
  { path: "/people", heading: "People" },
  { path: "/public-holidays", heading: "Public holidays" },
  { path: "/users", heading: "Users" },
  { path: "/users/new", heading: "New user" },
  { path: "/feature-flags", heading: "Feature flags" },
  { path: "/change-password", heading: "Change password" },
  { path: "/changelog", heading: "Changelog" },
];

// The light pass keeps its original titles; the dark pass (Playwright's `colorScheme: "dark"`, which
// the app's `auto` default follows) repeats the set under a suffix, so a finding names its scheme.
function registerAuthedPageScans(scheme: Scheme): void {
  const suffix = scheme === "dark" ? " in the dark scheme" : "";
  for (const { path, heading } of AUTHED_PAGES) {
    test(`${path} has no WCAG A/AA violations${suffix}`, async ({ page }) => {
      await login(page);
      await page.goto(path);
      // The page title is the first heading.
      await expect(page.getByRole("heading", { name: heading }).first()).toBeVisible();
      await expectScheme(page, scheme);
      await scan(page);
    });
  }
}
registerAuthedPageScans("light");
test.describe("dark scheme", () => {
  test.use({ colorScheme: "dark" });
  registerAuthedPageScans("dark");
  test("login screen has no WCAG A/AA violations in the dark scheme", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
    await expectScheme(page, "dark");
    await scan(page);
  });
});

// The app shell at a phone width (390x844): the desktop rail toggle gives way to the burger — the
// one control that opens the nav drawer — so the shell is scanned with it present, light and dark.
function registerMobileShellScan(scheme: Scheme): void {
  const suffix = scheme === "dark" ? " in the dark scheme" : "";
  test(`the app shell at a mobile width has no WCAG A/AA violations${suffix}`, async ({ page }) => {
    await login(page);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Astrolabe" }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Toggle navigation" })).toBeVisible();
    await expectScheme(page, scheme);
    await scan(page);
  });
}
test.describe("mobile width", () => {
  test.use({ viewport: { width: 390, height: 844 } });
  registerMobileShellScan("light");
  test.describe("dark scheme", () => {
    test.use({ colorScheme: "dark" });
    registerMobileShellScan("dark");
  });
});

test.describe("detail pages and overlays", () => {
  let api: APIRequestContext;
  let adminId: number;
  let teamId: number;
  let teamName: string;
  let programName: string;
  let otherProgramName: string;
  let streamName: string;
  // The fixture's delete paths in CREATION order, each registered the moment its row exists (a failing beforeAll still cleans up what it made);
  // the afterAll deletes them in reverse, children first (a parent with active children answers 409).
  const fixturePaths: string[] = [];
  let projectId: number;
  let projectName: string;
  let linkedProjectId: number;
  let linkedProjectName: string;
  let fixtureProgramId: number;
  let proposalTeamId: number; // the open-proposal world (seedProposalWorld), for the hovered-row scan
  let proposalTeamName: string;

  /** POST a row; `tear` is its collection path when the row needs its own delete (a milestone, capacity period or link goes with its parent). */
  async function create(path: string, data: object, tear?: string): Promise<number> {
    const created = await api.post(path, { data });
    expect(created.status(), await created.text()).toBe(201);
    const id = (await created.json() as { id: number }).id;
    if (tear !== undefined) fixturePaths.push(`${tear}/${id}`);
    return id;
  }

  test.beforeAll(async () => {
    ({ api, userId: adminId } = await apiAsAdmin());
    teamName = uniqueText("e2e-axe-team");
    teamId = await create("/api/v1/teams", { name: teamName }, "/api/v1/teams");
    // A capacity period with a WIP limit of 1 (and a capacity far below the load): the team page's strip then carries both warnings
    // wherever the fixture milestones overlap (the team's two milestones below sit on the same days in March), and the team's
    // delete takes the period with it.
    await create(`/api/v1/teams/${teamId}/capacity`, { effectiveFrom: "2026-02-02", mdPerWeek: 0.5, wipLimit: 1 });
    // One of each plan level so the Plan page renders a work stream, a program and a project row.
    streamName = uniqueText("e2e-axe-stream");
    programName = uniqueText("e2e-axe-program");
    const personId = await create("/api/v1/people", { name: uniqueText("e2e-axe-owner") }, "/api/v1/people");
    const streamId = await create("/api/v1/work-streams", { name: streamName, ownerPersonId: personId, startDate: "2026-01-05" }, "/api/v1/work-streams");
    const programId = await create(`/api/v1/work-streams/${streamId}/programs`, { name: programName, ownerPersonId: personId }, "/api/v1/programs");
    fixtureProgramId = programId;
    // A second program, so the "Move to…" dialog has a target to offer.
    otherProgramName = uniqueText("e2e-axe-program-other");
    await create(`/api/v1/work-streams/${streamId}/programs`, { name: otherProgramName, ownerPersonId: personId }, "/api/v1/programs");
    projectName = uniqueText("e2e-axe-project");
    projectId = await create(`/api/v1/programs/${programId}/projects`, {
      name: projectName,
      ownerPersonId: personId,
      targetStart: "2026-02-02",
      targetEnd: "2026-03-31",
    }, "/api/v1/projects");
    // The project view's richest state: a scheduled bar (editable for the admin) running past the target end (the orange drift) and a tray row.
    const scheduledId = await create(`/api/v1/projects/${projectId}/milestones`, { name: uniqueText("e2e-axe-milestone"), teamId, estimateMd: 3 });
    await create(`/api/v1/projects/${projectId}/milestones`, { name: uniqueText("e2e-axe-tray"), teamId, estimateMd: 0.5 });
    const view = (await (await api.get(`/api/v1/views/project/${projectId}`)).json()) as { revision: number };
    const scheduled = await api.put(`/api/v1/milestones/${scheduledId}/schedule`, {
      data: { expectedRevision: view.revision, startDate: "2026-02-09", endDate: "2026-04-10" },
    });
    expect(scheduled.status(), await scheduled.text()).toBe(200);
    // A second project whose milestone ends AFTER the fixture milestone starts, and a finish-to-start link from it: the fixture project
    // then shows the dependencies in their richest state (a violated row, the red conflicts badge, a ghost row and a red arrow).
    linkedProjectName = uniqueText("e2e-axe-linked");
    linkedProjectId = await create(`/api/v1/programs/${programId}/projects`, { name: linkedProjectName, ownerPersonId: personId }, "/api/v1/projects");
    const linkedId = await create(`/api/v1/projects/${linkedProjectId}/milestones`, { name: uniqueText("e2e-axe-predecessor"), teamId, estimateMd: 1 });
    const linkedView = (await (await api.get(`/api/v1/views/project/${linkedProjectId}`)).json()) as { revision: number };
    const linkedScheduled = await api.put(`/api/v1/milestones/${linkedId}/schedule`, {
      data: { expectedRevision: linkedView.revision, startDate: "2026-03-02", endDate: "2026-03-06" },
    });
    expect(linkedScheduled.status(), await linkedScheduled.text()).toBe(200);
    await create(`/api/v1/projects/${projectId}/dependencies`, {
      predecessor: { kind: "MILESTONE", id: linkedId },
      successor: { kind: "MILESTONE", id: scheduledId },
      type: "FS",
      lagDays: 0,
    });
    await seedChain(api, { programId, personId, teamId, projectId, scheduledId }, (path) => fixturePaths.push(path));
    ({ teamId: proposalTeamId, teamName: proposalTeamName } = await seedProposalWorld(api, (path) => fixturePaths.push(path)));
  });
  test.afterAll(async () => {
    try {
      await deleteViaApi(fixturePaths.splice(0).reverse());
    } finally {
      await api?.dispose();
    }
  });

  const DETAIL_PAGES: { name: string; path: () => string; settled: (page: Page) => Locator }[] = [
    { name: "the team page", path: () => `/teams/${teamId}`, settled: (p) => p.getByRole("heading", { name: teamName }) },
    { name: "the edit-user page", path: () => `/users/${adminId}/edit`, settled: (p) => p.getByRole("heading", { name: "Edit user" }) },
    { name: "the user-features page", path: () => `/users/${adminId}/features`, settled: (p) => p.getByRole("heading", { name: "Feature flags" }) },
  ];
  for (const { name, path, settled } of DETAIL_PAGES) {
    test(`${name} has no WCAG A/AA violations`, async ({ page }) => {
      await login(page);
      await page.goto(path());
      await expect(settled(page)).toBeVisible();
      await scan(page);
    });
  }

  // The Plan page with a work stream, a program and a project rendered (the empty page is a subset), light and dark.
  function registerPlanScan(scheme: Scheme): void {
    const suffix = scheme === "dark" ? " in the dark scheme" : "";
    test(`/plan with a work stream, a program and a project has no WCAG A/AA violations${suffix}`, async ({ page }) => {
      await login(page);
      await page.goto("/plan");
      await expect(page.getByRole("heading", { level: 4, name: programName })).toBeVisible();
      await expectScheme(page, scheme);
      await scan(page);
    });
  }
  registerPlanScan("light");
  test.describe("dark scheme", () => {
    test.use({ colorScheme: "dark" });
    registerPlanScan("dark");
  });

  // The project view: the shared timeline grid (bars with handles, the window band, the orange drift badge, the weekend hatch), the
  // dependencies (a red arrow, a ghost row, the red conflicts badge, the Dependencies table with a violated row) and the Unscheduled tray, light and dark.
  function registerProjectViewScan(scheme: Scheme): void {
    const suffix = scheme === "dark" ? " in the dark scheme" : "";
    test(`/projects/:id with a scheduled milestone, the drift and the tray has no WCAG A/AA violations${suffix}`, async ({ page }) => {
      await login(page);
      await page.goto(`/projects/${projectId}`);
      await expect(page.getByRole("heading", { level: 2, name: projectName })).toBeVisible();
      await expect(page.getByRole("grid", { name: "Milestone timeline" })).toBeVisible();
      await expect(page.getByText("Ends 10 days after the target")).toBeVisible();
      await expect(page.getByText("1 conflict", { exact: true })).toBeVisible();
      await expect(page.getByRole("table", { name: "Dependencies of the project" }).getByRole("row")).toHaveCount(3); // the header, the violated link and the chain link
      await expect(page.locator('[data-arrow][data-violated="true"]')).toHaveCount(1);
      await expect(page.getByRole("link", { name: new RegExp(`open project ${linkedProjectName}$`) })).toBeVisible();
      await expectScheme(page, scheme);
      await scan(page);
    });
  }
  registerProjectViewScan("light");
  test.describe("dark scheme", () => {
    test.use({ colorScheme: "dark" });
    registerProjectViewScan("dark");
  });

  // The project view with the critical-path toggle ON: the pressed toggle, the Slack column (a critical row, a ghost row's "—"), the emphasised
  // bars and the heavier arrow, the gray "Critical path" badge, the Critical chain table (the chain member beyond the neighbour) and the
  // Idle gaps section's closed disclosure, light and dark. The toggle is a browser setting, so the stored flag is set before the page loads.
  function registerCriticalPathScan(scheme: Scheme): void {
    const suffix = scheme === "dark" ? " in the dark scheme" : "";
    test(`/projects/:id with the critical path on has no WCAG A/AA violations${suffix}`, async ({ page }) => {
      await login(page);
      await page.evaluate(([key, value]) => localStorage.setItem(key, value), ["astrolabe.viewSettings.timeline.criticalPath", "true"]);
      await page.goto(`/projects/${projectId}`);
      await expect(page.getByRole("heading", { level: 2, name: projectName })).toBeVisible();
      await expect(page.getByRole("button", { name: "Critical path", exact: true })).toHaveAttribute("aria-pressed", "true");
      await expect(page.getByRole("grid", { name: "Milestone timeline" }).getByRole("columnheader", { name: "Slack" })).toBeVisible();
      await expect(page.locator('[data-arrow][data-critical="true"]')).toHaveCount(1);
      await expect(page.getByRole("heading", { level: 3, name: "Critical chain" })).toBeVisible();
      await expect(page.getByRole("table", { name: "Critical chain members in other projects" })).toBeVisible();
      await expectScheme(page, scheme);
      await scan(page);
    });
  }
  registerCriticalPathScan("light");
  test.describe("dark scheme", () => {
    test.use({ colorScheme: "dark" });
    registerCriticalPathScan("dark");
  });

  // The team view: the sticky load strip with both marks (the overloaded column, the dashed WIP chip), the orange and red badges on the facts
  // line, the Capacity table (with its WIP limit), the EXPANDED weekly table with its status badges, the arrows, light and dark.
  function registerTeamViewScan(scheme: Scheme): void {
    const suffix = scheme === "dark" ? " in the dark scheme" : "";
    test(`/teams/:id with the weekly load strip, both warnings and the weekly table has no WCAG A/AA violations${suffix}`, async ({ page }) => {
      await login(page);
      await page.goto(`/teams/${teamId}`);
      await expect(page.getByRole("heading", { level: 2, name: teamName })).toBeVisible();
      await expect(page.getByRole("grid", { name: "Team milestone timeline" })).toBeVisible();
      const facts = page.getByRole("group", { name: "Team facts" });
      await expect(facts).toContainText(/weeks? overloaded/);
      await expect(facts).toContainText(/weeks? over WIP limit/);
      await expect(facts).toContainText("1 conflict");
      await expect(page.locator('[data-week][data-overloaded="true"]').first()).toBeAttached();
      await expect(page.locator('[data-week][data-wip-exceeded="true"]').first()).toBeAttached();
      await expect(page.getByRole("table", { name: "Capacity periods of the team" }).getByRole("row")).toHaveCount(2);
      await page.getByRole("button", { name: "Show the weekly figures" }).click();
      await expect(page.getByRole("table", { name: "Weekly load of the team" })).toBeVisible();
      await expectScheme(page, scheme);
      await scan(page);
    });
  }
  registerTeamViewScan("light");
  test.describe("dark scheme", () => {
    test.use({ colorScheme: "dark" });
    registerTeamViewScan("dark");
  });

  // The hovered-row scans (registerHoveredRowScan, below) ride this fixture.
  const hoverFixture = (): HoverFixture => ({ projectId, teamId, teamName, proposalTeamId, proposalTeamName });
  registerHoveredRowScan("light", hoverFixture);
  test.describe("dark scheme", () => {
    test.use({ colorScheme: "dark" });
    registerHoveredRowScan("dark", hoverFixture);
  });

  // The Roadmap timeline with the fixture project and the linked one in the ranked rows (row handles and menus, the drift flag icon, the
  // violated milestone link's bundle arrow) and the flag panel open, light and dark. The projects are ranked only for the scan and unranked
  // again, so the shared ranking is as the other specs expect it.
  function registerRoadmapScan(scheme: Scheme): void {
    const suffix = scheme === "dark" ? " in the dark scheme" : "";
    test(`/roadmap with a ranked project has no WCAG A/AA violations${suffix}`, async ({ page }) => {
      await updateRankingViaApi(api, (ranked) => [...ranked, projectId, linkedProjectId]);
      try {
        await login(page);
        // The program pick (a browser setting) narrows the page to the fixture program: a stack that holds more than 80 projects (the sample
        // plan) virtualises the grid, and the fixture rows - ranked last - would not be mounted.
        await page.evaluate(([key, value]) => localStorage.setItem(key, value), ["astrolabe.viewSettings.planning.programPick", JSON.stringify([fixtureProgramId])]);
        await page.goto("/roadmap");
        await expect(page.getByRole("link", { name: `Open ${projectName}`, exact: true })).toBeVisible();
        await expect(page.getByRole("grid", { name: "Roadmap timeline" })).toBeVisible();
        await page.getByRole("button", { name: /^Show the \d+ flags?$/ }).click();
        await expect(page.getByRole("table", { name: "Flags of the projects shown" })).toBeVisible();
        await expectScheme(page, scheme);
        await scan(page);
      } finally {
        await updateRankingViaApi(api, (ranked) => ranked.filter((id) => id !== projectId && id !== linkedProjectId));
      }
    });
  }
  registerRoadmapScan("light");
  test.describe("dark scheme", () => {
    test.use({ colorScheme: "dark" });
    registerRoadmapScan("dark");
  });

  // The Programs tree with the fixture program opened (the chevron buttons with aria-expanded, a program's summary bar and roll-up count, the
  // project rows with their bars, the drift flag icon, the row menus and the bundle arrow between the two fixture projects), light and dark.
  function registerProgramsScan(scheme: Scheme): void {
    const suffix = scheme === "dark" ? " in the dark scheme" : "";
    test(`/programs with a program opened has no WCAG A/AA violations${suffix}`, async ({ page }) => {
      await login(page);
      // The program pick (a browser setting) narrows the page to the fixture program: a stack that holds the sample plan has hundreds of nodes
      // and an unfolded grid over 80 rows virtualises.
      await page.evaluate(([key, value]) => localStorage.setItem(key, value), ["astrolabe.viewSettings.planning.programPick", JSON.stringify([fixtureProgramId])]);
      await page.goto("/programs");
      await expect(page.getByRole("grid", { name: "Programs timeline" })).toBeVisible();
      await page.getByRole("button", { name: `Program ${programName}`, exact: true }).click();
      await expect(page.getByRole("link", { name: `Open ${projectName}`, exact: true })).toBeVisible();
      await expect(page.getByRole("link", { name: `Open ${linkedProjectName}`, exact: true })).toBeVisible();
      await expect(page.locator('[data-arrow][data-violated="true"]')).toHaveCount(1);
      await expectScheme(page, scheme);
      await scan(page);
    });
  }
  registerProgramsScan("light");
  test.describe("dark scheme", () => {
    test.use({ colorScheme: "dark" });
    registerProgramsScan("dark");
  });

  test("the reset-password page has no WCAG A/AA violations", async ({ page }) => {
    await page.goto("/reset-password");
    await expect(page.getByRole("heading", { name: "Reset password" })).toBeVisible();
    await scan(page);
    // The emailed link's page (the form state of a well-formed token; nothing is submitted, so nothing is consumed).
    await page.goto(`/reset-password/confirm#token=${"a".repeat(43)}`);
    await expect(page.getByRole("button", { name: "Set new password" })).toBeVisible();
    await scan(page);
  });

  test("the not-found page has no WCAG A/AA violations", async ({ page }) => {
    await login(page);
    await page.goto(`/${uniqueText("nowhere")}`);
    await expect(page.getByRole("heading").first()).toBeVisible();
    await scan(page);
  });

  // Overlays are scanned scoped to the dialog: the page behind them is inert, and the dialog is
  // where a missing label, a broken focus trap or a contrast slip would hide from the page sweep.
  // `toBeVisible` passes mid-transition; axe measures contrast against the fade-in's partial
  // opacity, so the scan waits for the dialog to settle at full opacity.
  async function settledDialog(page: Page): Promise<Locator> {
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveCSS("opacity", "1");
    return dialog;
  }

  test("a team editor modal has no WCAG A/AA violations", async ({ page }) => {
    await login(page);
    await page.goto("/teams");
    await page.getByRole("button", { name: "New team" }).click();
    const modal = await settledDialog(page);
    await expect(modal.getByRole("heading", { name: "New team" })).toBeVisible();
    await scan(page, '[role="dialog"]');
  });

  test("a milestone editor modal (team picker, estimate) has no WCAG A/AA violations", async ({ page }) => {
    await login(page);
    await page.goto(`/projects/${projectId}`);
    await page.getByRole("button", { name: "New milestone" }).click();
    const modal = await settledDialog(page);
    await expect(modal.getByRole("heading", { name: "New milestone" })).toBeVisible();
    await scan(page, '[role="dialog"]');
  });

  test("a dependency editor modal (successor, kind toggle, predecessor picker, type, lag) has no WCAG A/AA violations", async ({ page }) => {
    await login(page);
    await page.goto(`/projects/${projectId}`);
    await page.getByRole("button", { name: "Add dependency", exact: true }).click();
    const modal = await settledDialog(page);
    await expect(modal.getByRole("heading", { name: "Add dependency" })).toBeVisible();
    await scan(page, '[role="dialog"]');
    // The predecessor picker's open option list (the milestones of every project).
    await modal.getByRole("combobox", { name: "Predecessor" }).click();
    await expect(page.getByRole("option").first()).toBeVisible();
    await scan(page, '[role="listbox"]');
  });

  test("a capacity period modal (date, man-days, WIP limit) has no WCAG A/AA violations", async ({ page }) => {
    await login(page);
    await page.goto(`/teams/${teamId}`);
    await page.getByRole("button", { name: "Add period" }).click();
    const modal = await settledDialog(page);
    await expect(modal.getByRole("heading", { name: "Add a capacity period" })).toBeVisible();
    await scan(page, '[role="dialog"]');
  });

  test("a plan project editor modal (dates, fieldset, owner picker) has no WCAG A/AA violations", async ({ page }) => {
    await login(page);
    await page.goto("/plan");
    await page.getByRole("button", { name: `New project in ${programName}` }).click();
    const modal = await settledDialog(page);
    await expect(modal.getByRole("heading", { name: "New project" })).toBeVisible();
    await scan(page, '[role="dialog"]');
  });

  test("a plan move modal (grouped program select, open options) has no WCAG A/AA violations", async ({ page }) => {
    await login(page);
    await page.goto("/plan");
    await rowOperation(page, projectName, `Move ${projectName} to another program`);
    const modal = await settledDialog(page);
    await expect(modal.getByRole("heading", { name: "Move project" })).toBeVisible();
    await scan(page, '[role="dialog"]');
    await modal.getByRole("combobox", { name: "New program" }).click();
    await expect(page.getByRole("option", { name: otherProgramName })).toBeVisible();
    await scan(page, '[role="listbox"]');
  });
});

// The row under the pointer: Mantine's hover tint replaces the row background, and axe measures the computed styles, so the scan of a hovered
// row checks every ink of that row on the theme's tint (web/src/theme.test.ts chooses it). One row per table kind: the Users list (body and
// dimmed text), the project's Dependencies table (the violated row: a red badge, dimmed text), the team's expanded Weekly load table (an
// orange "Overloaded" verdict) and the Proposed schedule table of an open proposal (the checkbox column, the badges, the links column).
interface HoverFixture {
  projectId: number;
  teamId: number;
  teamName: string;
  proposalTeamId: number;
  proposalTeamName: string;
}

function registerHoveredRowScan(scheme: Scheme, fixture: () => HoverFixture): void {
  const suffix = scheme === "dark" ? " in the dark scheme" : "";
  test(`the hovered rows of the Users, Dependencies, Weekly load and Proposed schedule tables have no WCAG A/AA violations${suffix}`, async ({ page }) => {
    const { projectId, teamId, teamName, proposalTeamId, proposalTeamName } = fixture();
    await login(page);
    await page.goto("/users");
    const users = page.getByRole("table", { name: "Users", exact: true });
    const adminRow = users.getByRole("row").filter({ hasText: "admin@astrolabe.local" }); // a real data row, not a loading skeleton
    await expect(adminRow).toBeVisible();
    await adminRow.hover();
    await expectScheme(page, scheme);
    await scan(page);

    await page.goto(`/projects/${projectId}`);
    const dependencies = page.getByRole("table", { name: "Dependencies of the project" });
    await expect(dependencies.getByRole("row")).toHaveCount(3); // the header, the violated link and the chain link
    await dependencies.getByRole("row").nth(1).hover(); // violated links come first
    await scan(page);

    await page.goto(`/teams/${teamId}`);
    await expect(page.getByRole("heading", { level: 2, name: teamName })).toBeVisible();
    await page.getByRole("button", { name: "Show the weekly figures" }).click();
    const weekly = page.getByRole("table", { name: "Weekly load of the team" });
    const overloaded = weekly.getByRole("row").filter({ hasText: "Overloaded" }).first();
    await expect(overloaded).toBeVisible();
    await overloaded.hover();
    await scan(page);

    await page.goto(`/teams/${proposalTeamId}`);
    await expect(page.getByRole("heading", { level: 2, name: proposalTeamName })).toBeVisible();
    await page.getByRole("button", { name: "Propose schedule" }).click();
    const proposed = page.getByRole("table", { name: "Proposed schedule moves" });
    await expect(proposed.getByRole("row")).toHaveCount(3); // the header and the two moves
    // The row whose Links cell says "would violate" (the red ink of the table): the scan must hover THAT row.
    const violating = proposed.getByRole("row").filter({ hasText: "would violate" });
    await expect(violating).toHaveCount(1);
    await violating.hover();
    await expect(violating.getByText(/would violate/)).toBeVisible();
    await scan(page);
  });
}

/** The open-proposal world (below): both teams, the plan and the links; every delete path is handed to `track` the moment its row exists. */
async function seedProposalWorld(api: APIRequestContext, track: (deletePath: string) => void): Promise<{ teamId: number; teamName: string }> {
  async function create(path: string, data: object, tear?: string): Promise<number> {
    const created = await api.post(path, { data });
    expect(created.status(), await created.text()).toBe(201);
    const id = ((await created.json()) as { id: number }).id;
    if (tear !== undefined) track(`${tear}/${id}`);
    return id;
  }

  async function schedule(milestoneId: number, ofTeamId: number, startDate: string, endDate: string): Promise<void> {
    const view = (await (await api.get(`/api/v1/views/team/${ofTeamId}`)).json()) as { revision: number };
    const written = await api.put(`/api/v1/milestones/${milestoneId}/schedule`, { data: { expectedRevision: view.revision, startDate, endDate } });
    expect(written.status(), await written.text()).toBe(200);
  }

  const teamName = uniqueText("e2e-axe-prop-team");
  const teamId = await create("/api/v1/teams", { name: teamName }, "/api/v1/teams");
  const otherTeamId = await create("/api/v1/teams", { name: uniqueText("e2e-axe-prop-other") }, "/api/v1/teams");
  await create(`/api/v1/teams/${teamId}/capacity`, { effectiveFrom: "2042-01-06", mdPerWeek: 10, wipLimit: 2 });
  const personId = await create("/api/v1/people", { name: uniqueText("e2e-axe-prop-owner") }, "/api/v1/people");
  const streamId = await create("/api/v1/work-streams", { name: uniqueText("e2e-axe-prop-stream"), ownerPersonId: personId, startDate: "2026-01-05" }, "/api/v1/work-streams");
  const programId = await create(`/api/v1/work-streams/${streamId}/programs`, { name: uniqueText("e2e-axe-prop-program"), ownerPersonId: personId }, "/api/v1/programs");
  const projectId = await create(`/api/v1/programs/${programId}/projects`, { name: uniqueText("e2e-axe-prop-project"), ownerPersonId: personId }, "/api/v1/projects");
  const milestone = (label: string, owningTeamId: number, estimateMd: number) =>
    create(`/api/v1/projects/${projectId}/milestones`, { name: uniqueText(`e2e-axe-prop-${label}`), teamId: owningTeamId, estimateMd });
  const p1 = await milestone("p1", teamId, 6);
  const p2 = await milestone("p2", teamId, 2);
  const w = await milestone("w", otherTeamId, 1);
  const x = await milestone("x", otherTeamId, 1);
  await schedule(p2, teamId, "2042-03-03", "2042-03-04");
  await schedule(w, otherTeamId, "2042-01-12", "2042-01-13");
  await schedule(x, otherTeamId, "2042-03-10", "2042-03-11");
  for (const [from, to] of [[p1, w], [x, p2]]) {
    await create(`/api/v1/projects/${projectId}/dependencies`, {
      predecessor: { kind: "MILESTONE", id: from },
      successor: { kind: "MILESTONE", id: to },
      type: "FS",
      lagDays: 0,
    });
  }
  return { teamId, teamName };
}

// The team page with an OPEN schedule proposal (v0.8): the dashed proposal bars, the Proposed schedule section (the summary line, the table with its
// checkboxes and the select-all, the badges, the links column with a conflict and a resolved link, the Accept/Discard buttons), light and dark.
// Its own world, in 2042 (no other spec writes a holiday there; the page's range stretches to it, which is why it does not ride the fixture team):
// team T (the one proposed for) has its first capacity period on Monday 2042-01-06 (10 MD/week, WIP limit 2), `p1` 6 MD unscheduled and `p2` 2 MD
// at 2042-03-03..04; team X (fixed for the proposal) holds `w` 2042-01-12..13 and `x` 2042-03-10..11. Links `p1 -> w` and `x -> p2` (finish-to-start):
// p1 lands on 01-06..01-13 and ends after w starts (a link the proposal would violate), p2 waits for x and moves to 03-12..03-13 (a violated link it resolves).
// Owns: that team pair, a person, a work stream, a program, a project, four milestones and two links (unique `e2e-axe-prop-*` names), created and deleted via the API.
test.describe("an open schedule proposal", () => {
  let api: APIRequestContext;
  let teamId: number;
  let teamName: string;
  const paths: string[] = []; // delete paths in creation order, registered the moment each row exists; the afterAll deletes them in reverse

  test.beforeAll(async () => {
    ({ api } = await apiAsAdmin());
    ({ teamId, teamName } = await seedProposalWorld(api, (path) => paths.push(path)));
  });
  test.afterAll(async () => {
    try {
      await deleteViaApi(paths.splice(0).reverse());
    } finally {
      await api?.dispose();
    }
  });

  function registerProposalScan(scheme: Scheme): void {
    const suffix = scheme === "dark" ? " in the dark scheme" : "";
    test(`/teams/:id with an open schedule proposal has no WCAG A/AA violations${suffix}`, async ({ page }) => {
      await login(page);
      await page.goto(`/teams/${teamId}`);
      await expect(page.getByRole("heading", { level: 2, name: teamName })).toBeVisible();
      await expect(page.getByRole("grid", { name: "Team milestone timeline" })).toBeVisible();
      await page.getByRole("button", { name: "Propose schedule" }).click();
      const table = page.getByRole("table", { name: "Proposed schedule moves" });
      await expect(table).toBeVisible();
      await expect(table.getByRole("row")).toHaveCount(3); // the header and the two moves
      await expect(table.getByRole("checkbox", { name: "Accept all" })).toBeChecked();
      await expect(page.locator('[data-tone="proposal"]')).toHaveCount(2);
      // The badges and the links column say it in words: one link the proposal would violate, one violated link it resolves.
      await expect(page.getByText("1 link would be violated")).toBeVisible();
      await expect(table.getByText("Conflict", { exact: true })).toBeVisible();
      await expect(table.getByText(/^resolves: link with /)).toBeVisible();
      await expect(page.getByRole("button", { name: "Accept selected (2)" })).toBeEnabled();
      await expect(page.getByRole("button", { name: "Discard" })).toBeEnabled();
      // The pointer still rests where the Propose button was, over the section: hover a table row on purpose, so the scan covers the row the
      // pointer sits on (the theme's hover tint once dropped the "would violate" red below AA).
      await table.getByRole("row").nth(1).hover();
      await expectScheme(page, scheme);
      await scan(page);
    });
  }
  registerProposalScan("light");
  test.describe("dark scheme", () => {
    test.use({ colorScheme: "dark" });
    registerProposalScan("dark");
  });
});

// The baselines (v0.9): the registry with a row, the comparison page and the team page with a baseline picked. One world of its own (the plan is
// copied whole, so the baseline is taken AFTER the world exists, and then the plan moves under it): team T with `s1` 2026-02-02..06 (moves a week
// later: the orange "Later" badge and a +5 figure), `s2` 2026-02-09..13 (is unscheduled afterwards: an appended "unscheduled since the baseline" row
// with its shadow bar only), `s4` 2026-02-16..20 (is deleted: an appended "(removed)" row), and `s3` 2026-02-23..27 created after it ("New"). Three
// shadow bars (`s1`'s own, the two appended rows'), the Movement table open. The pick is a browser setting, set in the test's own browser context.
// Owns: that world (a team, a person, a work stream, a program, a project and four milestones; unique `e2e-axe-bl-*` names) and one baseline
// (`e2e-axe-bl-*`, taken in the beforeAll, soft-deleted first in the afterAll; baselines are shared state, so nothing here counts rows).
test.describe("a baseline on the plan", () => {
  let api: APIRequestContext;
  let teamId: number;
  let teamName: string;
  let projectName: string;
  let projectId: number;
  let programId: number;
  let baselineId: number;
  let baselineName: string;
  let scheduledName: string;
  let removedName: string;
  const paths: string[] = []; // delete paths in creation order (the baseline last); the afterAll deletes them in reverse

  async function create(path: string, data: object, tear?: string): Promise<number> {
    const created = await api.post(path, { data });
    expect(created.status(), await created.text()).toBe(201);
    const id = ((await created.json()) as { id: number }).id;
    if (tear !== undefined) paths.push(`${tear}/${id}`);
    return id;
  }

  async function place(milestoneId: number, startDate: string | null, endDate: string | null): Promise<void> {
    const view = (await (await api.get(`/api/v1/views/team/${teamId}`)).json()) as { revision: number };
    const written = await api.put(`/api/v1/milestones/${milestoneId}/schedule`, { data: { expectedRevision: view.revision, startDate, endDate } });
    expect(written.status(), await written.text()).toBe(200);
  }

  test.beforeAll(async () => {
    ({ api } = await apiAsAdmin());
    teamName = uniqueText("e2e-axe-bl-team");
    teamId = await create("/api/v1/teams", { name: teamName }, "/api/v1/teams");
    const personId = await create("/api/v1/people", { name: uniqueText("e2e-axe-bl-owner") }, "/api/v1/people");
    const streamId = await create("/api/v1/work-streams", { name: uniqueText("e2e-axe-bl-stream"), ownerPersonId: personId, startDate: "2026-01-05" }, "/api/v1/work-streams");
    programId = await create(`/api/v1/work-streams/${streamId}/programs`, { name: uniqueText("e2e-axe-bl-program"), ownerPersonId: personId }, "/api/v1/programs");
    projectName = uniqueText("e2e-axe-bl-project");
    projectId = await create(`/api/v1/programs/${programId}/projects`, { name: projectName, ownerPersonId: personId }, "/api/v1/projects");
    const milestone = (label: string, estimateMd: number) => {
      const name = uniqueText(`e2e-axe-bl-${label}`);
      return create(`/api/v1/projects/${projectId}/milestones`, { name, teamId, estimateMd }).then((id) => ({ id, name }));
    };
    const s1 = await milestone("s1", 3);
    const s2 = await milestone("s2", 2);
    const s4 = await milestone("s4", 1);
    scheduledName = s1.name;
    removedName = s4.name;
    await place(s1.id, "2026-02-02", "2026-02-06");
    await place(s2.id, "2026-02-09", "2026-02-13");
    await place(s4.id, "2026-02-16", "2026-02-20");
    baselineName = uniqueText("e2e-axe-bl-baseline");
    baselineId = await create("/api/v1/baselines", { name: baselineName }, "/api/v1/baselines");
    // The plan moves under the baseline.
    await place(s1.id, "2026-02-09", "2026-02-13");
    await place(s2.id, null, null);
    expect((await api.delete(`/api/v1/milestones/${s4.id}`)).status()).toBe(204);
    const s3 = await milestone("s3", 2);
    await place(s3.id, "2026-02-23", "2026-02-27");
  });
  test.afterAll(async () => {
    try {
      await deleteViaApi(paths.splice(0).reverse());
    } finally {
      await api?.dispose();
    }
  });

  function registerBaselineScans(scheme: Scheme): void {
    const suffix = scheme === "dark" ? " in the dark scheme" : "";
    test(`/baselines with a row has no WCAG A/AA violations${suffix}`, async ({ page }) => {
      await login(page);
      await page.goto("/baselines");
      await expect(page.getByRole("heading", { level: 2, name: "Baselines" })).toBeVisible();
      await expect(page.getByRole("link", { name: `Compare ${baselineName} with the plan` })).toBeVisible();
      await expect(page.getByRole("button", { name: "Take baseline", exact: true })).toBeVisible();
      await expectScheme(page, scheme);
      await scan(page);
    });

    test(`/baselines/:id has no WCAG A/AA violations${suffix}`, async ({ page }) => {
      await login(page);
      await page.goto(`/baselines/${baselineId}`);
      await expect(page.getByRole("heading", { level: 2, name: baselineName })).toBeVisible();
      // The project filter narrows the table to the fixture project (the stack may hold other specs' rows or the sample plan).
      await page.getByLabel("Project", { exact: true }).fill(projectName);
      const projectRow = page.getByRole("row").filter({ has: page.getByRole("link", { name: `Open project ${projectName}` }) });
      await expect(projectRow).toBeVisible();
      await expect(projectRow).toContainText("Later");
      await expect(page.getByRole("row").filter({ hasText: removedName }).getByText("Removed", { exact: true })).toBeVisible();
      await expectScheme(page, scheme);
      await scan(page);
    });

    test(`/teams/:id with a baseline picked has no WCAG A/AA violations${suffix}`, async ({ page }) => {
      await login(page);
      // The pick (a browser setting) is stored before the page loads, as the picker would have stored it.
      await page.evaluate(([key, value]) => localStorage.setItem(key, value), ["astrolabe.viewSettings.timeline.baseline", String(baselineId)]);
      await page.goto(`/teams/${teamId}`);
      await expect(page.getByRole("heading", { level: 2, name: teamName })).toBeVisible();
      await expect(page.getByRole("grid", { name: "Team milestone timeline" })).toBeVisible();
      await expect(page.getByLabel("Baseline", { exact: true })).toHaveValue(new RegExp(baselineName));
      // The shadow bars: the moved milestone's own, and the two appended rows' (unscheduled and removed since the baseline).
      await expect(page.locator('[data-tone="baseline"]')).toHaveCount(3);
      await expect(page.getByText("(unscheduled since the baseline)")).toBeVisible();
      await expect(page.getByText("(removed)")).toBeVisible();
      await page.getByRole("button", { name: "Show the movement" }).click();
      const movement = page.getByRole("table", { name: "Movement since the baseline" });
      await expect(movement.getByRole("row").filter({ hasText: scheduledName }).getByText("Later", { exact: true })).toBeVisible();
      await expectScheme(page, scheme);
      await scan(page);
    });

    // The pick (a browser setting) is stored before the page loads, as the picker would have stored it; the program pick narrows a stack that
    // holds the sample plan (more than 80 projects virtualise the grid) to the fixture program.
    const pickBaselineAndProgram = async (page: Page): Promise<void> => {
      await page.evaluate(
        ([baselineKey, baseline, programKey, program]) => {
          localStorage.setItem(baselineKey, baseline);
          localStorage.setItem(programKey, program);
        },
        ["astrolabe.viewSettings.timeline.baseline", String(baselineId), "astrolabe.viewSettings.planning.programPick", JSON.stringify([programId])],
      );
    };

    test(`/roadmap with a baseline picked has no WCAG A/AA violations${suffix}`, async ({ page }) => {
      await login(page);
      await pickBaselineAndProgram(page);
      await page.goto("/roadmap");
      await expect(page.getByRole("grid", { name: "Roadmap timeline" })).toBeVisible();
      await expect(page.getByRole("link", { name: `Open ${projectName}`, exact: true })).toBeVisible();
      await expect(page.getByLabel("Baseline", { exact: true })).toHaveValue(new RegExp(baselineName));
      await expect(page.locator('[data-tone="baseline"]').first()).toBeAttached();
      await expect(page.getByRole("note").first()).toBeVisible(); // the totals line
      await expectScheme(page, scheme);
      await scan(page);
    });

    test(`/programs with a baseline picked has no WCAG A/AA violations${suffix}`, async ({ page }) => {
      await login(page);
      await pickBaselineAndProgram(page);
      await page.goto("/programs");
      await expect(page.getByRole("grid", { name: "Programs timeline" })).toBeVisible();
      await page.getByRole("button", { name: /^Program e2e-axe-bl-program/ }).click();
      await expect(page.getByRole("link", { name: `Open ${projectName}`, exact: true })).toBeVisible();
      await expect(page.getByLabel("Baseline", { exact: true })).toHaveValue(new RegExp(baselineName));
      await expect(page.locator('[data-tone="baseline"]').first()).toBeAttached();
      await expect(page.getByRole("note").first()).toBeVisible(); // the totals line
      await expectScheme(page, scheme);
      await scan(page);
    });

    test(`/projects/:id with a baseline picked has no WCAG A/AA violations${suffix}`, async ({ page }) => {
      await login(page);
      await pickBaselineAndProgram(page);
      await page.goto(`/projects/${projectId}`);
      await expect(page.getByRole("heading", { level: 2, name: projectName })).toBeVisible();
      await expect(page.getByRole("grid", { name: "Milestone timeline" })).toBeVisible();
      await expect(page.getByLabel("Baseline", { exact: true })).toHaveValue(new RegExp(baselineName));
      await expect(page.locator('[data-tone="baseline"]').first()).toBeAttached();
      await expect(page.getByRole("heading", { level: 3, name: `Movement vs baseline ${baselineName}` })).toBeVisible();
      await expectScheme(page, scheme);
      await scan(page);
    });

    // The OPEN row menus: a Mantine menu dropdown is a portal'd `role="menu"`, only in the DOM while open, so a page scan with the menus closed
    // never saw it. The Teams list (the fixture team), the Baselines list (the fixture baseline) and the roadmap timeline (the fixture project's
    // row, ranked for the scan and unranked again). One menu at a time: Escape closes it, returns the focus to its kebab, and the next one opens after it has left the DOM.
    test(`the open row menus of the Teams list, the Baselines list and the roadmap timeline have no WCAG A/AA violations${suffix}`, async ({ page }) => {
      async function scanOpenMenu(name: string): Promise<void> {
        const kebab = page.getByRole("button", { name: `Operations for ${name}`, exact: true });
        await kebab.click();
        const menu = page.getByRole("menu");
        await expect(menu).toBeVisible();
        await expect(menu).toHaveCSS("opacity", "1"); // axe measures contrast against the fade-in's partial opacity
        await scan(page);
        await page.keyboard.press("Escape");
        await expect(menu).toHaveCount(0);
        await expect(kebab).toBeFocused(); // Escape gives the focus back to the kebab that opened the menu (it once ended on `body`)
      }
      await updateRankingViaApi(api, (ranked) => [...ranked, projectId]);
      try {
        await login(page);
        await page.goto("/teams");
        await expect(page.getByRole("heading", { level: 2, name: "Teams" })).toBeVisible();
        await openFilters(page);
        await page.getByLabel("Name", { exact: true }).fill(teamName); // the filter narrows a stack of many rows to the fixture
        await expect(page.getByRole("link", { name: `Open team ${teamName}` })).toBeVisible();
        await expectScheme(page, scheme);
        await scanOpenMenu(teamName);

        await page.goto("/baselines");
        await expect(page.getByRole("link", { name: `Compare ${baselineName} with the plan` })).toBeVisible();
        await scanOpenMenu(baselineName);

        await page.evaluate(([key, value]) => localStorage.setItem(key, value), ["astrolabe.viewSettings.planning.programPick", JSON.stringify([programId])]);
        await page.goto("/roadmap");
        await expect(page.getByRole("grid", { name: "Roadmap timeline" })).toBeVisible();
        await expect(page.getByRole("link", { name: `Open ${projectName}`, exact: true })).toBeVisible();
        await scanOpenMenu(projectName);
      } finally {
        await updateRankingViaApi(api, (ranked) => ranked.filter((id) => id !== projectId));
      }
    });
  }
  registerBaselineScans("light");
  test.describe("dark scheme", () => {
    test.use({ colorScheme: "dark" });
    registerBaselineScans("dark");
  });
});

// The Jira sync's pages (v1.1), in 2044: the connections registry with a row, a connection's page with every section filled (the facts and the runs
// table, the discovery report, the mapping form and Peek, the Links table with a row), the Deviations page with a deviating row, the connection editor
// modal (new and edit) and the bind dialog. One world of its own: a connection scoped to the stub's `E2E` project (tested once, in the beforeAll: Test
// connection and Peek share a 10-a-minute bucket per IP with the Jira spec, so no scan calls either) and a milestone linked to the stub's E2E-4 (which
// exists in both of the stub's scenario states, so nothing here depends on `jira-sync.spec.ts`'s flips or rows) that ends three working days after
// Jira's end: the orange warning row. The scans never press Test connection or Peek; `jira-sync.spec.ts` axe-scans the result tables.
// Owns: that connection (a unique throwaway site), its binding, and a person, a team, a work stream, a program, a project and one milestone (unique
// `e2e-axe-jira-*` names, dated in 2044), created and deleted via the API in the beforeAll/afterAll (the connection first: its binding goes with it).
test.describe("the Jira pages", () => {
  let api: APIRequestContext;
  let connectionId: number;
  let connectionName: string;
  let projectId: number;
  let milestoneName: string;
  const paths: string[] = []; // delete paths in creation order (the connection last); the afterAll deletes them in reverse

  async function create(path: string, data: object, tear: string): Promise<number> {
    const created = await api.post(path, { data });
    expect(created.status(), await created.text()).toBe(201);
    const id = ((await created.json()) as { id: number }).id;
    paths.push(`${tear}/${id}`);
    return id;
  }

  test.beforeAll(async () => {
    ({ api } = await apiAsAdmin());
    const teamId = await create("/api/v1/teams", { name: uniqueText("e2e-axe-jira-team") }, "/api/v1/teams");
    const personId = await create("/api/v1/people", { name: uniqueText("e2e-axe-jira-owner") }, "/api/v1/people");
    const streamId = await create("/api/v1/work-streams", { name: uniqueText("e2e-axe-jira-stream"), ownerPersonId: personId, startDate: "2044-01-04" }, "/api/v1/work-streams");
    const programId = await create(`/api/v1/work-streams/${streamId}/programs`, { name: uniqueText("e2e-axe-jira-program"), ownerPersonId: personId }, "/api/v1/programs");
    projectId = await create(`/api/v1/programs/${programId}/projects`, { name: uniqueText("e2e-axe-jira-project"), ownerPersonId: personId }, "/api/v1/projects");
    milestoneName = uniqueText("e2e-axe-jira-milestone");
    const milestoneId = await create(`/api/v1/projects/${projectId}/milestones`, { name: milestoneName, teamId, estimateMd: 3 }, "/api/v1/milestones");
    const view = (await (await api.get(`/api/v1/views/team/${teamId}`)).json()) as { revision: number };
    const placed = await api.put(`/api/v1/milestones/${milestoneId}/schedule`, { data: { expectedRevision: view.revision, startDate: "2044-01-04", endDate: "2044-01-13" } });
    expect(placed.status(), await placed.text()).toBe(200);
    connectionName = uniqueText("e2e-axe-jira-connection");
    const site = `https://e2eaxejira${uniqueText("s").replace(/[^a-z0-9]/g, "")}.atlassian.net`;
    connectionId = await create(
      "/api/v1/integrations/jira/connections",
      { name: connectionName, siteUrl: site, email: "e2e-axe-jira@astrolabe.local", apiToken: "e2e-axe-jira-token", authScheme: "BASIC", projectKeys: ["E2E"], enabled: true, pollIntervalMinutes: null },
      "/api/v1/integrations/jira/connections",
    );
    const tested = await api.post(`/api/v1/integrations/jira/connections/${connectionId}/test`);
    expect(tested.status(), await tested.text()).toBe(200);
    const bound = await api.post("/api/v1/integrations/jira/bindings", { data: { connectionId, level: "MILESTONE", nodeId: milestoneId, issueKey: "E2E-4" } });
    expect(bound.status(), await bound.text()).toBe(201);
  });
  test.afterAll(async () => {
    try {
      await deleteViaApi(paths.splice(0).reverse());
    } finally {
      await api?.dispose();
    }
  });

  function registerJiraScans(scheme: Scheme): void {
    const suffix = scheme === "dark" ? " in the dark scheme" : "";
    const openRegistry = async (page: Page): Promise<void> => {
      await login(page);
      await page.goto("/integrations/jira");
      await expect(page.getByRole("heading", { level: 2, name: "Jira connections" })).toBeVisible();
      await expect(page.getByRole("link", { name: `Open connection ${connectionName}` })).toBeVisible();
      await expectScheme(page, scheme);
    };
    const openConnection = async (page: Page): Promise<void> => {
      await login(page);
      await page.goto(`/integrations/jira/${connectionId}`);
      await expect(page.getByRole("heading", { level: 2, name: connectionName })).toBeVisible();
      // Every section, filled: the facts and runs, the discovery report with the mapping form and Peek, the Links table with the fixture's row.
      await expect(page.getByRole("heading", { level: 3, name: "Connection" })).toBeVisible();
      await expect(page.getByRole("table", { name: "Recent runs" })).toBeVisible();
      await expect(page.getByRole("heading", { level: 3, name: "Mapping" })).toBeVisible();
      await expect(page.getByRole("heading", { level: 4, name: "Discovery report" })).toBeVisible();
      await expect(page.getByRole("form", { name: "Field mapping" })).toBeVisible();
      await expect(page.getByRole("heading", { level: 4, name: "Peek at an issue" })).toBeVisible();
      await expect(page.getByRole("heading", { level: 3, name: "Links to plan items" })).toBeVisible();
      await expect(page.getByRole("table", { name: "Links to plan items" }).getByRole("row").filter({ hasText: milestoneName })).toBeVisible();
      await expectScheme(page, scheme);
    };

    test(`/integrations/jira has no WCAG A/AA violations${suffix}`, async ({ page }) => {
      await openRegistry(page);
      await scan(page);
    });

    test(`/integrations/jira/:id has no WCAG A/AA violations${suffix}`, async ({ page }) => {
      await openConnection(page);
      await scan(page);
    });

    test(`/deviations has no WCAG A/AA violations${suffix}`, async ({ page }) => {
      await login(page);
      await page.goto(`/deviations?projectId=${projectId}`);
      await expect(page.getByRole("heading", { level: 2, name: "Deviations" })).toBeVisible();
      const row = page.getByRole("table", { name: "Differences between the plan and Jira" }).getByRole("row").filter({ hasText: milestoneName });
      await expect(row).toContainText("Ends 3 working days later than Jira");
      await expectScheme(page, scheme);
      await scan(page);
    });

    test(`the Jira connection editor modal has no WCAG A/AA violations${suffix}`, async ({ page }) => {
      await openRegistry(page);
      await page.getByRole("button", { name: "New connection" }).click();
      await expect(page.getByRole("dialog", { name: "New Jira connection" })).toBeVisible();
      await scan(page, '[role="dialog"]');
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      // The edit variant: the site read-only, the token field's "a token is stored" hint.
      await rowOperation(page, connectionName, `Edit ${connectionName}`);
      await expect(page.getByRole("dialog", { name: "Edit Jira connection" })).toBeVisible();
      await expect(page.getByText("A token is stored. Leave blank to keep the current token")).toBeVisible();
      await scan(page, '[role="dialog"]');
    });

    test(`the Jira bind dialog has no WCAG A/AA violations${suffix}`, async ({ page }) => {
      await openConnection(page);
      await page.getByRole("button", { name: "Link a node…" }).click();
      const dialog = page.getByRole("dialog", { name: "Link to Jira" });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("combobox", { name: "Jira connection" })).toHaveValue(connectionName);
      await expect(dialog.getByRole("textbox", { name: "Jira issue key" })).toBeVisible();
      await scan(page, '[role="dialog"]');
    });
  }
  registerJiraScans("light");
  test.describe("dark scheme", () => {
    test.use({ colorScheme: "dark" });
    registerJiraScans("dark");
  });
});
