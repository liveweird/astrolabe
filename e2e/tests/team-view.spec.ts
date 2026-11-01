// The team view (/teams/:id): the team's manager sets a capacity period (any date) with a WIP limit, schedules from the team page and
// reads the overloaded week and the WIP warning on the strip, the facts line and the weekly table; moves a milestone to the bottom of the
// team's order, sees the custom order and resets it; a project OWNER (not the manager) reads the same page without the controls.
// Owns: its throwaway users, people, team and plan nodes (unique `e2e-tv-*` names), all seeded through the API and deleted by the
// afterEach below (the project first - its milestones go with it - then program, work stream, team (its capacity periods go with it),
// people, users).
import { randomUUID } from "node:crypto";
import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { apiAsAdmin, deleteViaApi, expect, login, rowOperation, test, uniqueText } from "./helpers";

// Registered in creation order; torn down in reverse (a project before its program before its stream before the team and the people).
const teardown: string[] = [];
test.afterEach(async () => {
  await deleteViaApi(teardown.splice(0).reverse());
});

interface Account {
  email: string;
  password: string;
}

interface World {
  api: APIRequestContext;
  owner: Account;
  manager: Account;
  team: string;
  teamId: number;
  projectId: number;
}

async function seed(api: APIRequestContext, path: string, data: object, tear: string): Promise<number> {
  const response = await api.post(path, { data });
  expect(response.status(), await response.text()).toBe(201);
  const id = ((await response.json()) as { id: number }).id;
  teardown.push(`${tear}/${id}`);
  return id;
}

async function seedUser(api: APIRequestContext, label: string): Promise<{ id: number; account: Account }> {
  const name = uniqueText(`e2e-tv-${label}`);
  const account = { email: `${name.toLowerCase()}@astrolabe.local`, password: randomUUID().replace(/-/g, "") };
  const id = await seed(api, "/api/v1/users", { name, email: account.email, password: account.password }, "/api/v1/users");
  return { id, account };
}

/**
 * Two throwaway logins (a project OWNER and a team MANAGER, deliberately different people), a team the manager manages, and a plan (work
 * stream and program owned by a third, login-less person) holding one project owned by the owner.
 */
async function seedWorld(): Promise<World> {
  const { api } = await apiAsAdmin();
  const owner = await seedUser(api, "owner");
  const manager = await seedUser(api, "manager");
  const lead = await seed(api, "/api/v1/people", { name: uniqueText("e2e-tv-lead") }, "/api/v1/people");
  const ownerPerson = await seed(api, "/api/v1/people", { name: uniqueText("e2e-tv-ownerperson"), userId: owner.id }, "/api/v1/people");
  const managerPerson = await seed(api, "/api/v1/people", { name: uniqueText("e2e-tv-managerperson"), userId: manager.id }, "/api/v1/people");
  const team = uniqueText("e2e-tv-team");
  const teamId = await seed(api, "/api/v1/teams", { name: team, managerPersonId: managerPerson }, "/api/v1/teams");
  const streamId = await seed(api, "/api/v1/work-streams", { name: uniqueText("e2e-tv-stream"), ownerPersonId: lead, startDate: "2026-01-05" }, "/api/v1/work-streams");
  const programId = await seed(api, `/api/v1/work-streams/${streamId}/programs`, { name: uniqueText("e2e-tv-program"), ownerPersonId: lead }, "/api/v1/programs");
  const projectId = await seed(api, `/api/v1/programs/${programId}/projects`, { name: uniqueText("e2e-tv-project"), ownerPersonId: ownerPerson }, "/api/v1/projects");
  return { api, owner: owner.account, manager: manager.account, team, teamId, projectId };
}

/** A milestone of the world's team through the API (always unscheduled); answers its id. */
async function seedMilestone(world: World, name: string, estimateMd: number): Promise<number> {
  const response = await world.api.post(`/api/v1/projects/${world.projectId}/milestones`, { data: { name, teamId: world.teamId, estimateMd } });
  expect(response.status(), await response.text()).toBe(201);
  return ((await response.json()) as { id: number }).id;
}

/** A schedule write as the ADMIN, with the team view's current plan revision (a client that has just read the view). */
async function scheduleViaApi(world: World, milestoneId: number, startDate: string, endDate: string): Promise<void> {
  const view = await world.api.get(`/api/v1/views/team/${world.teamId}`);
  const { revision } = (await view.json()) as { revision: number };
  const response = await world.api.put(`/api/v1/milestones/${milestoneId}/schedule`, { data: { expectedRevision: revision, startDate, endDate } });
  expect(response.status(), await response.text()).toBe(200);
}

/** Type an ISO date and leave the field by clicking the dialog title: Tab would focus the next date input and open its calendar over the footer. */
async function fillDate(dialog: Locator, label: string, value: string): Promise<void> {
  await dialog.getByLabel(label).fill(value);
  await dialog.getByRole("heading").first().click();
}

