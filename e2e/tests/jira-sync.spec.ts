// Jira sync (v1.1), against the compose stack's Jira STUB (WireMock, `E2E_JIRA_STUB_URL`, default http://localhost:8096) and its small isolated `E2E`
// project (every date in 2044): an administrator creates a connection and tests it, a wrong token shows the failed probes with their scope hints,
// the administrator maps the levels and fields and peeks an issue, a project owner links a milestone to an epic and the Deviations page shows the
// end three working days later than Jira's after a refresh, and an unlink removes the deviation while an epic deleted on "day 2" reads as gone.
// Owns: its Jira connections (unique `e2e-jira-*` names, each scoped to the stub's `E2E` project only and bound to a unique throwaway site, so no
// bindings of another spec or of the user's own connections ever meet), their bindings, and a throwaway world per test (a project-owner login, people,
// a team, a work stream, a program, a project and milestones, unique `e2e-jira-*` names, every date in 2044, which nothing writes a holiday in), all
// created through the API or the UI and removed by the afterEach through the API (the connection first - its bindings are unlinked with it - then the
// project, whose milestones go with it, program, work stream, team, people, users). It alone flips the stub's `jira-day2` scenario (one process, one
// state): the afterAll puts it back even after a failure, and the beforeAll starts from a known state.
import { randomUUID } from "node:crypto";
import { type APIRequestContext, type Locator, type Page, request as playwrightRequest } from "@playwright/test";
import { apiAsAdmin, axeViolations, deleteViaApi, expect, login, test, uniqueText } from "./helpers";

/** The stub's admin API: the same WireMock that answers the app's outbound calls, on the host port compose publishes. */
const STUB_URL = process.env.E2E_JIRA_STUB_URL ?? "http://localhost:8096";
const DAY2_STATE = "/__admin/scenarios/jira-day2/state";

// One scenario state for the whole stub: this file is the only flipper and runs serially (and the pool never runs two copies of it).
test.describe.configure({ mode: "serial" });

async function setStubState(state: "Started" | "day2"): Promise<void> {
  const stub = await playwrightRequest.newContext({ baseURL: STUB_URL });
  try {
    const response = await stub.put(DAY2_STATE, { data: { state } });
    expect(response.ok(), `the stub answered ${response.status()} to the scenario flip`).toBeTruthy();
  } finally {
    await stub.dispose();
  }
}

// The connection the linking tests (4 and 5) share, tested once (Test connection shares a 10-a-minute bucket per IP with Peek), and its own teardown:
// the afterEach below removes only what a test made, so a binding is unlinked per test and the connection survives to the afterAll. The first
// scenario's UI-created (and tested) connection also survives to the afterAll, for the third to map and peek through: a call saved. Run alone,
// the third seeds and tests its own. Under `retries` (CI: 2) a retried group starts from the first scenario again and spends the bucket again.
let linking: Connection;
let uiConnection: Connection | undefined;
const linkingTeardown: string[] = [];
test.beforeAll(async () => {
  await setStubState("Started");
  const { api } = await apiAsAdmin();
  try {
    linking = await seedTestedConnection(api, "link", linkingTeardown);
    await declareHalfManDayPerPoint(api, linking);
  } finally {
    await api.dispose();
  }
});
test.afterAll(async () => {
  try {
    await deleteViaApi(linkingTeardown.splice(0).reverse());
  } finally {
    await setStubState("Started");
  }
});

// Registered in creation order; torn down in reverse (a connection last registered, first deleted).
const teardown: string[] = [];
test.afterEach(async () => {
  await deleteViaApi(teardown.splice(0).reverse());
});

interface Account {
  email: string;
  password: string;
}

interface Connection {
  id: number;
  name: string;
}

interface World {
  api: APIRequestContext;
  owner: Account;
  project: string;
  projectId: number;
  teamId: number;
}

/** A unique throwaway Jira site: the stub answers for any tenant, and a site of its own keeps one test's bindings out of another's. */
const uniqueSite = () => `https://e2ejira${randomUUID().replace(/-/g, "").slice(0, 12)}.atlassian.net`;

async function create(api: APIRequestContext, path: string, data: object, tear: string, track: string[] = teardown): Promise<number> {
  const response = await api.post(path, { data });
  expect(response.status(), await response.text()).toBe(201);
  const id = ((await response.json()) as { id: number }).id;
  track.push(`${tear}/${id}`);
  return id;
}

