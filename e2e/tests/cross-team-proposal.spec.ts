// The cross-team schedule proposal (1.8) on /schedule-proposals, in 2048: a login that manages two teams runs ONE proposal over both, reads the
// second team's milestone landing after the first team's PROPOSED date and accepts both teams' moves in one write; unticking the first team's move
// turns the link into a warning through the ticked-subset check; a manager of one team is offered that team only and a login managing nothing is told so.
// Owns: its throwaway users, people, TWO teams (each with ONE capacity period from Monday 2048-01-06, 10 MD/week, no WIP limit), work stream,
// program, project, two milestones and the link between them (unique `e2e-ct-*` names), all seeded through the API and deleted by the afterEach
// below (the project first - its milestones and link go with it - then program, work stream, teams, people, users). Every date it pins is in 2048,
// which no other spec writes a holiday in; the real clock is the proposal's `asOf`, and nothing can land before a team's first capacity period.
import { randomUUID } from "node:crypto";
import type { APIRequestContext, Page } from "@playwright/test";
import { apiAsAdmin, deleteViaApi, expect, login, signOut, test, uniqueText } from "./helpers";

// A cross-team proposal's scope hash covers the global holiday dictionary, which `public-holidays` writes (2040): a holiday written while a run is open
// would stale the accept (409 `stale-scope`). The specs that write the dictionary or compare the hash never run at the same time.
test.describe.configure({ lock: "holiday-dictionary" });

// Registered in creation order; torn down in reverse (a project before its program before its stream before the teams and the people).
const teardown: string[] = [];
test.afterEach(async () => {
  await deleteViaApi(teardown.splice(0).reverse());
});

interface Account {
  email: string;
  password: string;
}

interface Milestone {
  id: number;
  name: string;
}

interface World {
  api: APIRequestContext;
  owner: Account;
  manager: Account;
  single: Account;
  teamX: string;
  teamY: string;
  x1: Milestone;
  y1: Milestone;
}

async function seed(api: APIRequestContext, path: string, data: object, tear: string): Promise<number> {
  const response = await api.post(path, { data });
  expect(response.status(), await response.text()).toBe(201);
  const id = ((await response.json()) as { id: number }).id;
  teardown.push(`${tear}/${id}`);
  return id;
}

async function seedUser(api: APIRequestContext, label: string): Promise<{ id: number; account: Account }> {
  const name = uniqueText(`e2e-ct-${label}`);
  const account = { email: `${name.toLowerCase()}@astrolabe.local`, password: randomUUID().replace(/-/g, "") };
  const id = await seed(api, "/api/v1/users", { name, email: account.email, password: account.password }, "/api/v1/users");
  return { id, account };
}

/**
 * The world: three throwaway logins (a project OWNER who manages nothing, a MANAGER and a SINGLE manager), two teams whose FIRST capacity period starts
 * on Monday 2048-01-06 (10 MD/week, no WIP limit: 2 MD a working day), a plan holding one project owned by the owner, and its milestones: `x1` 4 MD on
 * team X scheduled late (Monday 2048-03-02 to Tuesday 03-03), `y1` 2 MD on team Y unscheduled, and the finish-to-start link `x1 -> y1`. Team X is
 * managed by the MANAGER's person; team Y by the same person (the manager runs both teams) or, with `split`, by the SINGLE manager's (a team has
 * one manager, so the third scenario's world gives Y away).
 *
 * The run, counted by hand (2048 has no holiday on this stack): X is placed first (the link points from it), x1 takes two working days from the
 * first day with capacity, **2048-01-06 to 2048-01-07**; Y is placed with X's PROPOSED dates as facts, so y1 starts the working day after x1's
 * proposed end, a one-day milestone on **2048-01-08**; one pass, settled. Against x1's STORED end (03-03) y1 would start on 2048-03-04.
 */
