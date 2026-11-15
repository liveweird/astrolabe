// The Dependencies page (/dependencies, 1.20): every dependency of the plan, the violated ones first, its Status, Team and project filters in the URL,
// and the ways into it (the Roadmap's row menu, the team page's facts line, Home's violated-dependencies badge). The plan is shared by four workers, so
// the page is always narrowed to this spec's own project or team before a row is counted; Home's badge opens the plan-wide violated list, where the spec
// only looks for its own link. Owns: its throwaway person, ONE team (no manager), work stream, program and two projects in June 2027 (unique
// `e2e-deplist-*` names): the first holds milestones A (2027-06-07..11), B (2027-05-24..28) and C (2027-06-21..25), the second D (not scheduled);
// the links are A -> B (finish-to-start: B ends long before A does, violated by weeks whatever a holiday does), A -> C (kept with a week to spare)
// and D -> C (D is not scheduled). All seeded through the API in the test and removed through the API (the projects first - their milestones and
// links go with them - then program, work stream, team, person), even after a failure. It writes no ranking, no holiday and no connection, and needs
// no lock. The shortfall is matched by a pattern, never a number. The Team select lists every team of the plan (read to the end, 1.21), so the number
// of other specs' teams cannot hide this spec's own from it. The 1.22 test (edit and delete from the list) also owns two throwaway logins
// (`e2e-deplist-owner-*`, whose person owns the whole tree, and `e2e-deplist-nobody-*`, linked to no person), created and removed through the API too.
import { randomUUID } from "node:crypto";
import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { apiAsAdmin, deleteViaApi, expect, login, openFilters, rowOperation, test, uniqueText } from "./helpers";

// Registered in creation order; torn down in reverse (the projects before their program before its stream before the team and the person).
const teardown: string[] = [];
test.afterEach(async () => {
  await deleteViaApi(teardown.splice(0).reverse());
});

async function seed(api: APIRequestContext, path: string, data: object, tear?: string): Promise<number> {
  const response = await api.post(path, { data });
  expect(response.status(), await response.text()).toBe(201);
  const id = ((await response.json()) as { id: number }).id;
  if (tear !== undefined) teardown.push(`${tear}/${id}`);
  return id;
}

interface Account {
  email: string;
  password: string;
}

interface World {
  team: string;
  teamId: number;
  programId: number;
  /** The first project (milestones A, B, C) and the second (milestone D). */
  first: { id: number; name: string };
  second: { id: number; name: string };
  a: string;
  b: string;
  c: string;
  d: string;
}

/** Schedule a milestone with the project view's current revision (a client that has just read the view). */
async function schedule(api: APIRequestContext, projectId: number, milestoneId: number, startDate: string, endDate: string): Promise<void> {
  // The revision is the plan's: another worker's write between the read and the PUT is a 409, so read again and retry
  // (the `updateRankingViaApi` idiom).
  for (let attempt = 0; attempt < 10; attempt++) {
    const view = (await (await api.get(`/api/v1/views/project/${projectId}`)).json()) as { revision: number };
    const put = await api.put(`/api/v1/milestones/${milestoneId}/schedule`, { data: { expectedRevision: view.revision, startDate, endDate } });
    if (put.status() === 200) return;
    expect(put.status(), await put.text()).toBe(409);
  }
  throw new Error(`milestone ${milestoneId}: the schedule stayed stale after 10 attempts`);
}

/** A USER login (not an administrator) with a generated password, removed in the afterEach. */
async function seedUser(api: APIRequestContext, label: string): Promise<{ id: number; account: Account }> {
  const name = uniqueText(`e2e-deplist-${label}`);
  const account = { email: `${name.toLowerCase()}@astrolabe.local`, password: randomUUID().replace(/-/g, "") };
  const id = await seed(api, "/api/v1/users", { name, email: account.email, password: account.password }, "/api/v1/users");
  return { id, account };
}

interface Logins {
  /** The login of the person who owns the work stream, the program and both projects. */
  owner: Account;
  /** A login linked to no person. */
  nobody: Account;
}

