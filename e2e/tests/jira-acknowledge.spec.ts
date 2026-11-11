// Jira acknowledgement per line (1.12), against the compose stack's Jira STUB and its isolated `E2E` project (every date in 2044): a milestone bound to `E2E-4` ("E2E Epic One",
// Mon 2044-01-04 to Fri 01-08, 5 points) that ends on Wed 01-13 with an estimate of 3 man-days (at 0.5 man-days per point Jira says 2.50) raises THREE lines - End (a warning,
// three working days later), Estimate and Renamed (infos) - and one bound to `E2E-5` ("E2E Epic Two", Tue 2044-02-01 to Thu 02-10, 8 points) that ends on Tue 02-15 with an estimate of
// 4 man-days raises TWO (End, Renamed). Each line has its own Acknowledge / Unacknowledge button, a row with two or more open lines also **Acknowledge all (N)**, with two or more
// acknowledged **Withdraw all (N)**. The owner acknowledges one line and the others stay open (the project page's flag names only them); a plan-side change reopens only the line
// it changed; the batch buttons; the milestone's team manager acknowledges its line and has no button on the project's row.
// Owns: ONE Jira connection (`e2e-jack-connection-*`, scoped to the stub's `E2E` project ONLY on a unique `stub-` throwaway site, manual only, tested once per worker start of the
// file through the API in the beforeAll: one call of the shared per-IP Test bucket, and given 0.5 man-days per story point), its bindings (milestones to `E2E-4` / `E2E-5`, one
// project to `E2E-2`; `E2E-6` is never bound) and, per test, a throwaway world (an owner login, people, a team - with a manager login in the last test -, a work stream, a
// program, a project and one milestone, unique `e2e-jack-*` names, every date in **2044**, which nothing writes a holiday in), all seeded and removed through the API (the
// bindings first - their acknowledgements go with them -, then the project and the rest; the connection in the afterAll). It NEVER flips the stub's `jira-day2` scenario (only
// `jira-sync.spec.ts` does; `E2E-2`, `E2E-4` and `E2E-5` exist and read the same on both days) and needs no lock.
import { randomUUID } from "node:crypto";
import { type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { apiAsAdmin, deleteViaApi, expect, login, test, testJiraConnectionViaApi, uniqueText } from "./helpers";

// One connection shared by four tests that each seed their own world: a serial group (a failed test stops the rest).
test.describe.configure({ mode: "serial" });

const CONNECTIONS = "/api/v1/integrations/jira/connections";
const BINDINGS = "/api/v1/integrations/jira/bindings";

interface Account {
  email: string;
  password: string;
}

interface World {
  owner: Account;
  manager: Account | null;
  project: string;
  projectId: number;
  teamId: number;
}

let connection: { id: number; name: string };
const connectionTeardown: string[] = [];
// Registered in creation order; torn down in reverse (the bindings, created last, go first).
const teardown: string[] = [];

/** A unique throwaway Jira site: the server routes every `stub-` site to the stub, and a site of its own keeps this file's bindings apart from every other spec's. */
const uniqueSite = () => `https://stub-e2ejack${randomUUID().replace(/-/g, "").slice(0, 12)}.atlassian.net`;

async function create(api: APIRequestContext, path: string, data: object, tear: string, track: string[] = teardown): Promise<number> {
  const response = await api.post(path, { data });
  expect(response.status(), await response.text()).toBe(201);
  const id = ((await response.json()) as { id: number }).id;
  track.push(`${tear}/${id}`);
  return id;
}

/** Runs `use` with an administrator's API session and disposes it. */
async function asAdmin<T>(use: (api: APIRequestContext) => Promise<T>): Promise<T> {
  const { api } = await apiAsAdmin();
  try {
    return await use(api);
  } finally {
    await api.dispose();
  }
}

/** Saves the mapping the discovery proposes with 0.5 man-days per story point: `E2E-4` (5 points) then reads as 2.50 man-days, `E2E-5` (8 points) as 4.00. */
async function declareHalfManDayPerPoint(api: APIRequestContext, connectionId: number): Promise<void> {
  const path = `${CONNECTIONS}/${connectionId}/mapping`;
  const read = await api.get(path);
  expect(read.status(), await read.text()).toBe(200);
  const { defaults } = (await read.json()) as { defaults: { estimate: { unit: string } } };
  const saved = await api.put(path, { data: { ...defaults, estimate: { ...defaults.estimate, unit: "POINTS", manDaysPerUnit: 0.5 } } });
  expect(saved.status(), await saved.text()).toBe(204);
}

test.beforeAll(async () => {
  test.setTimeout(180_000); // the Test connection call may wait a 429 out (one minute)
  await asAdmin(async (api) => {
    const name = uniqueText("e2e-jack-connection");
    const body = { name, siteUrl: uniqueSite(), email: "e2e-jack@astrolabe.local", apiToken: "e2e-jack-token", authScheme: "BASIC", projectKeys: ["E2E"], enabled: true, pollIntervalMinutes: null };
    const id = await create(api, CONNECTIONS, body, CONNECTIONS, connectionTeardown);
    await testJiraConnectionViaApi(api, id);
    await declareHalfManDayPerPoint(api, id);
    connection = { id, name };
  });
});
test.afterAll(async () => {
  await deleteViaApi(connectionTeardown.splice(0).reverse());
});
test.afterEach(async () => {
  await deleteViaApi(teardown.splice(0).reverse());
});

/**
 * A project owner (a login with no administrator right) who owns one project under a work stream and a program owned by somebody else, and a team to put the milestone
 * on - managed by a login of its own when `withManager` (a person who owns nothing on the chain).
 */
async function seedWorld(withManager: boolean): Promise<World> {
  return asAdmin(async (api) => {
    const name = uniqueText("e2e-jack-owner");
    const owner = { email: `${name.toLowerCase()}@astrolabe.local`, password: randomUUID().replace(/-/g, "") };
    const ownerUser = await create(api, "/api/v1/users", { name, email: owner.email, password: owner.password }, "/api/v1/users");
    const lead = await create(api, "/api/v1/people", { name: uniqueText("e2e-jack-lead") }, "/api/v1/people");
    const ownerPerson = await create(api, "/api/v1/people", { name: uniqueText("e2e-jack-ownerperson"), userId: ownerUser }, "/api/v1/people");
    let manager: Account | null = null;
    let managerPerson: number | undefined;
    if (withManager) {
      const managerName = uniqueText("e2e-jack-manager");
      manager = { email: `${managerName.toLowerCase()}@astrolabe.local`, password: randomUUID().replace(/-/g, "") };
      const managerUser = await create(api, "/api/v1/users", { name: managerName, email: manager.email, password: manager.password }, "/api/v1/users");
      managerPerson = await create(api, "/api/v1/people", { name: uniqueText("e2e-jack-managerperson"), userId: managerUser }, "/api/v1/people");
    }
    const teamId = await create(api, "/api/v1/teams", { name: uniqueText("e2e-jack-team"), managerPersonId: managerPerson }, "/api/v1/teams");
    const streamId = await create(api, "/api/v1/work-streams", { name: uniqueText("e2e-jack-stream"), ownerPersonId: lead, startDate: "2044-01-04" }, "/api/v1/work-streams");
    const programId = await create(api, `/api/v1/work-streams/${streamId}/programs`, { name: uniqueText("e2e-jack-program"), ownerPersonId: lead }, "/api/v1/programs");
    const project = uniqueText("e2e-jack-project");
    const projectId = await create(api, `/api/v1/programs/${programId}/projects`, { name: project, ownerPersonId: ownerPerson }, "/api/v1/projects");
    return { owner, manager, project, projectId, teamId };
  });
}

/** Schedules (or moves) a milestone as the administrator, with the team view's current plan revision. */
async function schedule(world: World, milestoneId: number, startDate: string, endDate: string): Promise<void> {
  await asAdmin(async (api) => {
    const view = (await (await api.get(`/api/v1/views/team/${world.teamId}`)).json()) as { revision: number };
    const placed = await api.put(`/api/v1/milestones/${milestoneId}/schedule`, { data: { expectedRevision: view.revision, startDate, endDate } });
    expect(placed.status(), await placed.text()).toBe(200);
  });
}

async function seedMilestone(world: World, label: string, estimateMd: number, startDate: string, endDate: string): Promise<{ id: number; name: string }> {
  const name = uniqueText(`e2e-jack-${label}`);
  const id = await asAdmin((api) => create(api, `/api/v1/projects/${world.projectId}/milestones`, { name, teamId: world.teamId, estimateMd }, "/api/v1/milestones"));
  await schedule(world, id, startDate, endDate);
  return { id, name };
}

/** Links a plan node to an issue as the administrator (the setup; the acknowledgements are the subject). Answers the binding's id; torn down with the test. */
async function bindNode(level: "PROJECT" | "MILESTONE", nodeId: number, issueKey: string): Promise<number> {
  return asAdmin((api) => create(api, BINDINGS, { connectionId: connection.id, level, nodeId, issueKey }, BINDINGS));
}

const table = (page: Page) => page.getByRole("table", { name: "Differences between the plan and Jira" });
const rowOf = (page: Page, text: string) => table(page).getByRole("row").filter({ hasText: text });
/** A button by its FULL accessible name: "Acknowledge E2E-4: End" is a substring of "Unacknowledge E2E-4: End" otherwise. */
const button = (row: Locator, name: string) => row.getByRole("button", { name, exact: true });
/** One line's acknowledgement block (the sentence "Acknowledged by …" and its button): the button's parent, found by the line's stable `data-ack-for` key. */
const lineOf = (row: Locator, bindingId: number, kind: string) => row.locator(`[data-ack-for="${bindingId}:${kind}"]`).locator("xpath=..");
const acknowledgedBy = (row: Locator) => row.getByText(/^Acknowledged by /);

test("the owner acknowledges one line of a milestone's deviations: the other lines stay open and the project page's flag names only them", async ({ page }) => {
  const world = await seedWorld(false);
  const milestone = await seedMilestone(world, "lines", 3, "2044-01-04", "2044-01-13");
  const bindingId = await bindNode("MILESTONE", milestone.id, "E2E-4");

  await login(page, world.owner.email, world.owner.password);
  await page.goto(`/deviations?projectId=${world.projectId}&all=false`);
  const row = rowOf(page, milestone.name);
  await expect(row).toHaveCount(1);
  // Three lines: the warning and two infos; each has its own button and, with several open, the batch button heads them.
  await expect(row).toContainText("Ends 3 working days later than Jira");
  await expect(row).toContainText("Estimate is 3.00 man-days in the plan and 2.50 man-days in Jira");
  await expect(row).toContainText(`Named “E2E Epic One” in Jira and “${milestone.name}” in the plan`);
  for (const kind of ["End", "Estimate", "Renamed"]) await expect(button(row, `Acknowledge E2E-4: ${kind}`)).toBeVisible();
  await expect(button(row, "Acknowledge all (3) open deviations of E2E-4")).toBeVisible();
  await expect(acknowledgedBy(row)).toHaveCount(0);

  // The project page before: one flag cell, one warning and two infos, the End sentence among them.
  const flag = page.locator('[data-flags][title*="Jira E2E-4:"]');
  await page.goto(`/projects/${world.projectId}`);
  await expect(page.getByRole("grid", { name: "Milestone timeline" })).toBeVisible();
  await expect(flag).toHaveCount(1);
  await expect(flag).toHaveAttribute("data-flags", "1,2");
  await expect(flag).toHaveAttribute("title", /Ends 3 working days later than Jira/);

  // The owner acknowledges the End line alone: the row STAYS in the Open list (two lines are open), the End line reads acknowledged, the others are untouched.
  await page.goto(`/deviations?projectId=${world.projectId}&all=false`);
  await button(row, "Acknowledge E2E-4: End").click();
  await expect(button(row, "Unacknowledge E2E-4: End")).toBeVisible();
  await expect(row).toHaveCount(1);
  await expect(acknowledgedBy(row)).toHaveCount(1);
  await expect(lineOf(row, bindingId, "END_DIFFERS")).toContainText("Acknowledged by");
  for (const kind of ["Estimate", "Renamed"]) await expect(button(row, `Acknowledge E2E-4: ${kind}`)).toBeVisible();
  // The batch button now counts the two open lines; one acknowledged line has no Withdraw all (that needs two).
  await expect(button(row, "Acknowledge all (2) open deviations of E2E-4")).toBeVisible();
  await expect(row.getByRole("button", { name: /^Withdraw all/ })).toHaveCount(0);

  // The project page after: the same cell, no warning any more, the flag names the two open lines and not the acknowledged End.
  await page.goto(`/projects/${world.projectId}`);
  await expect(page.getByRole("grid", { name: "Milestone timeline" })).toBeVisible();
  await expect(flag).toHaveCount(1);
  await expect(flag).toHaveAttribute("data-flags", "0,2");
  await expect(flag).toHaveAttribute("title", /Estimate is 3\.00 man-days in the plan and 2\.50 man-days in Jira/);
  await expect(flag).not.toHaveAttribute("title", /Ends 3 working days later than Jira/);
});

test("a plan-side change to one line keeps the other acknowledged line, and moving the plan's end reopens only End", async ({ page }) => {
  const world = await seedWorld(false);
  const milestone = await seedMilestone(world, "changing", 3, "2044-01-04", "2044-01-13");
  const bindingId = await bindNode("MILESTONE", milestone.id, "E2E-4");

  await login(page, world.owner.email, world.owner.password);
  await page.goto(`/deviations?projectId=${world.projectId}&all=false`);
  const row = rowOf(page, milestone.name);
  const end = lineOf(row, bindingId, "END_DIFFERS");
  const estimate = lineOf(row, bindingId, "ESTIMATE_DIFFERS");
  // End and Estimate acknowledged one by one; Renamed stays open, so the row stays in the Open list throughout.
  await button(row, "Acknowledge E2E-4: End").click();
  await expect(button(row, "Unacknowledge E2E-4: End")).toBeVisible();
  await button(row, "Acknowledge E2E-4: Estimate").click();
  await expect(button(row, "Unacknowledge E2E-4: Estimate")).toBeVisible();
  await expect(acknowledgedBy(row)).toHaveCount(2);
  await expect(button(row, "Withdraw all (2) acknowledged deviations of E2E-4")).toBeVisible();

  // The plan's estimate changes from 3 to 4 man-days (the administrator through the API): ONLY the Estimate line changed, so only it reopens.
  await asAdmin(async (api) => {
    const changed = await api.put(`/api/v1/milestones/${milestone.id}`, { data: { name: milestone.name, teamId: world.teamId, estimateMd: 4 } });
    expect(changed.status(), await changed.text()).toBe(204);
  });
  await page.reload();
  await expect(row).toContainText("Estimate is 4.00 man-days in the plan and 2.50 man-days in Jira");
  await expect(estimate).toContainText("· changed since");
  await expect(button(row, "Acknowledge E2E-4: Estimate")).toBeVisible();
  await expect(end).toContainText("Acknowledged by");
  await expect(end).not.toContainText("changed since");
  await expect(button(row, "Unacknowledge E2E-4: End")).toBeVisible();

  // Acknowledged again, then the plan's end moves from Wed 01-13 to Thu 01-14 (four working days later): ONLY End reopens, the re-acknowledged Estimate stays.
  await button(row, "Acknowledge E2E-4: Estimate").click();
  await expect(button(row, "Unacknowledge E2E-4: Estimate")).toBeVisible();
  await schedule(world, milestone.id, "2044-01-04", "2044-01-14");
  await page.reload();
  await expect(row).toContainText("Ends 4 working days later than Jira");
  await expect(end).toContainText("· changed since");
  await expect(button(row, "Acknowledge E2E-4: End")).toBeVisible();
  await expect(estimate).toContainText("Acknowledged by");
  await expect(estimate).not.toContainText("changed since");
  await expect(button(row, "Unacknowledge E2E-4: Estimate")).toBeVisible();
  await expect(button(row, "Acknowledge E2E-4: Renamed")).toBeVisible(); // never touched
  await expect(row).toHaveCount(1);
});

test("Acknowledge all acknowledges every open line and Withdraw all reopens them", async ({ page }) => {
  const world = await seedWorld(false);
  const milestone = await seedMilestone(world, "batch", 3, "2044-01-04", "2044-01-13");
  await bindNode("MILESTONE", milestone.id, "E2E-4");

  await login(page, world.owner.email, world.owner.password);
  await page.goto(`/deviations?projectId=${world.projectId}&all=false`);
  const row = rowOf(page, milestone.name);
  await button(row, "Acknowledge all (3) open deviations of E2E-4").click();
  // No line is open: the row leaves the Open list ...
  await expect(row).toHaveCount(0);

  // ... and, under the project's own scope (every status), shows the three lines acknowledged, each with its Unacknowledge, and the Withdraw all button.
  await page.goto(`/deviations?projectId=${world.projectId}`);
  await expect(row).toHaveCount(1);
  await expect(acknowledgedBy(row)).toHaveCount(3);
  for (const kind of ["End", "Estimate", "Renamed"]) await expect(button(row, `Unacknowledge E2E-4: ${kind}`)).toBeVisible();
  await expect(button(row, "Withdraw all (3) acknowledged deviations of E2E-4")).toBeVisible();
  await expect(row.getByRole("button", { name: /^Acknowledge all/ })).toHaveCount(0);

  // Withdraw all: every stamp goes, the lines are open again and the batch button is back.
  await button(row, "Withdraw all (3) acknowledged deviations of E2E-4").click();
  await expect(button(row, "Acknowledge all (3) open deviations of E2E-4")).toBeVisible();
  await expect(acknowledgedBy(row)).toHaveCount(0);
  for (const kind of ["End", "Estimate", "Renamed"]) await expect(button(row, `Acknowledge E2E-4: ${kind}`)).toBeVisible();
  await expect(row.getByRole("button", { name: /^Withdraw all/ })).toHaveCount(0);
  await page.goto(`/deviations?projectId=${world.projectId}&all=false`);
  await expect(row).toHaveCount(1);
});

test("the milestone's team manager acknowledges its line and has no button on the project's row", async ({ page }) => {
  const world = await seedWorld(true);
  // E2E-5 runs Tue 2044-02-01 to Thu 02-10 with 8 points (4.00 man-days at 0.5 each): the milestone's 4 man-days agree, its end on Tue 02-15 is three working days
  // later (Fri 11, Mon 14, Tue 15) - two lines, End and Renamed. The project is bound to E2E-2 ("E2E Initiative Alpha", E2E-5's own parent in Jira).
  const milestone = await seedMilestone(world, "managed", 4, "2044-02-01", "2044-02-15");
  const milestoneBinding = await bindNode("MILESTONE", milestone.id, "E2E-5");
  await bindNode("PROJECT", world.projectId, "E2E-2");
  const manager = world.manager;
  if (manager === null) throw new Error("the world has no manager");

  // The manager is not on the project's chain (the owner is somebody else) but manages the milestone's team.
  await login(page, manager.email, manager.password);
  await page.goto(`/deviations?projectId=${world.projectId}&all=false`);
  const row = rowOf(page, milestone.name);
  const projectRow = rowOf(page, "E2E Initiative Alpha");
  await expect(row).toHaveCount(1);
  await expect(projectRow).toHaveCount(1);
  await expect(row).toContainText("Ends 3 working days later than Jira");
  // The project's row lists its lines and offers none of the controls: no per-line button, no batch button.
  await expect(projectRow).toContainText(`Named “E2E Initiative Alpha” in Jira and “${world.project}” in the plan`);
  await expect(projectRow.getByRole("button")).toHaveCount(0);

  // The milestone's row: the manager acknowledges End; Renamed (the only open line left) has its own button and no batch button.
  await expect(button(row, "Acknowledge all (2) open deviations of E2E-5")).toBeVisible();
  await button(row, "Acknowledge E2E-5: End").click();
  await expect(button(row, "Unacknowledge E2E-5: End")).toBeVisible();
  await expect(lineOf(row, milestoneBinding, "END_DIFFERS")).toContainText("Acknowledged by");
  await expect(button(row, "Acknowledge E2E-5: Renamed")).toBeVisible();
  await expect(row.getByRole("button", { name: /^Acknowledge all/ })).toHaveCount(0);
  await expect(projectRow.getByRole("button")).toHaveCount(0);
});
