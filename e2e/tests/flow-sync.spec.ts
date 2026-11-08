// Flow sync (v1.5), against the compose stack's Flow STUB (WireMock; the app reaches it as `E2E_FLOW_STUB_ORIGIN`, default http://flow-stub:8080, with the stub's one public
// service token read from sample-data/flow/expected.json): an administrator creates a Flow connection in the modal, tests it and refreshes the mirror; a team MANAGER (no
// administrator right) links the team to the stub's "E2E Flow Team" from the team page, previews the capacity import and applies it; and the roster panel shows the Flow
// team's current and former members until the link is removed. "E2E Flow Team" is dated in 2047 (six two-week sprints from Monday 2047-01-07, 40/36/44/40/38/42 man-days, so
// 20/18/22/20/19/21 man-days a week over ten working days each), which nothing writes a holiday in.
// Owns: its Flow connections (unique `e2e-flow-*` names, manual only, pointed at the stub: one made through the API in the beforeAll and tested + refreshed there, one made in the
// first scenario's modal and tested there), the link of the team to the stub's "E2E Flow Team" and the capacity periods the import writes (they go with the team), and a throwaway
// world of its own (a team manager login, a viewer login with no right on the team, their people and the team `e2e-flow-team-*`, unique `e2e-flow-*` names), all seeded and removed
// through the API (the connections first - their link goes with them - then the team, the people and the users). It never flips a scenario of the stub (day one's figures are
// asserted, and the beforeAll fails fast naming the scenario if a walk left one on), never presses "Link all suggested" (that would link the demo plan's teams) and shares the Playwright lock
// `flow-stub-scenario` with `flow-capacity-deviation.spec.ts`, which flips `flow-day2` (so this file never meets day two).
import { randomUUID } from "node:crypto";
import { type APIRequestContext, type Locator, type Page } from "@playwright/test";
import {
  apiAsAdmin,
  axeViolations,
  bindFlowTeamViaApi,
  deleteViaApi,
  expect,
  expectFlowStubOnDayOne,
  FLOW_STUB_ORIGIN,
  flowStub,
  login,
  refreshFlowConnectionViaApi,
  seedFlowConnection,
  test,
  testFlowConnectionViaApi,
  uniqueText,
} from "./helpers";

// One world, read by three tests in order (the roster scenario reuses the link the second one made, or makes its own when it runs alone). The lock keeps `flow-capacity-deviation.spec.ts`
// (the one spec that flips the stub's `flow-day2`) from running at the same time: this file asserts day one's figures.
test.describe.configure({ mode: "serial", lock: "flow-stub-scenario" });

const E2E_TEAM = flowStub().e2e.team;
/** The preview's date range cell: "2047-01-07 – 2047-01-18" (an en dash). */
const DASH = "–";

interface Account {
  email: string;
  password: string;
}

interface World {
  manager: Account;
  viewer: Account;
  team: string;
  teamId: number;
  shared: { id: number; name: string };
}

let world: World;
// Registered in creation order; deleted in reverse - the connections (created last) go first, then the team, the people and the users.
const teardown: string[] = [];

async function create(api: APIRequestContext, path: string, data: object, tear: string): Promise<number> {
  const response = await api.post(path, { data });
  expect(response.status(), await response.text()).toBe(201);
  const id = ((await response.json()) as { id: number }).id;
  teardown.push(`${tear}/${id}`);
  return id;
}

async function seedUser(api: APIRequestContext, label: string): Promise<{ id: number; account: Account }> {
  const name = uniqueText(`e2e-flow-${label}`);
  const account = { email: `${name.toLowerCase()}@astrolabe.local`, password: randomUUID().replace(/-/g, "") };
  const id = await create(api, "/api/v1/users", { name, email: account.email, password: account.password }, "/api/v1/users");
  return { id, account };
}

test.beforeAll(async () => {
  test.setTimeout(180_000); // the Test connection call may wait a 429 out (one minute)
  await expectFlowStubOnDayOne();
  const { api } = await apiAsAdmin();
  try {
    const manager = await seedUser(api, "manager");
    const viewer = await seedUser(api, "viewer");
    const managerPerson = await create(api, "/api/v1/people", { name: uniqueText("e2e-flow-managerperson"), userId: manager.id }, "/api/v1/people");
    const team = uniqueText("e2e-flow-team");
    const teamId = await create(api, "/api/v1/teams", { name: team, managerPersonId: managerPerson }, "/api/v1/teams");
    // The connection the second and third scenarios link through: tested once (one call of the per-IP `flow-test` bucket) and read once, so its mirror holds the stub's document.
    const sharedName = uniqueText("e2e-flow-shared");
    const sharedId = await seedFlowConnection(api, sharedName, teardown);
    await testFlowConnectionViaApi(api, sharedId);
    await refreshFlowConnectionViaApi(api, sharedId);
    world = { manager: manager.account, viewer: viewer.account, team, teamId, shared: { id: sharedId, name: sharedName } };
  } finally {
    await api.dispose();
  }
});
test.afterAll(async () => {
  await deleteViaApi(teardown.splice(0).reverse());
});

