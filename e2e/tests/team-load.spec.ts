// The Team load page (/team-load, 1.19): every team with its overloaded and over-WIP weeks, the "Show" filter in the URL. The plan is shared by four
// workers, so the plan-wide figures (the facts line's team counts) are only ever asserted PRESENT, never as values; the row asserted exactly is
// this spec's own team. Owns: its throwaway person, one team (no manager) with one capacity period from Monday 2027-04-05 of 1 man-day a week, a work
// stream, program, project and ONE milestone of 10 man-days on that team scheduled 2027-04-05..09 (unique `e2e-load-*` names), all seeded through the
// API in the test and removed through the API (the project first - its milestone goes with it - then program, work stream, team - its capacity
// period goes with it -, person), even after a failure. April 2027 on purpose: 10 man-days against 1 a week is overloaded whatever a holiday did to
// that week, and no far-off year keeps the team page's timeline short; it writes no ranking, no holiday and no connection, and needs no lock.
import type { APIRequestContext } from "@playwright/test";
import { apiAsAdmin, deleteViaApi, expect, login, openFilters, test, uniqueText } from "./helpers";

// Registered in creation order; torn down in reverse (a project before its program before its stream before the team and the person).
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

/** A team with 1 man-day a week from 2027-04-05 and one milestone of 10 man-days inside that week; answers the team's name. */
async function seedOverloadedTeam(): Promise<string> {
  const { api } = await apiAsAdmin();
  try {
    const person = await seed(api, "/api/v1/people", { name: uniqueText("e2e-load-person") }, "/api/v1/people");
    const team = uniqueText("e2e-load-team");
    const teamId = await seed(api, "/api/v1/teams", { name: team }, "/api/v1/teams");
    await seed(api, `/api/v1/teams/${teamId}/capacity`, { effectiveFrom: "2027-04-05", mdPerWeek: 1 });
    const stream = await seed(api, "/api/v1/work-streams", { name: uniqueText("e2e-load-stream"), ownerPersonId: person, startDate: "2026-01-05" }, "/api/v1/work-streams");
    const program = await seed(api, `/api/v1/work-streams/${stream}/programs`, { name: uniqueText("e2e-load-program"), ownerPersonId: person }, "/api/v1/programs");
    const projectId = await seed(api, `/api/v1/programs/${program}/projects`, { name: uniqueText("e2e-load-project"), ownerPersonId: person }, "/api/v1/projects");
    const milestoneId = await seed(api, `/api/v1/projects/${projectId}/milestones`, { name: uniqueText("e2e-load-milestone"), teamId, estimateMd: 10 }, "/api/v1/milestones");
    const view = (await (await api.get(`/api/v1/views/project/${projectId}`)).json()) as { revision: number };
    const put = await api.put(`/api/v1/milestones/${milestoneId}/schedule`, { data: { expectedRevision: view.revision, startDate: "2027-04-05", endDate: "2027-04-09" } });
    expect(put.status(), await put.text()).toBe(200);
    return team;
  } finally {
    await api.dispose();
  }
}

test("the Team load page lists a team with an overloaded week, and its name opens the team page that says the same", async ({ page }) => {
  const team = await seedOverloadedTeam();
  await login(page);

  // Narrowed to the teams with an overloaded week (the link Home's badge uses): this spec's team is a row with its worded badge, and the facts line
  // shows a count of teams with an overloaded week (present, never a value).
  await page.goto("/team-load?warning=overloaded");
  await expect(page.getByRole("heading", { level: 2, name: "Team load", exact: true })).toBeVisible();
  const rows = page.getByRole("table", { name: "Load of every team", exact: true }).locator("tbody tr");
  const mine = rows.filter({ has: page.getByRole("link", { name: `Open team ${team}`, exact: true }) });
  await expect(mine).toHaveCount(1);
  await expect(mine).toContainText("1 week overloaded");
  const facts = page.getByRole("group", { name: "Team load in figures", exact: true });
  await expect(facts.getByText(/^\d+ teams?$/)).toBeVisible();
  await expect(facts.getByText(/^\d+ teams? with an overloaded week$/)).toBeVisible();

  // "Every team" drops the parameter; the team's name opens the page that shows the same overloaded week.
  await openFilters(page);
  await page.getByRole("combobox", { name: "Show", exact: true }).click();
  await page.getByRole("option", { name: "Every team", exact: true }).click();
  await expect(page).not.toHaveURL(/warning=/);
  await page.getByRole("link", { name: `Open team ${team}`, exact: true }).click();
  await expect(page.getByRole("heading", { level: 2, name: team, exact: true })).toBeVisible();
  await expect(page.getByRole("group", { name: "Team facts", exact: true })).toContainText("1 week overloaded");
});