/** A connection through the API (the UI tests create their own): scoped to the stub's `E2E` project only, with a token the stub accepts. */
async function seedConnection(api: APIRequestContext, label: string, track: string[] = teardown): Promise<Connection> {
  const name = uniqueText(`e2e-jira-${label}`);
  const body = { name, siteUrl: uniqueSite(), email: "e2e-jira@astrolabe.local", apiToken: "e2e-jira-token", authScheme: "BASIC", projectKeys: ["E2E"], enabled: true };
  const id = await create(api, "/api/v1/integrations/jira/connections", body, "/api/v1/integrations/jira/connections", track);
  return { id, name };
}

/** The stored Test connection (records the verdict and the discovery the mapping and the bind need). */
async function testConnection(api: APIRequestContext, connection: Connection): Promise<void> {
  const response = await api.post(`/api/v1/integrations/jira/connections/${connection.id}/test`);
  expect(response.status(), await response.text()).toBe(200);
  const result = (await response.json()) as { rows: { name: string; ok: boolean }[] };
  expect(result.rows.filter((row) => !row.ok)).toEqual([]);
}

/**
 * Saves the mapping the discovery proposes with an estimate factor of 0.5 man-days per story point (the stub's E2E epics carry whole points: `E2E-4` has 5,
 * so it reads as 2.5 man-days), the factor a Jira estimate is compared through.
 */
async function declareHalfManDayPerPoint(api: APIRequestContext, connection: Connection): Promise<void> {
  const path = `/api/v1/integrations/jira/connections/${connection.id}/mapping`;
  const read = await api.get(path);
  expect(read.status(), await read.text()).toBe(200);
  const { defaults } = (await read.json()) as { defaults: { estimate: { unit: string } } };
  const saved = await api.put(path, { data: { ...defaults, estimate: { ...defaults.estimate, unit: "POINTS", manDaysPerUnit: 0.5 } } });
  expect(saved.status(), await saved.text()).toBe(204);
}

/** When the server last READ the single linked item of a project from Jira (`observedAt`, the Deviations view's own figure), as the administrator. */
async function observedAt(projectId: number): Promise<number> {
  const { api } = await apiAsAdmin();
  try {
    const response = await api.get(`/api/v1/views/deviations?projectId=${projectId}`);
    expect(response.ok(), await response.text()).toBeTruthy();
    const view = (await response.json()) as { items: { jira: { observedAt: number | null } }[] };
    expect(view.items).toHaveLength(1);
    const at = view.items[0].jira.observedAt;
    if (at === null) throw new Error("the linked item was never read");
    return at;
  } finally {
    await api.dispose();
  }
}

/** A tested connection, ready to link through. */
async function seedTestedConnection(api: APIRequestContext, label: string, track: string[] = teardown): Promise<Connection> {
  const connection = await seedConnection(api, label, track);
  await testConnection(api, connection);
  return connection;
}

/** A milestone of the world's team, scheduled by the administrator with the team view's current plan revision. */
async function seedMilestone(world: World, label: string, estimateMd: number, startDate: string, endDate: string): Promise<{ id: number; name: string }> {
  const name = uniqueText(`e2e-jira-${label}`);
  const id = await create(world.api, `/api/v1/projects/${world.projectId}/milestones`, { name, teamId: world.teamId, estimateMd }, "/api/v1/milestones");
  const view = (await (await world.api.get(`/api/v1/views/team/${world.teamId}`)).json()) as { revision: number };
  const placed = await world.api.put(`/api/v1/milestones/${id}/schedule`, { data: { expectedRevision: view.revision, startDate, endDate } });
  expect(placed.status(), await placed.text()).toBe(200);
  return { id, name };
}

/**
 * A project owner (a login with no administrator right) who owns one project, under a work stream and a program owned by somebody else, and a
 * team to put milestones on. The milestones are the test's own.
 */