async function seedWorld(split = false): Promise<World> {
  const { api } = await apiAsAdmin();
  const owner = await seedUser(api, "owner");
  const manager = await seedUser(api, "manager");
  const single = await seedUser(api, "single");
  const lead = await seed(api, "/api/v1/people", { name: uniqueText("e2e-ct-lead") }, "/api/v1/people");
  const ownerPerson = await seed(api, "/api/v1/people", { name: uniqueText("e2e-ct-ownerperson"), userId: owner.id }, "/api/v1/people");
  const managerPerson = await seed(api, "/api/v1/people", { name: uniqueText("e2e-ct-managerperson"), userId: manager.id }, "/api/v1/people");
  const singlePerson = await seed(api, "/api/v1/people", { name: uniqueText("e2e-ct-singleperson"), userId: single.id }, "/api/v1/people");
  const team = async (label: string, managerPersonId: number) => {
    const name = uniqueText(`e2e-ct-team${label}`);
    const id = await seed(api, "/api/v1/teams", { name, managerPersonId }, "/api/v1/teams");
    const capacity = await api.post(`/api/v1/teams/${id}/capacity`, { data: { effectiveFrom: "2048-01-06", mdPerWeek: 10 } });
    expect(capacity.status(), await capacity.text()).toBe(201);
    return { id, name };
  };
  const teamX = await team("x", managerPerson);
  const teamY = await team("y", split ? singlePerson : managerPerson);
  const streamId = await seed(api, "/api/v1/work-streams", { name: uniqueText("e2e-ct-stream"), ownerPersonId: lead, startDate: "2026-01-05" }, "/api/v1/work-streams");
  const programId = await seed(api, `/api/v1/work-streams/${streamId}/programs`, { name: uniqueText("e2e-ct-program"), ownerPersonId: lead }, "/api/v1/programs");
  const projectId = await seed(api, `/api/v1/programs/${programId}/projects`, { name: uniqueText("e2e-ct-project"), ownerPersonId: ownerPerson }, "/api/v1/projects");
  const milestone = async (label: string, teamId: number, estimateMd: number): Promise<Milestone> => {
    const name = uniqueText(`e2e-ct-${label}`);
    const response = await api.post(`/api/v1/projects/${projectId}/milestones`, { data: { name, teamId, estimateMd } });
    expect(response.status(), await response.text()).toBe(201);
    return { id: ((await response.json()) as { id: number }).id, name };
  };
  const x1 = await milestone("x1", teamX.id, 4);
  const y1 = await milestone("y1", teamY.id, 2);
  const view = await api.get(`/api/v1/views/team/${teamX.id}`);
  const { revision } = (await view.json()) as { revision: number };
  const scheduled = await api.put(`/api/v1/milestones/${x1.id}/schedule`, { data: { expectedRevision: revision, startDate: "2048-03-02", endDate: "2048-03-03" } });
  expect(scheduled.status(), await scheduled.text()).toBe(200);
  const link = await api.post(`/api/v1/projects/${projectId}/dependencies`, {
    data: { predecessor: { kind: "MILESTONE", id: x1.id }, successor: { kind: "MILESTONE", id: y1.id }, type: "FS", lagDays: 0 },
  });
  expect(link.status(), await link.text()).toBe(201);
  return { api, owner: owner.account, manager: manager.account, single: single.account, teamX: teamX.name, teamY: teamY.name, x1, y1 };
}

const teamsPicker = (page: Page) => page.getByRole("combobox", { name: "Teams", exact: true });
const proposeButton = (page: Page) => page.getByRole("button", { name: "Propose", exact: true });
const acceptButton = (page: Page, count: number) => page.getByRole("button", { name: `Accept selected across teams (${count})`, exact: true });
const sectionTable = (page: Page, team: string) => page.getByRole("table", { name: `Proposed moves of ${team}` });
const row = (page: Page, team: string, milestone: Milestone) => sectionTable(page, team).getByRole("row").filter({ hasText: milestone.name });
const note = (page: Page, text: string) => page.getByRole("note").filter({ hasText: text });
const isApi = (method: string, suffix: string) => (r: { request(): { method(): string }; url(): string; ok(): boolean }) =>
  r.request().method() === method && r.url().endsWith(`/api/v1/schedule-proposals${suffix}`) && r.ok();

async function openPage(page: Page): Promise<void> {
  await page.goto("/schedule-proposals");
  await expect(page.getByRole("heading", { level: 2, name: "Schedule proposals" })).toBeVisible();
}

/** Pick the teams in the multi-select (its dropdown lists only what the server offers). */
async function pickTeams(page: Page, ...names: string[]): Promise<void> {
  await teamsPicker(page).click();
  for (const name of names) await page.getByRole("option", { name, exact: true }).click();
  await page.keyboard.press("Escape");
}

/** Press Propose and wait for the run; returns its plan revision. */
async function propose(page: Page): Promise<number> {
  const [response] = await Promise.all([page.waitForResponse(isApi("POST", "")), proposeButton(page).click()]);
  await expect(page.getByRole("button", { name: "Discard", exact: true })).toBeVisible();
  return ((await response.json()) as { revision: number }).revision;
}

