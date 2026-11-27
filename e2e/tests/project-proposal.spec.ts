// The cross-team schedule proposal (1.8) on the project page (1.33), in 2049: ANY login previews one over the teams of the project's milestones, and the manager of ONE of the two
// teams accepts only their move. A login that manages nothing previews (the dashed bars, the new row of the tray milestone, the sentence about the project's end) and is offered
// no accept; the manager of team Y ticks only y1, reads the check's verdict for exactly that tick (the link from x1, which stays in March, turns into a warning), finds the date
// writes locked while the proposal is open and accepts: the accept names team Y alone, x1 stays where it was; an axe scan of the open preview closes it.
// Owns: its throwaway users, people, TWO teams (each with ONE capacity period from Monday 2049-01-04, 10 MD/week, no WIP limit), work stream, program, project, two milestones and
// the link between them (unique `e2e-pp-*` names), all deleted by the afterEach below (the project first - its milestones and link go with it - then program, work stream, teams,
// people, users). Every date it pins is in 2049, which no other spec writes a holiday in; the real clock is the proposal's `asOf`, and nothing can land before a team's first capacity period.
import { randomUUID } from "node:crypto";
import type { APIRequestContext, Page, Response } from "@playwright/test";
import { apiAsAdmin, axeViolations, deleteViaApi, expect, login, test, uniqueText } from "./helpers";

// A cross-team proposal's scope token carries the global holiday dictionary, which `public-holidays` writes (2040): the specs that write it or compare the figures never run at the same time.
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
  single: Account;
  teamX: string;
  teamY: string;
  projectId: number;
  projectName: string;
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
  const name = uniqueText(`e2e-pp-${label}`);
  const account = { email: `${name.toLowerCase()}@astrolabe.local`, password: randomUUID().replace(/-/g, "") };
  const id = await seed(api, "/api/v1/users", { name, email: account.email, password: account.password }, "/api/v1/users");
  return { id, account };
}

/**
 * The world: two throwaway logins (a project OWNER who manages nothing and the SINGLE manager of team Y), two teams whose FIRST capacity period starts on Monday 2049-01-04
 * (10 MD/week: 2 MD a working day; team X is managed by a person with no login of its own), a project owned by the owner and its milestones: `x1` 4 MD on team X scheduled
 * Tuesday 2049-03-02 to Wednesday 03-03, `y1` 2 MD on team Y unscheduled, and the finish-to-start link `x1 -> y1`.
 *
 * The run, counted by hand (2049 has no holiday on this stack): X is placed first (the link points from it), x1 takes two working days from the first day with capacity,
 * **2049-01-04 to 2049-01-05**; Y is placed with X's PROPOSED dates as facts, so y1 is a one-day milestone on **2049-01-06**; one pass, settled. The project's span (x1 alone,
 * y1 has no dates) is 2049-03-02 to 2049-03-03 now and **2049-01-04 to 2049-01-06** after the run: its end moves from Wednesday 03-03 to Wednesday 01-06, exactly eight weeks,
 * **40 working days earlier**.
 */
