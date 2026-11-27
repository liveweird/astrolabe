// The Teams page's load figures (1.19 as the Team load page; folded into /teams in 1.32, whose old address /team-load redirects): every team with its overloaded and over-WIP weeks, the "Show" filter in the URL, and (1.36) the badges that lead to the team's weekly load table. The plan is shared by four
// workers, so the plan-wide figures (the facts line's team counts) are only ever asserted PRESENT, never as values; the row asserted exactly is
// this spec's own team. Owns: its throwaway person, one team (no manager) with one capacity period from Monday 2027-04-05 of 1 man-day a week, a work
// stream, program, project and ONE milestone of 10 man-days on that team scheduled 2027-04-05..09 (unique `e2e-load-*` names), all seeded through the
// API in the test and removed through the API (the project first - its milestone goes with it - then program, work stream, team - its capacity
// period goes with it -, person), even after a failure. April 2027 on purpose: 10 man-days against 1 a week is overloaded whatever a holiday did to
// that week (every test here shares this world; since 1.36 the Teams page has no weeks table of its own, the team page's weekly table is the one place a week
// is read, and it lists every week, so the fixed April 2027 week never expires), and no far-off year keeps the team page's timeline short. It writes no
// ranking, no holiday and no connection, and needs no lock.
import type { APIRequestContext } from "@playwright/test";
import { addDays, apiAsAdmin, deleteViaApi, expect, expectNoSidewaysScroll, expectTextWhole, login, openFilters, PHONE, test, uniqueText } from "./helpers";

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

test("the Teams page lists a team with an overloaded week, and its name opens the team page that says the same", async ({ page }) => {
  const team = await seedOverloadedTeam("2027-04-05", ["2027-04-05"]);
  await login(page);

  // The retired address (an old bookmark) lands on Teams with the filter kept: this spec's team is a row with its worded badge and, for an ADMIN, its
  // row menu; the facts line shows a count of teams with an overloaded week and the plan-wide not-scheduled total (present, never a value).
  await page.goto("/team-load?warning=overloaded");
  await expect(page).toHaveURL(/\/teams\?warning=overloaded$/);
  await expect(page.getByRole("heading", { level: 2, name: "Teams", exact: true })).toBeVisible();
  const rows = page.getByRole("table", { name: "Teams", exact: true }).locator("tbody tr");
  const mine = rows.filter({ has: page.getByRole("link", { name: `Open team ${team}`, exact: true }) });
  await expect(mine).toHaveCount(1);
  await expect(mine).toContainText("1 week overloaded");
  await expect(mine.getByRole("button", { name: `Operations for ${team}`, exact: true })).toBeVisible();
  const facts = page.getByRole("group", { name: "The teams in figures", exact: true });
  await expect(facts.getByText(/^\d+ teams?$/)).toBeVisible();
  await expect(facts.getByText(/^\d+ teams? with an overloaded week$/)).toBeVisible();
  await expect(facts.getByText(/^\d+ not scheduled yet$/)).toBeVisible();

  // "Every team" drops the parameter; the team's name opens the page that shows the same overloaded week.
  await openFilters(page);
  await page.getByRole("combobox", { name: "Show", exact: true }).click();
  await page.getByRole("option", { name: "Every team", exact: true }).click();
  await expect(page).not.toHaveURL(/warning=/);
  await page
    .getByRole("table", { name: "Teams", exact: true })
    .getByRole("link", { name: `Open team ${team}`, exact: true })
    .click();
  await expect(page.getByRole("heading", { level: 2, name: team, exact: true })).toBeVisible();
  await expect(page.getByRole("group", { name: "Team facts", exact: true })).toContainText("1 week overloaded");
});

test("clicking a team's overloaded badge opens its page with the weekly load table open, focused and on the overloaded week", async ({ page }) => {
  const team = await seedOverloadedTeam("2027-04-05", ["2027-04-05"]);
  await login(page);

  // Narrowed to the teams with an overloaded week (four workers share the plan: only this spec's own row is read). The badge is a link named by its figure
  // and where it goes, and its address names the kind of week it counts (`?load=overloaded`).
  await page.goto("/teams?warning=overloaded");
  const teams = page.getByRole("table", { name: "Teams", exact: true });
  const mine = teams.locator("tbody tr").filter({ has: page.getByRole("link", { name: `Open team ${team}`, exact: true }) });
  await expect(mine).toHaveCount(1);
  await mine.getByRole("link", { name: `1 week overloaded: open the weekly load of team ${team}`, exact: true }).click();

  // The team page: the weekly load table is already open (no "Show the weekly figures" click), holds the focus, is in view (the Flow section above it has landed by
  // then), the address has dropped `load`, and the first overloaded week is marked and in view inside the table's own scroller. A holiday in the week would change
  // the capacity, never the week or the load, so the shortfall is a pattern.
  await expect(page.getByRole("heading", { level: 2, name: team, exact: true })).toBeVisible();
  const weekly = page.getByRole("table", { name: "Weekly load of the team", exact: true });
  await expect(weekly).toBeVisible();
  await expect(page.getByRole("button", { name: "Hide the weekly figures", exact: true })).toHaveAttribute("aria-expanded", "true");
  const region = page.getByRole("region", { name: "Weekly load of the team", exact: true });
  await expect(region).toBeFocused();
  await expect(region).toBeInViewport();
  await expect(page).not.toHaveURL(/load=/);
  const week = weekly.getByRole("row").filter({ hasText: "W14 · 2027-04-05" });
  await expect(week).toHaveCount(1);
  await expect(week.getByText(/^Overloaded · \+\d+\.\d{2} MD$/)).toHaveCount(1);
  await expect(week).toHaveAttribute("aria-current", "true");
  await expect(week).toBeInViewport();
});

test("the Teams page shows every warning badge whole at 1440 px and does not scroll sideways at 390 px", async ({ page }) => {
  const team = await seedOverloadedTeam("2027-04-05", ["2027-04-05"]);
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);

  // The badges (the plan is shared, so every badge on the page is read, not only this spec's own): none ends in an ellipsis, and this spec's own team
  // has its worded badge in a row that shows it.
  await page.goto("/teams");
  const teams = page.getByRole("table", { name: "Teams", exact: true });
  const mine = teams.locator("tbody tr").filter({ has: page.getByRole("link", { name: `Open team ${team}`, exact: true }) });
  await expect(mine).toContainText("1 week overloaded");
  // The row's badge is a link (1.36): its label is still read whole.
  await expect(mine.getByRole("link", { name: `1 week overloaded: open the weekly load of team ${team}`, exact: true })).toBeVisible();
  await expectTextWhole(teams.locator(".mantine-Badge-label"));

  // On a phone the table scrolls inside its own box.
  await page.setViewportSize(PHONE);
  await expect(mine).toContainText("1 week overloaded");
  await expectNoSidewaysScroll(page);
});