async function seedWorld(): Promise<World>;
async function seedWorld(withLogins: true): Promise<World & Logins>;
async function seedWorld(withLogins = false): Promise<World | (World & Logins)> {
  const { api } = await apiAsAdmin();
  try {
    const owner = withLogins ? await seedUser(api, "owner") : null;
    const nobody = withLogins ? await seedUser(api, "nobody") : null;
    const person = await seed(api, "/api/v1/people", { name: uniqueText("e2e-deplist-person"), ...(owner === null ? {} : { userId: owner.id }) }, "/api/v1/people");
    const team = uniqueText("e2e-deplist-team");
    const teamId = await seed(api, "/api/v1/teams", { name: team }, "/api/v1/teams");
    const stream = await seed(api, "/api/v1/work-streams", { name: uniqueText("e2e-deplist-stream"), ownerPersonId: person, startDate: "2026-01-05" }, "/api/v1/work-streams");
    const programId = await seed(api, `/api/v1/work-streams/${stream}/programs`, { name: uniqueText("e2e-deplist-program"), ownerPersonId: person }, "/api/v1/programs");
    const project = async (label: string) => {
      const name = uniqueText(`e2e-deplist-proj-${label}`);
      return { id: await seed(api, `/api/v1/programs/${programId}/projects`, { name, ownerPersonId: person }, "/api/v1/projects"), name };
    };
    const first = await project("one");
    const second = await project("two");
    const milestone = async (projectId: number, name: string) => seed(api, `/api/v1/projects/${projectId}/milestones`, { name, teamId, estimateMd: 2 });
    const [a, b, c, d] = ["a", "b", "c", "d"].map((label) => uniqueText(`e2e-deplist-ms-${label}`));
    const aId = await milestone(first.id, a);
    const bId = await milestone(first.id, b);
    const cId = await milestone(first.id, c);
    const dId = await milestone(second.id, d);
    await schedule(api, first.id, aId, "2027-06-07", "2027-06-11");
    await schedule(api, first.id, bId, "2027-05-24", "2027-05-28");
    await schedule(api, first.id, cId, "2027-06-21", "2027-06-25");
    // A link is written on its successor's project.
    const link = async (predecessor: number, successor: number, projectId: number) =>
      seed(api, `/api/v1/projects/${projectId}/dependencies`, { predecessor: { kind: "MILESTONE", id: predecessor }, successor: { kind: "MILESTONE", id: successor }, type: "FS", lagDays: 0 });
    await link(aId, bId, first.id);
    await link(aId, cId, first.id);
    await link(dId, cId, first.id);
    const world = { team, teamId, programId, first, second, a, b, c, d };
    return owner === null || nobody === null ? world : { ...world, owner: owner.account, nobody: nobody.account };
  } finally {
    await api.dispose();
  }
}

/** The body rows of the page's table (the scroll region around it carries the same name, hence the role). */
const rows = (page: Page): Locator => page.getByRole("table", { name: "Dependencies of the plan", exact: true }).locator("tbody tr");

const heading = (page: Page): Locator => page.getByRole("heading", { level: 2, name: "Dependencies", exact: true });