async function seedWorld(): Promise<World> {
  const { api } = await apiAsAdmin();
  const owner = await seedUser(api, "owner");
  const single = await seedUser(api, "single");
  const lead = await seed(api, "/api/v1/people", { name: uniqueText("e2e-pp-lead") }, "/api/v1/people");
  const ownerPerson = await seed(api, "/api/v1/people", { name: uniqueText("e2e-pp-ownerperson"), userId: owner.id }, "/api/v1/people");
  const singlePerson = await seed(api, "/api/v1/people", { name: uniqueText("e2e-pp-singleperson"), userId: single.id }, "/api/v1/people");
  const team = async (label: string, managerPersonId: number) => {
    const name = uniqueText(`e2e-pp-team${label}`);
    const id = await seed(api, "/api/v1/teams", { name, managerPersonId }, "/api/v1/teams");
    const capacity = await api.post(`/api/v1/teams/${id}/capacity`, { data: { effectiveFrom: "2049-01-04", mdPerWeek: 10 } });
    expect(capacity.status(), await capacity.text()).toBe(201);
    return { id, name };
  };
  const teamX = await team("x", lead);
  const teamY = await team("y", singlePerson);
  const streamId = await seed(api, "/api/v1/work-streams", { name: uniqueText("e2e-pp-stream"), ownerPersonId: lead, startDate: "2026-01-05" }, "/api/v1/work-streams");
  const programId = await seed(api, `/api/v1/work-streams/${streamId}/programs`, { name: uniqueText("e2e-pp-program"), ownerPersonId: lead }, "/api/v1/programs");
  const projectName = uniqueText("e2e-pp-project");
  const projectId = await seed(api, `/api/v1/programs/${programId}/projects`, { name: projectName, ownerPersonId: ownerPerson }, "/api/v1/projects");
  const milestone = async (label: string, teamId: number, estimateMd: number): Promise<Milestone> => {
    const name = uniqueText(`e2e-pp-${label}`);
    const response = await api.post(`/api/v1/projects/${projectId}/milestones`, { data: { name, teamId, estimateMd } });
    expect(response.status(), await response.text()).toBe(201);
    return { id: ((await response.json()) as { id: number }).id, name };
  };
  const x1 = await milestone("x1", teamX.id, 4);
  const y1 = await milestone("y1", teamY.id, 2);
  const view = await api.get(`/api/v1/views/team/${teamX.id}`);
  const { revision } = (await view.json()) as { revision: number };
  const scheduled = await api.put(`/api/v1/milestones/${x1.id}/schedule`, { data: { expectedRevision: revision, startDate: "2049-03-02", endDate: "2049-03-03" } });
  expect(scheduled.status(), await scheduled.text()).toBe(200);
  const link = await api.post(`/api/v1/projects/${projectId}/dependencies`, {
    data: { predecessor: { kind: "MILESTONE", id: x1.id }, successor: { kind: "MILESTONE", id: y1.id }, type: "FS", lagDays: 0 },
  });
  expect(link.status(), await link.text()).toBe(201);
  return { api, owner: owner.account, single: single.account, teamX: teamX.name, teamY: teamY.name, projectId, projectName, x1, y1 };
}

const proposeButton = (page: Page) => page.getByRole("button", { name: "Propose schedule", exact: true });
const acceptButton = (page: Page, count: number) => page.getByRole("button", { name: `Accept selected (${count})`, exact: true });
const sectionTable = (page: Page, team: string) => page.getByRole("table", { name: `Proposed moves of ${team}` });
const timelineRow = (page: Page, milestone: Milestone) => page.getByRole("grid", { name: "Milestone timeline" }).getByRole("row").filter({ hasText: milestone.name });
const note = (page: Page, text: string) => page.getByRole("note").filter({ hasText: text });
const runHeading = (page: Page) => page.getByRole("heading", { level: 3, name: "Schedule proposal", exact: true });
const isApi = (method: string, suffix: string) => (r: { request(): { method(): string }; url(): string }) =>
  r.request().method() === method && r.url().endsWith(`/api/v1/schedule-proposals${suffix}`);
async function expectOk(response: Response): Promise<Response> {
  expect(response.status(), await response.text()).toBe(200);
  return response;
}

/** The project's page, with the viewer's rights read (Propose waits for them). */
async function openProject(page: Page, world: World): Promise<void> {
  await page.goto(`/projects/${world.projectId}`);
  await expect(page.getByRole("grid", { name: "Milestone timeline" })).toBeVisible();
  await expect(proposeButton(page)).toBeEnabled();
}

/** Press Propose and wait for the run. */
async function propose(page: Page): Promise<void> {
  const [response] = await Promise.all([page.waitForResponse(isApi("POST", "")), proposeButton(page).click()]);
  await expectOk(response);
  await expect(runHeading(page)).toBeVisible();
  // The run opens on its heading (1.37): focused and below the sticky 56 px header, not scrolled down to the Discard button at the end of the section.
  await expect(runHeading(page)).toBeFocused();
  await expect.poll(async () => (await runHeading(page).boundingBox())?.y ?? 0).toBeGreaterThanOrEqual(56);
  await expect(page.getByRole("button", { name: "Discard", exact: true })).toBeVisible();
}

