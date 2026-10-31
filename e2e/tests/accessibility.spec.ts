// Axe accessibility smoke: WCAG 2.0/2.1 A+AA scans over the login screen, the authenticated list
// and form pages, the detail pages of one API-seeded fixture team, and the overlays (a registry
// editor modal) — where focus traps, aria-modal and labels actually live, and the app shell at a
// phone width (the burger); the page sets run in the light scheme and again in the dark one.
// Owns: the fixture team and the fixture plan (a person, work stream, program and project with two milestones, one scheduled past the
// project's target end and one in the Unscheduled tray; unique `e2e-axe-*` names), created and deleted via the API.
import type { APIRequestContext, Locator, Page } from "@playwright/test";
import {
  apiAsAdmin,
  axeViolations,
  expect,
  expectScheme,
  login,
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
  let streamName: string;
  // The fixture plan's delete paths, children first (a parent with active children answers 409).
  let planPaths: string[];
  let projectId: number;
  let projectName: string;

  async function create(path: string, data: object): Promise<number> {
    const created = await api.post(path, { data });
    expect(created.status(), await created.text()).toBe(201);
    return (await created.json() as { id: number }).id;
  }

  test.beforeAll(async () => {
    ({ api, userId: adminId } = await apiAsAdmin());
    teamName = uniqueText("e2e-axe-team");
    teamId = await create("/api/v1/teams", { name: teamName });
    // One of each plan level so the Plan page renders a work stream, a program and a project row.
    streamName = uniqueText("e2e-axe-stream");
    programName = uniqueText("e2e-axe-program");
    const personId = await create("/api/v1/people", { name: uniqueText("e2e-axe-owner") });
    const streamId = await create("/api/v1/work-streams", { name: streamName, ownerPersonId: personId, startDate: "2026-01-05" });
    const programId = await create(`/api/v1/work-streams/${streamId}/programs`, { name: programName, ownerPersonId: personId });
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
    planPaths = [`/api/v1/projects/${projectId}`, `/api/v1/programs/${programId}`, `/api/v1/work-streams/${streamId}`, `/api/v1/people/${personId}`];
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

  // The project view: the shared timeline grid (bars with handles, the window band, the orange drift badge, the weekend hatch) and the
  // Unscheduled tray, light and dark.
  function registerProjectViewScan(scheme: Scheme): void {
    const suffix = scheme === "dark" ? " in the dark scheme" : "";
    test(`/projects/:id with a scheduled milestone, the drift and the tray has no WCAG A/AA violations${suffix}`, async ({ page }) => {
      await login(page);
      await page.goto(`/projects/${projectId}`);
      await expect(page.getByRole("heading", { level: 2, name: projectName })).toBeVisible();
      await expect(page.getByRole("grid", { name: "Milestone timeline" })).toBeVisible();
      await expect(page.getByText("Ends 10 days after the target")).toBeVisible();
      await expectScheme(page, scheme);
      await scan(page);
    });
  }
  registerProjectViewScan("light");
  test.describe("dark scheme", () => {
    test.use({ colorScheme: "dark" });
    registerProjectViewScan("dark");
  });

  // The Roadmap with the fixture project in the ranked list (handles, Move and Unrank buttons) and the rest in Unranked, light and dark.
  // The project is ranked only for the scan and unranked again, so the shared ranking is as the other specs expect it.
  function registerRoadmapScan(scheme: Scheme): void {
    const suffix = scheme === "dark" ? " in the dark scheme" : "";
    test(`/roadmap with a ranked project has no WCAG A/AA violations${suffix}`, async ({ page }) => {
      await updateRankingViaApi(api, (ranked) => [...ranked, projectId]);
      try {
        await login(page);
        await page.goto("/roadmap");
        await expect(page.getByRole("button", { name: `Drag ${projectName}`, exact: true })).toBeVisible();
        await expectScheme(page, scheme);
        await scan(page);
      } finally {
        await updateRankingViaApi(api, (ranked) => ranked.filter((id) => id !== projectId));
      }
    });
  }
  registerRoadmapScan("light");
  test.describe("dark scheme", () => {
    test.use({ colorScheme: "dark" });
    registerRoadmapScan("dark");
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

  test("a plan project editor modal (dates, fieldset, owner picker) has no WCAG A/AA violations", async ({ page }) => {
    await login(page);
    await page.goto("/plan");
    await page.getByRole("button", { name: `New project in ${programName}` }).click();
    const modal = await settledDialog(page);
    await expect(modal.getByRole("heading", { name: "New project" })).toBeVisible();
    await scan(page, '[role="dialog"]');
  });
});