test("the Dependencies page lists a project's links with the violated one first, and the status filter narrows them", async ({ page }) => {
  const world = await seedWorld();
  await login(page);

  // Narrowed to the first project by its address: the chip names it, and the three links with an end in it are the spec's own.
  await page.goto(`/dependencies?projectId=${world.first.id}`);
  await expect(heading(page)).toBeVisible();
  await expect(page.getByText(`Project: ${world.first.name}`, { exact: true })).toBeVisible();
  await expect(rows(page)).toHaveCount(3);
  await expect(rows(page).nth(0).getByText(/^Violated · \d+ working days? short$/)).toBeVisible();
  await expect(rows(page).nth(1).getByText("OK", { exact: true })).toBeVisible();
  await expect(rows(page).nth(2).getByText("Not scheduled yet", { exact: true })).toBeVisible();
  // Each end shows its milestone, its project and the team.
  await expect(rows(page).nth(0)).toContainText(world.a);
  await expect(rows(page).nth(0)).toContainText(world.b);
  await expect(rows(page).nth(1)).toContainText(world.a);
  await expect(rows(page).nth(1)).toContainText(world.c);
  await expect(rows(page).nth(2)).toContainText(world.d);
  await expect(rows(page).nth(2)).toContainText(world.c);
  await expect(rows(page).nth(2)).toContainText(world.second.name);
  for (const index of [0, 1, 2]) {
    await expect(rows(page).nth(index)).toContainText(world.first.name);
    await expect(rows(page).nth(index)).toContainText(world.team);
  }

  // "Violated" leaves the one link that does not hold, in the address too, and survives a reload.
  await openFilters(page);
  await page.getByRole("combobox", { name: "Status", exact: true }).click();
  await page.getByRole("option", { name: "Violated", exact: true }).click();
  await expect(page).toHaveURL(/[?&]status=violated(&|$)/);
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText(world.a);
  await expect(rows(page).first()).toContainText(world.b);
  await page.reload();
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText(world.b);

  // The predecessor's project name is the way into its page.
  await rows(page).first().getByRole("cell").nth(1).getByRole("link", { name: `Open ${world.first.name}`, exact: true }).click();
  await expect(page.getByRole("heading", { level: 2, name: world.first.name, exact: true })).toBeVisible();
});

