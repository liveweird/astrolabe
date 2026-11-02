// Baselines (v0.9), in 2043: an administrator takes a baseline on /baselines, the plan moves under it (a milestone later, a new one, a deleted one), and
// the team's manager reads the movement on the team page (the picker, the shadow bars, the Movement table) and anyone reads the plan-wide comparison
// page; a reader sees the list without the write controls; an editor renames a baseline (the picker reads the new name) and deletes it (a page that had
// it picked falls back to no baseline).
// Owns: its throwaway users, people, team, plan nodes and milestones (unique `e2e-bl-*` names, every date in 2043, which nothing writes a holiday in), all
// seeded through the API and deleted by the afterEach below (the baselines first - a soft delete, the only delete there is, so the frozen rows stay by
// design - then the project, whose milestones go with it, program, work stream, team, people, users), and its throwaway BASELINES (unique `e2e-bl-*`
// names; baselines are plan-wide shared state, so no assertion here counts rows or assumes the list holds only these). The baseline pick is a browser
// setting, local to the test's own browser context: no other spec ever sees it.
import { randomUUID } from "node:crypto";
import type { APIRequestContext, Page } from "@playwright/test";
import { apiAsAdmin, deleteViaApi, expect, login, rowOperation, test, uniqueText } from "./helpers";

// Registered in creation order; torn down in reverse (a baseline before the project, a project before its program before its stream before the team and the people).
const teardown: string[] = [];
test.afterEach(async () => {
  await deleteViaApi(teardown.splice(0).reverse());
});

interface Account {
  email: string;
  password: string;
}

interface Milestone {
  id: number;
  name: string;
}

interface World {
  api: APIRequestContext;
  owner: Account;
  manager: Account;
  team: string;
  teamId: number;
  project: string;
  projectId: number;
  /** 3 MD, scheduled 2043-01-05..01-09 (Monday to Friday). */
  m1: Milestone;
  /** 2 MD, scheduled 2043-01-12..01-16. */
  m2: Milestone;
}

async function seed(api: APIRequestContext, path: string, data: object, tear: string): Promise<number> {
  const response = await api.post(path, { data });
  expect(response.status(), await response.text()).toBe(201);
  const id = ((await response.json()) as { id: number }).id;
  teardown.push(`${tear}/${id}`);
  return id;
}

async function seedUser(api: APIRequestContext, label: string): Promise<{ id: number; account: Account }> {
  const name = uniqueText(`e2e-bl-${label}`);
  const account = { email: `${name.toLowerCase()}@astrolabe.local`, password: randomUUID().replace(/-/g, "") };
  const id = await seed(api, "/api/v1/users", { name, email: account.email, password: account.password }, "/api/v1/users");
  return { id, account };
}

/** A milestone of the world's team through the API (unscheduled until `schedule`). */
async function seedMilestone(world: Pick<World, "api" | "projectId" | "teamId">, label: string, estimateMd: number): Promise<Milestone> {
  const name = uniqueText(`e2e-bl-${label}`);
  const response = await world.api.post(`/api/v1/projects/${world.projectId}/milestones`, { data: { name, teamId: world.teamId, estimateMd } });
  expect(response.status(), await response.text()).toBe(201);
  return { id: ((await response.json()) as { id: number }).id, name };
}

/** A schedule write as the ADMIN, with the team view's current plan revision (a client that has just read the view). */
async function schedule(world: Pick<World, "api" | "teamId">, milestone: Milestone, startDate: string, endDate: string): Promise<void> {
  const view = await world.api.get(`/api/v1/views/team/${world.teamId}`);
  const { revision } = (await view.json()) as { revision: number };
  const response = await world.api.put(`/api/v1/milestones/${milestone.id}/schedule`, { data: { expectedRevision: revision, startDate, endDate } });
  expect(response.status(), await response.text()).toBe(200);
}

/**
 * Two throwaway logins (a project OWNER and a team MANAGER, deliberately different people), a team the manager manages, a plan (work stream and
 * program owned by a third, login-less person) holding one project owned by the owner, and its two scheduled milestones `m1` and `m2`, both on the team.
 */
