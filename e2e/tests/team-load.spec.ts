// The Team load page (/team-load, 1.19): every team with its overloaded and over-WIP weeks, the "Show" filter in the URL. The plan is shared by four
// workers, so the plan-wide figures (the facts line's team counts) are only ever asserted PRESENT, never as values; the row asserted exactly is
// this spec's own team. Owns: its throwaway person, one team (no manager) with one capacity period from Monday 2027-04-05 of 1 man-day a week, a work
// stream, program, project and ONE milestone of 10 man-days on that team scheduled 2027-04-05..09 (unique `e2e-load-*` names), all seeded through the
// API in the test and removed through the API (the project first - its milestone goes with it - then program, work stream, team - its capacity
// period goes with it -, person), even after a failure. April 2027 on purpose: 10 man-days against 1 a week is overloaded whatever a holiday did to
// that week (its two tests, the second since 1.21, share this world, and open the page with past=true since 1.22: the page lists the weeks from the
// server's current week on, so a fixed April 2027 week would vanish by default once the run passes it), and no far-off year keeps the team page's
// timeline short. The 1.22 test seeds its OWN team dated from the run (capacity from four weeks before this week; one 10 man-day milestone in the
// week three weeks before it and one three weeks after, both Monday to Friday): it can never meet "this week" or expire. It writes no ranking, no
// holiday and no connection, and needs no lock.
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

/**
 * A team with 1 man-day a week from `capacityFrom` and, for each Monday in `weeks`, one milestone of 10 man-days scheduled Monday to Friday of that
 * week (overloaded whatever a holiday does); answers the team's name.
 */
async function seedOverloadedTeam(capacityFrom: string, weeks: readonly string[]): Promise<string> {
  const { api } = await apiAsAdmin();
  try {
    const person = await seed(api, "/api/v1/people", { name: uniqueText("e2e-load-person") }, "/api/v1/people");
    const team = uniqueText("e2e-load-team");
    const teamId = await seed(api, "/api/v1/teams", { name: team }, "/api/v1/teams");
    await seed(api, `/api/v1/teams/${teamId}/capacity`, { effectiveFrom: capacityFrom, mdPerWeek: 1 });
    const stream = await seed(api, "/api/v1/work-streams", { name: uniqueText("e2e-load-stream"), ownerPersonId: person, startDate: "2026-01-05" }, "/api/v1/work-streams");
    const program = await seed(api, `/api/v1/work-streams/${stream}/programs`, { name: uniqueText("e2e-load-program"), ownerPersonId: person }, "/api/v1/programs");
    const projectId = await seed(api, `/api/v1/programs/${program}/projects`, { name: uniqueText("e2e-load-project"), ownerPersonId: person }, "/api/v1/projects");
    for (const monday of weeks) {
      const milestoneId = await seed(api, `/api/v1/projects/${projectId}/milestones`, { name: uniqueText("e2e-load-milestone"), teamId, estimateMd: 10 }, "/api/v1/milestones");
      // Each schedule moves the plan's revision: read it fresh for every milestone.
      const view = (await (await api.get(`/api/v1/views/project/${projectId}`)).json()) as { revision: number };
      const put = await api.put(`/api/v1/milestones/${milestoneId}/schedule`, {
        data: { expectedRevision: view.revision, startDate: monday, endDate: addDays(monday, 4) },
      });
      expect(put.status(), await put.text()).toBe(200);
    }
    return team;
  } finally {
    await api.dispose();
  }
}

/** An ISO date plus whole days (UTC, so no zone or daylight-saving shift can move it). */
function addDays(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** The Monday of the week that is `weeksFromNow` weeks from the run's UTC date (the server's "this week" is a UTC Monday too). */
function mondayFromNow(weeksFromNow: number): string {
  const today = new Date().toISOString().slice(0, 10);
  const weekday = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7;
  return addDays(today, weeksFromNow * 7 - weekday);
}

test("the Team load page lists a team with an overloaded week, and its name opens the team page that says the same", async ({ page }) => {
  const team = await seedOverloadedTeam("2027-04-05", ["2027-04-05"]);
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
  // Scoped to the teams table: since 1.21 the "Weeks with a warning" table names the team again (strict mode refuses a page-wide match).
  await page
    .getByRole("table", { name: "Load of every team", exact: true })
    .getByRole("link", { name: `Open team ${team}`, exact: true })
    .click();
  await expect(page.getByRole("heading", { level: 2, name: team, exact: true })).toBeVisible();
  await expect(page.getByRole("group", { name: "Team facts", exact: true })).toContainText("1 week overloaded");
});