async function seedWorld(): Promise<World> {
  const { api } = await apiAsAdmin();
  const name = uniqueText("e2e-jira-owner");
  const owner = { email: `${name.toLowerCase()}@astrolabe.local`, password: randomUUID().replace(/-/g, "") };
  const userId = await create(api, "/api/v1/users", { name, email: owner.email, password: owner.password }, "/api/v1/users");
  const lead = await create(api, "/api/v1/people", { name: uniqueText("e2e-jira-lead") }, "/api/v1/people");
  const ownerPerson = await create(api, "/api/v1/people", { name: uniqueText("e2e-jira-ownerperson"), userId }, "/api/v1/people");
  const teamId = await create(api, "/api/v1/teams", { name: uniqueText("e2e-jira-team") }, "/api/v1/teams");
  const streamId = await create(api, "/api/v1/work-streams", { name: uniqueText("e2e-jira-stream"), ownerPersonId: lead, startDate: "2044-01-04" }, "/api/v1/work-streams");
  const programId = await create(api, `/api/v1/work-streams/${streamId}/programs`, { name: uniqueText("e2e-jira-program"), ownerPersonId: lead }, "/api/v1/programs");
  const project = uniqueText("e2e-jira-project");
  const projectId = await create(api, `/api/v1/programs/${programId}/projects`, { name: project, ownerPersonId: ownerPerson }, "/api/v1/projects");
  return { api, owner, project, projectId, teamId };
}

/** Link a milestone to an issue through the API as the administrator (the setup of a test whose subject is not the link itself); torn down with the test. */
async function bindMilestone(api: APIRequestContext, connection: Connection, nodeId: number, issueKey: string): Promise<void> {
  await create(api, "/api/v1/integrations/jira/bindings", { connectionId: connection.id, level: "MILESTONE", nodeId, issueKey }, "/api/v1/integrations/jira/bindings");
}

/** Type one key into the editor's tags input and commit it with Enter (Mantine's TagsInput is a combobox). */
async function addProjectKey(dialog: Locator, key: string): Promise<void> {
  const input = dialog.getByRole("combobox", { name: "Project keys" });
  await input.fill(key);
  await input.press("Enter");
}

/** One probe's row of a Test connection table, found by its name cell (a substring match would also hit `projects` for `project`, `search` inside paths). */
const probeRow = (results: Locator, name: string) => results.getByRole("row").filter({ has: results.page().getByText(name, { exact: true }) });

const rowOf = (page: Page, text: string) => page.getByRole("table", { name: "Differences between the plan and Jira" }).getByRole("row").filter({ hasText: text });
const sourceRow = (page: Page, connection: Connection) => page.getByRole("table", { name: "Data from Jira" }).getByRole("row").filter({ hasText: connection.name });

/**
 * The administrator presses Refresh now on the Deviations page for one connection and waits, as long as a run takes, for what the page then shows
 * (`done`: the run's own outcome, or the change it makes to a row) - the page re-reads by itself while the run is going, never a fixed sleep.
 */
async function refreshAsAdmin(page: Page, connection: Connection, projectId: number, done: (page: Page) => Locator): Promise<void> {
  await login(page);
  await page.goto(`/deviations?projectId=${projectId}`);
  await page.getByRole("button", { name: `Refresh now: ${connection.name}` }).click();
  await expect(done(page)).toBeVisible({ timeout: 30_000 });
}

test("admin creates a Jira connection, tests it and sees every probe green", async ({ page }) => {
  const name = uniqueText("e2e-jira-ui");
  await login(page);
  await page.goto("/integrations/jira");
  await expect(page.getByRole("heading", { level: 2, name: "Jira connections" })).toBeVisible();

  await page.getByRole("button", { name: "New connection" }).click();
  const dialog = page.getByRole("dialog", { name: "New Jira connection" });
  await dialog.getByRole("textbox", { name: "Name" }).fill(name);
  await dialog.getByRole("textbox", { name: "Site" }).fill(uniqueSite());
  await dialog.getByRole("textbox", { name: "Account email" }).fill("e2e-jira@astrolabe.local");
  await dialog.getByLabel("API token", { exact: true }).fill("e2e-jira-token");
  // Only the stub's `E2E` project: any other scope falls through to the stub's 401 catch-all.
  await addProjectKey(dialog, "E2E");
  const [created] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === "POST" && /\/api\/v1\/integrations\/jira\/connections$/.test(r.url())),
    dialog.getByRole("button", { name: "Create", exact: true }).click(),
  ]);
  expect(created.status()).toBe(201);
  const id = ((await created.json()) as { id: number }).id;
  linkingTeardown.push(`/api/v1/integrations/jira/connections/${id}`); // kept for the third scenario; the afterAll removes it
  uiConnection = { id, name };

  // A new connection lands on its page, never tested: the facts say so and the token is only "stored".
  await expect(page).toHaveURL(new RegExp(`/integrations/jira/${id}$`));
  await expect(page.getByRole("heading", { level: 2, name })).toBeVisible();
  const facts = page.getByRole("table", { name: "Connection facts" });
  await expect(facts).toContainText("A token is stored");
  await expect(facts).toContainText("E2E");
  await expect(facts).toContainText("Never tested");

  // Test connection probes the stub with the stored token: every row is green and nothing failed.
  await page.getByRole("button", { name: "Test connection" }).click();
  await expect(page.getByRole("status").filter({ hasText: /^Test passed\. OK: (\d+) of \1\.$/ })).toBeVisible();
  const results = page.getByRole("table", { name: "Connection test results" });
  for (const probe of ["tenant_info", "myself", "issuetype", "search", "field", "projects", "project:E2E"]) {
    await expect(probeRow(results, probe).getByText("OK", { exact: true })).toBeVisible();
  }
  await expect(results.getByText("Failed", { exact: true })).toHaveCount(0);
  await expect(page.getByText(/^Cloud id: /)).toBeVisible();
  await expect(facts).toContainText("Passed");
  // The green result table is scanned as it stands (the "Connection created" toast has gone, so it does not sit over the page).
  await expect(page.locator(".mantine-Notification-root")).toHaveCount(0);
  expect(await axeViolations(page)).toEqual([]);
});

