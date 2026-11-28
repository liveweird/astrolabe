// The cross-team schedule proposal planned from the team page (1.38), in 2050: the manager of TWO teams opens team A's page, adds the linked team with "Add linked teams", proposes and
// reads team B's linked milestone as a dimmed row (its current dates a ghost bar, its proposed dates the dashed bar) under team A's own, follows the ticks (an unticked move loses its dashed
// bar, its row stays) and accepts: the run's ONE accept schedules both teams' milestones. The picker row wraps at 390 px; the open run passes axe in both schemes.
// Owns: its throwaway users, people, TWO teams (each with ONE capacity period from Monday 2050-01-03, 10 MD/week, no WIP limit; both managed by the same login), work stream, program, project,
// two milestones and the link between them (unique `e2e-tr-*` names), all seeded through the API and deleted by the afterEach below (the project first - its milestones and link go with it - then
// program, work stream, teams, people, users). Every date it pins is in 2050, which no other spec writes a holiday in; the real clock is the proposal's `asOf`, and nothing can land before a team's
// first capacity period.
import { randomUUID } from "node:crypto";
import type { APIRequestContext, Page, Response } from "@playwright/test";
import { apiAsAdmin, axeViolations, deleteViaApi, expect, expectNoSidewaysScroll, expectScheme, login, PHONE, test, uniqueText, type Scheme } from "./helpers";

// A cross-team proposal's scope token carries the global holiday dictionary, which `public-holidays` writes (2040): the specs that write it or compare the figures never run at the same time.
test.describe.configure({ lock: "holiday-dictionary" });

// Registered in creation order; torn down in reverse (a project before its program before its stream before the teams and the people).
const teardown: string[] = [];
test.afterEach(async () => {
  await deleteViaApi(teardown.splice(0).reverse());
});

interface Milestone {
  id: number;
  name: string;
}

interface World {
  api: APIRequestContext;
  manager: { email: string; password: string };
  teamA: { id: number; name: string };
  teamB: { id: number; name: string };
  projectName: string;
  a1: Milestone;
  b1: Milestone;
}

async function seed(api: APIRequestContext, path: string, data: object, tear: string): Promise<number> {
  const response = await api.post(path, { data });
  expect(response.status(), await response.text()).toBe(201);
  const id = ((await response.json()) as { id: number }).id;
  teardown.push(`${tear}/${id}`);
  return id;
}

/**
 * The world: ONE throwaway login that manages BOTH teams (through one person), two teams whose FIRST capacity period starts on Monday 2050-01-03 (10 MD/week: 2 MD a working day), a
 * project owned by a person with no login and its milestones: `a1` 4 MD on team A scheduled Tuesday 2050-03-01 to Wednesday 03-02, `b1` 2 MD on team B scheduled Thursday 03-03 to Friday
 * 03-04, and the finish-to-start link `a1 -> b1` (so team A's page names team B's milestone).
 *
 * The run, counted by hand (2050 has no holiday on this stack): A is placed first (the link points from it), a1 takes two working days from the first day with capacity, **2050-01-03 to
 * 2050-01-04**; B is placed with A's PROPOSED dates as facts, so b1 is a one-day milestone on the working day after, **2050-01-05**; one pass, settled.
 */
