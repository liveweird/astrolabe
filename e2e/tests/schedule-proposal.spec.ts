// The schedule proposal (v0.8) on the team page (/teams/:id), in 2042: the team's manager asks for a proposal, reads the moves and the proposed
// weekly load beside the dashed bars, and accepts all of it, some of it, or all of it while one milestone was rescheduled under the open
// preview (that one is skipped, the others land); the project OWNER, who is not the manager, has no Propose button.
// Owns: its throwaway users, people, team (with ONE capacity period from Monday 2042-01-06, 10 MD/week, WIP limit 2), work stream, program,
// project, three milestones and the link between two of them (unique `e2e-sp-*` names), all seeded through the API and deleted by the
// afterEach below (the project first - its milestones and link go with it - then program, work stream, team, people, users). Every date
// it pins is in 2042, which no other spec writes a holiday in; the real clock is the proposal's `asOf`, and nothing can land before the
// team's first capacity period whatever today is.
import { randomUUID } from "node:crypto";
import type { APIRequestContext, Page } from "@playwright/test";
import { apiAsAdmin, deleteViaApi, expect, login, test, uniqueText } from "./helpers";

// The holiday dictionary is global, and a schedule proposal's scope hash covers it: a holiday written while a proposal is open stales the accept (409
// `stale-scope`). Specs that write the dictionary or compare the hash never run at the same time (a named lock holds the whole file's run).
test.describe.configure({ lock: "holiday-dictionary" });

// Registered in creation order; torn down in reverse (a project before its program before its stream before the team and the people).
const teardown: string[] = [];
test.afterEach(async () => {
  await deleteViaApi(teardown.splice(0).reverse());
});

interface Account {
  email: string;
  password: string;
}

interface World {
  api: APIRequestContext;
  owner: Account;
  manager: Account;
  team: string;
  teamId: number;
  a: { id: number; name: string };
  b: { id: number; name: string };
  c: { id: number; name: string };
}

async function seed(api: APIRequestContext, path: string, data: object, tear: string): Promise<number> {
  const response = await api.post(path, { data });
  expect(response.status(), await response.text()).toBe(201);
  const id = ((await response.json()) as { id: number }).id;
  teardown.push(`${tear}/${id}`);
  return id;
}

async function seedUser(api: APIRequestContext, label: string): Promise<{ id: number; account: Account }> {
  const name = uniqueText(`e2e-sp-${label}`);
  const account = { email: `${name.toLowerCase()}@astrolabe.local`, password: randomUUID().replace(/-/g, "") };
  const id = await seed(api, "/api/v1/users", { name, email: account.email, password: account.password }, "/api/v1/users");
  return { id, account };
}

/**
 * The world: two throwaway logins (a project OWNER and a team MANAGER, deliberately different people), a team the manager manages whose FIRST
 * capacity period starts on Monday 2042-01-06 (10 MD/week with a WIP limit of 2: 1 MD a day per milestone, 2 MD a day for the team), a plan
 * holding one project owned by the owner, and its milestones: `a` 4 MD and `b` 6 MD unscheduled, `c` 2 MD scheduled Monday 2042-03-03 to
 * Tuesday 03-04, and the finish-to-start link `b -> c`.
 *
 * The proposal, counted by hand (2042 has no holiday on this stack; the team order is c, a, b - the dated milestone first, the unscheduled
 * ones by name - and b is hoisted ahead of c, which needs it): b takes the first six working days from Mon 01-06 (01-06..01-10, then Mon
 * 01-13), a runs beside it, four days 01-06..01-09 (2 MD a day = the daily capacity, 2 in progress = the limit), and c starts the working
 * day after b ends, Tue 01-14..Wed 01-15. c moves 34 working days earlier (01-14 against 03-03: 4 weeks to Tue 02-11, 3 more to Tue 03-04,
 * less one day). The proposed week of 01-06 loads 4 + 5 = 9 of 10 MD, the week of 01-13 loads 1 + 2 = 3 of 10.
 */