test("the Team load page lists the team's overloaded week with how far it is over, and the team's page shows the same week", async ({ page }) => {
  const team = await seedOverloadedTeam("2027-04-05", ["2027-04-05"]);
  await login(page);

  // Narrowed to the teams with an overloaded week; the weeks table names every such team's weeks, so the spec's own rows are the ones that
  // link to its team (four workers share the plan: nothing here is a plan-wide figure). A holiday in the week would change the capacity, never
  // the week or the load, so the shortfall is a pattern. Since 1.22 the page lists the weeks from this week on, so the fixed April 2027 week is
  // asked for with past=true: it never expires once that April is behind the run.
  await page.goto("/team-load?warning=overloaded&past=true");
  await expect(page.getByRole("heading", { level: 2, name: "Team load", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { level: 3, name: "Weeks with a warning", exact: true })).toBeVisible();
  const weeks = page.getByRole("table", { name: "Weeks with a warning, by team", exact: true });
  const mine = weeks.locator("tbody tr").filter({ has: page.getByRole("link", { name: `Open team ${team}`, exact: true }) });
  await expect(mine).toHaveCount(1);
  await expect(mine.getByRole("cell").nth(1)).toHaveText("W14 · 2027-04-05");
  await expect(mine.getByRole("cell").nth(2)).toHaveText("10.00");
  const badge = mine.getByText(/^Overloaded · \+\d+\.\d{2} MD$/);
  await expect(badge).toHaveCount(1);
  const verdict = (await badge.textContent()) ?? "";

  // The team's name opens its page; its weekly table shows the same week with the same worded badge.
  await mine.getByRole("link", { name: `Open team ${team}`, exact: true }).click();
  await expect(page.getByRole("heading", { level: 2, name: team, exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Show the weekly figures" }).click();
  const weekly = page.getByRole("table", { name: "Weekly load of the team", exact: true });
  const week = weekly.getByRole("row").filter({ hasText: "W14 · 2027-04-05" });
  await expect(week).toHaveCount(1);
  await expect(week).toContainText(verdict);
});

test("the Team load page lists the weeks from this week on, and Include past weeks brings an earlier one back", async ({ page }) => {
  // Dated from the run: capacity from four weeks before this week, one overloaded week three weeks before and one three weeks after, so neither
  // week can be "this week" whatever day or time zone the run starts in.
  const earlier = mondayFromNow(-3);
  const later = mondayFromNow(3);
  const team = await seedOverloadedTeam(mondayFromNow(-4), [earlier, later]);
  await login(page);

  // From this week on by default: the teams table counts both weeks, the weeks table lists the later one only, and one line says that earlier
  // weeks are left out (the plan is shared, so its count is not asserted).
  await page.goto("/team-load?warning=overloaded");
  await expect(page.getByRole("heading", { level: 2, name: "Team load", exact: true })).toBeVisible();
  const teams = page.getByRole("table", { name: "Load of every team", exact: true });
  const teamRow = teams.locator("tbody tr").filter({ has: page.getByRole("link", { name: `Open team ${team}`, exact: true }) });
  await expect(teamRow).toHaveCount(1);
  await expect(teamRow).toContainText("2 weeks overloaded");
  const weeks = page.getByRole("table", { name: "Weeks with a warning, by team", exact: true });
  const mine = weeks.locator("tbody tr").filter({ has: page.getByRole("link", { name: `Open team ${team}`, exact: true }) });
  await expect(mine).toHaveCount(1);
  await expect(mine.getByRole("cell").nth(1)).toHaveText(new RegExp(`^W\\d{2} · ${later}$`));
  await expect(page.getByText(/earlier weeks? (is|are) left out here/)).toBeVisible();

  // The switch brings the earlier week back (earlier Monday first), writes past=true and moves no count.
  await openFilters(page);
  await page.getByRole("switch", { name: "Include past weeks", exact: true }).click();
  await expect(page).toHaveURL(/past=true/);
  await expect(mine).toHaveCount(2);
  await expect(mine.first().getByRole("cell").nth(1)).toHaveText(new RegExp(`^W\\d{2} · ${earlier}$`));
  await expect(mine.last().getByRole("cell").nth(1)).toHaveText(new RegExp(`^W\\d{2} · ${later}$`));
  await expect(teamRow).toContainText("2 weeks overloaded");
  await expect(page.getByText(/earlier weeks? (is|are) left out here/)).toHaveCount(0);
});
