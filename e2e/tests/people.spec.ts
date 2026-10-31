// The people directory: an admin creates a person with an email, links a throwaway login, renames them and deletes them; a
// regular user sees the read-only People list, emails included. Owns: its throwaway people (unique `e2e-person-*` names) and
// users, deleted by the end of each test and, if a step fails first, by the afterEach below (people only; the users are
// removed through the Users page).
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
