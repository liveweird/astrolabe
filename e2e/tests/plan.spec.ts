// The Plan page: an admin builds work stream -> program -> project through the modals (assigning owners, a target window, handing
// a project over), then deletes them bottom-up; a PROJECT owner edits their project but is offered no way to set its target
// window and no actions on anything they do not own. Owns: its throwaway people, plan nodes (unique `e2e-plan-*` names) and user,
// deleted by the end of each test and, if a step fails first, by the afterEach below (plan nodes and people only, children first;
// the user is removed through the Users page).
import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { apiAsAdmin, createUserViaUi, deleteUserRow, deleteViaApi, expect, login, rowOperation, signOut, test, uniqueText } from "./helpers";

// Registered in creation order; torn down in reverse (a project before its program before its stream before the people).
const teardown: string[] = [];
test.afterEach(async () => {
  await deleteViaApi(teardown.splice(0).reverse());
});

async function seed(api: APIRequestContext, path: string, data: object, tear: string): Promise<number> {
  const response = await api.post(path, { data });
  expect(response.status(), await response.text()).toBe(201);
  const id = ((await response.json()) as { id: number }).id;
  teardown.push(`${tear}/${id}`);
  return id;
}

/** Type an ISO date and leave the field by clicking the dialog title: Tab would focus the next date input and open its calendar over the footer. */
async function fillDate(dialog: Locator, label: string, value: string): Promise<void> {
  await dialog.getByLabel(label).fill(value);
  await dialog.getByRole("heading").first().click();
}

async function pickOwner(page: Page, dialog: Locator, name: string): Promise<void> {
  const owner = dialog.getByRole("combobox", { name: "Owner" });
  await owner.click();
  await owner.fill(name);
  await page.getByRole("option", { name }).click();
}

/** Press Create in the open dialog and return the new record's id from the POST response. */
async function createAndGetId(page: Page, dialog: Locator, path: RegExp): Promise<number> {
  const [response] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === "POST" && path.test(r.url()) && r.ok()),
    dialog.getByRole("button", { name: "Create", exact: true }).click(),
  ]);
  return ((await response.json()) as { id: number }).id;
}

async function confirmDelete(page: Page, path: RegExp): Promise<void> {
  await Promise.all([
    page.waitForResponse((r) => r.request().method() === "DELETE" && path.test(r.url()) && r.ok()),
    page.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).click(),
  ]);
}

