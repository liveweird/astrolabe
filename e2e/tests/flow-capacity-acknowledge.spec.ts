// Acknowledging the capacity deviation (v1.9) against the compose stack's Flow STUB (WireMock; the app reaches it as `E2E_FLOW_STUB_ORIGIN`, the spec flips its `flow-day2` scenario through `E2E_FLOW_STUB_URL`):
// a team linked to the stub's "E2E Flow Team" whose capacity was imported on day one reads, after the stub's day two (sprint 2 36 -> 30 man-days, sprint 3 44 -> 48), a WARNING for sprint 2 (the plan has
// more) and an INFO for sprint 3 (less), while a team linked to "Billing" (gone from day two) reads gone. The team's manager - or the administrator - acknowledges ONE sprint's row ("known, leave it") on the
// team page's Flow section or on the Deviations page's "Capacity from Flow" section; an acknowledged row leaves the Open list, is listed under Status Acknowledged and All, and stops counting in the team
// page's "Capacity vs Flow" fact, in the header's flag (ONE roll-up of the OPEN rows) and in the marks of the weeks strip; a change of THAT sprint's figures (a capacity period edited in the plan) opens it
// again and touches no other row. Since 1.10 the manager can also acknowledge every open row of the team at once ("Acknowledge all (N)"), and an acknowledgement goes when
// its sprint comes back in line, so the same difference returning reads open. "E2E Flow Team" is dated in 2047 (six two-week sprints from Monday 2047-01-07, ten working days each), which nothing writes a holiday in. Every figure is read from
// `sample-data/flow/expected.json` (`flowStub()`), never copied.
// Owns: ONE Flow connection (`e2e-capack-connection-*`, manual only, made through the API and tested + refreshed in the beforeAll: one call of the per-IP `flow-test` bucket per worker start), a throwaway world
// (a team-manager login and its person, the team `e2e-capack-team-*` linked to "E2E Flow Team" and the team `e2e-capack-gone-*` linked to the stub's "Billing", both through that connection, so no other spec's
// link is ever met; a login-less owner's work stream / program / project holding ONE milestone of the team scheduled 2047-01-07..2047-02-15, so the team view's `weeks[]` cover sprints 1-3), the six capacity
// periods the import writes (they go with the team), the acknowledgements it makes (they go with the binding) and the stub's `flow-day2` SCENARIO, which this file flips too - the second flipper, one at a time
// under the Playwright lock `flow-stub-scenario` shared with `flow-sync` and `flow-capacity-deviation`; the beforeAll puts the scenario back to `Started`, flips it only to refresh the connection's mirror once
// and the afterAll resets it even after a failure. The last two scenarios (1.10) start by putting sprint 3's period back to the import's figure (the one before them raised it); the last flips the scenario again (day one, then day two, a refresh after each, reset in a `finally`). Everything is removed through the API (the connection first - the links and the acknowledgements go with it - then the plan, the teams, the people and the user).
// The Deviations page lists EVERY linked team of the stack, so each page is narrowed to the spec's own team with the `teamId` filter and every assertion is about that team's rows. Each scenario starts by
// withdrawing every acknowledgement of the world through the API, so none depends on what an earlier one left.
import { randomUUID } from "node:crypto";
import { type APIRequestContext, type Locator, type Page, request as playwrightRequest } from "@playwright/test";
import { BASE_URL } from "../playwright.config";
import {
  apiAsAdmin,
  axeViolations,
  bindFlowTeamViaApi,
  deleteViaApi,
  expect,
  expectFlowStubOnDayOne,
  expectScheme,
  FLOW_STUB_URL,
  flowStub,
  login,
  openFilters,
  refreshFlowConnectionViaApi,
  seedFlowConnection,
  test,
  testFlowConnectionViaApi,
  uniqueText,
} from "./helpers";

// One stub scenario state for the whole stack: this file and `flow-capacity-deviation` are the flippers, each serial, and every Flow spec takes the lock (`flow-sync` asserts day one's figures).
test.describe.configure({ mode: "serial", lock: "flow-stub-scenario", timeout: 120_000 });

const E2E_TEAM = flowStub().e2e.team;
const GONE_TEAM = flowStub().day2.gone[0];
const EN_DASH = "–";
const EM_DASH = "—";
const SCHEDULE_START = "2047-01-07";
const SCHEDULE_END = "2047-02-15";

interface Account {
  email: string;
  password: string;
}

interface World {
  manager: Account;
  managerPerson: string;
  team: string;
  teamId: number;
  teamBindingId: number;
  goneTeam: string;
  goneTeamId: number;
  goneBindingId: number;
  connection: { id: number; name: string };
}

let world: World;
// Registered in creation order; deleted in reverse - the connection (created last) goes first, then the plan, the teams, the people and the user.
const teardown: string[] = [];