async function seedWorld(): Promise<World> {
  const { api } = await apiAsAdmin();
  const owner = await seedUser(api, "owner");
  const manager = await seedUser(api, "manager");
  const lead = await seed(api, "/api/v1/people", { name: uniqueText("e2e-sp-lead") }, "/api/v1/people");
  const ownerPerson = await seed(api, "/api/v1/people", { name: uniqueText("e2e-sp-ownerperson"), userId: owner.id }, "/api/v1/people");
  const managerPerson = await seed(api, "/api/v1/people", { name: uniqueText("e2e-sp-managerperson"), userId: manager.id }, "/api/v1/people");
  const team = uniqueText("e2e-sp-team");
  const teamId = await seed(api, "/api/v1/teams", { name: team, managerPersonId: managerPerson }, "/api/v1/teams");
  const capacity = await api.post(`/api/v1/teams/${teamId}/capacity`, { data: { effectiveFrom: "2042-01-06", mdPerWeek: 10, wipLimit: 2 } });
  expect(capacity.status(), await capacity.text()).toBe(201);
  const streamId = await seed(api, "/api/v1/work-streams", { name: uniqueText("e2e-sp-stream"), ownerPersonId: lead, startDate: "2026-01-05" }, "/api/v1/work-streams");
  const programId = await seed(api, `/api/v1/work-streams/${streamId}/programs`, { name: uniqueText("e2e-sp-program"), ownerPersonId: lead }, "/api/v1/programs");
  const projectId = await seed(api, `/api/v1/programs/${programId}/projects`, { name: uniqueText("e2e-sp-project"), ownerPersonId: ownerPerson }, "/api/v1/projects");
  const milestone = async (label: string, estimateMd: number) => {
    const name = uniqueText(`e2e-sp-ms-${label}`);
    const response = await api.post(`/api/v1/projects/${projectId}/milestones`, { data: { name, teamId, estimateMd } });
    expect(response.status(), await response.text()).toBe(201);
    return { id: ((await response.json()) as { id: number }).id, name };
  };
  const a = await milestone("a", 4);
  const b = await milestone("b", 6);
  const c = await milestone("c", 2);
  const world = { api, owner: owner.account, manager: manager.account, team, teamId, a, b, c };
  await scheduleViaApi(world, c.id, "2042-03-03", "2042-03-04");
  const link = await api.post(`/api/v1/projects/${projectId}/dependencies`, {
    data: { predecessor: { kind: "MILESTONE", id: b.id }, successor: { kind: "MILESTONE", id: c.id }, type: "FS", lagDays: 0 },
  });
  expect(link.status(), await link.text()).toBe(201);
  return world;
}

/** A schedule write as the ADMIN, with the team view's current plan revision (a client that has just read the view). */
async function scheduleViaApi(world: Pick<World, "api" | "teamId">, milestoneId: number, startDate: string, endDate: string): Promise<void> {
  const view = await world.api.get(`/api/v1/views/team/${world.teamId}`);
  const { revision } = (await view.json()) as { revision: number };
  const response = await world.api.put(`/api/v1/milestones/${milestoneId}/schedule`, { data: { expectedRevision: revision, startDate, endDate } });
  expect(response.status(), await response.text()).toBe(200);
}

const settled = (page: Page) => expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
const timeline = (page: Page) => page.getByRole("grid", { name: "Team milestone timeline" });
const tray = (page: Page) => page.getByRole("table", { name: "Unscheduled milestones of the team" });
const proposalTable = (page: Page) => page.getByRole("table", { name: "Proposed schedule moves" });
const strip = (page: Page, week: string) => page.locator(`[data-week="${week}"]`);
const proposeButton = (page: Page) => page.getByRole("button", { name: "Propose schedule" });
/** The note under the timeline header that says what an accept came to (the visually hidden status region says it too, so scope to the note). */
const outcomeNote = (page: Page, text: string) => page.getByRole("note").filter({ hasText: text });
/** A milestone's own (current) bar: the manager's bars are movable buttons named "<name>, <project>, <start> to <end>, <estimate>". */
const bar = (page: Page, name: string, start: string, end: string) => timeline(page).getByRole("button", { name: new RegExp(`^${name}, .*, ${start} to ${end}, `) });

async function openTeam(page: Page, world: World): Promise<void> {
  await page.goto(`/teams/${world.teamId}`);
  await expect(page.getByRole("heading", { level: 2, name: world.team })).toBeVisible();
  await expect(timeline(page)).toBeVisible();
  await settled(page);
}

