// The Gantts' hideable columns (1.34) and "Scroll to today", by clicks and keys: on the project page "Hide columns" collapses every column between the name and
// Operations (the Operations header and the bars move left by the width of what went), the chevron's menu brings one back and stays open, and the choice holds across a
// reload and across a collapse and expand; the keyboard steps from the row header over the hidden columns to Operations and on to the bar; the team page and the Roadmap's
// two modes each keep their own choice; "Scroll to today" brings the today line back into the visible track; the open menu and a collapsed timeline pass axe in both
// schemes. Nothing is written by the tests themselves: the world (below) is seeded once through the API and only navigated. Owns: its throwaway person, team, work stream,
// program, project and one milestone scheduled 2027-06-07..11 (no figure is pinned, so no far-off year and no lock), all `e2e-tc-*`, seeded in the beforeAll and removed in
// the afterAll through the API, children first. The choices themselves are browser state (`astrolabe.viewSettings.timeline.columns.<page>`): each test has a fresh browser
// context and `login` clears its storage, so no test inherits another's. It never touches the global ranking (its project stays unranked).
import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { apiAsAdmin, axeViolations, deleteViaApi, expect, expectScheme, login, type Scheme, test, uniqueText } from "./helpers";

interface World {
  project: string;
  projectId: number;
  program: string;
  programId: number;
  milestone: string;
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

/** A schedule write as the ADMIN, with the project view's current revision. */
async function schedule(api: APIRequestContext, projectId: number, milestoneId: number, startDate: string, endDate: string): Promise<void> {
  const view = await api.get(`/api/v1/views/project/${projectId}`);
  const { revision } = (await view.json()) as { revision: number };
  const response = await api.put(`/api/v1/milestones/${milestoneId}/schedule`, { data: { expectedRevision: revision, startDate, endDate } });
  expect(response.status(), await response.text()).toBe(200);
}

/** One person, a team, a work stream with a program and a project, and one milestone of the team scheduled 2027-06-07..11. */
async function seedWorld(): Promise<World> {
  const { api } = await apiAsAdmin();
  try {
    const personId = await seed(api, "/api/v1/people", { name: uniqueText("e2e-tc-person") }, "/api/v1/people");
    const team = uniqueText("e2e-tc-team");
    const teamId = await seed(api, "/api/v1/teams", { name: team }, "/api/v1/teams");
    const streamId = await seed(api, "/api/v1/work-streams", { name: uniqueText("e2e-tc-stream"), ownerPersonId: personId, startDate: "2026-01-05" }, "/api/v1/work-streams");
    const program = uniqueText("e2e-tc-program");
    const programId = await seed(api, `/api/v1/work-streams/${streamId}/programs`, { name: program, ownerPersonId: personId }, "/api/v1/programs");
    const project = uniqueText("e2e-tc-project");
    const projectId = await seed(api, `/api/v1/programs/${programId}/projects`, { name: project, ownerPersonId: personId }, "/api/v1/projects");
    const milestone = uniqueText("e2e-tc-ms");
    const milestoneId = await seed(api, `/api/v1/projects/${projectId}/milestones`, { name: milestone, teamId, estimateMd: 3 }, null);
    await schedule(api, projectId, milestoneId, "2027-06-07", "2027-06-11");
    return { project, projectId, program, programId, milestone, team, teamId };
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
const headers = (grid: Locator) => grid.getByRole("columnheader");
const hideColumns = (page: Page) => page.getByRole("button", { name: "Hide columns", exact: true });
const showColumns = (page: Page) => page.getByRole("button", { name: "Show columns", exact: true });
// The chevron carries a count in its name while a column is not drawn ("Choose columns · 2 hidden"), so it is found by its start.
const chooseColumns = (page: Page) => page.getByRole("button", { name: /^Choose columns/ });
const columnItem = (page: Page, name: string) => page.getByRole("menuitemcheckbox", { name, exact: true });

async function openProject(page: Page): Promise<Locator> {
  await page.goto(`/projects/${world.projectId}`);
  await expect(heading(page, world.project)).toBeVisible();
  const grid = timeline(page, "Milestone timeline");
  await expect(grid).toBeVisible();
  await expect(grid.getByRole("button", { name: new RegExp(`^${world.milestone}, `) })).toBeVisible();
  return grid;
}

async function openTeam(page: Page): Promise<Locator> {
  await page.goto(`/teams/${world.teamId}`);
  await expect(heading(page, world.team)).toBeVisible();
  const grid = timeline(page, "Team milestone timeline");
  await expect(grid.getByRole("link", { name: `Open milestone ${world.milestone}`, exact: true })).toBeVisible();
  return grid;
}

/** The Roadmap in a mode, narrowed to the world's program so that every row on it is the world's own. */
async function openRoadmap(page: Page, mode: "prioritization" | "overview"): Promise<Locator> {
  await page.goto(`/roadmap?mode=${mode}&programId=${world.programId}`);
  if (mode === "overview") {
    const grid = timeline(page, "Programs timeline");
    await expect(grid.getByRole("button", { name: `Program ${world.program}`, exact: true })).toBeVisible();
    return grid;
  }
  const grid = timeline(page, "Roadmap timeline");
  await expect(grid.getByRole("link", { name: `Open project ${world.project}`, exact: true })).toBeVisible();
  return grid;
}

/** A locator's left edge, as drawn on the page. */
async function leftOf(locator: Locator): Promise<number> {
  const box = await locator.boundingBox();
  expect(box, "the element is drawn").not.toBeNull();
  return (box as { x: number }).x;
}

/** A locator's right edge, as drawn on the page. */
async function rightOf(locator: Locator): Promise<number> {
  const box = await locator.boundingBox();
  expect(box, "the element is drawn").not.toBeNull();
  const { x, width } = box as { x: number; width: number };
  return x + width;
}

async function widthOf(locator: Locator): Promise<number> {
  const box = await locator.boundingBox();
  expect(box, "the element is drawn").not.toBeNull();
  return (box as { width: number }).width;
}

test("the project page hides its extra columns, brings one back from the menu and remembers the choice", async ({ page }) => {
  await login(page);
  const grid = await openProject(page);
  const team = grid.getByRole("columnheader", { name: "Team", exact: true });
  const estimate = grid.getByRole("columnheader", { name: "Estimate", exact: true });
  const operations = grid.getByRole("columnheader", { name: "Operations", exact: true });
  const bar = grid.getByRole("button", { name: new RegExp(`^${world.milestone}, `) });
  await expect(headers(grid)).toHaveText(["Milestone", "Team", "Estimate", "Operations"]);
  await expect(hideColumns(page)).toHaveAttribute("aria-expanded", "true");

  // Hide columns: the two extra headers go, and the Operations header and the bar move left by exactly the width the two had (the scroll position is kept).
  // The grid opens at the milestone, near the range's right end (1.37); moved 600 px back first, so the narrower pane's smaller maximum cannot clamp the position.
  await scroller(page, "Milestone timeline").evaluate((element) => {
    element.scrollLeft = Math.max(0, element.scrollWidth - element.clientWidth - 600);
  });
  const hiddenWidth = (await widthOf(team)) + (await widthOf(estimate));
  const operationsRight = await rightOf(operations);
  const barLeft = await leftOf(bar);
  const scrollBefore = await scroller(page, "Milestone timeline").evaluate((element) => element.scrollLeft);
  await hideColumns(page).click();
  await expect(team).toHaveCount(0);
  await expect(estimate).toHaveCount(0);
  await expect(headers(grid)).toHaveText(["Milestone", "Operations"]);
  await expect(showColumns(page)).toHaveAttribute("aria-expanded", "false");
  expect(await scroller(page, "Milestone timeline").evaluate((element) => element.scrollLeft)).toBe(scrollBefore);
  await expect.poll(() => rightOf(operations)).toBeCloseTo(operationsRight - hiddenWidth, 0);
  await expect.poll(() => leftOf(bar)).toBeCloseTo(barLeft - hiddenWidth, 0);

  // The menu shows what is drawn (nothing now); ticking Team brings that column back alone, and the menu stays open for the next pick.
  await chooseColumns(page).click();
  await expect(columnItem(page, "Team")).toHaveAttribute("aria-checked", "false");
  await expect(columnItem(page, "Estimate")).toHaveAttribute("aria-checked", "false");
  await columnItem(page, "Team").click();
  await expect(columnItem(page, "Team")).toHaveAttribute("aria-checked", "true");
  await expect(columnItem(page, "Estimate")).toBeVisible();
  await expect(chooseColumns(page)).toHaveAttribute("aria-expanded", "true");
  // Estimate is still not drawn: the chevron says so, in its text and its name (while collapsed it said "2 hidden").
  await expect(chooseColumns(page)).toHaveText("1 hidden");
  await expect(page.getByRole("button", { name: "Choose columns · 1 hidden", exact: true })).toBeVisible();
  await expect(team).toBeVisible();
  await expect(estimate).toHaveCount(0);
  await expect(headers(grid)).toHaveText(["Milestone", "Team", "Operations"]);
  await expect(hideColumns(page)).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
  await expect(columnItem(page, "Team")).toHaveCount(0);

  // The choice is browser state: a reload keeps it.
  await page.reload();
  await expect(grid.getByRole("button", { name: new RegExp(`^${world.milestone}, `) })).toBeVisible();
  await expect(headers(grid)).toHaveText(["Milestone", "Team", "Operations"]);

  // Collapse, then expand: the pick (Team shown, Estimate hidden) is what comes back.
  await hideColumns(page).click();
  await expect(headers(grid)).toHaveText(["Milestone", "Operations"]);
  await showColumns(page).click();
  await expect(headers(grid)).toHaveText(["Milestone", "Team", "Operations"]);
  await expect(estimate).toHaveCount(0);
});

test("the keyboard steps over the hidden columns", async ({ page }) => {
  await login(page);
  const grid = await openProject(page);
  await hideColumns(page).click();
  await expect(headers(grid)).toHaveText(["Milestone", "Operations"]);

  // Row header -> Operations (the Team and Estimate cells are gone, not skipped by a dead stop) -> the bar.
  await grid.getByRole("rowheader", { name: new RegExp(`^${world.milestone}`) }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(grid.getByRole("button", { name: `Operations for ${world.milestone}`, exact: true })).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(grid.getByRole("button", { name: new RegExp(`^${world.milestone}, `) })).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(grid.getByRole("button", { name: `Operations for ${world.milestone}`, exact: true })).toBeFocused();
});

test("the team page and the Roadmap's two modes each keep their own choice", async ({ page }) => {
  await login(page);

  // Every page starts with everything shown; hiding on one page leaves the others alone. Headers only: four workers share the plan.
  let grid = await openTeam(page);
  await expect(headers(grid)).toHaveText(["Milestone", "Project", "Estimate", "Operations"]);
  await hideColumns(page).click();
  await expect(headers(grid)).toHaveText(["Milestone", "Operations"]);

  grid = await openRoadmap(page, "prioritization");
  await expect(headers(grid)).toHaveText(["#", "Project", "Flags", "Operations"]);
  await hideColumns(page).click();
  await expect(headers(grid)).toHaveText(["#", "Project", "Operations"]);

  grid = await openRoadmap(page, "overview");
  await expect(headers(grid)).toHaveText(["Work stream, program, project", "Flags", "Operations"]);
  await hideColumns(page).click();
  await expect(headers(grid)).toHaveText(["Work stream, program, project", "Operations"]);

  // The project page has its own key too: untouched.
  grid = await openProject(page);
  await expect(headers(grid)).toHaveText(["Milestone", "Team", "Estimate", "Operations"]);

  // Each page, opened again, still has its own choice.
  grid = await openTeam(page);
  await expect(headers(grid)).toHaveText(["Milestone", "Operations"]);
  await expect(showColumns(page)).toHaveAttribute("aria-expanded", "false");
  grid = await openRoadmap(page, "prioritization");
  await expect(headers(grid)).toHaveText(["#", "Project", "Operations"]);
  grid = await openRoadmap(page, "overview");
  await expect(headers(grid)).toHaveText(["Work stream, program, project", "Operations"]);
});

test("Scroll to today brings today back into view", async ({ page }) => {
  await login(page);
  const grid = await openProject(page);
  const region = scroller(page, "Milestone timeline");
  const line = grid.locator('[class*="timelineToday_"]');
  const operations = grid.getByRole("columnheader", { name: "Operations", exact: true });

  // Today is in the track's range but far from the milestone (2027): at the far end of the timeline it is behind the sticky left columns, out of the visible track.
  await region.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
  });
  await expect.poll(() => region.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  const trackLeft = await rightOf(operations);
  expect(await leftOf(line), "today is out of the visible track at the far end").toBeLessThan(trackLeft);

  await page.getByRole("button", { name: "Scroll to today" }).click();
  await expect
    .poll(async () => {
      const x = await leftOf(line);
      const box = await region.boundingBox();
      return box !== null && x >= trackLeft - 0.5 && x <= box.x + box.width;
    })
    .toBe(true);
});

test("the columns menu and a collapsed timeline pass axe in light and dark", async ({ page }) => {
  await login(page);
  const grid = await openProject(page);
  for (const scheme of ["light", "dark"] satisfies Scheme[]) {
    await page.emulateMedia({ colorScheme: scheme });
    await expectScheme(page, scheme);

    // The menu open over the expanded timeline.
    await chooseColumns(page).click();
    await expect(columnItem(page, "Team")).toBeVisible();
    await expect(page.getByRole("menu")).toHaveCSS("opacity", "1"); // axe measures contrast against the fade-in's partial opacity
    expect(await axeViolations(page), `the open columns menu, ${scheme} scheme`).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(columnItem(page, "Team")).toHaveCount(0);

    // The collapsed timeline, then back to the expanded one for the next scheme.
    await hideColumns(page).click();
    await expect(headers(grid)).toHaveText(["Milestone", "Operations"]);
    expect(await axeViolations(page), `the collapsed timeline, ${scheme} scheme`).toEqual([]);
    await showColumns(page).click();
    await expect(headers(grid)).toHaveText(["Milestone", "Team", "Estimate", "Operations"]);
  }
  await page.emulateMedia({ colorScheme: "light" });
});