/** POSTs a record and registers its delete path (`deletePath` when the create path is nested under a parent). */
async function create(api: APIRequestContext, path: string, data: object, deletePath = path): Promise<number> {
  const response = await api.post(path, { data });
  expect(response.status(), await response.text()).toBe(201);
  const id = ((await response.json()) as { id: number }).id;
  teardown.push(`${deletePath}/${id}`);
  return id;
}

/** Puts the stub's `flow-day2` scenario into a state (`Started` = day one, the stub's `day2State` = day two). */
async function setStubState(state: string): Promise<void> {
  const stub = await playwrightRequest.newContext({ baseURL: FLOW_STUB_URL });
  try {
    const response = await stub.put(`/__admin/scenarios/${flowStub().scenarios.day2}/state`, { data: { state } });
    expect(response.ok(), `the Flow stub answered ${response.status()} to the scenario flip`).toBeTruthy();
  } finally {
    await stub.dispose();
  }
}

/** An API context signed in as the throwaway team manager (no administrator right): the import and the acknowledge are the team's manager's. */
async function apiAsManager(): Promise<APIRequestContext> {
  const anonymous = await playwrightRequest.newContext({ baseURL: BASE_URL });
  const signedIn = await anonymous.post("/api/v1/login", { data: world.manager });
  expect(signedIn.ok(), await signedIn.text()).toBeTruthy();
  const { token } = (await signedIn.json()) as { token: string };
  await anonymous.dispose();
  return playwrightRequest.newContext({ baseURL: BASE_URL, extraHTTPHeaders: { Authorization: `Bearer ${token}` } });
}

interface PreviewItem {
  sprintId: number;
  action: string;
  effectiveFrom: string | null;
  mdPerWeek: string | null;
  ticked: boolean;
}

/** The capacity import as the modal does it: the preview, then the apply of exactly the rows the preview ticked. */
async function importCapacity(api: APIRequestContext): Promise<void> {
  const previewed = await api.post(`/api/v1/integrations/flow/team-bindings/${world.teamBindingId}/capacity-preview`, { data: {} });
  expect(previewed.status(), await previewed.text()).toBe(200);
  const plan = (await previewed.json()) as { from: string; includeClosed: boolean; items: PreviewItem[] };
  const items = plan.items
    .filter((item) => item.ticked && (item.action === "CREATE" || item.action === "UPDATE"))
    .map((item) => ({ sprintId: item.sprintId, expected: { action: item.action, effectiveFrom: item.effectiveFrom, mdPerWeek: item.mdPerWeek } }));
  expect(items.length, "every sprint of the E2E Flow Team is a row to import").toBe(flowStub().e2e.preview.length);
  const applied = await api.post(`/api/v1/integrations/flow/team-bindings/${world.teamBindingId}/capacity-import`, {
    data: { from: plan.from, includeClosed: plan.includeClosed, items, removals: [] },
  });
  expect(applied.status(), await applied.text()).toBe(200);
  const outcome = (await applied.json()) as { created: unknown[]; skipped: unknown[] };
  expect(outcome.skipped).toEqual([]);
  expect(outcome.created).toHaveLength(items.length);
}