async function seedWorld(): Promise<World> {
  const { api } = await apiAsAdmin();
  const owner = await seedUser(api, "owner");
  const manager = await seedUser(api, "manager");
  const lead = await seed(api, "/api/v1/people", { name: uniqueText("e2e-bl-lead") }, "/api/v1/people");
  const ownerPerson = await seed(api, "/api/v1/people", { name: uniqueText("e2e-bl-ownerperson"), userId: owner.id }, "/api/v1/people");
  const managerPerson = await seed(api, "/api/v1/people", { name: uniqueText("e2e-bl-managerperson"), userId: manager.id }, "/api/v1/people");
  const team = uniqueText("e2e-bl-team");
  const teamId = await seed(api, "/api/v1/teams", { name: team, managerPersonId: managerPerson }, "/api/v1/teams");
  const streamId = await seed(api, "/api/v1/work-streams", { name: uniqueText("e2e-bl-stream"), ownerPersonId: lead, startDate: "2026-01-05" }, "/api/v1/work-streams");
  const programId = await seed(api, `/api/v1/work-streams/${streamId}/programs`, { name: uniqueText("e2e-bl-program"), ownerPersonId: lead }, "/api/v1/programs");
  const project = uniqueText("e2e-bl-project");
  const projectId = await seed(api, `/api/v1/programs/${programId}/projects`, { name: project, ownerPersonId: ownerPerson }, "/api/v1/projects");
  const partial = { api, owner: owner.account, manager: manager.account, team, teamId, project, projectId };
  const m1 = await seedMilestone(partial, "ms1", 3);
  const m2 = await seedMilestone(partial, "ms2", 2);
  await schedule(partial, m1, "2043-01-05", "2043-01-09");
  await schedule(partial, m2, "2043-01-12", "2043-01-16");
  return { ...partial, m1, m2 };
}

/** Take a baseline through the API as the administrator (the plan is copied as it is now); registers its soft delete. Answers its id. */
async function takeBaseline(world: Pick<World, "api">, name: string): Promise<number> {
  const response = await world.api.post("/api/v1/baselines", { data: { name } });
  expect(response.status(), await response.text()).toBe(201);
  const id = ((await response.json()) as { id: number }).id;
  teardown.push(`/api/v1/baselines/${id}`);
  return id;
}

/** Re-plan under the baseline: `m1` moves a week later onto `m2`'s days, and a new `m3` (2 MD) is scheduled 2043-01-19..01-21. */
async function replan(world: World): Promise<Milestone> {
  await schedule(world, world.m1, "2043-01-12", "2043-01-16");
  const m3 = await seedMilestone(world, "ms3", 2);
  await schedule(world, m3, "2043-01-19", "2043-01-21");
  return m3;
}

const settled = (page: Page) => expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
const shadows = (page: Page) => page.locator('[data-tone="baseline"]');
const picker = (page: Page) => page.getByLabel("Baseline", { exact: true });
const dates = (start: string, end: string) => `${start} – ${end}`;

async function openTeam(page: Page, world: World): Promise<void> {
  await page.goto(`/teams/${world.teamId}`);
  await expect(page.getByRole("heading", { level: 2, name: world.team })).toBeVisible();
  await expect(page.getByRole("grid", { name: "Team milestone timeline" })).toBeVisible();
  await settled(page);
}

/** Choose a baseline in the timeline toolbar's picker (the pick is stored in this browser and drives the view's `?baseline=`). */
async function pickBaseline(page: Page, name: string): Promise<void> {
  await picker(page).click();
  await page.getByRole("option", { name }).click();
  await expect(picker(page)).toHaveValue(new RegExp(name));
}

/** The cells of the Movement table's row of one milestone (the team page: milestone, project, baseline, current, start, end, estimate, status). */
const movementRow = (page: Page, name: string) => page.getByRole("table", { name: "Movement since the baseline" }).getByRole("row").filter({ hasText: name });

