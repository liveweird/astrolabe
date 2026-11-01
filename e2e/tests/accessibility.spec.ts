// Axe accessibility smoke: WCAG 2.0/2.1 A+AA scans over the login screen, the authenticated list
// and form pages, the detail pages of one API-seeded fixture team, and the overlays (a registry
// editor modal) — where focus traps, aria-modal and labels actually live, and the app shell at a
// phone width (the burger); the page sets run in the light scheme and again in the dark one.
// Owns: the fixture team and the fixture plan (a person, work stream, program and project with two milestones, one scheduled past the
// project's target end and one in the Unscheduled tray, plus a second project with one milestone linked as the fixture milestone's
// violated predecessor; unique `e2e-axe-*` names), created and deleted via the API. The fixture team carries one capacity period with a
// WIP limit of 1 (deleted with the team), so its page shows the strip's overload and WIP marks.
import type { APIRequestContext, Locator, Page } from "@playwright/test";
import {
  apiAsAdmin,
  axeViolations,
  expect,
  expectScheme,
  login,
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
  // The fixture plan's delete paths, children first (a parent with active children answers 409).
  let planPaths: string[];
  let projectId: number;
  let projectName: string;
  let linkedProjectId: number;
  let linkedProjectName: string;
  let fixtureProgramId: number;

  async function create(path: string, data: object): Promise<number> {
    const created = await api.post(path, { data });
    expect(created.status(), await created.text()).toBe(201);
    return (await created.json() as { id: number }).id;
  }

  test.beforeAll(async () => {
    ({ api, userId: adminId } = await apiAsAdmin());
    teamName = uniqueText("e2e-axe-team");
    teamId = await create("/api/v1/teams", { name: teamName });
    // A capacity period with a WIP limit of 1 (and a capacity far below the load): the team page's strip then carries both warnings
    // wherever the fixture milestones overlap (the team's two milestones below sit on the same days in March), and the team's
    // delete takes the period with it.
    await create(`/api/v1/teams/${teamId}/capacity`, { effectiveFrom: "2026-02-02", mdPerWeek: 0.5, wipLimit: 1 });
    // One of each plan level so the Plan page renders a work stream, a program and a project row.
    streamName = uniqueText("e2e-axe-stream");
    programName = uniqueText("e2e-axe-program");
    const personId = await create("/api/v1/people", { name: uniqueText("e2e-axe-owner") });
    const streamId = await create("/api/v1/work-streams", { name: streamName, ownerPersonId: personId, startDate: "2026-01-05" });
    const programId = await create(`/api/v1/work-streams/${streamId}/programs`, { name: programName, ownerPersonId: personId });
    fixtureProgramId = programId;
    // A second program, so the "Move to…" dialog has a target to offer.
    otherProgramName = uniqueText("e2e-axe-program-other");
    const otherProgramId = await create(`/api/v1/work-streams/${streamId}/programs`, { name: otherProgramName, ownerPersonId: personId });
    projectName = uniqueText("e2e-axe-project");
    projectId = await create(`/api/v1/programs/${programId}/projects`, {
      name: projectName,
      ownerPersonId: personId,
      targetStart: "2026-02-02",
      targetEnd: "2026-03-31",
    });
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
    linkedProjectId = await create(`/api/v1/programs/${programId}/projects`, { name: linkedProjectName, ownerPersonId: personId });
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
    planPaths = [`/api/v1/projects/${projectId}`, `/api/v1/projects/${linkedProjectId}`, `/api/v1/programs/${programId}`, `/api/v1/programs/${otherProgramId}`, `/api/v1/work-streams/${streamId}`, `/api/v1/people/${personId}`];
  });
  test.afterAll(async () => {
    for (const path of [...planPaths, `/api/v1/teams/${teamId}`]) {
      const response = await api.delete(path);
      expect([204, 404], `${path} -> ${response.status()}`).toContain(response.status());
    }
    await api.dispose();
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
      await expect(page.getByRole("table", { name: "Dependencies of the project" }).getByRole("row")).toHaveCount(2);
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