test.beforeAll(async () => {
  test.setTimeout(180_000); // the Test connection call may wait a 429 out (one minute)
  await setStubState("Started"); // a crashed earlier run may have left day two on; the import below needs day one's document
  await expectFlowStubOnDayOne(); // ... and the other scenario (an outage left by a manual walk) is not ours to reset
  const { api } = await apiAsAdmin();
  try {
    const name = uniqueText("e2e-capack-manager");
    const account = { email: `${name.toLowerCase()}@astrolabe.local`, password: randomUUID().replace(/-/g, "") };
    const userId = await create(api, "/api/v1/users", { name, email: account.email, password: account.password });
    const managerPerson = uniqueText("e2e-capack-managerperson");
    const managerPersonId = await create(api, "/api/v1/people", { name: managerPerson, userId });
    const ownerPersonId = await create(api, "/api/v1/people", { name: uniqueText("e2e-capack-ownerperson") });
    const team = uniqueText("e2e-capack-team");
    const teamId = await create(api, "/api/v1/teams", { name: team, managerPersonId });
    const goneTeam = uniqueText("e2e-capack-gone");
    const goneTeamId = await create(api, "/api/v1/teams", { name: goneTeam, managerPersonId });
    // The owner's plan: one milestone of the team scheduled over sprints 1-3, so the team view's weekly load (and its strip) covers them. The admin schedules it: dates are the team's manager's or ADMIN's.
    const streamId = await create(api, "/api/v1/work-streams", { name: uniqueText("e2e-capack-stream"), ownerPersonId, startDate: "2026-01-05" });
    const programId = await create(api, `/api/v1/work-streams/${streamId}/programs`, { name: uniqueText("e2e-capack-program"), ownerPersonId }, "/api/v1/programs");
    const projectId = await create(api, `/api/v1/programs/${programId}/projects`, { name: uniqueText("e2e-capack-project"), ownerPersonId }, "/api/v1/projects");
    const milestoneId = await create(api, `/api/v1/projects/${projectId}/milestones`, { name: uniqueText("e2e-capack-milestone"), teamId, estimateMd: 30 }, "/api/v1/milestones");
    const view = (await (await api.get(`/api/v1/views/team/${teamId}`)).json()) as { revision: number };
    const scheduled = await api.put(`/api/v1/milestones/${milestoneId}/schedule`, { data: { expectedRevision: view.revision, startDate: SCHEDULE_START, endDate: SCHEDULE_END } });
    expect(scheduled.status(), await scheduled.text()).toBe(200);
    // The connection both teams are linked through: tested once (one call of the per-IP `flow-test` bucket) and read once, so its mirror holds the stub's day-one document.
    const connectionName = uniqueText("e2e-capack-connection");
    const connectionId = await seedFlowConnection(api, connectionName, teardown);
    await testFlowConnectionViaApi(api, connectionId);
    await refreshFlowConnectionViaApi(api, connectionId);
    const teamBindingId = await bindFlowTeamViaApi(api, connectionId, teamId, E2E_TEAM);
    const goneBindingId = await bindFlowTeamViaApi(api, connectionId, goneTeamId, GONE_TEAM);
    world = { manager: account, managerPerson, team, teamId, teamBindingId, goneTeam, goneTeamId, goneBindingId, connection: { id: connectionId, name: connectionName } };
    // Day one's capacity is imported (20 / 18 / 22 / ... man-days a week) as the manager; then day two: Flow lowers sprint 2, raises sprint 3 and drops "Billing". The flip is undone at once.
    const manager = await apiAsManager();
    try {
      await importCapacity(manager);
    } finally {
      await manager.dispose();
    }
    await setStubState(flowStub().scenarios.day2State);
    try {
      await refreshFlowConnectionViaApi(api, connectionId);
    } finally {
      await setStubState("Started");
    }
  } finally {
    await api.dispose();
  }
});
test.afterAll(async () => {
  try {
    await deleteViaApi(teardown.splice(0).reverse());
  } finally {
    await setStubState("Started");
  }
});

/** The sprints of day two: the one Flow lowered (the WARNING) and the one it raised (the INFO), with their dates from the stub's own preview. */
function daySprints() {
  const { preview } = flowStub().e2e;
  const changes = flowStub().day2.capacityChanges.filter((change) => change.team === E2E_TEAM);
  const find = (more: boolean) => {
    const change = changes.find((candidate) => (more ? candidate.from > candidate.to : candidate.from < candidate.to));
    expect(change, `expected.json: a day-two sprint of the E2E team that ${more ? "loses" : "gains"} Flow capacity`).toBeDefined();
    const sprint = preview.find((candidate) => candidate.sprintId === change?.sprintId);
    expect(sprint, `expected.json lists the sprint ${change?.sprintId}`).toBeDefined();
    if (change === undefined || sprint === undefined) throw new Error("expected.json lacks the day-two sprints");
    return { id: change.sprintId, name: change.name, start: sprint.start, end: sprint.end, plan: change.from, flow: change.to };
  };
  return { more: find(true), less: find(false) };
}

/** A man-days figure as the sentences print it: two decimals. */
const md = (value: number): string => value.toFixed(2);

/** The line of a differing sprint as the page words it; `plan` is what the plan holds over the sprint, `flow` what Flow says. */
function sentence(sprint: { name: string; start: string; end: string }, plan: number, flow: number): string {
  const gap = Math.abs(plan - flow);
  return `${sprint.name} (${sprint.start} ${EN_DASH} ${sprint.end}): the plan has ${md(plan)} man-days, Flow ${md(flow)} ${EM_DASH} ${md(gap)} ${plan > flow ? "more" : "less"} in the plan`;
}

interface DeviationRow {
  kind: string;
  detail: { sprintId: number | null };
  fingerprint: string;
  acknowledgement: { current: boolean } | null;
}

/** The team's capacity-deviation rows (`teamId` lists the acknowledged ones too) with the binding they belong to. */
async function rowsOf(api: APIRequestContext, teamId: number): Promise<{ bindingId: number; rows: DeviationRow[] }> {
  const response = await api.get(`/api/v1/views/capacity-deviations?teamId=${teamId}`);
  expect(response.status(), await response.text()).toBe(200);
  const view = (await response.json()) as { items: { bindingId: number; deviations: DeviationRow[] }[] };
  expect(view.items, "the team has its capacity-deviation item").toHaveLength(1);
  return { bindingId: view.items[0].bindingId, rows: view.items[0].deviations };
}