test("an editor takes a baseline and reads a milestone's movement on the team page", async ({ page }) => {
  const world = await seedWorld();
  const name = uniqueText("e2e-bl-take");

  // The administrator takes the baseline from the registry.
  await login(page);
  await page.goto("/baselines");
  await page.getByRole("button", { name: "Take baseline", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Take a baseline" });
  await dialog.getByLabel("Name").fill(name);
  const [created] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === "POST" && /\/api\/v1\/baselines$/.test(r.url())),
    dialog.getByRole("button", { name: "Take baseline", exact: true }).click(),
  ]);
  expect(created.status()).toBe(201);
  teardown.push(`/api/v1/baselines/${((await created.json()) as { id: number }).id}`);
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("link", { name: `Compare ${name} with the plan` })).toBeVisible();

  // The plan moves under it.
  const m3 = await replan(world);
  await world.api.dispose();

  // The team's manager picks the baseline: a shadow bar under each of the two milestones the baseline froze, none for the new one.
  await login(page, world.manager.email, world.manager.password);
  await openTeam(page, world);
  await expect(shadows(page)).toHaveCount(0);
  await pickBaseline(page, name);
  await expect(shadows(page)).toHaveCount(2);
  await settled(page);
  await expect(page.getByRole("img", { name: `Baseline: ${world.m1.name}, 2043-01-05 to 2043-01-09, 5 working days later (start and end), read-only` })).toBeAttached();
  await expect(page.getByRole("img", { name: `Baseline: ${world.m2.name}, 2043-01-12 to 2043-01-16, read-only` })).toBeAttached();

  // The Movement table: m1 five working days later at both ends (the "Later" badge), m3 new; m2, unchanged, is hidden until "Changed only" is off.
  await expect(page.getByRole("heading", { level: 3, name: `Movement vs baseline ${name}` })).toBeVisible();
  await page.getByRole("button", { name: "Show the movement" }).click();
  const first = movementRow(page, world.m1.name).getByRole("cell");
  await expect(first.nth(0)).toHaveText(world.m1.name);
  await expect(first.nth(1)).toHaveText(world.project);
  await expect(first.nth(2)).toHaveText(dates("2043-01-05", "2043-01-09"));
  await expect(first.nth(3)).toHaveText(dates("2043-01-12", "2043-01-16"));
  await expect(first.nth(4)).toHaveText("+5");
  await expect(first.nth(5)).toHaveText("+5");
  await expect(first.nth(6)).toHaveText("3");
  await expect(first.nth(7)).toHaveText("Later");
  const added = movementRow(page, m3.name).getByRole("cell");
  await expect(added.nth(2)).toHaveText("—");
  await expect(added.nth(3)).toHaveText(dates("2043-01-19", "2043-01-21"));
  await expect(added.nth(7)).toHaveText("New");
  await expect(movementRow(page, world.m2.name)).toHaveCount(0);
  await page.getByLabel("Changed only").uncheck({ force: true });
  await expect(movementRow(page, world.m2.name).getByRole("cell").nth(7)).toHaveText("Unchanged");
});

test("the comparison page lists the project's moved, new and removed milestones and the project's own movement", async ({ page }) => {
  const world = await seedWorld();
  const name = uniqueText("e2e-bl-compare");
  const id = await takeBaseline(world, name);
  const m3 = await replan(world);
  expect((await world.api.delete(`/api/v1/milestones/${world.m2.id}`)).status()).toBe(204);
  await world.api.dispose();

  // The project's span was 01-05..01-16 and is 01-12..01-21 now: the start is five working days later (Mon 01-05 -> Mon 01-12) and the end three
  // (Fri 01-16 -> Mon 19, Tue 20, Wed 21).
  await login(page, world.owner.email, world.owner.password);
  await page.goto(`/baselines/${id}`);
  await expect(page.getByRole("heading", { level: 2, name })).toBeVisible();
  await page.getByLabel("Project", { exact: true }).fill(world.project);
  const projectRow = page.getByRole("row").filter({ has: page.getByRole("link", { name: `Open project ${world.project}` }) });
  await expect(projectRow).toHaveCount(1);
  await expect(projectRow).toContainText("start 5 working days later, end 3 working days later");
  await expect(projectRow).toContainText("Milestones: 1 end later, 1 new, 1 removed");
  const span = projectRow.getByRole("cell");
  await expect(span.nth(1)).toHaveText(dates("2043-01-05", "2043-01-16"));
  await expect(span.nth(2)).toHaveText(dates("2043-01-12", "2043-01-21"));
  await expect(span.nth(3)).toHaveText("+5");
  await expect(span.nth(4)).toHaveText("+3");
  await expect(span.nth(6)).toHaveText("Later");

  const rows = page.getByRole("table", { name: "Changes since the baseline" }).getByRole("row");
  const moved = rows.filter({ hasText: world.m1.name }).getByRole("cell");
  await expect(moved.nth(2)).toHaveText(dates("2043-01-05", "2043-01-09"));
  await expect(moved.nth(3)).toHaveText(dates("2043-01-12", "2043-01-16"));
  await expect(moved.nth(4)).toHaveText("+5");
  await expect(moved.nth(5)).toHaveText("+5");
  await expect(moved.nth(7)).toHaveText("Later");
  const added = rows.filter({ hasText: m3.name }).getByRole("cell");
  await expect(added.nth(2)).toHaveText("—");
  await expect(added.nth(3)).toHaveText(dates("2043-01-19", "2043-01-21"));
  await expect(added.nth(6)).toHaveText("2");
  await expect(added.nth(7)).toHaveText("New");
  const removed = rows.filter({ hasText: world.m2.name }).getByRole("cell");
  await expect(removed.nth(2)).toHaveText(dates("2043-01-12", "2043-01-16"));
  await expect(removed.nth(3)).toHaveText("—");
  await expect(removed.nth(7)).toHaveText("Removed");
});