test("a wrong token shows the failed probes with their scope hints", async ({ page }) => {
  await login(page);
  await page.goto("/integrations/jira");
  await page.getByRole("button", { name: "New connection" }).click();
  const dialog = page.getByRole("dialog", { name: "New Jira connection" });
  await dialog.getByRole("textbox", { name: "Name" }).fill(uniqueText("e2e-jira-wrong"));
  await dialog.getByRole("textbox", { name: "Site" }).fill(uniqueSite());
  await dialog.getByRole("textbox", { name: "Account email" }).fill("e2e-jira@astrolabe.local");
  // The stub refuses exactly this token on every authenticated route.
  await dialog.getByLabel("API token", { exact: true }).fill("wrong-token");
  await addProjectKey(dialog, "E2E");

  // The modal's own Test connection (an ad-hoc probe: nothing is saved).
  await dialog.getByRole("button", { name: "Test connection" }).click();
  await expect(dialog.getByRole("status").filter({ hasText: /^Test failed\. Required probes that failed: \d+ of \d+\.$/ })).toBeVisible();
  const results = dialog.getByRole("table", { name: "Connection test results" });
  const myself = probeRow(results, "myself");
  await expect(myself.getByText("Failed", { exact: true })).toBeVisible();
  await expect(myself).toContainText("401");
  await expect(myself).toContainText("Jira refused the credentials");
  await expect(myself).toContainText("needs scope: read:jira-user");
  await expect(probeRow(results, "issuetype")).toContainText("needs scope: read:issue-type:jira");
  await expect(probeRow(results, "search")).toContainText("needs scope: read:jql:jira");
  await expect(probeRow(results, "field")).toContainText("needs scope: read:field:jira");
  await expect(probeRow(results, "projects")).toContainText("needs scope: read:project:jira");
  // The one unauthenticated probe still passes.
  await expect(probeRow(results, "tenant_info").getByText("OK", { exact: true })).toBeVisible();
  // The red failure state, in the open dialog, is scanned as it stands.
  expect(await axeViolations(page, '[role="dialog"]')).toEqual([]);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  // The token is nowhere in what the page says about the probes, nor in the list the dialog leaves behind.
  await expect(results).toHaveCount(0);
  await expect(page.getByRole("table", { name: "Jira connections" })).not.toContainText("wrong-token");
});

