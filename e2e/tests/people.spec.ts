// The people directory: an admin creates a person with an email, links a throwaway login, renames them and deletes them; a
// regular user sees the read-only People list, emails included. Owns: its throwaway people (unique `e2e-person-*` names) and
// users, deleted by the end of each test and, if a step fails first, by the afterEach below (people only; the users are
// removed through the Users page). The responsibilities test seeds its own person with a team, a work stream, a program and a project
// (all `e2e-person-*`) through the API and removes them, children first, in the same afterEach.
import { apiAsAdmin, createUserViaUi, deleteUserRow, deleteViaApi, expect, login, openFilters, rowOperation, signOut, test, uniqueText } from "./helpers";

const teardown: string[] = [];
test.afterEach(async () => {
  await deleteViaApi(teardown.splice(0).reverse());
});

test("admin creates a person, links a login, renames them, and deletes them", async ({ page }) => {
  await login(page);
  const account = await createUserViaUi(page, "E2E Person Login");
  const personName = uniqueText("e2e-person");
  const personEmail = `${personName}@example.com`;

  // Create through the modal — a new person lands on their own page.
  await page.goto("/people");
  await expect(page.getByRole("heading", { name: "People" })).toBeVisible();
  await page.getByRole("button", { name: "New person" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name").fill(personName);
  await dialog.getByLabel("Email").fill(personEmail);
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page).toHaveURL(/\/people\/\d+$/);
  teardown.push(`/api/v1/people/${/\/people\/(\d+)$/.exec(page.url())![1]}`);
  await expect(page.getByRole("heading", { name: personName })).toBeVisible();
  await expect(page.getByText(`Email: ${personEmail}`)).toBeVisible();
  await expect(page.getByText("No login")).toBeVisible();

  // Link the throwaway login from the editor's searchable picker, and rename.
  const renamed = `${personName}-renamed`;
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const editor = page.getByRole("dialog");
  await editor.getByLabel("Name").fill(renamed);
  const loginPicker = editor.getByRole("combobox", { name: "Login" });
  await loginPicker.click();
  await loginPicker.fill(account.name);
  await page.getByRole("option", { name: `${account.name} (${account.email})` }).click();
  await Promise.all([
    page.waitForResponse((r) => r.request().method() === "PUT" && /\/api\/v1\/people\/\d+$/.test(r.url()) && r.ok()),
    editor.getByRole("button", { name: "Save", exact: true }).click(),
  ]);
  await expect(page.getByRole("heading", { name: renamed })).toBeVisible();
  await expect(page.getByText(`Login: ${account.email}`)).toBeVisible();

  // The list shows the login (filtered by name); delete from the row menu.
  await page.goto("/people");
  await openFilters(page);
  await page.getByLabel("Name", { exact: true }).fill(renamed);
  await expect(page.getByRole("link", { name: `Open person ${renamed}` })).toBeVisible();
  await expect(page.getByRole("row", { name: new RegExp(renamed) })).toContainText(account.email);
  await rowOperation(page, renamed, `Delete ${renamed}`);
  await Promise.all([
    page.waitForResponse((r) => r.request().method() === "DELETE" && /\/api\/v1\/people\/\d+$/.test(r.url()) && r.ok()),
    page.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).click(),
  ]);
  await expect(page.getByRole("link", { name: `Open person ${renamed}` })).toHaveCount(0);

  await deleteUserRow(page, account.name);
});