/** Press Propose schedule, wait for the answer and for the Proposed schedule section. */
async function propose(page: Page): Promise<void> {
  await Promise.all([
    page.waitForResponse((r) => r.request().method() === "POST" && /\/api\/v1\/teams\/\d+\/schedule-proposal$/.test(r.url()) && r.ok()),
    proposeButton(page).click(),
  ]);
  await expect(page.getByRole("heading", { level: 3, name: "Proposed schedule" })).toBeVisible();
  await expect(proposalTable(page)).toBeVisible();
}

/** Press the accept button (named by the selected count) and wait for the batch. */
async function accept(page: Page, count: number): Promise<void> {
  await Promise.all([
    page.waitForResponse((r) => r.request().method() === "POST" && /\/api\/v1\/teams\/\d+\/milestone-schedules$/.test(r.url()) && r.ok()),
    page.getByRole("button", { name: `Accept selected (${count})` }).click(),
  ]);
  await expect(proposalTable(page)).toHaveCount(0);
}

test("the team's manager proposes a schedule, reads the moves and the proposed load, and accepts them all", async ({ page }) => {
  const world = await seedWorld();
  await world.api.dispose();

  await login(page, world.manager.email, world.manager.password);
  await openTeam(page, world);
  // Before: c sits in March and loads that week; a and b wait in the tray.
  await expect(strip(page, "2042-03-03")).toHaveAttribute("title", /^Week of 2042-03-03: 2 of 10 man-days/);
  await expect(tray(page).getByRole("row")).toHaveCount(3); // the header, a and b
  await propose(page);

  // The preview: three dashed bars (c's proposed one beside its current bar, a and b on rows the preview appends), the summary, the strip.
  await expect(page.locator('[data-tone="proposal"]')).toHaveCount(3);
  await expect(page.getByRole("img", { name: `Proposed: ${world.b.name}, 2042-01-06 to 2042-01-13, read-only` })).toBeVisible();
  await expect(page.getByRole("img", { name: `Proposed: ${world.a.name}, 2042-01-06 to 2042-01-09, read-only` })).toBeVisible();
  await expect(page.getByRole("img", { name: `Proposed: ${world.c.name}, 2042-01-14 to 2042-01-15, read-only` })).toBeVisible();
  await expect(page.getByText("3 moves · 2 newly scheduled · 0 stay · 0 could not be placed")).toBeVisible();
  // The strip shows the load AFTER accepting every move: 4 + 5 = 9 of 10 in the week of 01-06, 1 + 2 = 3 in the week of 01-13.
  await expect(strip(page, "2042-01-06")).toHaveAttribute("title", /^Week of 2042-01-06: 9 of 10 man-days; up to 2 milestones in progress$/);
  await expect(strip(page, "2042-01-13")).toHaveAttribute("title", /^Week of 2042-01-13: 3 of 10 man-days/);
  await expect(strip(page, "2042-01-06")).toHaveAttribute("data-overloaded", "false");
  await expect(strip(page, "2042-01-06")).toHaveAttribute("data-wip-exceeded", "false");

  // The table: the team's order (c, a, b), all three ticked, each move in words.
  const table = proposalTable(page);
  await expect(table.getByRole("row")).toHaveCount(4);
  await expect(table.getByRole("checkbox", { name: "Accept all" })).toBeChecked();
  const rowC = table.getByRole("row").filter({ hasText: world.c.name });
  await expect(rowC).toContainText("2042-03-03 to 2042-03-04");
  await expect(rowC).toContainText("2042-01-14 to 2042-01-15");
  await expect(rowC).toContainText("34 working days earlier");
  const rowA = table.getByRole("row").filter({ hasText: world.a.name });
  await expect(rowA).toContainText("Unscheduled → 2042-01-06 to 2042-01-09, 4 working days");
  const rowB = table.getByRole("row").filter({ hasText: world.b.name });
  await expect(rowB).toContainText("Unscheduled → 2042-01-06 to 2042-01-13, 6 working days");
  await expect(table.getByRole("row").nth(1)).toContainText(world.c.name);
  await expect(table.getByRole("row").nth(2)).toContainText(world.a.name);
  await expect(table.getByRole("row").nth(3)).toContainText(world.b.name);

  // Accept all: the batch lands, the dashed bars and the table go, the milestones are bars at the proposed dates and the tray is empty.
  await accept(page, 3);
  await expect(outcomeNote(page, "3 scheduled")).toBeVisible();
  await expect(page.locator('[data-tone="proposal"]')).toHaveCount(0);
  await expect(bar(page, world.b.name, "2042-01-06", "2042-01-13")).toBeVisible();
  await expect(bar(page, world.a.name, "2042-01-06", "2042-01-09")).toBeVisible();
  await expect(bar(page, world.c.name, "2042-01-14", "2042-01-15")).toBeVisible();
  await expect(page.getByText("Every milestone is scheduled.")).toBeVisible();
  await expect(tray(page)).toHaveCount(0);
  // The page reads what the server stored: the weekly load is now the proposed one.
  await expect(strip(page, "2042-01-06")).toHaveAttribute("title", /^Week of 2042-01-06: 9 of 10 man-days/);
  await expect(strip(page, "2042-03-03")).toHaveCount(0);
  await expect(proposeButton(page)).toBeEnabled();
});