test("the roadmap's row menu, the team page and Home open the Dependencies page filtered to that project, that team and the violated links", async ({ page }) => {
  const world = await seedWorld();
  await login(page);

  // The Roadmap narrowed to the spec's program (a remembered browser setting); the first project's row menu has the item.
  await page.evaluate(([key, value]) => localStorage.setItem(key, value), ["astrolabe.viewSettings.planning.programPick", JSON.stringify([world.programId])]);
  await page.getByRole("group", { name: "Planning" }).getByRole("link", { name: "Roadmap" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Roadmap" })).toBeVisible();
  await expect(page.getByRole("grid", { name: "Roadmap timeline" })).toBeVisible();
  await page.getByRole("button", { name: `Operations for ${world.first.name}`, exact: true }).click();
  await page.getByRole("menuitem", { name: `Dependencies of ${world.first.name}`, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/dependencies\\?projectId=${world.first.id}$`));
  await expect(heading(page)).toBeVisible();
  await expect(page.getByText(`Project: ${world.first.name}`, { exact: true })).toBeVisible();
  await expect(rows(page)).toHaveCount(3);

  // The team page's facts line: all the team's links, then only the violated one.
  await page.goto(`/teams/${world.teamId}`);
  await expect(page.getByRole("heading", { level: 2, name: world.team, exact: true })).toBeVisible();
  const facts = page.getByRole("group", { name: "Team facts", exact: true });
  await facts.getByRole("link", { name: "3 dependencies: the dependencies of this team's milestones", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/dependencies\\?teamId=${world.teamId}$`));
  await expect(heading(page)).toBeVisible();
  await openFilters(page);
  await expect(page.getByRole("combobox", { name: "Team", exact: true })).toHaveValue(world.team);
  await expect(rows(page)).toHaveCount(3);
  await page.goBack();
  await expect(page.getByRole("heading", { level: 2, name: world.team, exact: true })).toBeVisible();
  await page.getByRole("group", { name: "Team facts", exact: true }).getByRole("link", { name: "1 conflict: the violated dependencies of this team", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/dependencies\\?status=violated&teamId=${world.teamId}$`));
  await expect(rows(page)).toHaveCount(1);

  // Home's Roadmap card: the plan-wide violated list (N is never asserted - four workers share the plan), with the spec's own link among the rows.
  await page.goto("/");
  await page.getByRole("group", { name: "The roadmap in figures", exact: true }).getByRole("link", { name: /^\d+ violated dependenc(y|ies)$/ }).click();
  await expect(page).toHaveURL(/\/dependencies\?status=violated$/);
  await expect(heading(page)).toBeVisible();
  await openFilters(page);
  await expect(page.getByRole("combobox", { name: "Status", exact: true })).toHaveValue("Violated");
  await expect(rows(page).filter({ hasText: world.a }).filter({ hasText: world.b })).toHaveCount(1);
});

// 1.22: the list changes a link. The owner of the successor's project (every successor here is in the first project, whose person owns the whole
// tree) gets a menu on each row; a login linked to no person gets none. The spec's own project is the page's only scope, so no other worker's
// row is counted.
test("the owner of the successor's project changes a dependency's type and deletes it from the Dependencies page, and a user who owns nothing gets no row menu", async ({ page }) => {
  const world = await seedWorld(true);
  const linkName = `${world.a} · ${world.first.name} → ${world.c} · ${world.first.name}`;
  const row = rows(page).filter({ hasText: world.a }).filter({ hasText: world.c });
  const menuButton = row.getByRole("button", { name: `Operations for ${linkName}`, exact: true });

  // The owner sees three rows, each with its menu; the one of A and C is named by both ends with their projects.
  await login(page, world.owner.email, world.owner.password);
  await page.goto(`/dependencies?projectId=${world.first.id}`);
  await expect(heading(page)).toBeVisible();
  await expect(rows(page)).toHaveCount(3);
  await expect(rows(page).getByRole("button", { name: /^Operations for / })).toHaveCount(3);
  await expect(menuButton).toBeVisible();

  // "Edit…" opens the project page's dialog (both ends read-only, each with its project); the new type shows in the row and the focus returns to the menu.
  await rowOperation(page, linkName, `Edit ${linkName}`);
  const dialog = page.getByRole("dialog", { name: "Edit dependency" });
  await expect(dialog.getByRole("textbox", { name: "Predecessor" })).toHaveValue(`${world.a} · ${world.first.name}`);
  await expect(dialog.getByRole("textbox", { name: "Successor" })).toHaveValue(`${world.c} · ${world.first.name}`);
  await dialog.getByRole("combobox", { name: "Type" }).click();
  await page.getByRole("option", { name: "Start → Start (SS)", exact: true }).click();
  await Promise.all([
    page.waitForResponse((r) => r.request().method() === "PUT" && /\/api\/v1\/dependencies\/\d+$/.test(r.url()) && r.status() === 204),
    dialog.getByRole("button", { name: "Save", exact: true }).click(),
  ]);
  await expect(dialog).toHaveCount(0);
  await expect(row).toContainText("Start → Start (SS)");
  await expect(menuButton).toBeFocused();

  // "Delete" confirms and removes the row; the page title takes the focus; the project's own page no longer lists the link.
  await rowOperation(page, linkName, `Delete ${linkName}`);
  const confirm = page.getByRole("dialog", { name: "Delete dependency?" });
  await Promise.all([
    page.waitForResponse((r) => r.request().method() === "DELETE" && /\/api\/v1\/dependencies\/\d+$/.test(r.url()) && r.status() === 204),
    confirm.getByRole("button", { name: "Delete", exact: true }).click(),
  ]);
  await expect(confirm).toHaveCount(0);
  await expect(rows(page)).toHaveCount(2);
  await expect(heading(page)).toBeFocused();
  await page.goto(`/projects/${world.first.id}`);
  const projectLinks = page.getByRole("table", { name: "Dependencies of the project", exact: true }).locator("tbody tr");
  await expect(projectLinks).toHaveCount(2);
  await expect(projectLinks.filter({ hasText: world.a }).filter({ hasText: world.c })).toHaveCount(0);

  // A login that owns nothing reads the same two rows and is offered no menu and no operations column.
  await login(page, world.nobody.email, world.nobody.password);
  await page.goto(`/dependencies?projectId=${world.first.id}`);
  await expect(heading(page)).toBeVisible();
  await expect(rows(page)).toHaveCount(2);
  await expect(rows(page).getByRole("button")).toHaveCount(0);
  await expect(page.getByRole("columnheader", { name: "Operations", exact: true })).toHaveCount(0);
});