/** The team's Flow panel as the administrator reads it (`GET /teams/{id}/flow`). */
async function panelOf(api: APIRequestContext): Promise<{ binding: { id: number; flowTeamName: string } | null }> {
  const response = await api.get(`/api/v1/teams/${world.teamId}/flow`);
  expect(response.status(), await response.text()).toBe(200);
  return (await response.json()) as { binding: { id: number; flowTeamName: string } | null };
}

/** Makes sure the world's team is linked to "E2E Flow Team" through the shared connection (the second scenario's link, or one of its own when this one runs alone). */
async function ensureLinked(): Promise<void> {
  const { api } = await apiAsAdmin();
  try {
    if ((await panelOf(api)).binding === null) await bindFlowTeamViaApi(api, world.shared.id, world.teamId, E2E_TEAM);
  } finally {
    await api.dispose();
  }
}

/** The capacity periods of the team (`GET /teams/{id}/capacity`): how many, to prove an unlink leaves the imported ones. */
async function periodCount(api: APIRequestContext): Promise<number> {
  const response = await api.get(`/api/v1/teams/${world.teamId}/capacity`);
  expect(response.status(), await response.text()).toBe(200);
  return ((await response.json()) as { items: unknown[] }).items.length;
}

/** One probe's row of a Test connection table, found by its label cell. */
const probeRow = (results: Locator, label: string) => results.getByRole("row").filter({ has: results.page().getByText(label, { exact: true }) });

/** Opens a Mantine Select's list and picks an option, unless the field already shows it (a lone offered connection is preselected and read-only). */
async function choose(page: Page, field: Locator, option: string): Promise<void> {
  if ((await field.inputValue()) === option) return;
  await field.click();
  await page.getByRole("option", { name: option, exact: true }).click();
  await expect(field).toHaveValue(option);
}

test("admin creates a Flow connection, tests it and refreshes the observed teams", async ({ page }) => {
  const name = uniqueText("e2e-flow-ui");
  const stub = flowStub();
  await login(page);
  await page.goto("/integrations/flow");
  await expect(page.getByRole("heading", { level: 2, name: "Flow connections" })).toBeVisible();

  await page.getByRole("button", { name: "New connection" }).click();
  const dialog = page.getByRole("dialog", { name: "New Flow connection" });
  await dialog.getByRole("textbox", { name: "Name" }).fill(name);
  await dialog.getByRole("textbox", { name: "Base URL" }).fill(FLOW_STUB_ORIGIN);
  // Flow's own metrics zone is pre-filled; the stub's instants are Warsaw's.
  await expect(dialog.getByRole("textbox", { name: "Time zone" })).toHaveValue("Europe/Warsaw");
  await dialog.getByLabel("Service token", { exact: true }).fill(stub.contract.token);
  // Manual only: the scheduler never touches this connection, the refresh below is the one run.
  await dialog.getByRole("checkbox", { name: "Manual only (no polling)" }).check();
  const [created] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === "POST" && /\/api\/v1\/integrations\/flow\/connections$/.test(r.url())),
    dialog.getByRole("button", { name: "Create", exact: true }).click(),
  ]);
  expect(created.status()).toBe(201);
  const id = ((await created.json()) as { id: number }).id;
  teardown.push(`/api/v1/integrations/flow/connections/${id}`);

  // A new connection lands on its page, never tested: the facts say so and the token is only "stored".
  await expect(page).toHaveURL(new RegExp(`/integrations/flow/${id}$`));
  await expect(page.getByRole("heading", { level: 2, name })).toBeVisible();
  const facts = page.getByRole("table", { name: "Connection facts" });
  await expect(facts).toContainText("A token is stored");
  await expect(facts).toContainText("Europe/Warsaw");
  await expect(facts).toContainText("Never tested");

  // Test connection reads the stub with the stored token: both probes are green, and the document's size is the stub's own.
  await page.getByRole("button", { name: "Test connection" }).click();
  await expect(page.getByRole("status").filter({ hasText: /^Test passed\. OK: 2 of 2\.$/ })).toBeVisible();
  const results = page.getByRole("table", { name: "Connection test results" });
  for (const probe of ["Service token", "Teams document"]) {
    await expect(probeRow(results, probe).getByText("OK", { exact: true })).toBeVisible();
  }
  await expect(results.getByText("Failed", { exact: true })).toHaveCount(0);
  await expect(page.getByText(`Flow's document · teams: ${stub.totals.teams} · sprints: ${stub.totals.sprints}`)).toBeVisible();
  await expect(facts).toContainText("Passed");
  // The green result is scanned as it stands (the "Connection created" toast has gone, so it does not sit over the page).
  await expect(page.locator(".mantine-Notification-root")).toHaveCount(0);
  expect(await axeViolations(page)).toEqual([]);

  // A test writes no mirror: the Teams section asks for a refresh first. Refresh now starts the one run and the section fills by itself.
  await expect(page.getByText("Refresh the connection first")).toBeVisible();
  await page.getByRole("button", { name: "Refresh now" }).click();
  await expect(page.getByRole("table", { name: "Recent runs" }).getByText("Succeeded", { exact: true })).toBeVisible({ timeout: 30_000 });
  const teams = page.getByRole("table", { name: "Flow teams" });
  await expect(teams).toBeVisible();
  await expect(page.getByText(new RegExp(`^Flow teams: ${stub.totals.teams} · linked: 0 · with a suggestion: \\d+$`))).toBeVisible();

  // "E2E Flow Team": its memberships and sprints counted, no Astrolabe team of that name, so no suggestion and no Link button.
  const e2eCounts = stub.teams.find((team) => team.name === E2E_TEAM);
  expect(e2eCounts, "expected.json lists E2E Flow Team").toBeDefined();
  const e2eRow = teams.getByRole("row").filter({ has: page.getByText(E2E_TEAM, { exact: true }) });
  await expect(e2eRow.getByRole("cell").nth(1)).toHaveText(String(e2eCounts?.members.rows));
  await expect(e2eRow.getByRole("cell").nth(2)).toHaveText(String(e2eCounts?.sprints.count));
  await expect(e2eRow).toContainText("No team of this name");
  await expect(e2eRow.getByRole("button")).toHaveCount(0);
  // "Legacy Mainframe" has no Astrolabe counterpart either, whatever its sprints carry.
  const legacy = teams.getByRole("row").filter({ has: page.getByText("Legacy Mainframe", { exact: true }) });
  await expect(legacy).toContainText("No team of this name");
  await expect(legacy.getByRole("button")).toHaveCount(0);
  await expect(facts).not.toContainText("Never tested");
});