test("the manager of two teams runs a cross-team proposal: the second team's milestone lands after the first team's proposed date, and one accept writes both", async ({ page }) => {
  const world = await seedWorld();
  const { api } = world;

  await login(page, world.manager.email, world.manager.password);
  await openPage(page);
  // The multi-select offers exactly the two teams the login manages; Propose waits for a pick.
  await teamsPicker(page).click();
  await expect(page.getByRole("option")).toHaveText([world.teamX, world.teamY]);
  await page.keyboard.press("Escape");
  await expect(proposeButton(page)).toBeDisabled();
  await pickTeams(page, world.teamX, world.teamY);
  const proposedAt = await propose(page);

  // One pass, settled; the sections in placement order (X, whose link points ahead, then Y).
  await expect(note(page, "Placed in 1 pass · settled")).toBeVisible();
  await expect(page.getByRole("heading", { level: 3 })).toHaveText([world.teamX, world.teamY]);
  await expect(page.getByText("placed 1 of 2")).toBeVisible();
  await expect(page.getByText("placed 2 of 2")).toBeVisible();
  // x1 moves from March to the first days of the year; y1 lands the working day AFTER x1's proposed end, not after its stored one.
  await expect(row(page, world.teamX, world.x1)).toContainText("2048-03-02 to 2048-03-03");
  await expect(row(page, world.teamX, world.x1)).toContainText("2048-01-06 to 2048-01-07");
  await expect(row(page, world.teamY, world.y1)).toContainText("Unscheduled → 2048-01-08 to 2048-01-08, 1 working day");
  await expect(page.getByRole("checkbox", { name: `Accept ${world.x1.name}` })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: `Accept ${world.y1.name}` })).toBeChecked();
  await expect(page.getByText("Conflict", { exact: true })).toHaveCount(0);

  // ONE accept writes both teams' moves.
  const [accepted] = await Promise.all([page.waitForResponse(isApi("POST", "/accept")), acceptButton(page, 2).click()]);
  const body = (await accepted.json()) as { revision: number; accepted: unknown[]; skipped: unknown[] };
  expect(body.accepted).toHaveLength(2);
  expect(body.skipped).toHaveLength(0);
  // One plan write, one bump: the revision rose above the run's (other specs write the plan too, so "above", never an exact figure).
  expect(body.revision).toBeGreaterThan(proposedAt);
  await expect(note(page, "2 scheduled")).toBeVisible();
  await expect(sectionTable(page, world.teamX)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Discard", exact: true })).toHaveCount(0);

  // The API shows what the server stored, on both teams.
  for (const [milestone, start, end] of [
    [world.x1, "2048-01-06", "2048-01-07"],
    [world.y1, "2048-01-08", "2048-01-08"],
  ] as const) {
    const stored = await api.get(`/api/v1/milestones/${milestone.id}`);
    expect(await stored.json()).toMatchObject({ startDate: start, endDate: end });
  }
  await api.dispose();
});

test("unticking the first team's move keeps it in March, and the check turns the second team's link into a warning", async ({ page }) => {
  const world = await seedWorld();
  await world.api.dispose();

  await login(page, world.manager.email, world.manager.password);
  await openPage(page);
  await pickTeams(page, world.teamX, world.teamY);
  await propose(page);
  await expect(acceptButton(page, 2)).toBeVisible();
  await expect(sectionTable(page, world.teamY).getByText("Conflict", { exact: true })).toHaveCount(0);

  // Untick x1: it stays in March (ends 03-03), so y1 at 01-08 would start before its predecessor ends. The check answers for the ticked subset.
  await Promise.all([page.waitForResponse(isApi("POST", "/check")), page.getByRole("checkbox", { name: `Accept ${world.x1.name}` }).uncheck()]);
  await expect(acceptButton(page, 1)).toBeVisible();
  const y1 = row(page, world.teamY, world.y1);
  await expect(y1.getByText("Conflict", { exact: true })).toBeVisible();
  await expect(y1).toContainText("must start on 2048-03-04 or later");
  await expect(y1).toContainText(world.x1.name);

  // Tick it again: every move ticked, the proposal's own verdicts are exact (no check is asked) and the warning is gone.
  await page.getByRole("checkbox", { name: `Accept ${world.x1.name}` }).check();
  await expect(acceptButton(page, 2)).toBeVisible();
  await expect(sectionTable(page, world.teamY).getByText("Conflict", { exact: true })).toHaveCount(0);
  await expect(y1).not.toContainText("must start on");
});

test("a manager of one team is offered that team only, and a login managing nothing is told so", async ({ page }) => {
  const world = await seedWorld(true);
  await world.api.dispose();

  // SINGLE manages Y alone: the multi-select offers Y, and the run places y1 after x1's STORED end (X is a fact, not a team of the run).
  await login(page, world.single.email, world.single.password);
  await openPage(page);
  await teamsPicker(page).click();
  await expect(page.getByRole("option")).toHaveText([world.teamY]);
  await page.keyboard.press("Escape");
  await pickTeams(page, world.teamY);
  await propose(page);
  await expect(note(page, "Placed in 1 pass · settled")).toBeVisible();
  await expect(page.getByRole("heading", { level: 3 })).toHaveText([world.teamY]);
  await expect(row(page, world.teamY, world.y1)).toContainText("Unscheduled → 2048-03-04 to 2048-03-04, 1 working day");

  // The project OWNER manages no team: the empty state, no multi-select and no Propose.
  await signOut(page);
  await login(page, world.owner.email, world.owner.password);
  await openPage(page);
  await expect(page.getByText("You manage no team")).toBeVisible();
  await expect(page.getByText("A team's manager or an administrator can run a proposal.")).toBeVisible();
  await expect(teamsPicker(page)).toHaveCount(0);
  await expect(proposeButton(page)).toHaveCount(0);
});