test("admin builds a work stream, a program and a project, assigns owners, and deletes them bottom-up", async ({ page }) => {
  const { api } = await apiAsAdmin();
  const anna = uniqueText("e2e-plan-anna");
  const ben = uniqueText("e2e-plan-ben");
  await seed(api, "/api/v1/people", { name: anna }, "/api/v1/people");
  await seed(api, "/api/v1/people", { name: ben }, "/api/v1/people");
  await api.dispose();

  await login(page);
  await page.goto("/plan");
  await expect(page.getByRole("heading", { level: 2, name: "Plan" })).toBeVisible();

  // Work stream: name, owner, start date.
  const streamName = uniqueText("e2e-plan-stream");
  await page.getByRole("button", { name: "New work stream" }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name").fill(streamName);
  await pickOwner(page, dialog, anna);
  await fillDate(dialog, "Start date", "2026-01-05");
  teardown.push(`/api/v1/work-streams/${await createAndGetId(page, dialog, /\/api\/v1\/work-streams$/)}`);
  await expect(page.getByRole("heading", { level: 3, name: streamName })).toBeVisible();
  await expect(page.getByText(`Owner: ${anna} · From 2026-01-05`)).toBeVisible();

  // Program under it, owned by the same person.
  const programName = uniqueText("e2e-plan-program");
  await page.getByRole("button", { name: `New program in ${streamName}` }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name").fill(programName);
  await pickOwner(page, dialog, anna);
  teardown.push(`/api/v1/programs/${await createAndGetId(page, dialog, /\/api\/v1\/work-streams\/\d+\/programs$/)}`);
  await expect(page.getByRole("heading", { level: 4, name: programName })).toBeVisible();

  // Project under the program, owned by the second person, with a target window.
  const projectName = uniqueText("e2e-plan-project");
  await page.getByRole("button", { name: `New project in ${programName}` }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name").fill(projectName);
  await pickOwner(page, dialog, ben);
  await fillDate(dialog, "Target start", "2026-02-02");
  await fillDate(dialog, "Target end", "2026-03-31");
  teardown.push(`/api/v1/projects/${await createAndGetId(page, dialog, /\/api\/v1\/programs\/\d+\/projects$/)}`);
  const table = page.getByRole("table", { name: `Projects of ${programName}` });
  await expect(table.getByRole("row", { name: new RegExp(projectName) })).toContainText(ben);
  await expect(table.getByRole("row", { name: new RegExp(projectName) })).toContainText("2026-02-02 – 2026-03-31");

  // Hand the project over to the first person and rename it (the full-replace PUT of the fields).
  const renamed = `${projectName}-renamed`;
  await rowOperation(page, projectName, `Edit ${projectName}`);
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name").fill(renamed);
  await dialog.getByLabel("Clear the owner").click();
  await pickOwner(page, dialog, anna);
  await Promise.all([
    page.waitForResponse((r) => r.request().method() === "PUT" && /\/api\/v1\/projects\/\d+$/.test(r.url()) && r.ok()),
    dialog.getByRole("button", { name: "Save", exact: true }).click(),
  ]);
  const row = table.getByRole("row", { name: new RegExp(renamed) });
  await expect(row).toContainText(anna);
  await expect(row).toContainText("2026-02-02 – 2026-03-31");

  // A parent with children refuses to go (the server's 409, said in words); bottom-up deletion works.
  await rowOperation(page, streamName, `Delete ${streamName}`);
  await page.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByText("This work stream still has programs. Delete them first.")).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();

  await rowOperation(page, renamed, `Delete ${renamed}`);
  await confirmDelete(page, /\/api\/v1\/projects\/\d+$/);
  await expect(page.getByText(renamed)).toHaveCount(0);
  await rowOperation(page, programName, `Delete ${programName}`);
  await confirmDelete(page, /\/api\/v1\/programs\/\d+$/);
  await expect(page.getByRole("heading", { level: 4, name: programName })).toHaveCount(0);
  await rowOperation(page, streamName, `Delete ${streamName}`);
  await confirmDelete(page, /\/api\/v1\/work-streams\/\d+$/);
  await expect(page.getByRole("heading", { level: 3, name: streamName })).toHaveCount(0);
});

test("a project owner edits their project but is offered no target window and no other actions", async ({ page }) => {
  await login(page);
  const account = await createUserViaUi(page, "E2E Plan Owner");
  const { api } = await apiAsAdmin();
  const lead = uniqueText("e2e-plan-lead");
  const mine = uniqueText("e2e-plan-mine");
  const leadId = await seed(api, "/api/v1/people", { name: lead }, "/api/v1/people");
  const minePersonId = await seed(api, "/api/v1/people", { name: mine, userId: account.id }, "/api/v1/people");
  const streamName = uniqueText("e2e-plan-stream");
  const programName = uniqueText("e2e-plan-program");
  const ownProject = uniqueText("e2e-plan-own");
  const foreignProject = uniqueText("e2e-plan-foreign");
  const streamId = await seed(api, "/api/v1/work-streams", { name: streamName, ownerPersonId: leadId, startDate: "2026-01-05" }, "/api/v1/work-streams");
  const programId = await seed(api, `/api/v1/work-streams/${streamId}/programs`, { name: programName, ownerPersonId: leadId }, "/api/v1/programs");
  const targetWindow = { targetStart: "2026-02-02", targetEnd: "2026-03-31" };
  await seed(api, `/api/v1/programs/${programId}/projects`, { name: ownProject, ownerPersonId: minePersonId, ...targetWindow }, "/api/v1/projects");
  await seed(api, `/api/v1/programs/${programId}/projects`, { name: foreignProject, ownerPersonId: leadId, ...targetWindow }, "/api/v1/projects");
  await api.dispose();
  await signOut(page);

  await login(page, account.email, account.password);
  await page.goto("/plan");
  await expect(page.getByRole("heading", { level: 3, name: streamName })).toBeVisible();
  // Everything is readable, but only their own project offers actions.
  await expect(page.getByRole("button", { name: "New work stream" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: `New program in ${streamName}` })).toHaveCount(0);
  await expect(page.getByRole("button", { name: `New project in ${programName}` })).toHaveCount(0);
  await expect(page.getByRole("button", { name: `Operations for ${streamName}` })).toHaveCount(0);
  await expect(page.getByRole("button", { name: `Operations for ${programName}` })).toHaveCount(0);
  await expect(page.getByRole("button", { name: `Operations for ${foreignProject}` })).toHaveCount(0);
  await expect(page.getByRole("button", { name: `Operations for ${ownProject}` })).toBeVisible();

  // Edit: the fields are theirs, the target window is not.
  await rowOperation(page, ownProject, `Edit ${ownProject}`);
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Name")).toBeEnabled();
  await expect(dialog.getByLabel("Target start", { exact: true })).toBeDisabled();
  await expect(dialog.getByLabel("Target end", { exact: true })).toBeDisabled();
  await expect(dialog.getByText("Only an administrator, an owner above the project or a roadmap editor can change the target window.")).toBeVisible();
  const renamed = `${ownProject}-renamed`;
  await dialog.getByLabel("Name").fill(renamed);
  await Promise.all([
    page.waitForResponse((r) => r.request().method() === "PUT" && /\/api\/v1\/projects\/\d+$/.test(r.url()) && r.ok()),
    dialog.getByRole("button", { name: "Save", exact: true }).click(),
  ]);
  const row = page.getByRole("row", { name: new RegExp(renamed) });
  await expect(row).toContainText(mine);
  await expect(row).toContainText("2026-02-02 – 2026-03-31");
  await signOut(page);

  // Cleanup as the admin (the plan nodes and people are removed by the afterEach).
  await login(page);
  await deleteUserRow(page, account.name);
});