test("admin maps the levels and fields and peeks an issue through the mapping", async ({ page }) => {
  // The connection the first scenario created and tested (nothing is mapped on it yet); run alone, this test seeds and tests its own.
  let connection = uiConnection;
  if (connection === undefined) {
    const { api } = await apiAsAdmin();
    try {
      connection = await seedTestedConnection(api, "map");
    } finally {
      await api.dispose();
    }
  }

  await login(page);
  await page.goto(`/integrations/jira/${connection.id}`);
  await expect(page.getByRole("heading", { level: 2, name: connection.name })).toBeVisible();
  await expect(page.getByRole("heading", { level: 3, name: "Mapping" })).toBeVisible();

  // What the stored test found on the stub: the counts and a line for every assumption marker (the defaults rest on them).
  const report = page.getByRole("heading", { level: 4, name: "Discovery report" });
  await expect(report).toBeVisible();
  await expect(page.getByText(/^On the site: 60 fields and 7 issue types, read .* UTC\.$/)).toBeVisible();
  await expect(page.getByText("Hierarchy levels:")).toBeVisible();
  await expect(page.getByText(/^Target start found as “Target start” \(customfield_10022, /)).toBeVisible();
  await expect(page.getByText(/^Target end found as “Target end” \(customfield_10023, /)).toBeVisible();
  await expect(page.getByText(/^Team field found as “Team” \(customfield_10001, /)).toBeVisible();
  await expect(page.getByText(/^A legacy Parent Link field exists: /)).toBeVisible();

  // The form opens on the defaults the site's hierarchy gives: Epic is the milestone, Initiative the project, Program the program.
  const mapping = page.getByRole("form", { name: "Field mapping" });
  await expect(mapping).toContainText("Nothing is saved yet");
  const levelSelect = (level: "Program" | "Project" | "Milestone") => mapping.getByRole("group", { name: level, exact: true }).getByRole("combobox", { name: "Jira level" });
  await expect(levelSelect("Milestone")).toHaveValue(/^Level 1 — Epic$/);
  await expect(levelSelect("Project")).toHaveValue(/^Level 2 — Initiative$/);
  await expect(levelSelect("Program")).toHaveValue(/^Level 3 — Program$/);

  // The estimate: the stub's epics carry Story Points of twice the plan's man-days, so 0.5 man-days per point makes them comparable. Saved as it is.
  await mapping.getByRole("textbox", { name: "Man-days per unit" }).fill("0.5");
  await mapping.getByRole("button", { name: "Save mapping" }).click();
  await expect(mapping).toContainText("This is the saved mapping.");
  await expect(mapping.getByRole("textbox", { name: "Man-days per unit" })).toHaveValue("0.5"); // what was saved is what the form reopens on
  await expect(page.getByRole("table", { name: "Connection facts" })).toContainText("Saved");

  // Peek reads E2E-4 through that mapping: its level, its dates from "Target start"/"Target end", its estimate in the declared unit.
  await page.getByRole("textbox", { name: "Issue key" }).fill("e2e-4");
  await page.getByRole("button", { name: "Peek", exact: true }).click();
  const peek = page.getByRole("table", { name: "Peek result" });
  const value = (label: string) => peek.getByRole("row").filter({ has: page.getByRole("cell", { name: label, exact: true }) }).getByRole("cell").nth(1);
  await expect(value("Key")).toContainText("E2E-4");
  await expect(value("Summary")).toHaveText("E2E Epic One");
  await expect(value("Type")).toHaveText("Epic");
  await expect(value("Plan level")).toHaveText("Milestone");
  await expect(value("Start")).toHaveText("2044-01-04");
  await expect(value("End")).toHaveText("2044-01-08");
  await expect(value("Estimate")).toHaveText("5 Story points"); // Jira's own figure; the 0.5 conversion shows on the Deviations page (scenarios 4 and 5)
  // The result table is scanned as it stands (the "Mapping saved" toast has gone).
  await expect(page.locator(".mantine-Notification-root")).toHaveCount(0);
  expect(await axeViolations(page)).toEqual([]);

  // Re-mapping the milestone's end to the "Due date" (which the stub's E2E epic does not carry) changes what the same Peek resolves: the end is gone.
  const milestone = mapping.getByRole("group", { name: "Milestone", exact: true });
  await milestone.getByRole("combobox", { name: "End" }).click();
  await page.getByRole("option", { name: "Due date — duedate" }).click();
  await expect(milestone.getByRole("combobox", { name: "End" })).toHaveValue("Due date — duedate");
  await mapping.getByRole("button", { name: "Save mapping" }).click();
  await expect(peek).toHaveCount(0); // a result belongs to the mapping it was read under
  await page.getByRole("button", { name: "Peek", exact: true }).click();
  await expect(value("Start")).toHaveText("2044-01-04");
  await expect(value("End")).toHaveText("—");
});

/** The owner opens the milestone's row menu on the project page and links it to `issueKey` through the Link to Jira dialog; answers the binding's id. */
async function linkMilestoneAsOwner(page: Page, connection: Connection, milestone: { name: string }, issueKey: string): Promise<number> {
  await page.getByRole("button", { name: `Operations for ${milestone.name}` }).click();
  await page.getByRole("menuitem", { name: `Link to Jira…: ${milestone.name}` }).click();
  const dialog = page.getByRole("dialog", { name: "Link to Jira" });
  // The connections come from the Deviations view (the registry is for administrators); the stack may hold other enabled ones, so the choice is explicit.
  const choice = dialog.getByRole("combobox", { name: "Jira connection" });
  await expect(choice).toBeVisible();
  if ((await choice.inputValue()) !== connection.name) {
    await choice.click();
    await page.getByRole("option", { name: connection.name, exact: true }).click();
  }
  await expect(dialog.getByRole("textbox", { name: "Plan item" })).toHaveValue(milestone.name);
  await dialog.getByRole("textbox", { name: "Jira issue key" }).fill(issueKey);
  const [bound] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === "POST" && /\/api\/v1\/integrations\/jira\/bindings$/.test(r.url())),
    dialog.getByRole("button", { name: "Link", exact: true }).click(),
  ]);
  expect(bound.status()).toBe(201);
  await expect(dialog).toHaveCount(0);
  return ((await bound.json()) as { id: number }).id;
}