const settled = (page: Page) => expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
const tray = (page: Page) => page.getByRole("table", { name: "Unscheduled milestones of the team" });
const timeline = (page: Page) => page.getByRole("grid", { name: "Team milestone timeline" });
/** The scheduled rows of the timeline, top to bottom (only this spec's milestones carry the `e2e-tv-` prefix). */
const rows = (page: Page) => timeline(page).getByRole("row").filter({ hasText: "e2e-tv-ms" });
const facts = (page: Page) => page.getByRole("group", { name: "Team facts" });
const strip = (page: Page, week: string) => page.locator(`[data-week="${week}"]`);

async function openTeam(page: Page, world: World): Promise<void> {
  await page.goto(`/teams/${world.teamId}`);
  await expect(page.getByRole("heading", { level: 2, name: world.team })).toBeVisible();
}

/**
 * Do one schedule change and wait for its PUT; answers the status. The page ignores a change while its previous save is still running,
 * and every save is followed by a background reload of the view: that reload is registered BEFORE the change and awaited AFTER the PUT,
 * so the next step never starts while the page is still busy and a late reload can never overwrite it.
 */
async function change(page: Page, act: () => Promise<void>): Promise<number> {
  await settled(page);
  const reload = page.waitForResponse((r) => r.request().method() === "GET" && /\/api\/v1\/views\/team\/\d+$/.test(r.url()), { timeout: 15_000 });
  reload.catch(() => undefined); // no unhandled rejection when `act` fails first: the failure is `act`'s
  const [response] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === "PUT" && /\/api\/v1\/milestones\/\d+\/schedule$/.test(r.url())),
    act(),
  ]);
  await reload;
  await settled(page);
  return response.status();
}

test("the team's manager sets a capacity period with a WIP limit, schedules from the team page and reads the overloaded week and the WIP warning", async ({ page }) => {
  const world = await seedWorld();
  const first = uniqueText("e2e-tv-ms-a");
  const second = uniqueText("e2e-tv-ms-b");
  await seedMilestone(world, first, 10);
  await seedMilestone(world, second, 10);
  await world.api.dispose();

  await login(page, world.manager.email, world.manager.password);
  await openTeam(page, world);
  await expect(page.getByText("No capacity set")).toBeVisible();

  // A capacity period from a WEDNESDAY (any date is accepted), 8 man-days per week, at most one milestone in progress.
  await page.getByRole("button", { name: "Add period" }).click();
  const period = page.getByRole("dialog", { name: "Add a capacity period" });
  await fillDate(period, "Effective from", "2027-02-03");
  await period.getByLabel("Man-days per week").fill("8");
  await period.getByLabel("WIP limit", { exact: true }).fill("1");
  await Promise.all([
    page.waitForResponse((r) => r.request().method() === "POST" && /\/api\/v1\/teams\/\d+\/capacity$/.test(r.url()) && r.ok()),
    period.getByRole("button", { name: "Create", exact: true }).click(),
  ]);
  await expect(period).toHaveCount(0);
  const periods = page.getByRole("table", { name: "Capacity periods of the team" });
  await expect(periods.getByRole("row").nth(1)).toContainText("2027-02-03");
  await expect(periods.getByRole("row").nth(1).getByRole("cell").nth(1)).toHaveText("8");
  await expect(periods.getByRole("row").nth(1).getByRole("cell").nth(2)).toHaveText("1");

  // The first milestone is scheduled from the tray's row menu: 2027-02-01 to 2027-02-05 carries 10 MD against the prorated 4.80.
  expect(
    await change(page, async () => {
      await rowOperation(page, first, `Edit schedule of ${first}`);
      const dialog = page.getByRole("dialog", { name: `Schedule of ${first}` });
      await fillDate(dialog, "Start date", "2027-02-01");
      await fillDate(dialog, "End date", "2027-02-05");
      await dialog.getByRole("button", { name: "Save" }).click();
    }),
  ).toBe(200);
  await expect(strip(page, "2027-02-01")).toHaveAttribute("data-overloaded", "true");
  await expect(facts(page)).toContainText("1 week overloaded");
  await page.getByRole("button", { name: "Show the weekly figures" }).click();
  const weekly = page.getByRole("table", { name: "Weekly load of the team" });
  const week = weekly.getByRole("row").filter({ hasText: "2027-02-01" });
  await expect(week.getByRole("cell").nth(2)).toHaveText("4.80");
  await expect(week.getByRole("cell").nth(3)).toHaveText("1");
  await expect(week).toContainText("Overloaded · +5.20 MD");
  await expect(week).not.toContainText("Over WIP limit");

  // The second one: the tray's Schedule places it for a week from today and it leaves the tray ...
  expect(await change(page, () => page.getByRole("button", { name: `Schedule ${second}`, exact: true }).click())).toBe(200);
  await expect(tray(page)).toHaveCount(0);
  await expect(page.getByText("Every milestone is scheduled.")).toBeVisible();
  // ... and its row menu moves it onto the same days 2027-02-04 to 2027-02-05: two milestones in progress against a limit of one.
  expect(
    await change(page, async () => {
      await rowOperation(page, second, `Edit schedule of ${second}`);
      const dialog = page.getByRole("dialog", { name: `Schedule of ${second}` });
      await fillDate(dialog, "Start date", "2027-02-04");
      await fillDate(dialog, "End date", "2027-02-05");
      await dialog.getByRole("button", { name: "Save" }).click();
    }),
  ).toBe(200);
  await expect(strip(page, "2027-02-01")).toHaveAttribute("data-wip-exceeded", "true");
  await expect(facts(page)).toContainText("1 week over WIP limit");
  const exceeded = weekly.getByRole("row").filter({ hasText: "2027-02-01" });
  await expect(exceeded.getByRole("cell").nth(3)).toHaveText("2");
  await expect(exceeded).toContainText("Over WIP limit");
});