/** Withdraws every acknowledgement (current or stale) of the team's rows, so a scenario starts from nothing acknowledged. */
async function withdrawAll(api: APIRequestContext, teamId: number): Promise<void> {
  const { bindingId, rows } = await rowsOf(api, teamId);
  for (const row of rows.filter((candidate) => candidate.acknowledgement !== null)) {
    const query = row.detail.sprintId === null ? "" : `?sprintId=${row.detail.sprintId}`;
    const withdrawn = await api.delete(`/api/v1/integrations/flow/team-bindings/${bindingId}/acknowledge${query}`);
    expect(withdrawn.status(), await withdrawn.text()).toBe(204);
  }
}

/** Acknowledges one sprint's row (the fingerprint read off the view, as the page does). */
async function acknowledgeViaApi(api: APIRequestContext, teamId: number, sprintId: number): Promise<void> {
  const { bindingId, rows } = await rowsOf(api, teamId);
  const row = rows.find((candidate) => candidate.detail.sprintId === sprintId);
  expect(row, `the view lists a deviation for the sprint ${sprintId}`).toBeDefined();
  const acknowledged = await api.post(`/api/v1/integrations/flow/team-bindings/${bindingId}/acknowledge`, { data: { sprintId, fingerprint: row?.fingerprint } });
  expect(acknowledged.status(), await acknowledged.text()).toBe(200);
}

/** The Deviations page narrowed to one team, `status` being the URL's own words (`&all=false` is the Open list under a team scope). */
async function openDeviations(page: Page, teamId: number, status = ""): Promise<void> {
  await page.goto(`/deviations?teamId=${teamId}${status}`);
  await expect(page.getByRole("heading", { level: 2, name: "Deviations" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 3, name: "Capacity from Flow" })).toBeVisible();
}

const capacityTable = (page: Page) => page.getByRole("table", { name: "Capacity differences between the plan and Flow" });
const rowOf = (page: Page, team: string) => capacityTable(page).getByRole("row").filter({ has: page.getByRole("link", { name: `Open team ${team}` }) });
/** The totals badges under "Differences from Flow" (the section's own group). */
const totalsOf = (page: Page) => page.getByRole("group", { name: "Differences from Flow" });
/** The "Link to Flow" facts of the team page (the "Capacity vs Flow" row among them). */
const factsOf = (page: Page) => page.getByRole("table", { name: "Link to Flow" });
/** The team page's header flag: ONE roll-up of the open rows, and the strip's cell of a week. */
const headerFlag = (page: Page) => page.locator('[data-team-flag="FLOW_CAPACITY"]');
const stripCell = (page: Page, week: string) => page.locator(`[data-week="${week}"]`);
/** Weeks whose strip cell is rendered (visible) and carries no Flow capacity mark: the cell is proven first, so a missing strip cannot pass the negative. */
async function expectUnmarked(page: Page, weeks: string[]): Promise<void> {
  for (const week of weeks) {
    await expect(stripCell(page, week), `the strip renders the week ${week}`).toBeVisible();
    await expect(stripCell(page, week), week).not.toHaveAttribute("data-flow-capacity", /.+/);
  }
}
/** The acknowledge cell's buttons name their row by the sprint (exact: "Acknowledge X" is also a substring of "Unacknowledge X"). */
const acknowledgeButton = (scope: Page | Locator, name: string) => scope.getByRole("button", { name: `Acknowledge ${name}`, exact: true });
const unacknowledgeButton = (scope: Page | Locator, name: string) => scope.getByRole("button", { name: `Unacknowledge ${name}`, exact: true });

/** Opens the team page and waits for its Flow section. */
async function openTeamPage(page: Page, teamId: number, teamName: string): Promise<void> {
  await page.goto(`/teams/${teamId}`);
  await expect(page.getByRole("heading", { level: 2, name: teamName })).toBeVisible();
  await expect(page.getByRole("heading", { level: 3, name: "Flow" })).toBeVisible();
}

/** axe over the open page in the light scheme and again in the dark one (the page follows Playwright's emulated colour scheme). */
async function scanBothSchemes(page: Page, url: string, ready: () => Promise<void>): Promise<void> {
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto(url);
    await ready();
    await expectScheme(page, scheme);
    expect(await axeViolations(page), `axe in the ${scheme} scheme`).toEqual([]);
  }
  await page.emulateMedia({ colorScheme: "light" });
}