test("the manager accepts some of the proposal and the rest stays as it was", async ({ page }) => {
  const world = await seedWorld();
  await world.api.dispose();

  await login(page, world.manager.email, world.manager.password);
  await openTeam(page, world);
  await propose(page);

  // Untick b: the select-all box turns indeterminate and the button counts two.
  const table = proposalTable(page);
  await table.getByRole("checkbox", { name: `Accept ${world.b.name}` }).uncheck();
  await expect(table.getByRole("checkbox", { name: `Accept ${world.a.name}` })).toBeChecked();
  await expect(table.getByRole("checkbox", { name: `Accept ${world.c.name}` })).toBeChecked();
  await expect(table.getByRole("checkbox", { name: "Accept all" })).toHaveJSProperty("indeterminate", true);
  await accept(page, 2);

  // a and c landed at their proposed dates; b is still in the tray, and its link to c reads nothing (an unscheduled end is no conflict).
  await expect(outcomeNote(page, "2 scheduled")).toBeVisible();
  await expect(bar(page, world.a.name, "2042-01-06", "2042-01-09")).toBeVisible();
  await expect(bar(page, world.c.name, "2042-01-14", "2042-01-15")).toBeVisible();
  await expect(timeline(page).getByRole("button", { name: new RegExp(`^${world.b.name}, `) })).toHaveCount(0);
  await expect(tray(page).getByRole("row").filter({ hasText: world.b.name })).toHaveCount(1);
  await expect(tray(page).getByRole("row").filter({ hasText: world.a.name })).toHaveCount(0);
  await expect(page.getByRole("group", { name: "Team facts" })).not.toContainText("conflict");
});

test("a milestone rescheduled after the proposal is skipped and the others land", async ({ page }) => {
  const world = await seedWorld();

  await login(page, world.manager.email, world.manager.password);
  await openTeam(page, world);
  await propose(page);

  // Meanwhile the administrator schedules a (through the API) to dates of their own: its schedule revision is now above the proposal's.
  await scheduleViaApi(world, world.a.id, "2042-02-04", "2042-02-05");
  await world.api.dispose();

  await accept(page, 3);
  await expect(outcomeNote(page, "2 scheduled · 1 skipped: rescheduled in the meantime")).toBeVisible();
  // a keeps the administrator's dates once the page has reloaded the view; b and c took the proposal's.
  await expect(bar(page, world.a.name, "2042-02-04", "2042-02-05")).toBeVisible();
  await expect(bar(page, world.b.name, "2042-01-06", "2042-01-13")).toBeVisible();
  await expect(bar(page, world.c.name, "2042-01-14", "2042-01-15")).toBeVisible();
  await expect(timeline(page).getByRole("button", { name: new RegExp(`^${world.a.name}, .*, 2042-01-06 to 2042-01-09, `) })).toHaveCount(0);
  await expect(tray(page)).toHaveCount(0);
});

test("the project owner reads the team page without the Propose schedule button", async ({ page }) => {
  const world = await seedWorld();
  await world.api.dispose();

  await login(page, world.owner.email, world.owner.password);
  await openTeam(page, world);
  // The page is the same read-only one the owner always sees: c's bar is a read-only image and nothing proposes.
  await expect(page.getByRole("img", { name: new RegExp(`^${world.c.name}, .*, 2042-03-03 to 2042-03-04, .*, read-only$`) })).toBeVisible();
  await expect(page.getByText("manager or an administrator schedules them")).toBeVisible();
  await expect(proposeButton(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Propose/ })).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 3, name: "Proposed schedule" })).toHaveCount(0);
});