test("a regular user sees the read-only people list", async ({ page }) => {
  await login(page);
  const user = await createUserViaUi(page, "E2E Person Reader");
  // The person is seeded through the API; the journey under test is the reader's.
  const { api } = await apiAsAdmin();
  const personName = uniqueText("e2e-person-ro");
  const personEmail = `${personName}@example.com`;
  const created = await api.post("/api/v1/people", { data: { name: personName, email: personEmail } });
  expect(created.status(), await created.text()).toBe(201);
  teardown.push(`/api/v1/people/${((await created.json()) as { id: number }).id}`);
  await api.dispose();
  await signOut(page);

  await login(page, user.email, user.password);
  await page.goto("/people");
  await openFilters(page);
  await page.getByLabel("Name", { exact: true }).fill(personName);
  await expect(page.getByRole("link", { name: `Open person ${personName}` })).toBeVisible();
  await expect(page.getByText(personEmail)).toBeVisible();
  await expect(page.getByRole("button", { name: "New person" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: `Operations for ${personName}` })).toHaveCount(0);
  await page.getByRole("link", { name: `Open person ${personName}` }).click();
  await expect(page.getByRole("heading", { name: personName })).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);
  await signOut(page);

  // Cleanup as the admin (the person is removed by the afterEach).
  await login(page);
  await deleteUserRow(page, user.name);
});

test("a person's page lists the team they manage and the work stream, program and project they own, each a link to its page", async ({ page }) => {
  const { api } = await apiAsAdmin();
  const personName = uniqueText("e2e-person-resp");
  const seed = async (path: string, data: object, tear: string): Promise<number> => {
    const created = await api.post(path, { data });
    expect(created.status(), await created.text()).toBe(201);
    const id = ((await created.json()) as { id: number }).id;
    teardown.push(`${tear}/${id}`);
    return id;
  };
  // Registered in creation order, removed in reverse: the project before its program before its stream before the team and the person.
  const personId = await seed("/api/v1/people", { name: personName }, "/api/v1/people");
  const team = uniqueText("e2e-person-team");
  const teamId = await seed("/api/v1/teams", { name: team, managerPersonId: personId }, "/api/v1/teams");
  const stream = uniqueText("e2e-person-stream");
  const streamId = await seed("/api/v1/work-streams", { name: stream, ownerPersonId: personId, startDate: "2026-01-05" }, "/api/v1/work-streams");
  const program = uniqueText("e2e-person-program");
  const programId = await seed(`/api/v1/work-streams/${streamId}/programs`, { name: program, ownerPersonId: personId }, "/api/v1/programs");
  const project = uniqueText("e2e-person-project");
  const projectId = await seed(`/api/v1/programs/${programId}/projects`, { name: project, ownerPersonId: personId }, "/api/v1/projects");
  await api.dispose();

  await login(page);
  await page.goto(`/people/${personId}`);
  await expect(page.getByRole("heading", { name: personName })).toBeVisible();
  const managed = page.getByRole("list", { name: "Teams managed" });
  const streams = page.getByRole("list", { name: "Work streams owned" });
  const programs = page.getByRole("list", { name: "Programs owned" });
  const projects = page.getByRole("list", { name: "Projects owned" });
  await expect(managed.getByRole("link", { name: `Open team ${team}` })).toBeVisible();
  await expect(streams.getByRole("link", { name: `Open work stream ${stream}` })).toBeVisible();
  await expect(programs.getByRole("link", { name: `Open program ${program}` })).toBeVisible();
  await expect(projects.getByRole("link", { name: `Open project ${project}` })).toBeVisible();
  await expect(page.getByText("Manages no team")).toHaveCount(0);
  await expect(page.getByText("Owns no project")).toHaveCount(0);

  // The team name leads to the team's page, the project name to the project's, the work stream's to the Roadmap overview narrowed to it.
  await managed.getByRole("link", { name: `Open team ${team}` }).click();
  await expect(page).toHaveURL(new RegExp(`/teams/${teamId}$`));
  await expect(page.getByRole("heading", { name: team })).toBeVisible();
  await page.goBack();
  await projects.getByRole("link", { name: `Open project ${project}` }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}$`));
  await expect(page.getByRole("heading", { name: project })).toBeVisible();
  await page.goBack();
  await streams.getByRole("link", { name: `Open work stream ${stream}` }).click();
  await expect(page).toHaveURL(new RegExp(`/roadmap\\?.*workStreamId=${streamId}`));
});
