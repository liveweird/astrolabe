// Where the Gantts open (1.37): every Gantt opens with today about a quarter of the visible grid from its left edge, or at its first bar when no bar falls in that first
// screen, so the grid is never empty and the header's "Today" pill is never cut at an edge. The project page (work starting more than a year after today, and work around
// today), the team page, and the Roadmap in both modes. Read-only: the world (below) is seeded once through the API and only navigated. Owns: its throwaway person, team,
// work stream, program and TWO projects, `e2e-to-*`: "far" has one milestone scheduled a Monday-to-Friday about 14 months after today, "near" one scheduled the week
// after today; both are the team's, none is ranked. The dates are relative to the day the suite runs (no calendar year is pinned, no holiday, capacity or ranking figure is
// read), seeded in the beforeAll and removed in the afterAll through the API, children first. The browser state (`astrolabe.viewSettings.timeline.*`) is cleared by `login`.
import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { addDays, apiAsAdmin, deleteViaApi, expect, login, test, uniqueText } from "./helpers";

interface Project {
  id: number;
  name: string;
  milestone: string;
}
interface World {
  far: Project;
  near: Project;
  program: string;
  programId: number;
  team: string;
  teamId: number;
}

let world: World;

// Registered in creation order; torn down in reverse (a project before its program before its stream before the team and the person).
const teardown: string[] = [];
test.afterAll(async () => {
  await deleteViaApi(teardown.splice(0).reverse());
});

async function seed(api: APIRequestContext, path: string, data: object, tear: string | null): Promise<number> {
  const response = await api.post(path, { data });
  expect(response.status(), await response.text()).toBe(201);
  const id = ((await response.json()) as { id: number }).id;
  if (tear !== null) teardown.push(`${tear}/${id}`);
  return id;
}