test("a team manager links the team to its Flow team, previews the capacity import and applies it", async ({ page }) => {
  const { preview } = flowStub().e2e;
  await login(page, world.manager.email, world.manager.password);
  await page.goto(`/teams/${world.teamId}`);
  await expect(page.getByRole("heading", { level: 2, name: world.team })).toBeVisible();
  await expect(page.getByRole("heading", { level: 3, name: "Flow" })).toBeVisible();
  await expect(page.getByText("Not linked to a Flow team")).toBeVisible();

  // Link: the manager is not an administrator, yet the dialog offers the connections (the panel lists them) and the shared connection's Flow teams.
  await page.getByRole("button", { name: "Link to Flow team…" }).click();
  const link = page.getByRole("dialog", { name: "Link to a Flow team" });
  await choose(page, link.getByRole("combobox", { name: "Flow connection" }), world.shared.name);
  await choose(page, link.getByRole("combobox", { name: "Flow team" }), E2E_TEAM);
  const [bound] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === "POST" && /\/api\/v1\/integrations\/flow\/team-bindings$/.test(r.url())),
    link.getByRole("button", { name: "Link", exact: true }).click(),
  ]);
  expect(bound.status()).toBe(201);
  await expect(link).toHaveCount(0);
  const linked = page.getByRole("table", { name: "Link to Flow" });
  await expect(linked).toContainText(E2E_TEAM);
  await expect(linked).toContainText(world.shared.name);

  // Preview: one row per sprint, the dates in the connection's zone, the working days and the stub's own figures; the man-days per week are the sprint total over its working days.
  await page.getByRole("button", { name: "Import capacity…" }).click();
  const dialog = page.getByRole("dialog", { name: "Import capacity from Flow" });
  const table = dialog.getByRole("table", { name: "Capacity import preview" });
  await expect(table.getByRole("row").filter({ hasText: "E2E Flow Sprint" })).toHaveCount(preview.length);
  for (const sprint of preview) {
    const row = table.getByRole("row").filter({ has: page.getByText(sprint.name, { exact: true }) });
    const cells = row.getByRole("cell");
    await expect(cells.nth(2), sprint.name).toHaveText(`${sprint.start} ${DASH} ${sprint.end}`);
    await expect(cells.nth(3), sprint.name).toHaveText(String(sprint.workingDays));
    await expect(cells.nth(4), sprint.name).toHaveText(String(sprint.flowMd));
    await expect(cells.nth(5), sprint.name).toHaveText(sprint.mdPerWeek);
    await expect(cells.nth(6), sprint.name).toHaveText("Create");
    await expect(dialog.getByRole("checkbox", { name: `Import ${sprint.name}` })).toBeChecked();
  }
  await expect(dialog.getByRole("status").filter({ hasText: `Selected: ${preview.length} · to create: ${preview.length} · to update: 0 · to remove: 0` })).toBeVisible();
  expect(await axeViolations(page, '[role="dialog"]')).toEqual([]);

  // Apply: every row is created; the plan is read again and now says the rows are already imported, with nothing left to select.
  const [applied] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === "POST" && /\/capacity-import$/.test(r.url())),
    dialog.getByRole("button", { name: "Import", exact: true }).click(),
  ]);
  expect(applied.status()).toBe(200);
  await expect(dialog.getByRole("note")).toHaveText(`${preview.length} created`);
  for (const sprint of preview) {
    await expect(table.getByRole("row").filter({ has: page.getByText(sprint.name, { exact: true }) }).getByRole("cell").nth(6), sprint.name).toHaveText("Unchanged");
  }
  await expect(dialog.getByRole("status").filter({ hasText: "Selected: 0" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  // The capacity table now holds the six Flow-badged periods, one per sprint start, each titled with its sprint.
  const periods = page.getByRole("table", { name: "Capacity periods of the team" });
  for (const sprint of preview) {
    const row = periods.getByRole("row").filter({ hasText: sprint.start });
    await expect(row, sprint.start).toHaveCount(1);
    await expect(row.getByRole("cell").nth(0)).toContainText("Flow");
    await expect(row.getByTitle(sprint.name)).toHaveText("Flow");
    await expect(row.getByRole("cell").nth(1)).toHaveText(String(Number(sprint.mdPerWeek)));
  }
});

test("the roster panel shows Flow's current and former members, and unlinking removes it", async ({ page }) => {
  const { roster } = flowStub().e2e;
  await ensureLinked();
  const { api } = await apiAsAdmin();
  try {
    // Every signed-in user reads the roster (the decision): a login with no right on the team sees the members, and neither Link nor Unlink.
    await login(page, world.viewer.email, world.viewer.password);
    await page.goto(`/teams/${world.teamId}`);
    await expect(page.getByRole("heading", { level: 2, name: world.team })).toBeVisible();
    await expect(page.getByRole("table", { name: "Current members of the Flow team" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Unlink" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Import capacity…" })).toHaveCount(0);

    // The team's manager: the four current members, then the former one behind the disclosure, with the dates in the connection's zone.
    await login(page, world.manager.email, world.manager.password);
    await page.goto(`/teams/${world.teamId}`);
    await expect(page.getByRole("heading", { level: 2, name: world.team })).toBeVisible();
    await expect(page.getByRole("heading", { level: 4, name: "Roster" })).toBeVisible();
    const current = page.getByRole("table", { name: "Current members of the Flow team" });
    for (const member of roster.current) await expect(current.getByRole("cell", { name: member, exact: true })).toBeVisible();
    await expect(current.getByRole("row")).toHaveCount(roster.current.length + 1);
    await expect(current).not.toContainText(roster.former[0].displayName);
    await expect(page.getByRole("table", { name: "Former members of the Flow team" })).toHaveCount(0);
    await page.getByRole("button", { name: `${roster.former.length} former member` }).click();
    const former = page.getByRole("table", { name: "Former members of the Flow team" });
    const day = (instant: number) => new Date(instant).toLocaleDateString("sv-SE", { timeZone: "Europe/Warsaw" });
    const gone = former.getByRole("row").filter({ hasText: roster.former[0].displayName });
    await expect(gone.getByRole("cell").nth(1)).toHaveText(day(roster.former[0].validFrom));
    await expect(gone.getByRole("cell").nth(2)).toHaveText(day(roster.former[0].validTo));
    await expect(page.getByText(/^Observed \(UTC\): \d{4}-/).last()).toBeVisible();

    // Unlink behind its confirmation: the panel is "not linked" again and the roster is gone; what was imported stays.
    const periodsBefore = await periodCount(api);
    await page.getByRole("button", { name: "Unlink", exact: true }).click();
    const confirm = page.getByRole("dialog", { name: "Unlink the Flow team?" });
    await expect(confirm).toContainText(E2E_TEAM);
    const [unlinked] = await Promise.all([
      page.waitForResponse((r) => r.request().method() === "DELETE" && /\/api\/v1\/integrations\/flow\/team-bindings\/\d+$/.test(r.url())),
      confirm.getByRole("button", { name: "Unlink", exact: true }).click(),
    ]);
    expect(unlinked.status()).toBe(204);
    await expect(page.getByText("Not linked to a Flow team")).toBeVisible();
    await expect(page.getByRole("table", { name: "Current members of the Flow team" })).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 4, name: "Roster" })).toHaveCount(0);
    expect((await panelOf(api)).binding).toBeNull();
    expect(await periodCount(api)).toBe(periodsBefore);
  } finally {
    await api.dispose();
  }
});