test("the team's manager acknowledges one sprint's difference on the team page: the line reads acknowledged, the Capacity vs Flow fact counts one open difference and one acknowledged, and the header flag and the weeks strip follow", async ({ page }) => {
  const { more, less } = daySprints();
  const manager = await apiAsManager();
  try {
    await withdrawAll(manager, world.teamId);
  } finally {
    await manager.dispose();
  }
  await login(page, world.manager.email, world.manager.password);

  // Nothing acknowledged: two open differences. The header carries ONE flag counting them, orange (a warning is among them); the strip marks the weeks of sprint 2 (WARNING: the plan has more) and of
  // sprint 3 (INFO: less) and no other week; the Flow section lists both lines with their buttons.
  await openTeamPage(page, world.teamId, world.team);
  await expect(headerFlag(page)).toHaveText("Capacity differs from Flow: 2 open differences");
  await expect(headerFlag(page)).toHaveAttribute("data-severity", "WARNING");
  for (const week of ["2047-01-21", "2047-01-28"]) await expect(stripCell(page, week), week).toHaveAttribute("data-flow-capacity", "WARNING");
  for (const week of ["2047-02-04", "2047-02-11"]) await expect(stripCell(page, week), week).toHaveAttribute("data-flow-capacity", "INFO");
  await expectUnmarked(page, ["2047-01-07", "2047-01-14"]);
  await expect(factsOf(page)).toContainText("Differs from Flow for 2 sprints");
  const lines = page.getByRole("list", { name: "Capacity differences from Flow" });
  const warningLine = lines.getByRole("listitem").filter({ hasText: sentence(more, more.plan, more.flow) });
  const infoLine = lines.getByRole("listitem").filter({ hasText: sentence(less, less.plan, less.flow) });
  await expect(warningLine).toContainText("Warning:");
  await expect(infoLine).toContainText("Info:");
  await expect(acknowledgeButton(warningLine, more.name)).toBeVisible();
  await expect(acknowledgeButton(infoLine, less.name)).toBeVisible();
  // The Weekly load table, behind its disclosure, says the same in words: "Differs from Flow" on the four weeks.
  await page.getByRole("button", { name: "Show the weekly figures" }).click();
  await expect(page.locator('[data-flow-badge="WARNING"]')).toHaveCount(2);
  await expect(page.locator('[data-flow-badge="INFO"]')).toHaveCount(2);

  // Acknowledge sprint 3 (the INFO): the line reads who and when, the fact counts one open difference and one acknowledged, the flag counts one, and the INFO weeks lose their mark (sprint 2's stay).
  await acknowledgeButton(page, less.name).click();
  await expect(infoLine).toContainText(new RegExp(`Acknowledged by ${world.managerPerson} on `));
  await expect(unacknowledgeButton(infoLine, less.name)).toBeVisible();
  await expect(factsOf(page)).toContainText("Differs from Flow for 1 sprint");
  await expect(factsOf(page)).toContainText("1 acknowledged");
  await expect(headerFlag(page)).toHaveText("Capacity differs from Flow: 1 open difference");
  await expectUnmarked(page, ["2047-02-04", "2047-02-11"]);
  for (const week of ["2047-01-21", "2047-01-28"]) await expect(stripCell(page, week), week).toHaveAttribute("data-flow-capacity", "WARNING");
  await expect(acknowledgeButton(warningLine, more.name)).toBeVisible();

  // The page in this state (the header flag, the strip's marks, the dimmed acknowledged badge and its line) passes axe, light and dark.
  await scanBothSchemes(page, `/teams/${world.teamId}`, async () => {
    await expect(headerFlag(page)).toHaveText("Capacity differs from Flow: 1 open difference");
    await expect(unacknowledgeButton(page, less.name)).toBeVisible();
  });
});

