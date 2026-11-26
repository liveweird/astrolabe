// The Roadmap's dependency panel (the Dependencies page of 1.20, whose list it became in 1.29; /dependencies is a redirect into it): every dependency of the plan,
// the violated ones first, its Status, Team and project filters in the URL (`dependencies`, `dependencyTeamId`, `dependencyProjectId`), and the ways into it (the
// Roadmap's row menu, the team page's facts line, Home's violated-dependencies badge, an old /dependencies bookmark). The plan is shared by four workers, so
// the panel is always narrowed to this spec's own project or team before a row is counted; Home's badge opens the plan-wide violated list, where the spec
// only looks for its own link. Owns: its throwaway person, ONE team (no manager), work stream, program and two projects in June 2027 (unique
// `e2e-deplist-*` names): the first holds milestones A (2027-06-07..11), B (2027-05-24..28) and C (2027-06-21..25), the second D (not scheduled);
// the links are A -> B (finish-to-start: B ends long before A does, violated by weeks whatever a holiday does), A -> C (kept with a week to spare)
// and D -> C (D is not scheduled). All seeded through the API in the test and removed through the API (the projects first - their milestones and
// links go with them - then program, work stream, team, person), even after a failure. It writes no ranking, no holiday and no connection, and needs
// no lock. The shortfall is matched by a pattern, never a number. The Team select lists every team of the plan (read to the end, 1.21), so the number
// of other specs' teams cannot hide this spec's own from it. The 1.22 test (edit and delete from the list) also owns two throwaway logins
// (`e2e-deplist-owner-*`, whose person owns the whole tree, and `e2e-deplist-nobody-*`, linked to no person), created and removed through the API too.
// The 1.27 test (add from the list) also owns a foreign person, work stream, program and project (`e2e-deplist-foreign-*`) and the one link it adds.
import { randomUUID } from "node:crypto";
import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { apiAsAdmin, deleteViaApi, expect, login, rowOperation, test, uniqueText } from "./helpers";

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

/**
 * A project the owner of the world may NOT manage: its own person, work stream, program and project (unique `e2e-deplist-foreign-*` names), seeded after the
 * world so the teardown, in reverse, removes it first. Answers the project's name.
 */
async function seedForeignProject(): Promise<string> {
  const { api } = await apiAsAdmin();
  try {
    const person = await seed(api, "/api/v1/people", { name: uniqueText("e2e-deplist-foreign-person") }, "/api/v1/people");
    const stream = await seed(api, "/api/v1/work-streams", { name: uniqueText("e2e-deplist-foreign-stream"), ownerPersonId: person, startDate: "2026-01-05" }, "/api/v1/work-streams");
    const program = await seed(api, `/api/v1/work-streams/${stream}/programs`, { name: uniqueText("e2e-deplist-foreign-program"), ownerPersonId: person }, "/api/v1/programs");
    const name = uniqueText("e2e-deplist-foreign-proj");
    await seed(api, `/api/v1/programs/${program}/projects`, { name, ownerPersonId: person }, "/api/v1/projects");
    return name;
  } finally {
    await api.dispose();
  }
}

/** The body rows of the panel's table (the scroll region around it carries the same name, hence the role). */
const rows = (page: Page): Locator => page.getByRole("table", { name: "Dependencies of the plan", exact: true }).locator("tbody tr");

/** The Roadmap's dependency panel: a region named by its h3 (the Roadmap has other "Filters" toggles, so everything of the list is looked up inside it). */
const panelOf = (page: Page): Locator => page.getByRole("region", { name: "Dependencies", exact: true });

const heading = (page: Page): Locator => panelOf(page).getByRole("heading", { level: 3, name: "Dependencies", exact: true });

/** Open the panel's own Filters (the Roadmap's toggle is another button). */
async function openPanelFilters(page: Page): Promise<void> {
  const toggle = panelOf(page).getByRole("button", { name: /^Filters/ });
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
}

/** The Roadmap with the panel opened by its address, narrowed to one project (the mode is the one last used: the panel is the same in both). */
const projectPanel = (projectId: number): string => `/roadmap?dependencies=all&dependencyProjectId=${projectId}`;