test("a login that manages no team previews a project proposal: the dashed bars, the new row, the sentence about the project's end, and nothing to accept", async ({ page }) => {
  const world = await seedWorld();
  await world.api.dispose();

  // The project OWNER manages no team. Everyone previews: Propose is offered, the run opens, nothing is offered to accept.
  await login(page, world.owner.email, world.owner.password);
  await openProject(page, world);
  await expect(page.locator('[data-tone="proposal"]')).toHaveCount(0);
  await propose(page);
  await expect(note(page, "This is a preview.")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Accept selected/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save proposal", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Propose again", exact: true })).toBeVisible();
  // The dashed bars: x1's row, y1's appended "(new)" row and the summary row's proposed span of the whole project.
  await expect(page.locator('[data-tone="proposal"]')).toHaveCount(3);
  await expect(page.getByRole("img", { name: `Proposed: ${world.x1.name}, 2049-01-04 to 2049-01-05, read-only` })).toBeVisible();
  await expect(page.getByRole("img", { name: `Proposed: ${world.y1.name}, 2049-01-06 to 2049-01-06, read-only` })).toBeVisible();
  await expect(page.getByRole("img", { name: `Proposed: ${world.projectName}, 2049-01-04 to 2049-01-06, read-only` })).toBeVisible();
  await expect(timelineRow(page, world.y1).filter({ hasText: "(new)" })).toBeVisible();
  // The project's end in a sentence; the run's sections hold this project's moves, the other team's one a click away.
  await expect(page.getByText("If every team's moves are accepted, the project would end on 2049-01-06 instead of 2049-03-03, 40 working days earlier.")).toBeVisible();
  await page.getByRole("button", { name: `Show the moves of ${world.teamY}`, exact: true }).click();
  await expect(sectionTable(page, world.teamY)).toContainText("Unscheduled → 2049-01-06 to 2049-01-06, 1 working day");
  await expect(page.getByRole("checkbox", { name: `Accept ${world.y1.name}` })).toBeDisabled();
  // Discard closes the preview; nothing was written.
  await page.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(runHeading(page)).toHaveCount(0);
  await expect(page.locator('[data-tone="proposal"]')).toHaveCount(0);
});

test("the manager of one of the project's two teams accepts only their move: the check describes that tick, the date writes are locked meanwhile, and the other team's milestone stays", async ({ page }) => {
  const world = await seedWorld();
  const { api } = world;
  try {
    await login(page, world.single.email, world.single.password);
    await openProject(page, world);
    await propose(page);
    await expect(page.getByText("If every team's moves are accepted, the project would end on 2049-01-06 instead of 2049-03-03, 40 working days earlier.")).toBeVisible();

    // Only team Y's move is theirs: y1 is ticked, x1 (team X's) is a read-only line in a closed section.
    await expect(acceptButton(page, 1)).toBeVisible();
    await expect(page.getByRole("checkbox", { name: `Accept ${world.y1.name}` })).toBeChecked();
    await expect(page.getByRole("button", { name: `Show the moves of ${world.teamX}`, exact: true })).toHaveAttribute("aria-expanded", "false");
    // The check describes exactly the ticked move: x1 stays in March, so y1 on 01-06 would start before its predecessor ends - a warning, not a refusal.
    const y1 = sectionTable(page, world.teamY).getByRole("row").filter({ hasText: world.y1.name });
    await expect(y1.getByText("Conflict", { exact: true })).toBeVisible();
    await expect(y1).toContainText("must start on 2049-03-04 or later");

    // While the proposal is open the date writes are locked: the tray's Schedule button is off.
    await expect(page.getByRole("button", { name: `Schedule ${world.y1.name}`, exact: true })).toBeDisabled();

    // ONE accept, naming team Y alone; y1 is written, x1 is not.
    const [accepted] = await Promise.all([page.waitForResponse(isApi("POST", "/accept")), acceptButton(page, 1).click()]);
    await expectOk(accepted);
    const request = accepted.request().postDataJSON() as { teamIds: number[]; acceptTeamIds: number[]; items: { milestoneId: number }[] };
    expect(request.teamIds).toHaveLength(2);
    expect(request.acceptTeamIds).toHaveLength(1);
    expect(request.items.map((item) => item.milestoneId)).toEqual([world.y1.id]);
    const body = (await accepted.json()) as { accepted: unknown[]; skipped: unknown[] };
    expect(body.accepted).toHaveLength(1);
    expect(body.skipped).toHaveLength(0);
    await expect(note(page, "1 scheduled")).toBeVisible();
    await expect(runHeading(page)).toHaveCount(0);
    await expect(page.locator('[data-tone="proposal"]')).toHaveCount(0);

    // The API shows what the server stored: y1 as proposed, x1 where it was.
    expect(await (await api.get(`/api/v1/milestones/${world.y1.id}`)).json()).toMatchObject({ startDate: "2049-01-06", endDate: "2049-01-06" });
    expect(await (await api.get(`/api/v1/milestones/${world.x1.id}`)).json()).toMatchObject({ startDate: "2049-03-02", endDate: "2049-03-03" });
  } finally {
    await api.dispose();
  }
});

test("the open preview has no WCAG A/AA violations", async ({ page }) => {
  const world = await seedWorld();
  await world.api.dispose();

  await login(page, world.owner.email, world.owner.password);
  await openProject(page, world);
  await propose(page);
  await expect(page.locator('[data-tone="proposal"]')).toHaveCount(3);
  expect(await axeViolations(page)).toEqual([]);
});
