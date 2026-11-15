// The Milestones page (/milestones, 1.19): every milestone of the plan, narrowed by the Schedule, Team, project and name filters that live in the URL.
// The plan is shared by four workers, so the page is always narrowed to this spec's own team before a row is counted. Owns: its throwaway person,
// team, work stream, program, project and three milestones of that team (unique `e2e-ms-*` names; one scheduled 2027-05-03..07, two left unscheduled),
// all seeded through the API in the test and removed through the API (the project first - its milestones go with it - then program, work stream,
// team, person), even after a failure. Dated May 2027 on purpose (no holiday, no far-off year: nothing here depends on working days); it writes no
// ranking, no holiday and no connection, and needs no lock.
// The Team and Project selects list every team and every project of the plan (read to the end, 1.21), so no count of other specs' rows can hide this
// spec's own from them (test-fixtures.md, the 1.19 worlds). The second test (1.21) picks the spec's project in the Project select.
import type { APIRequestContext, Page } from "@playwright/test";
import { apiAsAdmin, deleteViaApi, expect, login, openFilters, test, uniqueText } from "./helpers";

// Registered in creation order; torn down in reverse (a project before its program before its stream before the team and the person).
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
  team: string;
  teamId: number;
  project: string;
  projectId: number;
  scheduled: string;
  unscheduled: string[];
}

/** One team, one project, three milestones of that team: `scheduled` 2027-05-03..07 and two left unscheduled. */
async function seedWorld(): Promise<World> {
  const { api } = await apiAsAdmin();
  try {
    const person = await seed(api, "/api/v1/people", { name: uniqueText("e2e-ms-person") }, "/api/v1/people");
    const team = uniqueText("e2e-ms-team");
    const teamId = await seed(api, "/api/v1/teams", { name: team }, "/api/v1/teams");
    const stream = await seed(api, "/api/v1/work-streams", { name: uniqueText("e2e-ms-stream"), ownerPersonId: person, startDate: "2026-01-05" }, "/api/v1/work-streams");
    const program = await seed(api, `/api/v1/work-streams/${stream}/programs`, { name: uniqueText("e2e-ms-program"), ownerPersonId: person }, "/api/v1/programs");
    const project = uniqueText("e2e-ms-project");
    const projectId = await seed(api, `/api/v1/programs/${program}/projects`, { name: project, ownerPersonId: person }, "/api/v1/projects");
    const milestone = async (name: string) => seed(api, `/api/v1/projects/${projectId}/milestones`, { name, teamId, estimateMd: 2 }, "/api/v1/milestones");
    const scheduled = uniqueText("e2e-ms-scheduled");
    const scheduledId = await milestone(scheduled);
    const unscheduled = [uniqueText("e2e-ms-open-a"), uniqueText("e2e-ms-open-b")];
    for (const name of unscheduled) await milestone(name);
    const view = (await (await api.get(`/api/v1/views/project/${projectId}`)).json()) as { revision: number };
    const put = await api.put(`/api/v1/milestones/${scheduledId}/schedule`, { data: { expectedRevision: view.revision, startDate: "2027-05-03", endDate: "2027-05-07" } });
    expect(put.status(), await put.text()).toBe(200);
    return { team, teamId, project, projectId, scheduled, unscheduled };
  } finally {
    await api.dispose();
  }
}

/** The body rows of the Milestones table (the scroll region around it carries the same name, hence the role). */
const rows = (page: Page) => page.getByRole("table", { name: "Milestones", exact: true }).locator("tbody tr");

test("the Milestones page lists a team's milestones, and the schedule filter narrows them to the ones not scheduled yet", async ({ page }) => {
  const world = await seedWorld();
  await login(page);

  // From the menu; the plan is shared, so the team filter is what makes the rows this spec's own.
  await page.getByRole("group", { name: "Planning" }).getByRole("link", { name: "Milestones", exact: true }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Milestones", exact: true })).toBeVisible();
  await openFilters(page);
  const team = page.getByRole("combobox", { name: "Team", exact: true });
  await team.click();
  await team.fill(world.team);
  await page.getByRole("option", { name: world.team, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`[?&]teamId=${world.teamId}(&|$)`));

  await expect(rows(page)).toHaveCount(3);
  const scheduledRow = rows(page).filter({ hasText: world.scheduled });
  await expect(scheduledRow).toHaveCount(1);
  await expect(scheduledRow).toContainText("2027-05-03");
  await expect(scheduledRow).toContainText("2027-05-07");
  for (const name of world.unscheduled) {
    await expect(rows(page).filter({ hasText: name })).toContainText("Not scheduled");
  }

  // "Not scheduled" leaves the two milestones without dates, in the address too, and survives a reload.
  await page.getByRole("combobox", { name: "Schedule", exact: true }).click();
  await page.getByRole("option", { name: "Not scheduled", exact: true }).click();
  await expect(page).toHaveURL(/[?&]scheduled=false(&|$)/);
  await expect(rows(page)).toHaveCount(2);
  await expect(rows(page).filter({ hasText: world.scheduled })).toHaveCount(0);
  await page.reload();
  await expect(rows(page)).toHaveCount(2);
  for (const name of world.unscheduled) {
    await expect(rows(page).filter({ hasText: name })).toHaveCount(1);
  }

  // A project's name is the way into its page.
  await rows(page).first().getByRole("link", { name: `Open ${world.project}`, exact: true }).click();
  await expect(page.getByRole("heading", { level: 2, name: world.project, exact: true })).toBeVisible();
});

test("the Milestones page's Project select narrows the list to one project and shows it as a chip", async ({ page }) => {
  const world = await seedWorld();
  await login(page);

  // From the menu, then the Project select of the filter panel (searched by the project's unique name): the address, the chip and exactly the project's milestones.
  await page.getByRole("group", { name: "Planning" }).getByRole("link", { name: "Milestones", exact: true }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Milestones", exact: true })).toBeVisible();
  await openFilters(page);
  const project = page.getByRole("combobox", { name: "Project", exact: true });
  await project.click();
  await project.fill(world.project);
  await page.getByRole("option", { name: world.project, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`[?&]projectId=${world.projectId}(&|$)`));
  await expect(page.getByText(`Project: ${world.project}`, { exact: true })).toBeVisible();
  await expect(rows(page)).toHaveCount(3);
  for (const name of [world.scheduled, ...world.unscheduled]) {
    await expect(rows(page).filter({ hasText: name })).toHaveCount(1);
  }

  // Removing the chip lifts the filter: no projectId in the address, and the select is empty again.
  await page.getByRole("button", { name: "Remove the project filter", exact: true }).click();
  await expect(page).not.toHaveURL(/[?&]projectId=/);
  await expect(page.getByText(`Project: ${world.project}`, { exact: true })).toHaveCount(0);
  await expect(project).toHaveValue("");
});