test("the Roadmap's dependency panel lists a project's links with the violated one first, and the status filter narrows them", async ({ page }) => {
  const world = await seedWorld();
  await login(page);

  // Opened and narrowed to the first project by its address: the chip names it, and the three links with an end in it are the spec's own.
  await page.goto(projectPanel(world.first.id));
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
  await openPanelFilters(page);
  await panelOf(page).getByRole("combobox", { name: "Status", exact: true }).click();
  await page.getByRole("option", { name: "Violated", exact: true }).click();
  await expect(page).toHaveURL(/[?&]dependencies=violated(&|$)/);
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

test("the roadmap's row menu, the team page and Home open the dependency panel filtered to that project, that team and the violated links", async ({ page }) => {
  const world = await seedWorld();
  await login(page);

  // The Roadmap narrowed to the spec's program (a remembered browser setting); the first project's row menu has the item.
  await page.evaluate(([key, value]) => localStorage.setItem(key, value), ["astrolabe.viewSettings.planning.programPick", JSON.stringify([world.programId])]);
  await page.getByRole("group", { name: "Planning" }).getByRole("link", { name: "Roadmap" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Roadmap" })).toBeVisible();
  await expect(page.getByRole("grid", { name: "Roadmap timeline" })).toBeVisible();
  await page.getByRole("button", { name: `Operations for ${world.first.name}`, exact: true }).click();
  await page.getByRole("menuitem", { name: `Dependencies of ${world.first.name}`, exact: true }).click();
  // An in-page action: the panel opens on the Roadmap's own address (its program pick stays), narrowed to the project, and takes the focus.
  await expect(page).toHaveURL(new RegExp(`/roadmap\\?.*dependencies=all&dependencyProjectId=${world.first.id}$`));
  await expect(heading(page)).toBeFocused();
  await expect(page.getByText(`Project: ${world.first.name}`, { exact: true })).toBeVisible();
  await expect(rows(page)).toHaveCount(3);

  // The team page's facts line: all the team's links, then only the violated one.
  await page.goto(`/teams/${world.teamId}`);
  await expect(page.getByRole("heading", { level: 2, name: world.team, exact: true })).toBeVisible();
  const facts = page.getByRole("group", { name: "Team facts", exact: true });
  await facts.getByRole("link", { name: "3 dependencies: the dependencies of this team's milestones", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/roadmap\\?.*dependencies=all&dependencyTeamId=${world.teamId}$`));
  await expect(heading(page)).toBeFocused();
  await openPanelFilters(page);
  await expect(panelOf(page).getByRole("combobox", { name: "Team", exact: true })).toHaveValue(world.team);
  await expect(rows(page)).toHaveCount(3);
  await page.goBack();
  await expect(page.getByRole("heading", { level: 2, name: world.team, exact: true })).toBeVisible();
  await page.getByRole("group", { name: "Team facts", exact: true }).getByRole("link", { name: "1 conflict: the violated dependencies of this team", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/roadmap\\?.*dependencies=violated&dependencyTeamId=${world.teamId}$`));
  await expect(rows(page)).toHaveCount(1);

  // Home's Roadmap card: the plan-wide violated list (N is never asserted - four workers share the plan), with the spec's own link among the rows.
  await page.goto("/");
  await page.getByRole("group", { name: "The roadmap in figures", exact: true }).getByRole("link", { name: /^\d+ violated dependenc(y|ies)$/ }).click();
  await expect(page).toHaveURL(/\/roadmap\?.*dependencies=violated$/);
  await expect(heading(page)).toBeFocused();
  await openPanelFilters(page);
  await expect(panelOf(page).getByRole("combobox", { name: "Status", exact: true })).toHaveValue("Violated");
  await expect(rows(page).filter({ hasText: world.a }).filter({ hasText: world.b })).toHaveCount(1);
});

// 1.29: the Dependencies page is gone; its address and its old filter names still work.
test("an old /dependencies bookmark lands on the Roadmap with the dependency panel open and its filters under the panel's names", async ({ page }) => {
  const world = await seedWorld();
  await login(page);

  await page.goto(`/dependencies?status=violated&projectId=${world.first.id}`);
  await expect(page).toHaveURL(new RegExp(`/roadmap\\?.*dependencies=violated&dependencyProjectId=${world.first.id}$`));
  await expect(heading(page)).toBeFocused();
  await expect(page.getByText(`Project: ${world.first.name}`, { exact: true })).toBeVisible();
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText(world.a);
  await expect(rows(page).first()).toContainText(world.b);
});

// 1.22: the list changes a link. The owner of the successor's project (every successor here is in the first project, whose person owns the whole
// tree) gets a menu on each row; a login linked to no person gets none. The spec's own project is the page's only scope, so no other worker's
// row is counted.
test("the owner of the successor's project changes a dependency's type and deletes it from the dependency panel, and a user who owns nothing gets no row menu", async ({ page }) => {
  const world = await seedWorld(true);
  const linkName = `${world.a} · ${world.first.name} → ${world.c} · ${world.first.name}`;
  const row = rows(page).filter({ hasText: world.a }).filter({ hasText: world.c });
  const menuButton = row.getByRole("button", { name: `Operations for ${linkName}`, exact: true });

  // The owner sees three rows, each with its menu; the one of A and C is named by both ends with their projects.
  await login(page, world.owner.email, world.owner.password);
  await page.goto(projectPanel(world.first.id));
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

  // "Delete" confirms and removes the row; the panel's heading takes the focus; the project's own page no longer lists the link.
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
  await page.goto(projectPanel(world.first.id));
  await expect(heading(page)).toBeVisible();
  await expect(rows(page)).toHaveCount(2);
  await expect(rows(page).getByRole("button")).toHaveCount(0);
  await expect(panelOf(page).getByRole("columnheader", { name: "Operations", exact: true })).toHaveCount(0);
});

// 1.27: the page adds a link. The button shows to whoever may manage at least one project (the plan view's `can.createDependency`), the dialog's first
// field picks the SUCCESSOR's project among those only, and the link is written on that project. The spec's own project is the page's scope, so no other
// worker's row is counted; the owner's two projects are the whole of the picker (their person owns this world's work stream and nothing else).
test("a project owner adds a dependency from the dependency panel choosing among the projects they manage, and a user who owns nothing is offered no button", async ({ page }) => {
  const world = await seedWorld(true);
  const foreign = await seedForeignProject();
  const addButton = page.getByRole("button", { name: "Add dependency", exact: true });

  // The owner opens the page narrowed to the first project; the chip names it only once the plan view has been read, which is also what the button waits for.
  await login(page, world.owner.email, world.owner.password);
  await page.goto(projectPanel(world.first.id));
  await expect(heading(page)).toBeVisible();
  await expect(page.getByText(`Project: ${world.first.name}`, { exact: true })).toBeVisible();
  await expect(rows(page)).toHaveCount(3);
  await expect(addButton).toBeVisible();
  await addButton.click();

  // The dialog opens on the page's project; its picker offers the two projects the owner manages and not the foreign one.
  const dialog = page.getByRole("dialog", { name: "Add dependency" });
  await expect(dialog).toBeVisible();
  const projectSelect = dialog.getByRole("combobox", { name: "Successor's project", exact: true });
  await expect(projectSelect).toHaveValue(world.first.name);
  await projectSelect.click();
  const options = page.getByRole("option");
  await expect(options.filter({ hasText: world.second.name })).toHaveCount(1);
  await expect(options.filter({ hasText: world.first.name })).toHaveCount(1);
  await expect(options.filter({ hasText: foreign })).toHaveCount(0);
  await expect(options).toHaveCount(2);

  // The second project: its only milestone D is the successor (the picker lists that project's milestones alone); B of the first project is the predecessor
  // (any project of the plan), so B -> D is written on the second project, whatever the page is filtered to.
  await page.getByRole("option", { name: world.second.name, exact: true }).click();
  await expect(projectSelect).toHaveValue(world.second.name);
  const successor = dialog.getByRole("combobox", { name: "Successor", exact: true });
  await successor.click();
  await expect(page.getByRole("option")).toHaveCount(1);
  await page.getByRole("option", { name: `${world.d} · ${world.second.name}`, exact: true }).click();
  const predecessor = dialog.getByRole("combobox", { name: "Predecessor", exact: true });
  await predecessor.click();
  await predecessor.fill(world.b);
  await page.getByRole("option", { name: `${world.b} · ${world.first.name}`, exact: true }).click();
  await expect(dialog.getByRole("combobox", { name: "Type", exact: true })).toHaveValue("Finish → Start (FS)");
  await Promise.all([
    page.waitForResponse((r) => r.request().method() === "POST" && new RegExp(`/api/v1/projects/${world.second.id}/dependencies$`).test(r.url()) && r.status() === 201),
    dialog.getByRole("button", { name: "Save", exact: true }).click(),
  ]);

  // The dialog is gone, the list refreshed (four links now touch the first project, the new one among them: D is not scheduled), the filter stays and the
  // focus is back on the button that opened it.
  await expect(dialog).toHaveCount(0);
  await expect(rows(page)).toHaveCount(4);
  const added = rows(page).filter({ hasText: world.b }).filter({ hasText: world.d });
  await expect(added).toHaveCount(1);
  await expect(added).toContainText("Not scheduled yet");
  await expect(page).toHaveURL(new RegExp(`/roadmap\\?.*dependencies=all&dependencyProjectId=${world.first.id}$`));
  await expect(page.getByText(`Project: ${world.first.name}`, { exact: true })).toBeVisible();
  await expect(addButton).toBeFocused();

  // A login linked to no person manages no project: the same page, read to the end (the chip names the project), has no button.
  await login(page, world.nobody.email, world.nobody.password);
  await page.goto(projectPanel(world.first.id));
  await expect(heading(page)).toBeVisible();
  await expect(page.getByText(`Project: ${world.first.name}`, { exact: true })).toBeVisible();
  await expect(rows(page)).toHaveCount(4);
  await expect(addButton).toHaveCount(0);
});

// 1.29: the Roadmap's and the Programs page's panel is the same list, hidden until asked for. The plan is shared by four workers, so every count is taken
// after the panel is narrowed to the spec's own project (its address names it).
test("the Roadmap and the Programs page hide the dependency list until asked for, then list a project's links with the filters in the address", async ({ page }) => {
  const world = await seedWorld();
  await login(page);

  // The Roadmap narrowed to the spec's program: the panel is hidden, nothing is listed, and showing it is a browser memory.
  await page.goto(`/roadmap?programId=${world.programId}`);
  await expect(page.getByRole("grid", { name: "Roadmap timeline" })).toBeVisible();
  const panel = page.getByRole("region", { name: "Dependencies", exact: true });
  await expect(panel.getByRole("button", { name: "Show the dependency list", exact: true })).toHaveAttribute("aria-expanded", "false");
  await expect(rows(page)).toHaveCount(0);
  await panel.getByRole("button", { name: "Show the dependency list", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Hide the dependency list", exact: true })).toBeFocused();
  await expect(panel.getByRole("table", { name: "Dependencies of the plan", exact: true })).toBeVisible();
  await page.reload();
  await expect(panel.getByRole("table", { name: "Dependencies of the plan", exact: true })).toBeVisible();

  // Narrowed to the first project by the address: the three links with an end in it, violated first; the status filter writes its own name, the
  // Roadmap's own parameters stay, and the panel's heading has the focus on arrival.
  await page.goto(`/roadmap?programId=${world.programId}&dependencies=all&dependencyProjectId=${world.first.id}`);
  await expect(panel.getByRole("heading", { level: 3, name: "Dependencies", exact: true })).toBeFocused();
  // On screen too: the focus waits for the page's own view, so the timeline arriving above never pushes the heading below the fold.
  await expect(panel.getByRole("heading", { level: 3, name: "Dependencies", exact: true })).toBeInViewport();
  await expect(rows(page)).toHaveCount(3);
  await expect(rows(page).nth(0).getByText(/^Violated · \d+ working days? short$/)).toBeVisible();
  await expect(rows(page).nth(1).getByText("OK", { exact: true })).toBeVisible();
  await expect(rows(page).nth(2).getByText("Not scheduled yet", { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: /^Filters/ }).click();
  await panel.getByRole("combobox", { name: "Status", exact: true }).click();
  await page.getByRole("option", { name: "Violated", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`programId=${world.programId}&dependencies=violated&dependencyProjectId=${world.first.id}$`));
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText(world.a);
  await expect(rows(page).first()).toContainText(world.b);

  // Hiding a panel the address opened takes its word away (the filters stay); the memory says "hidden" from now on.
  await panel.getByRole("button", { name: "Hide the dependency list", exact: true }).click();
  await expect(rows(page)).toHaveCount(0);
  await expect(page).not.toHaveURL(/dependencies=/);
  await expect(page).toHaveURL(new RegExp(`dependencyProjectId=${world.first.id}`));

  // The Programs page has the same panel, hidden, and the one memory.
  await page.goto(`/roadmap?mode=overview&programId=${world.programId}`);
  await expect(page.getByRole("grid", { name: "Programs timeline" })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Show the dependency list", exact: true })).toHaveAttribute("aria-expanded", "false");
  await page.goto(`/roadmap?mode=overview&programId=${world.programId}&dependencies=violated&dependencyProjectId=${world.first.id}`);
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText(world.b);
});