test("an owner links a milestone to a Jira epic and the Deviations page shows its end three working days later after a refresh", async ({ page, browser }) => {
  const world = await seedWorld();
  // The stub's E2E-4 "E2E Epic One" runs Mon 2044-01-04 to Fri 2044-01-08. The milestone starts with it and ends on Wed 2044-01-13: three working days
  // (Mon 11, Tue 12, Wed 13) LATER than Jira - the weekend 01-09/01-10 does not count - which is what the page's sentence says ("Ends 3 working days
  // later than Jira"). The stub's own `expected.json` figure (+3) is Jira's end against the plan's, the other way round.
  const milestone = await seedMilestone(world, "epic-one", 3, "2044-01-04", "2044-01-13");
  await world.api.dispose();

  // The owner - no administrator - links the milestone from the project page.
  await login(page, world.owner.email, world.owner.password);
  await page.goto(`/projects/${world.projectId}`);
  await expect(page.getByRole("heading", { level: 2, name: world.project })).toBeVisible();
  await expect(page.getByRole("grid", { name: "Milestone timeline" })).toBeVisible();
  teardown.push(`/api/v1/integrations/jira/bindings/${await linkMilestoneAsOwner(page, linking, milestone, "E2E-4")}`);

  // The page now knows the link: the chip in the facts line and the row menu's unlink item.
  await expect(page.getByRole("group", { name: "Links to Jira" })).toContainText("1 milestone linked to Jira");
  await page.getByRole("button", { name: `Operations for ${milestone.name}` }).click();
  await expect(page.getByRole("menuitem", { name: `Unlink from Jira: E2E-4 (${milestone.name})` })).toBeVisible();
  await page.keyboard.press("Escape");

  // The chip's count opens the Deviations page for this project. Nothing has been refreshed yet, and the owner has no way to refresh.
  await page.getByRole("group", { name: "Links to Jira" }).getByRole("link").click();
  await expect(page).toHaveURL(new RegExp(`/deviations\\?projectId=${world.projectId}$`));
  await expect(page.getByRole("heading", { level: 2, name: "Deviations" })).toBeVisible();
  await expect(sourceRow(page, linking)).toContainText("Never refreshed");
  await expect(page.getByRole("button", { name: `Refresh now: ${linking.name}` })).toHaveCount(0);

  // The bind itself wrote the item's first reading, so the row reads the same before and after a refresh: what proves the run is the server's own
  // `observedAt` of the item (when it was last read from Jira), which must have strictly grown by the time the administrator's run has succeeded.
  const readAtBind = await observedAt(world.projectId);

  // An administrator, in a browser of their own, presses Refresh now and waits for the run to succeed.
  const adminContext = await browser.newContext();
  try {
    await refreshAsAdmin(await adminContext.newPage(), linking, world.projectId, (admin) => sourceRow(admin, linking).getByText("Succeeded", { exact: true }));
  } finally {
    await adminContext.close();
  }

  expect(await observedAt(world.projectId)).toBeGreaterThan(readAtBind);

  // The owner reads the figures after the refresh: both sides' dates, the sentence, and the connection no longer "never refreshed".
  await page.reload();
  await expect(sourceRow(page, linking).getByText("Succeeded", { exact: true })).toBeVisible();
  await expect(sourceRow(page, linking)).not.toContainText("No refresh has finished yet");
  const row = rowOf(page, milestone.name);
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("E2E-4");
  await expect(row).toContainText("E2E Epic One");
  await expect(row).toContainText("Plan 2044-01-04 → 2044-01-13");
  await expect(row).toContainText("Jira 2044-01-04 → 2044-01-08");
  await expect(row).toContainText("Ends 3 working days later than Jira");
  // The connection declares 0.5 man-days per point and `E2E-4` carries 5 points: Jira's estimate reads 2.50 man-days against the plan's 3.00.
  await expect(row).toContainText("Estimate is 3.00 man-days in the plan and 2.50 man-days in Jira");
});

