// Dependencies on the project view (/projects/:id): a project owner links a milestone of one project to a milestone of another through
// the Add dependency dialog (searchable pickers), sees the other project's milestone as a ghost row with a link and the link as an
// arrow, and has a link that would close a cycle refused with the path named; the milestone's team manager moves the successor ahead
// of its predecessor and reads the conflict (the red arrow, the "1 conflict" badge, the table row with what it needs), and the
// owner deletes the link from the table. Owns: its throwaway users, people, team and plan nodes (unique `e2e-dep-*` names), all
// seeded through the API and deleted by the afterEach below (the projects first - their milestones and links go with them - then
// program, work stream, team, people, users).
import { randomUUID } from "node:crypto";
import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { apiAsAdmin, deleteViaApi, expect, login, rowOperation, test, uniqueText } from "./helpers";

// Registered in creation order; torn down in reverse (the projects before their program before its stream before the team and the people).
const teardown: string[] = [];
test.afterEach(async () => {
  await deleteViaApi(teardown.splice(0).reverse());
});

interface Account {
  email: string;
  password: string;
}

interface Project {
  id: number;
  name: string;
  milestoneId: number;
  milestone: string;
}

interface World {
  api: APIRequestContext;
  owner: Account;
  manager: Account;
  a: Project;
  b: Project;
}

async function seed(api: APIRequestContext, path: string, data: object, tear: string): Promise<number> {
  const response = await api.post(path, { data });
  expect(response.status(), await response.text()).toBe(201);
  const id = ((await response.json()) as { id: number }).id;
  teardown.push(`${tear}/${id}`);
  return id;
}

async function seedUser(api: APIRequestContext, label: string): Promise<{ id: number; account: Account }> {
  const name = uniqueText(`e2e-dep-${label}`);
  const account = { email: `${name.toLowerCase()}@astrolabe.local`, password: randomUUID().replace(/-/g, "") };
  const id = await seed(api, "/api/v1/users", { name, email: account.email, password: account.password }, "/api/v1/users");
  return { id, account };
}

/** A schedule write as the ADMIN, with the project view's current revision (a client that has just read the view). */
async function schedule(api: APIRequestContext, projectId: number, milestoneId: number, startDate: string, endDate: string): Promise<void> {
  const view = await api.get(`/api/v1/views/project/${projectId}`);
  const { revision } = (await view.json()) as { revision: number };
  const response = await api.put(`/api/v1/milestones/${milestoneId}/schedule`, { data: { expectedRevision: revision, startDate, endDate } });
  expect(response.status(), await response.text()).toBe(200);
}

/**
 * Two throwaway logins (a project OWNER - the person who owns the program, so both projects - and a team MANAGER who owns nothing),
 * a team the manager manages, and a plan under a login-less lead holding two projects A and B, each with one milestone: a1 (A)
 * scheduled 2027-02-01..05 and b1 (B) scheduled 2027-02-08..12 - b1 starts the working day after a1 ends, so a finish-to-start
 * link a1 -> b1 holds with no lag.
 */
async function seedWorld(): Promise<World> {
  const { api } = await apiAsAdmin();
  const owner = await seedUser(api, "owner");
  const manager = await seedUser(api, "manager");
  const lead = await seed(api, "/api/v1/people", { name: uniqueText("e2e-dep-lead") }, "/api/v1/people");
  const ownerPerson = await seed(api, "/api/v1/people", { name: uniqueText("e2e-dep-ownerperson"), userId: owner.id }, "/api/v1/people");
  const managerPerson = await seed(api, "/api/v1/people", { name: uniqueText("e2e-dep-managerperson"), userId: manager.id }, "/api/v1/people");
  const teamId = await seed(api, "/api/v1/teams", { name: uniqueText("e2e-dep-team"), managerPersonId: managerPerson }, "/api/v1/teams");
  const streamId = await seed(api, "/api/v1/work-streams", { name: uniqueText("e2e-dep-stream"), ownerPersonId: lead, startDate: "2026-01-05" }, "/api/v1/work-streams");
  const programId = await seed(api, `/api/v1/work-streams/${streamId}/programs`, { name: uniqueText("e2e-dep-program"), ownerPersonId: ownerPerson }, "/api/v1/programs");

  async function project(label: string, start: string, end: string): Promise<Project> {
    const name = uniqueText(`e2e-dep-proj-${label}`);
    const id = await seed(api, `/api/v1/programs/${programId}/projects`, { name, ownerPersonId: ownerPerson }, "/api/v1/projects");
    const milestone = uniqueText(`e2e-dep-${label}1`);
    const milestoneResponse = await api.post(`/api/v1/projects/${id}/milestones`, { data: { name: milestone, teamId, estimateMd: 3 } });
    expect(milestoneResponse.status(), await milestoneResponse.text()).toBe(201);
    const milestoneId = ((await milestoneResponse.json()) as { id: number }).id;
    await schedule(api, id, milestoneId, start, end);
    return { id, name, milestoneId, milestone };
  }

  const a = await project("a", "2027-02-01", "2027-02-05");
  const b = await project("b", "2027-02-08", "2027-02-12");
  return { api, owner: owner.account, manager: manager.account, a, b };
}