test("the Deviations page lists the acknowledged sprint under Status Acknowledged only, the team gone from Flow is acknowledged too, and withdrawing reopens the line", async ({ page }) => {
  const { more, less } = daySprints();
  const manager = await apiAsManager();
  try {
    await withdrawAll(manager, world.teamId);
    await withdrawAll(manager, world.goneTeamId);
    await acknowledgeViaApi(manager, world.teamId, less.id);
  } finally {
    await manager.dispose();
  }
  await login(page); // the seed administrator: ADMIN acknowledges any team's rows

  // Open (a team scope implies "all", so the Open list is `all=false`): sprint 2 only; the totals count the open rows and the one acknowledged.
  await openDeviations(page, world.teamId, "&all=false");
  let row = rowOf(page, world.team);
  await expect(row.getByRole("listitem")).toHaveCount(1);
  await expect(row).toContainText(sentence(more, more.plan, more.flow));
  await expect(row).not.toContainText(sentence(less, less.plan, less.flow));
  await expect(totalsOf(page).getByText("1 warning", { exact: true })).toBeVisible();
  await expect(totalsOf(page).getByText("0 infos", { exact: true })).toBeVisible();
  await expect(totalsOf(page).getByText("1 acknowledged", { exact: true })).toBeVisible();

  // Status Acknowledged lists sprint 3 alone, with the sentence, who acknowledged it and the way back.
  await openFilters(page);
  await page.getByRole("combobox", { name: "Status" }).click();
  await page.getByRole("option", { name: "Acknowledged", exact: true }).click();
  row = rowOf(page, world.team);
  await expect(row.getByRole("listitem")).toHaveCount(1);
  await expect(row).toContainText(sentence(less, less.plan, less.flow));
  await expect(row).toContainText("Acknowledged by");
  await expect(unacknowledgeButton(row, less.name)).toBeVisible();
  await expect(row).not.toContainText(sentence(more, more.plan, more.flow));

  // Status All lists both lines, the open one with its Acknowledge button and the acknowledged one with its Unacknowledge.
  await page.getByRole("combobox", { name: "Status" }).click();
  await page.getByRole("option", { name: "All", exact: true }).click();
  row = rowOf(page, world.team);
  await expect(row.getByRole("listitem")).toHaveCount(2);
  await expect(acknowledgeButton(row, more.name)).toBeVisible();
  await expect(unacknowledgeButton(row, less.name)).toBeVisible();

  // The team gone from Flow has ONE row, its own, with an Acknowledge: acknowledged, it stays listed (a team scope lists everything), stops counting as a warning and counts as acknowledged.
  await openDeviations(page, world.goneTeamId);
  const gone = rowOf(page, world.goneTeam);
  await expect(gone).toContainText("The Flow team is no longer in Flow's document");
  await expect(totalsOf(page).getByText("1 warning", { exact: true })).toBeVisible();
  await acknowledgeButton(gone, "the team's own row").click();
  await expect(gone).toContainText("Acknowledged by");
  await expect(unacknowledgeButton(gone, "the team's own row")).toBeVisible();
  await expect(totalsOf(page).getByText("0 warnings", { exact: true })).toBeVisible();
  await expect(totalsOf(page).getByText("1 acknowledged", { exact: true })).toBeVisible();

  // Back on the first team under Acknowledged: withdrawing sprint 3's acknowledgement takes it off that list; under Open it is back next to sprint 2 and nothing is acknowledged.
  await openDeviations(page, world.teamId, "&acknowledged=true");
  row = rowOf(page, world.team);
  await expect(row).toContainText(sentence(less, less.plan, less.flow));
  await unacknowledgeButton(row, less.name).click();
  await expect(rowOf(page, world.team)).toHaveCount(0);
  await openDeviations(page, world.teamId, "&all=false");
  row = rowOf(page, world.team);
  await expect(row.getByRole("listitem")).toHaveCount(2);
  await expect(row).toContainText(sentence(less, less.plan, less.flow));
  await expect(acknowledgeButton(row, less.name)).toBeVisible();
  await expect(totalsOf(page).getByText("1 warning", { exact: true })).toBeVisible();
  await expect(totalsOf(page).getByText("1 info", { exact: true })).toBeVisible();
  await expect(totalsOf(page).getByText("0 acknowledged", { exact: true })).toBeVisible();
});

test("a capacity change in the plan reopens only the sprint it touches", async ({ page }) => {
  const { more, less } = daySprints();
  const manager = await apiAsManager();
  try {
    await withdrawAll(manager, world.teamId);
  } finally {
    await manager.dispose();
  }
  await login(page, world.manager.email, world.manager.password);

  // The manager acknowledges BOTH lines on the team page: no open difference remains, so the fact says so (never "In line with Flow"), the header has no flag and no week is marked.
  await openTeamPage(page, world.teamId, world.team);
  const lines = page.getByRole("list", { name: "Capacity differences from Flow" });
  const warningLine = lines.getByRole("listitem").filter({ hasText: sentence(more, more.plan, more.flow) });
  const infoLine = lines.getByRole("listitem").filter({ hasText: sentence(less, less.plan, less.flow) });
  await acknowledgeButton(warningLine, more.name).click();
  await expect(warningLine).toContainText(new RegExp(`Acknowledged by ${world.managerPerson} on `));
  await acknowledgeButton(infoLine, less.name).click();
  await expect(infoLine).toContainText(new RegExp(`Acknowledged by ${world.managerPerson} on `));
  await expect(factsOf(page)).toContainText("No open difference");
  await expect(factsOf(page)).toContainText("2 acknowledged");
  await expect(factsOf(page)).not.toContainText("In line with Flow");
  await expect(headerFlag(page)).toHaveCount(0);
  await expect(page.locator("[data-flow-capacity]")).toHaveCount(0);

  // The manager edits the plan's capacity for sprint 3: one man-day a week more than the import's day-one figure (the plan holds `less.plan` over the sprint's two weeks, so `less.plan / 2 + 1` a week and `less.plan + 2` over it), still below Flow's day-two figure (`less.flow`, 24 a week): the plan then differs by `less.flow - (less.plan + 2)` man-days, and that sprint's figures have changed.
  const editedWeekly = less.plan / 2 + 1;
  const editedTotal = less.plan + 2;
  const api = await apiAsManager();
  try {
    const periods = await api.get(`/api/v1/teams/${world.teamId}/capacity`);
    expect(periods.status(), await periods.text()).toBe(200);
    const period = ((await periods.json()) as { items: { id: number; effectiveFrom: string }[] }).items.find((item) => item.effectiveFrom === less.start);
    expect(period, `the import wrote the period starting ${less.start}`).toBeDefined();
    const edited = await api.put(`/api/v1/capacity-periods/${period?.id}`, { data: { effectiveFrom: less.start, mdPerWeek: editedWeekly } });
    expect(edited.status(), await edited.text()).toBe(204);
  } finally {
    await api.dispose();
  }

  // Re-read: sprint 3 reads "changed since" and is open again (with its new figures, the fact, the flag and the marks); sprint 2 is untouched and stays acknowledged.
  await openTeamPage(page, world.teamId, world.team);
  const changedLine = lines.getByRole("listitem").filter({ hasText: sentence(less, editedTotal, less.flow) });
  await expect(changedLine).toContainText(new RegExp(`Acknowledged on .+ by ${world.managerPerson} · changed since`));
  await expect(acknowledgeButton(changedLine, less.name)).toBeVisible();
  const quietLine = lines.getByRole("listitem").filter({ hasText: sentence(more, more.plan, more.flow) });
  await expect(quietLine).toContainText(new RegExp(`Acknowledged by ${world.managerPerson} on `));
  await expect(unacknowledgeButton(quietLine, more.name)).toBeVisible();
  await expect(factsOf(page)).toContainText("Differs from Flow for 1 sprint");
  await expect(factsOf(page)).toContainText("1 acknowledged");
  await expect(headerFlag(page)).toHaveText("Capacity differs from Flow: 1 open difference");
  await expect(headerFlag(page)).toHaveAttribute("data-severity", "INFO");
  for (const week of ["2047-02-04", "2047-02-11"]) await expect(stripCell(page, week), week).toHaveAttribute("data-flow-capacity", "INFO");
  await expectUnmarked(page, ["2047-01-21", "2047-01-28"]);
});