test("unlinking the milestone removes its deviation, and a deleted Jira item reads as gone", async ({ page, browser }) => {
  const world = await seedWorld();
  // `moved` is linked to E2E-4 (Mon 2044-01-04 to Fri 01-08) and ends three working days later; `kept` is linked to E2E-6 (Mon 2044-02-14 to Fri 02-18,
  // which the stub deletes on day 2) and has the same days.
  const moved = await seedMilestone(world, "moved", 3, "2044-01-04", "2044-01-13");
  const kept = await seedMilestone(world, "kept", 3, "2044-02-14", "2044-02-18");
  await bindMilestone(world.api, linking, moved.id, "E2E-4");
  await bindMilestone(world.api, linking, kept.id, "E2E-6");
  await world.api.dispose();

  // The owner reads the project's links: one deviating, one in line.
  await login(page, world.owner.email, world.owner.password);
  await page.goto(`/deviations?projectId=${world.projectId}`);
  await expect(page.getByRole("heading", { level: 2, name: "Deviations" })).toBeVisible();
  await expect(rowOf(page, moved.name)).toContainText("Ends 3 working days later than Jira");
  await expect(rowOf(page, kept.name)).toContainText("Jira 2044-02-14 → 2044-02-18"); // the same days as the plan's: only the name differs
  await expect(rowOf(page, kept.name)).not.toContainText("working day");

  // They unlink the first from its row menu on the project page, behind the confirmation (nothing changes in Jira).
  await page.goto(`/projects/${world.projectId}`);
  await expect(page.getByRole("grid", { name: "Milestone timeline" })).toBeVisible();
  await page.getByRole("button", { name: `Operations for ${moved.name}` }).click();
  await page.getByRole("menuitem", { name: `Unlink from Jira: E2E-4 (${moved.name})` }).click();
  const confirm = page.getByRole("dialog", { name: "Unlink from Jira?" });
  await expect(confirm).toContainText(`${moved.name} will no longer be linked to E2E-4. Nothing changes in Jira`);
  await confirm.getByRole("button", { name: "Unlink", exact: true }).click();
  await expect(confirm).toHaveCount(0);

  // Its deviation is gone from the page with it; the other link stays.
  await page.goto(`/deviations?projectId=${world.projectId}`);
  await expect(rowOf(page, kept.name)).toHaveCount(1);
  await expect(rowOf(page, moved.name)).toHaveCount(0);

  // Day 2 on the stub: E2E-6 is deleted in Jira. Until now nothing says so; after the administrator's refresh the owner's page reads it as gone. The stub
  // goes back to day 1 as soon as the run has been read (the afterAll is only the backstop).
  await expect(rowOf(page, kept.name).getByText("Gone from Jira")).toHaveCount(0);
  const adminContext = await browser.newContext();
  try {
    await setStubState("day2");
    await refreshAsAdmin(await adminContext.newPage(), linking, world.projectId, (admin) => rowOf(admin, kept.name).getByText("Gone from Jira", { exact: true }));
  } finally {
    await setStubState("Started");
    await adminContext.close();
  }
  await page.reload();
  const gone = rowOf(page, kept.name);
  await expect(gone.getByText("Gone from Jira", { exact: true })).toBeVisible();
  await expect(gone).toContainText("E2E-6");
  await expect(page.getByText("1 gone from Jira")).toBeVisible();
  await expect(gone).toContainText("Warning: Gone");
  await expect(gone).toContainText("No longer readable in Jira: deleted, moved out of the connection's projects, or no longer visible to its account");
  await expect(gone.getByRole("cell").last()).toHaveText(/ · stale$/); // the "Data as of" cell: what the row shows is what was last read, not a current figure
});
