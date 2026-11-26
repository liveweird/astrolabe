// The Projects page (/projects, /projects/:id): a bare /projects opens the project this browser viewed last and forgets one that is gone, and
// the picker above a project's title finds a project by its program's name (and its owner's) and opens the pick as a history entry. Owns: its
// throwaway people, work stream, program and two projects (unique `e2e-pp-*` names), seeded through the API and deleted by the afterEach through
// the API (projects first, then program, work stream, people). Read-only in the browser: nothing is written through the UI.
import type { APIRequestContext } from "@playwright/test";
import { apiAsAdmin, deleteViaApi, expect, login, test, uniqueText } from "./helpers";

// Registered in creation order; torn down in reverse (the projects before their program before its stream before the people).
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

interface World {
  program: string;
  alpha: { id: number; name: string; owner: string };
  beta: { id: number; name: string; owner: string };
}

/** One work stream and program (unique names) holding two projects of two different owners. */
async function seedWorld(): Promise<World> {
  const { api } = await apiAsAdmin();
  const lead = await seed(api, "/api/v1/people", { name: uniqueText("e2e-pp-lead") }, "/api/v1/people");
  const alphaOwner = uniqueText("e2e-pp-alice");
  const betaOwner = uniqueText("e2e-pp-bruno");
  const alphaOwnerId = await seed(api, "/api/v1/people", { name: alphaOwner }, "/api/v1/people");
  const betaOwnerId = await seed(api, "/api/v1/people", { name: betaOwner }, "/api/v1/people");
  const streamId = await seed(api, "/api/v1/work-streams", { name: uniqueText("e2e-pp-stream"), ownerPersonId: lead, startDate: "2026-01-05" }, "/api/v1/work-streams");
  const program = uniqueText("e2e-pp-program");
  const programId = await seed(api, `/api/v1/work-streams/${streamId}/programs`, { name: program, ownerPersonId: lead }, "/api/v1/programs");
  const alphaName = uniqueText("e2e-pp-alpha");
  const betaName = uniqueText("e2e-pp-beta");
  const alphaId = await seed(api, `/api/v1/programs/${programId}/projects`, { name: alphaName, ownerPersonId: alphaOwnerId }, "/api/v1/projects");
  const betaId = await seed(api, `/api/v1/programs/${programId}/projects`, { name: betaName, ownerPersonId: betaOwnerId }, "/api/v1/projects");
  await api.dispose();
  return { program, alpha: { id: alphaId, name: alphaName, owner: alphaOwner }, beta: { id: betaId, name: betaName, owner: betaOwner } };
}

test("a bare /projects opens the project viewed last in this browser and forgets one that was deleted", async ({ page }) => {
  const world = await seedWorld();
  await login(page);

  // A fresh browser has nothing remembered: the page says so and offers the picker.
  await page.goto("/projects");
  await expect(page.getByRole("heading", { level: 2, name: "Projects", exact: true })).toBeVisible();
  await expect(page.getByText("No project picked")).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Project", exact: true })).toBeVisible();

  // Two projects viewed: the last one is the one a bare visit opens.
  await page.goto(`/projects/${world.alpha.id}`);
  await expect(page.getByRole("heading", { level: 2, name: world.alpha.name })).toBeVisible();
  await page.goto(`/projects/${world.beta.id}`);
  await expect(page.getByRole("heading", { level: 2, name: world.beta.name })).toBeVisible();
  await page.goto("/projects");
  await expect(page).toHaveURL(new RegExp(`/projects/${world.beta.id}$`));
  await expect(page.getByRole("heading", { level: 2, name: world.beta.name })).toBeVisible();

  // The remembered project is deleted elsewhere: the next bare visit shows the empty state and stays on /projects.
  const { api } = await apiAsAdmin();
  expect((await api.delete(`/api/v1/projects/${world.beta.id}`)).status()).toBe(204);
  await api.dispose();
  await page.goto("/projects");
  await expect(page.getByText("No project picked")).toBeVisible();
  await expect(page).toHaveURL(/\/projects$/);
});

test("the picker finds a project by its program's name or its owner's and a pick opens it as a history entry", async ({ page }) => {
  const world = await seedWorld();
  await login(page);
  await page.goto(`/projects/${world.alpha.id}`);
  await expect(page.getByRole("heading", { level: 2, name: world.alpha.name })).toBeVisible();
  const picker = page.getByRole("combobox", { name: "Project", exact: true });
  await expect(picker).toHaveValue(world.alpha.name);
  // The loaded page has no back link: the picker is the way to another project.
  await expect(page.getByRole("link", { name: /^Back to/ })).toHaveCount(0);

  // The program's name finds both of its projects, and nothing else of the plan.
  await picker.click();
  await picker.fill(world.program);
  await expect(page.getByRole("option")).toHaveText([world.alpha.name, world.beta.name]);
  // An owner's name finds that owner's project alone.
  await picker.fill(world.beta.owner);
  await expect(page.getByRole("option")).toHaveText([world.beta.name]);

  await page.getByRole("option", { name: world.beta.name, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${world.beta.id}$`));
  await expect(page.getByRole("heading", { level: 2, name: world.beta.name })).toBeVisible();
  await expect(picker).toHaveValue(world.beta.name);

  // A push, not a replace: Back returns to the project before.
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/projects/${world.alpha.id}$`));
  await expect(page.getByRole("heading", { level: 2, name: world.alpha.name })).toBeVisible();
});