/** Puts sprint 3's capacity period back to the day-one import's figure (the previous scenario raised it by one man-day a week), so the sentences below read the day-two figures. */
async function restoreSprintThreeCapacity(api: APIRequestContext): Promise<void> {
  const { less } = daySprints();
  const periods = await api.get(`/api/v1/teams/${world.teamId}/capacity`);
  expect(periods.status(), await periods.text()).toBe(200);
  const period = ((await periods.json()) as { items: { id: number; effectiveFrom: string }[] }).items.find((item) => item.effectiveFrom === less.start);
  expect(period, `the import wrote the period starting ${less.start}`).toBeDefined();
  const restored = await api.put(`/api/v1/capacity-periods/${period?.id}`, { data: { effectiveFrom: less.start, mdPerWeek: less.plan / 2 } });
  expect(restored.status(), await restored.text()).toBe(204);
}

test("the team's manager acknowledges every open difference of the team in one click", async ({ page }) => {
  const { more, less } = daySprints();
  const manager = await apiAsManager();
  try {
    await restoreSprintThreeCapacity(manager);
    await withdrawAll(manager, world.teamId);
  } finally {
    await manager.dispose();
  }
  await login(page, world.manager.email, world.manager.password);

  // Nothing acknowledged: two open differences, so the list's head offers ONE button for both (its visible text carries the count, its accessible name the team).
  const allButton = page.getByRole("button", { name: `Acknowledge all (2) open differences of ${world.team}`, exact: true });
  await openTeamPage(page, world.teamId, world.team);
  await expect(headerFlag(page)).toHaveText("Capacity differs from Flow: 2 open differences");
  await expect(allButton).toBeVisible();
  await expect(allButton).toHaveText("Acknowledge all (2)");

  // The page in this state (the batch button beside two open lines) passes axe, light and dark.
  await scanBothSchemes(page, `/teams/${world.teamId}`, async () => {
    await expect(allButton).toBeVisible();
  });

  // One click: both lines read who and when with their Unacknowledge, the fact says no difference is open and counts the two acknowledged, the header flag is gone and so is the button.
  await allButton.click();
  const lines = page.getByRole("list", { name: "Capacity differences from Flow" });
  const warningLine = lines.getByRole("listitem").filter({ hasText: sentence(more, more.plan, more.flow) });
  const infoLine = lines.getByRole("listitem").filter({ hasText: sentence(less, less.plan, less.flow) });
  await expect(warningLine).toContainText(new RegExp(`Acknowledged by ${world.managerPerson} on `));
  await expect(infoLine).toContainText(new RegExp(`Acknowledged by ${world.managerPerson} on `));
  await expect(unacknowledgeButton(warningLine, more.name)).toBeVisible();
  await expect(unacknowledgeButton(infoLine, less.name)).toBeVisible();
  await expect(factsOf(page)).toContainText("No open difference");
  await expect(factsOf(page)).toContainText("2 acknowledged");
  await expect(headerFlag(page)).toHaveCount(0);
  await expect(page.locator("[data-flow-capacity]")).toHaveCount(0);
  await expect(allButton).toHaveCount(0);
});