async function seedWorld(): Promise<World> {
  const { api } = await apiAsAdmin();
  const name = uniqueText("e2e-tr-manager");
  const manager = { email: `${name.toLowerCase()}@astrolabe.local`, password: randomUUID().replace(/-/g, "") };
  const managerUser = await seed(api, "/api/v1/users", { name, email: manager.email, password: manager.password }, "/api/v1/users");
  const lead = await seed(api, "/api/v1/people", { name: uniqueText("e2e-tr-lead") }, "/api/v1/people");
  const managerPerson = await seed(api, "/api/v1/people", { name: uniqueText("e2e-tr-managerperson"), userId: managerUser }, "/api/v1/people");
  const team = async (label: string) => {
    const teamName = uniqueText(`e2e-tr-team${label}`);
    const id = await seed(api, "/api/v1/teams", { name: teamName, managerPersonId: managerPerson }, "/api/v1/teams");
    const capacity = await api.post(`/api/v1/teams/${id}/capacity`, { data: { effectiveFrom: "2050-01-03", mdPerWeek: 10 } });
    expect(capacity.status(), await capacity.text()).toBe(201);
    return { id, name: teamName };
  };
  const teamA = await team("a");
  const teamB = await team("b");
  const streamId = await seed(api, "/api/v1/work-streams", { name: uniqueText("e2e-tr-stream"), ownerPersonId: lead, startDate: "2026-01-05" }, "/api/v1/work-streams");
  const programId = await seed(api, `/api/v1/work-streams/${streamId}/programs`, { name: uniqueText("e2e-tr-program"), ownerPersonId: lead }, "/api/v1/programs");
  const projectName = uniqueText("e2e-tr-project");
  const projectId = await seed(api, `/api/v1/programs/${programId}/projects`, { name: projectName, ownerPersonId: lead }, "/api/v1/projects");
  const milestone = async (label: string, teamId: number, estimateMd: number, start: string, end: string): Promise<Milestone> => {
    const milestoneName = uniqueText(`e2e-tr-${label}`);
    const response = await api.post(`/api/v1/projects/${projectId}/milestones`, { data: { name: milestoneName, teamId, estimateMd } });
    expect(response.status(), await response.text()).toBe(201);
    const id = ((await response.json()) as { id: number }).id;
    const view = await api.get(`/api/v1/views/team/${teamId}`);
    const { revision } = (await view.json()) as { revision: number };
    const scheduled = await api.put(`/api/v1/milestones/${id}/schedule`, { data: { expectedRevision: revision, startDate: start, endDate: end } });
    expect(scheduled.status(), await scheduled.text()).toBe(200);
    return { id, name: milestoneName };
  };
  const a1 = await milestone("a1", teamA.id, 4, "2050-03-01", "2050-03-02");
  const b1 = await milestone("b1", teamB.id, 2, "2050-03-03", "2050-03-04");
  const link = await api.post(`/api/v1/projects/${projectId}/dependencies`, {
    data: { predecessor: { kind: "MILESTONE", id: a1.id }, successor: { kind: "MILESTONE", id: b1.id }, type: "FS", lagDays: 0 },
  });
  expect(link.status(), await link.text()).toBe(201);
  return { api, manager, teamA, teamB, projectName, a1, b1 };
}

const timeline = (page: Page) => page.getByRole("grid", { name: "Team milestone timeline" });
const proposeButton = (page: Page) => page.getByRole("button", { name: "Propose schedule", exact: true });
const picker = (page: Page) => page.getByRole("combobox", { name: "Plan together with", exact: true });
const addLinked = (page: Page) => page.getByRole("button", { name: "Add linked teams", exact: true });
const runHeading = (page: Page) => page.getByRole("heading", { level: 3, name: "Schedule proposal", exact: true });
const rowOf = (page: Page, milestone: Milestone) => timeline(page).getByRole("row").filter({ hasText: milestone.name });
const dashed = (page: Page) => page.locator('[data-tone="proposal"]');
const note = (page: Page, text: string) => page.getByRole("note").filter({ hasText: text });
const isApi = (method: string, suffix: string) => (r: { request(): { method(): string }; url(): string }) =>
  r.request().method() === method && r.url().endsWith(`/api/v1/schedule-proposals${suffix}`);
async function expectOk(response: Response): Promise<Response> {
  expect(response.status(), await response.text()).toBe(200);
  return response;
}

/** Team A's page, with the page's own rights read (Propose is offered with `team.can.schedule`). */
async function openTeamA(page: Page, world: World): Promise<void> {
  await page.goto(`/teams/${world.teamA.id}`);
  await expect(page.getByRole("heading", { level: 2, name: world.teamA.name })).toBeVisible();
  await expect(timeline(page)).toBeVisible();
  await expect(proposeButton(page)).toBeEnabled();
}