test("a reader opens the baselines list without the Take baseline button and the row menu", async ({ page }) => {
  const world = await seedWorld();
  const name = uniqueText("e2e-bl-reader");
  const id = await takeBaseline(world, name);
  await world.api.dispose();

  // The project owner has no baseline right (ADMIN or a ROADMAP_EDITOR grant): the list is read-only.
  await login(page, world.owner.email, world.owner.password);
  await page.goto("/baselines");
  await expect(page.getByRole("heading", { level: 2, name: "Baselines" })).toBeVisible();
  const link = page.getByRole("link", { name: `Compare ${name} with the plan` });
  await expect(link).toBeVisible();
  await expect(page.getByRole("button", { name: "Take baseline" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: `Operations for ${name}` })).toHaveCount(0);

  // The comparison opens for a reader: the unchanged plan.
  await link.click();
  await expect(page).toHaveURL(new RegExp(`/baselines/${id}$`));
  await expect(page.getByRole("heading", { level: 2, name })).toBeVisible();
  await expect(page.getByRole("group", { name: "Baseline facts" })).toContainText("Taken");
});

test("an editor renames and deletes a baseline, and a page that had it picked falls back to none", async ({ page }) => {
  const world = await seedWorld();
  const name = uniqueText("e2e-bl-rename");
  const renamed = uniqueText("e2e-bl-renamed");
  const id = await takeBaseline(world, name);
  await world.api.dispose();

  // Pick the baseline on the team page: one shadow bar per frozen milestone.
  await login(page);
  await openTeam(page, world);
  await pickBaseline(page, name);
  await expect(shadows(page)).toHaveCount(2);

  // Rename it in the registry; the page that had it picked reads the new name.
  await page.goto("/baselines");
  await rowOperation(page, name, `Rename ${name}`);
  const dialog = page.getByRole("dialog", { name: "Rename baseline" });
  await dialog.getByLabel("Name").fill(renamed);
  await Promise.all([
    page.waitForResponse((r) => r.request().method() === "PUT" && r.url().endsWith(`/api/v1/baselines/${id}`) && r.ok()),
    dialog.getByRole("button", { name: "Save", exact: true }).click(),
  ]);
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("link", { name: `Compare ${renamed} with the plan` })).toBeVisible();
  await openTeam(page, world);
  await expect(picker(page)).toHaveValue(new RegExp(renamed));
  await expect(shadows(page)).toHaveCount(2);

  // Delete it (behind its confirmation): the stored pick now names nothing, and the team page falls back to no baseline.
  await page.goto("/baselines");
  await rowOperation(page, renamed, `Delete ${renamed}`);
  await Promise.all([
    page.waitForResponse((r) => r.request().method() === "DELETE" && r.url().endsWith(`/api/v1/baselines/${id}`) && r.ok()),
    page.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).click(),
  ]);
  await expect(page.getByRole("link", { name: `Compare ${renamed} with the plan` })).toHaveCount(0);
  await openTeam(page, world);
  await expect(picker(page)).toHaveValue("None");
  await expect(shadows(page)).toHaveCount(0);
  await expect(page.getByRole("grid", { name: "Team milestone timeline" }).getByRole("row").filter({ hasText: world.m1.name })).toBeVisible();
});