/** The first Monday strictly after `iso` plus `weeks` weeks. */
function mondayAfter(iso: string, weeks: number): string {
  const weekday = (new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7;
  return addDays(iso, 7 - weekday + 7 * weeks);
}

/** The day the suite runs on, as the browser (and the app) will read it: the local calendar day. */
function localToday(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

async function seedProject(api: APIRequestContext, programId: number, personId: number, teamId: number, label: string, start: string): Promise<Project> {
  const name = uniqueText(`e2e-to-${label}`);
  const id = await seed(api, `/api/v1/programs/${programId}/projects`, { name, ownerPersonId: personId }, "/api/v1/projects");
  const milestone = uniqueText(`e2e-to-ms-${label}`);
  const milestoneId = await seed(api, `/api/v1/projects/${id}/milestones`, { name: milestone, teamId, estimateMd: 3 }, null);
  const view = await api.get(`/api/v1/views/project/${id}`);
  const { revision } = (await view.json()) as { revision: number };
  const response = await api.put(`/api/v1/milestones/${milestoneId}/schedule`, { data: { expectedRevision: revision, startDate: start, endDate: addDays(start, 4) } });
  expect(response.status(), await response.text()).toBe(200);
  return { id, name, milestone };
}

async function seedWorld(): Promise<World> {
  const { api } = await apiAsAdmin();
  try {
    const today = localToday();
    const personId = await seed(api, "/api/v1/people", { name: uniqueText("e2e-to-person") }, "/api/v1/people");
    const team = uniqueText("e2e-to-team");
    const teamId = await seed(api, "/api/v1/teams", { name: team }, "/api/v1/teams");
    const streamId = await seed(api, "/api/v1/work-streams", { name: uniqueText("e2e-to-stream"), ownerPersonId: personId, startDate: "2026-01-05" }, "/api/v1/work-streams");
    const program = uniqueText("e2e-to-program");
    const programId = await seed(api, `/api/v1/work-streams/${streamId}/programs`, { name: program, ownerPersonId: personId }, "/api/v1/programs");
    const far = await seedProject(api, programId, personId, teamId, "far", mondayAfter(today, 60));
    const near = await seedProject(api, programId, personId, teamId, "near", mondayAfter(today, 0));
    return { far, near, program, programId, team, teamId };
  } finally {
    await api.dispose();
  }
}

test.beforeAll(async () => {
  world = await seedWorld();
});

const heading = (page: Page, name: string) => page.getByRole("heading", { level: 2, name, exact: true });
const timeline = (page: Page, label: string) => page.getByRole("grid", { name: label, exact: true });
const scroller = (page: Page, label: string) => page.getByRole("region", { name: label, exact: true });

async function boxOf(locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await locator.boundingBox();
  expect(box, "the element is drawn").not.toBeNull();
  return box as { x: number; y: number; width: number; height: number };
}

/** The visible track of a Gantt: from the right edge of its sticky pane (the Operations header) to the scroller's right edge (less a classic scrollbar). */
async function visibleTrack(page: Page, grid: Locator, label: string): Promise<{ left: number; right: number }> {
  const operations = await boxOf(grid.getByRole("columnheader", { name: "Operations", exact: true }));
  const region = await boxOf(scroller(page, label));
  const scrollbar = await scroller(page, label).evaluate((element) => (element as HTMLElement).offsetWidth - element.clientWidth);
  return { left: operations.x + operations.width, right: region.x + region.width - scrollbar };
}

/** The header's "Today" pill, whole inside the visible track (never cut at either edge). */
async function expectTodayPillWhole(page: Page, grid: Locator, label: string): Promise<void> {
  const pill = grid.getByText("Today", { exact: true });
  await expect(pill).toBeVisible();
  const track = await visibleTrack(page, grid, label);
  const box = await boxOf(pill);
  expect(box.x, "the pill's left edge is inside the track").toBeGreaterThanOrEqual(track.left - 0.5);
  expect(box.x + box.width, "the pill's right edge is inside the track").toBeLessThanOrEqual(track.right + 0.5);
}

/** Where today's line falls in the visible track, 0 (left edge) to 1 (right edge). */
async function todayShare(page: Page, grid: Locator, label: string): Promise<number> {
  const track = await visibleTrack(page, grid, label);
  const line = await boxOf(grid.locator('[class*="timelineToday_"]'));
  return (line.x + line.width / 2 - track.left) / (track.right - track.left);
}

async function openProject(page: Page, project: Project): Promise<Locator> {
  await page.goto(`/projects/${project.id}`);
  await expect(heading(page, project.name)).toBeVisible();
  const grid = timeline(page, "Milestone timeline");
  await expect(grid.getByRole("button", { name: new RegExp(`^${project.milestone}, `) })).toBeVisible();
  return grid;
}

test("the project page opens at its first bar when its work starts months after today", async ({ page }) => {
  await login(page);
  const grid = await openProject(page, world.far);
  const bar = grid.getByRole("button", { name: new RegExp(`^${world.far.milestone}, `) });
  const track = await visibleTrack(page, grid, "Milestone timeline");
  await expect.poll(() => scroller(page, "Milestone timeline").evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  const box = await boxOf(bar);
  expect(box.x, "the bar starts in the visible track").toBeGreaterThanOrEqual(track.left - 0.5);
  expect(box.x - track.left, "a small lead, not flush and not far in").toBeLessThan(120);
  expect(box.x + box.width).toBeLessThanOrEqual(track.right);
  expect(await todayShare(page, grid, "Milestone timeline"), "today lies left of the visible track").toBeLessThan(0);
});

test("the project page and the team page open with today a quarter of the way in when their work is around today", async ({ page }) => {
  await login(page);
  const project = await openProject(page, world.near);
  const share = await todayShare(page, project, "Milestone timeline");
  expect(share, "today a quarter of the visible grid from its left edge").toBeGreaterThan(0.2);
  expect(share).toBeLessThan(0.3);
  await expectTodayPillWhole(page, project, "Milestone timeline");

  // The team's work is both projects' milestones, one around today: the same rule on the team page.
  await page.goto(`/teams/${world.teamId}`);
  await expect(heading(page, world.team)).toBeVisible();
  const team = timeline(page, "Team milestone timeline");
  await expect(team.getByRole("link", { name: `Open milestone ${world.near.milestone}`, exact: true })).toBeVisible();
  const teamShare = await todayShare(page, team, "Team milestone timeline");
  expect(teamShare).toBeGreaterThan(0.2);
  expect(teamShare).toBeLessThan(0.3);
  await expectTodayPillWhole(page, team, "Team milestone timeline");
});

test("the Roadmap, in both modes, opens with the Today pill whole", async ({ page }) => {
  await login(page);
  await page.goto(`/roadmap?mode=prioritization&programId=${world.programId}`);
  const prioritization = timeline(page, "Roadmap timeline");
  await expect(prioritization.getByRole("link", { name: `Open project ${world.near.name}`, exact: true })).toBeVisible();
  await expectTodayPillWhole(page, prioritization, "Roadmap timeline");
  const share = await todayShare(page, prioritization, "Roadmap timeline");
  expect(share, "today in the first half of the grid, not at its far right edge").toBeLessThan(0.5);

  await page.goto(`/roadmap?mode=overview&programId=${world.programId}`);
  const overview = timeline(page, "Programs timeline");
  await expect(overview.getByRole("button", { name: `Program ${world.program}`, exact: true })).toBeVisible();
  await expectTodayPillWhole(page, overview, "Programs timeline");
  expect(await todayShare(page, overview, "Programs timeline")).toBeLessThan(0.5);
});

test("Scroll to today still centres today after the grid has opened", async ({ page }) => {
  await login(page);
  const grid = await openProject(page, world.near);
  const region = scroller(page, "Milestone timeline");
  const opened = await region.evaluate((element) => element.scrollLeft);
  await page.getByRole("button", { name: "Scroll to today" }).click();
  await expect.poll(async () => Math.abs((await todayShare(page, grid, "Milestone timeline")) - 0.5)).toBeLessThan(0.05);
  expect(await region.evaluate((element) => element.scrollLeft), "the button moved the grid from where it opened").not.toBe(opened);
});