/** Add the linked team and press Propose: the run over A and B, opened on its heading. */
async function planTogether(page: Page): Promise<void> {
  await addLinked(page).click();
  await expect(proposeButton(page)).toBeEnabled();
  const [response] = await Promise.all([page.waitForResponse(isApi("POST", "")), proposeButton(page).click()]);
  await expectOk(response);
  await expect(runHeading(page)).toBeVisible();
  // The run opens on its heading (1.37): focused and below the sticky 56 px header.
  await expect(runHeading(page)).toBeFocused();
  await expect.poll(async () => (await runHeading(page).boundingBox())?.y ?? 0).toBeGreaterThanOrEqual(56);
}

test("the manager of two teams plans together from one team's page: the linked team's milestone is a dimmed row with its dashed bar, and one accept schedules both teams", async ({ page }) => {
  const world = await seedWorld();
  const { api } = world;
  try {
    await login(page, world.manager.email, world.manager.password);
    await openTeamA(page, world);
    // Before: the picker row is beside Propose, team B is the one linked team, no dashed bar, no dimmed row.
    await expect(picker(page)).toBeVisible();
    await expect(dashed(page)).toHaveCount(0);
    await expect(rowOf(page, world.b1)).toHaveCount(0);
    await planTogether(page);

    // The picker gives way to the run, which names both teams and was asked once over [A, B].
    await expect(picker(page)).toHaveCount(0);
    await expect(proposeButton(page)).toBeDisabled();
    await expect(page.getByRole("heading", { level: 3, name: world.teamA.name, exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { level: 3, name: world.teamB.name, exact: true })).toBeVisible();

    // The rows: A's own a1 with its dashed bar beside the current one; B's b1 as a dimmed row after it - the ghost bar where b1 stands, the dashed bar where the run puts it.
    await expect(dashed(page)).toHaveCount(2);
    await expect(page.getByRole("img", { name: `Proposed: ${world.a1.name}, 2050-01-03 to 2050-01-04, read-only` })).toBeVisible();
    const linked = rowOf(page, world.b1);
    await expect(linked).toHaveCount(1);
    await expect(linked.getByRole("img", { name: `${world.b1.name}, ${world.teamB.name}, ${world.projectName}, 2050-03-03 to 2050-03-04, linked to this team's work, read-only` })).toBeVisible();
    await expect(linked.getByRole("img", { name: `Proposed: ${world.b1.name}, 2050-01-05 to 2050-01-05, read-only` })).toBeVisible();
    await expect(linked.getByRole("link", { name: `Open team ${world.teamB.name}` })).toBeVisible();
    await expect(timeline(page).getByRole("row").nth(1)).toContainText(world.a1.name);
    await expect(timeline(page).getByRole("row").nth(2)).toContainText(world.b1.name);

    // Both teams' moves are the manager's: ticked, one accept for both. The dashed bars follow the ticks: b1 unticked loses its bar, its row stays; ticked again, the bar is back.
    await expect(page.getByRole("button", { name: "Accept selected (2)", exact: true })).toBeVisible();
    await page.getByRole("checkbox", { name: `Accept ${world.b1.name}` }).uncheck();
    await expect(dashed(page)).toHaveCount(1);
    await expect(rowOf(page, world.b1)).toHaveCount(1);
    await page.getByRole("checkbox", { name: `Accept ${world.b1.name}` }).check();
    await expect(dashed(page)).toHaveCount(2);

    // ONE accept, naming both teams, writing both milestones.
    const [accepted] = await Promise.all([page.waitForResponse(isApi("POST", "/accept")), page.getByRole("button", { name: "Accept selected (2)", exact: true }).click()]);
    await expectOk(accepted);
    const request = accepted.request().postDataJSON() as { teamIds: number[]; acceptTeamIds: number[]; items: { milestoneId: number }[] };
    expect([...request.teamIds].sort((a, b) => a - b)).toEqual([world.teamA.id, world.teamB.id].sort((a, b) => a - b));
    expect([...request.acceptTeamIds].sort((a, b) => a - b)).toEqual([world.teamA.id, world.teamB.id].sort((a, b) => a - b));
    expect(request.items.map((item) => item.milestoneId).sort((a, b) => a - b)).toEqual([world.a1.id, world.b1.id].sort((a, b) => a - b));
    expect(((await accepted.json()) as { accepted: unknown[] }).accepted).toHaveLength(2);
    await expect(note(page, "2 scheduled")).toBeVisible();
    await expect(runHeading(page)).toHaveCount(0);
    await expect(dashed(page)).toHaveCount(0);
    await expect(rowOf(page, world.b1)).toHaveCount(0);
    // The mounted page already shows a1 at its new dates, and the picker is back with the choice kept.
    await expect(timeline(page).getByRole("button", { name: new RegExp(`^${world.a1.name}, .*, 2050-01-03 to 2050-01-04, `) })).toBeVisible();
    await expect(picker(page)).toBeVisible();

    // The server stored both.
    expect(await (await api.get(`/api/v1/milestones/${world.a1.id}`)).json()).toMatchObject({ startDate: "2050-01-03", endDate: "2050-01-04" });
    expect(await (await api.get(`/api/v1/milestones/${world.b1.id}`)).json()).toMatchObject({ startDate: "2050-01-05", endDate: "2050-01-05" });
  } finally {
    await api.dispose();
  }
});

test("left empty, the picker proposes for the team alone, as Propose always did", async ({ page }) => {
  const world = await seedWorld();
  await world.api.dispose();

  await login(page, world.manager.email, world.manager.password);
  await openTeamA(page, world);
  const [response] = await Promise.all([page.waitForResponse((r) => r.request().method() === "POST" && /\/api\/v1\/teams\/\d+\/schedule-proposal$/.test(r.url())), proposeButton(page).click()]);
  expect(response.status(), await response.text()).toBe(200);
  await expect(page.getByRole("heading", { level: 3, name: "Proposed schedule", exact: true })).toBeVisible();
  await expect(runHeading(page)).toHaveCount(0);
  // Only the team's own move is drawn: team B's milestone has no row.
  await expect(dashed(page)).toHaveCount(1);
  await expect(rowOf(page, world.b1)).toHaveCount(0);
});

test("the picker row wraps at 390 px: the picker, Add linked teams and Propose stay inside the window", async ({ page }) => {
  const world = await seedWorld();
  await world.api.dispose();

  await login(page, world.manager.email, world.manager.password);
  await openTeamA(page, world);
  await addLinked(page).click();
  await page.setViewportSize(PHONE);
  await expect(picker(page)).toBeVisible();
  for (const control of [proposeButton(page), picker(page), addLinked(page)]) {
    const box = await control.boundingBox();
    expect(box).not.toBeNull();
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(PHONE.width);
    expect(box?.x ?? 0).toBeGreaterThanOrEqual(0);
  }
  await expectNoSidewaysScroll(page);
});

/** The open run, scanned in the scheme the test runs in (the dark one failed contrast once for a disabled picker, so the run is scanned in each). */
async function scanOpenRun(page: Page, scheme: Scheme): Promise<void> {
  const world = await seedWorld();
  await world.api.dispose();

  await login(page, world.manager.email, world.manager.password);
  await openTeamA(page, world);
  await planTogether(page);
  await expectScheme(page, scheme);
  await expect(dashed(page)).toHaveCount(2);
  expect(await axeViolations(page)).toEqual([]);
}

test("the open run on the team page has no WCAG A/AA violations", async ({ page }) => {
  await scanOpenRun(page, "light");
});

test.describe("dark scheme", () => {
  test.use({ colorScheme: "dark" });
  test("the open run on the team page has no WCAG A/AA violations in the dark scheme", async ({ page }) => {
    await scanOpenRun(page, "dark");
  });
});