test("the team's manager withdraws every acknowledgement of the team in one click", async ({ page }) => {
  const { more, less } = daySprints();
  const manager = await apiAsManager();
  try {
    await restoreSprintThreeCapacity(manager);
    await withdrawAll(manager, world.teamId);
    await acknowledgeViaApi(manager, world.teamId, more.id);
    await acknowledgeViaApi(manager, world.teamId, less.id);
  } finally {
    await manager.dispose();
  }
  await login(page, world.manager.email, world.manager.password);

  // Both sprints are acknowledged: the list's head offers ONE button for both (visible text with the count, accessible name with the team), and no open difference remains.
  const withdrawButton = page.getByRole("button", { name: `Withdraw all (2) acknowledged differences of ${world.team}`, exact: true });
  await openTeamPage(page, world.teamId, world.team);
  await expect(factsOf(page)).toContainText("No open difference");
  await expect(headerFlag(page)).toHaveCount(0);
  await expect(withdrawButton).toBeVisible();
  await expect(withdrawButton).toHaveText("Withdraw all (2)");
  await expect(page.getByRole("button", { name: /^Acknowledge all/ })).toHaveCount(0);

  // One click: both lines are open again with their Acknowledge buttons, the fact counts two open differences, the header flag is back and so are the marked weeks; the button gives way to Acknowledge all.
  await withdrawButton.click();
  const lines = page.getByRole("list", { name: "Capacity differences from Flow" });
  const warningLine = lines.getByRole("listitem").filter({ hasText: sentence(more, more.plan, more.flow) });
  const infoLine = lines.getByRole("listitem").filter({ hasText: sentence(less, less.plan, less.flow) });
  await expect(acknowledgeButton(warningLine, more.name)).toBeVisible();
  await expect(acknowledgeButton(infoLine, less.name)).toBeVisible();
  await expect(lines).not.toContainText("Acknowledged by");
  await expect(factsOf(page)).toContainText("Differs from Flow for 2 sprints");
  await expect(headerFlag(page)).toHaveText("Capacity differs from Flow: 2 open differences");
  await expect(page.locator("[data-flow-capacity]")).not.toHaveCount(0);
  await expect(withdrawButton).toHaveCount(0);
  await expect(page.getByRole("button", { name: `Acknowledge all (2) open differences of ${world.team}`, exact: true })).toBeVisible();
});

test("an acknowledged sprint that comes back in line loses its acknowledgement, so the same difference is open when it returns", async ({ page }) => {
  const { more, less } = daySprints();
  const manager = await apiAsManager();
  try {
    await restoreSprintThreeCapacity(manager);
    await withdrawAll(manager, world.teamId);
    await acknowledgeViaApi(manager, world.teamId, less.id);
  } finally {
    await manager.dispose();
  }
  const { api } = await apiAsAdmin();
  try {
    // Day one again (the stub at `Started`) and the connection read: every sprint is in line, so the team has no row and sprint 3's acknowledgement - its row left the list - is deleted with it.
    await setStubState("Started"); // day one: already the state the beforeAll leaves before its flip, set again so this scenario does not depend on it
    await refreshFlowConnectionViaApi(api, world.connection.id);
    const inLine = await api.get(`/api/v1/views/capacity-deviations?teamId=${world.teamId}`);
    expect(inLine.status(), await inLine.text()).toBe(200);
    expect(((await inLine.json()) as { items: unknown[] }).items, "day one: the team is in line, so the view lists no item for it").toEqual([]);
    // Day two again and the connection read once more: the SAME difference returns.
    try {
      await setStubState(flowStub().scenarios.day2State);
      await refreshFlowConnectionViaApi(api, world.connection.id);
    } finally {
      await setStubState("Started"); // the mirror holds day two, as the beforeAll leaves it
    }
    const { rows } = await rowsOf(api, world.teamId);
    const returned = rows.find((row) => row.detail.sprintId === less.id);
    expect(returned, "sprint 3's row is listed again on day two").toBeDefined();
    expect(returned?.acknowledgement ?? null, "sprint 3's acknowledgement went when the sprint came back in line").toBeNull();
  } finally {
    await api.dispose();
  }
  await login(page, world.manager.email, world.manager.password);

  // Sprint 3 reads the same sentence as before (the plan has 44.00, Flow 48.00), open: no "Acknowledged by", the Acknowledge button back; sprint 2 is open beside it.
  await openTeamPage(page, world.teamId, world.team);
  const lines = page.getByRole("list", { name: "Capacity differences from Flow" });
  const infoLine = lines.getByRole("listitem").filter({ hasText: sentence(less, less.plan, less.flow) });
  await expect(infoLine).toBeVisible();
  await expect(infoLine).not.toContainText("Acknowledged");
  await expect(acknowledgeButton(infoLine, less.name)).toBeVisible();
  await expect(acknowledgeButton(lines.getByRole("listitem").filter({ hasText: sentence(more, more.plan, more.flow) }), more.name)).toBeVisible();
  await expect(factsOf(page)).toContainText("Differs from Flow for 2 sprints");
  await expect(headerFlag(page)).toHaveText("Capacity differs from Flow: 2 open differences");
});