test("the manager moves a milestone to the bottom, sees the custom order, and resets it", async ({ page }) => {
  const world = await seedWorld();
  const first = uniqueText("e2e-tv-ms-a");
  const second = uniqueText("e2e-tv-ms-b");
  await scheduleViaApi(world, await seedMilestone(world, first, 3), "2027-02-01", "2027-02-05");
  await scheduleViaApi(world, await seedMilestone(world, second, 3), "2027-02-08", "2027-02-12");
  await world.api.dispose();

  await login(page, world.manager.email, world.manager.password);
  await openTeam(page, world);
  // No override yet: the project rank's default order (same project, so by start date).
  await expect(rows(page)).toHaveText([new RegExp(first), new RegExp(second)]);
  await expect(facts(page)).not.toContainText("Custom order");

  await settled(page);
  await Promise.all([
    page.waitForResponse((r) => r.request().method() === "PUT" && /\/api\/v1\/teams\/\d+\/milestone-order$/.test(r.url()) && r.ok()),
    rowOperation(page, first, `Move ${first} to bottom`),
  ]);
  await expect(rows(page)).toHaveText([new RegExp(second), new RegExp(first)]);
  await expect(facts(page)).toContainText("Custom order");
  await expect(page.getByRole("status").filter({ hasText: `${first} moved to position 2 of 2` })).toBeAttached();
  await settled(page);

  await page.getByRole("button", { name: "Reset order" }).click();
  const confirm = page.getByRole("dialog", { name: "Reset the order?" });
  await expect(confirm).toContainText("project rank");
  await Promise.all([
    page.waitForResponse((r) => r.request().method() === "PUT" && /\/api\/v1\/teams\/\d+\/milestone-order$/.test(r.url()) && r.ok()),
    confirm.getByRole("button", { name: "Reset", exact: true }).click(),
  ]);
  await expect(rows(page)).toHaveText([new RegExp(first), new RegExp(second)]);
  await expect(facts(page)).not.toContainText("Custom order");
  await expect(confirm).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Reset order" })).toBeDisabled();
});

test("the project owner reads the team page without the manager's controls", async ({ page }) => {
  const world = await seedWorld();
  const first = uniqueText("e2e-tv-ms-a");
  const second = uniqueText("e2e-tv-ms-b");
  await scheduleViaApi(world, await seedMilestone(world, first, 3), "2027-02-01", "2027-02-05");
  await seedMilestone(world, second, 3);
  await world.api.dispose();

  await login(page, world.owner.email, world.owner.password);
  await openTeam(page, world);
  await expect(rows(page)).toHaveCount(1);
  await expect(facts(page)).toContainText("2 milestones");
  await expect(facts(page)).toContainText("1 scheduled");
  // The bar is a read-only image; nothing to pick up, resize, schedule, order or edit.
  await expect(page.getByRole("img", { name: new RegExp(`^${first}, .*, read-only$`) })).toBeVisible();
  await expect(page.getByRole("button", { name: new RegExp(`^${first}, `) })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^(Add period|Reset order|Schedule |Resize)/ })).toHaveCount(0);
  await expect(page.locator('[class*="timelineRowHandle"]')).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Edit$/ })).toHaveCount(0);
  await expect(page.getByText("manager or an administrator schedules them")).toBeVisible();
  await expect(page.getByText("No capacity set")).toBeVisible();
  await expect(page.getByText("The team's manager or an administrator sets the capacity.")).toBeVisible();
  // The row menu offers the project link and nothing that changes the plan or the order.
  await page.getByRole("button", { name: `Operations for ${first}` }).click();
  await expect(page.getByRole("menuitem", { name: /^Open project / })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /Move|schedule/i })).toHaveCount(0);
});