/** Type an ISO date and leave the field by clicking the dialog title: Tab would focus the next date input and open its calendar over the footer. */
async function fillDate(dialog: Locator, label: string, value: string): Promise<void> {
  await dialog.getByLabel(label).fill(value);
  await dialog.getByRole("heading").first().click();
}

async function openProject(page: Page, project: Project): Promise<void> {
  await page.goto(`/projects/${project.id}`);
  await expect(page.getByRole("heading", { level: 2, name: project.name })).toBeVisible();
  await expect(page.getByRole("grid", { name: "Milestone timeline" })).toBeVisible();
}

const arrows = (page: Page) => page.locator("[data-arrow]");
const dependenciesTable = (page: Page) => page.getByRole("table", { name: "Dependencies of the project" });
const facts = (page: Page) => page.getByRole("group", { name: "Project facts" });

/** Open the Add dependency dialog, choose the successor (a milestone of this project) and find the predecessor milestone by name. */
async function fillDependency(page: Page, successor: string, predecessor: Project): Promise<Locator> {
  await page.getByRole("button", { name: "Add dependency", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add dependency" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("combobox", { name: "Successor" }).click();
  await page.getByRole("option", { name: successor, exact: true }).click();
  const picker = dialog.getByRole("combobox", { name: "Predecessor" });
  await picker.click();
  await picker.fill(predecessor.milestone);
  await page.getByRole("option", { name: `${predecessor.milestone} · ${predecessor.name}` }).click();
  return dialog;
}

test("a project owner links a milestone to a milestone of another project, sees the ghost row and the arrow, and a cycle is refused", async ({ page }) => {
  const { api, owner, a, b } = await seedWorld();
  await api.dispose();

  await login(page, owner.email, owner.password);
  await openProject(page, b);
  await expect(page.getByText("No dependencies yet")).toBeVisible();
  await expect(arrows(page)).toHaveCount(0);

  // b1 waits for a1 (finish-to-start, no lag): the successor is b's own milestone, the predecessor is found by name across projects.
  const dialog = await fillDependency(page, b.milestone, a);
  await expect(dialog.getByRole("combobox", { name: "Type" })).toHaveValue("Finish → Start (FS)");
  await Promise.all([
    page.waitForResponse((r) => r.request().method() === "POST" && /\/api\/v1\/projects\/\d+\/dependencies$/.test(r.url()) && r.status() === 201),
    dialog.getByRole("button", { name: "Save", exact: true }).click(),
  ]);
  await expect(dialog).toHaveCount(0);

  // The table lists the link as holding; a1 is a grayed ghost row whose name leads to project A; the link is one gray arrow.
  const row = dependenciesTable(page).getByRole("row").filter({ hasText: a.milestone });
  await expect(row).toContainText("OK");
  await expect(row).toContainText(`${a.milestone} · ${a.name}`);
  const grid = page.getByRole("grid", { name: "Milestone timeline" });
  await expect(grid.getByRole("rowheader").filter({ hasText: `${a.name} › ${a.milestone}` })).toBeVisible();
  await expect(grid.getByRole("link", { name: `${a.name} › ${a.milestone} - open project ${a.name}` })).toHaveAttribute("href", `/projects/${a.id}`);
  await expect(arrows(page)).toHaveCount(1);
  await expect(arrows(page)).toHaveAttribute("data-violated", "false");
  await expect(facts(page)).not.toContainText("conflict");

  // From A the reverse link a1 <- b1 would close a loop: the dialog names it and nothing is added.
  await openProject(page, a);
  await expect(dependenciesTable(page).getByRole("row")).toHaveCount(2); // the header and the one link
  const refused = await fillDependency(page, a.milestone, b);
  await Promise.all([
    page.waitForResponse((r) => r.request().method() === "POST" && /\/api\/v1\/projects\/\d+\/dependencies$/.test(r.url()) && r.status() === 409),
    refused.getByRole("button", { name: "Save", exact: true }).click(),
  ]);
  const notice = refused.getByRole("alert");
  await expect(notice).toContainText("This link would close a cycle through:");
  await expect(notice).toContainText(a.milestone);
  await expect(notice).toContainText(b.milestone);
  await refused.getByRole("button", { name: "Cancel" }).click();
  await expect(refused).toHaveCount(0);
  await expect(dependenciesTable(page).getByRole("row")).toHaveCount(2);
});

test("the team's manager moves the successor before its predecessor and reads the conflict; the owner deletes the link", async ({ page }) => {
  const { api, owner, manager, a, b } = await seedWorld();
  const link = await api.post(`/api/v1/projects/${b.id}/dependencies`, {
    data: { predecessor: { kind: "MILESTONE", id: a.milestoneId }, successor: { kind: "MILESTONE", id: b.milestoneId }, type: "FS", lagDays: 0 },
  });
  expect(link.status(), await link.text()).toBe(201);
  await api.dispose();

  // The manager (not an owner of anything) drags nothing: Edit schedule puts b1 two weeks ahead of the end of a1.
  await login(page, manager.email, manager.password);
  await openProject(page, b);
  await expect(arrows(page)).toHaveAttribute("data-violated", "false");
  await rowOperation(page, b.milestone, `Edit schedule of ${b.milestone}`);
  const dialog = page.getByRole("dialog");
  await fillDate(dialog, "Start date", "2027-01-25");
  await fillDate(dialog, "End date", "2027-01-29");
  await Promise.all([
    page.waitForResponse((r) => r.request().method() === "PUT" && /\/api\/v1\/milestones\/\d+\/schedule$/.test(r.url()) && r.ok()),
    dialog.getByRole("button", { name: "Save", exact: true }).click(),
  ]);
  await expect(dialog).toHaveCount(0);

  // The server's check arrives with the refreshed view: a red arrow, the badge, the row and the bar's own name all say it.
  await expect(arrows(page)).toHaveAttribute("data-violated", "true");
  await expect(facts(page)).toContainText("1 conflict");
  const row = dependenciesTable(page).getByRole("row").filter({ hasText: a.milestone });
  await expect(row).toContainText("Violated · 10 working days short");
  await expect(row).toContainText("needs 2027-02-08 · is 2027-01-25");
  await expect(page.getByRole("button", { name: new RegExp(`^${b.milestone}, `) })).toHaveAccessibleName(/, 1 conflict$/);
  // Only the successor's project chain deletes: the manager's row has no operations menu.
  await expect(row.getByRole("button")).toHaveCount(0);

  // The project's owner removes the link from the table: the arrow and the ghost row go, and the empty state returns.
  await login(page, owner.email, owner.password);
  await openProject(page, b);
  await expect(facts(page)).toContainText("1 conflict");
  // The link is named with its ends as the table shows them: the other project's milestone carries its project.
  const linkName = `${a.milestone} · ${a.name} → ${b.milestone}`;
  await rowOperation(page, linkName, `Delete ${linkName}`);
  const confirm = page.getByRole("dialog", { name: "Delete dependency?" });
  await Promise.all([
    page.waitForResponse((r) => r.request().method() === "DELETE" && /\/api\/v1\/dependencies\/\d+$/.test(r.url()) && r.status() === 204),
    confirm.getByRole("button", { name: "Delete", exact: true }).click(),
  ]);
  await expect(confirm).toHaveCount(0);
  await expect(page.getByText("No dependencies yet")).toBeVisible();
  await expect(arrows(page)).toHaveCount(0);
  await expect(page.getByRole("grid", { name: "Milestone timeline" }).getByRole("link", { name: new RegExp(`open project ${a.name}$`) })).toHaveCount(0);
  await expect(facts(page)).not.toContainText("conflict");
});
