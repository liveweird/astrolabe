// The capacity deviation (v1.6), against the compose stack's Flow STUB (WireMock; the app reaches it as `E2E_FLOW_STUB_ORIGIN`, the spec flips its `flow-day2` scenario through `E2E_FLOW_STUB_URL`):
// a team linked to the stub's "E2E Flow Team" with no capacity period reads "N sprints without capacity in the plan" on the Deviations page's "Capacity from Flow" section and on the team
// page, importing the capacity (the manager, through the API) brings it in line, and after the stub's day two (sprint 2 36 -> 30 man-days, sprint 3 44 -> 48) the same team has MORE capacity than
// Flow for one sprint (the warning) and LESS for another (the info) while a team linked to the Flow team that left Flow's document ("Billing") reads gone. "E2E Flow Team" is dated in 2047 (six
// two-week sprints from Monday 2047-01-07, ten working days each), which nothing writes a holiday in. Every figure is read from `sample-data/flow/expected.json` (`flowStub()`), never copied.
// Owns: ONE Flow connection (`e2e-capdev-connection-*`, manual only, made through the API and tested + refreshed in the beforeAll: one call of the per-IP `flow-test` bucket per worker start),
// a throwaway world (a team-manager login and its person, the team `e2e-capdev-team-*` linked to "E2E Flow Team" and the team `e2e-capdev-gone-*` linked to the stub's "Billing", both through that
// connection, so the Flow-team uniqueness of no other spec's connection is ever met), the six capacity periods the import writes (they go with the team) and the stub's `flow-day2` SCENARIO,
// which this file flips (as does `flow-capacity-acknowledge.spec.ts`: the stub is one process with one state). It holds the Playwright lock `flow-stub-scenario` with `flow-sync.spec.ts`, whose figures are day one's, and with that spec; the beforeAll
// puts the scenario back to `Started` and the afterAll does so even after a failure. Everything is removed through the API (the connection first - the links go with it - then the teams, the person
// and the user). The section lists EVERY linked team of the stack, so each page is narrowed to the spec's own team with the `teamId` filter and every assertion is about that team's rows.
import { randomUUID } from "node:crypto";
import { type APIRequestContext, type Page, request as playwrightRequest } from "@playwright/test";
import { BASE_URL } from "../playwright.config";
import {
  apiAsAdmin,
  apiAsThrowawayAdmin,
  axeViolations,
  bindFlowTeamViaApi,
  deleteViaApi,
  expect,
  expectFlowStubOnDayOne,
  expectScheme,
  FLOW_STUB_URL,
  flowStub,
  login,
  refreshFlowConnectionViaApi,
  seedFlowConnection,
  test,
  testFlowConnectionViaApi,
  type ThrowawayAdmin,
  uniqueText,
} from "./helpers";

// One stub scenario state for the whole stack: this file and `flow-capacity-acknowledge` are the flippers, each serial, and every Flow spec takes the lock (`flow-sync` asserts day one's figures).
test.describe.configure({ mode: "serial", lock: "flow-stub-scenario", timeout: 120_000 });

const E2E_TEAM = flowStub().e2e.team;
const GONE_TEAM = flowStub().day2.gone[0];
/** The en dash of "(2047-01-21 – 2047-02-01)" and the em dash of "Flow 30.00 — 6.00 more in the plan" in the sentences. */
const EN_DASH = "–";
const EM_DASH = "—";

interface Account {
  email: string;
  password: string;
}

interface World {
  manager: Account;
  team: string;
  teamId: number;
  teamBindingId: number;
  goneTeam: string;
  goneTeamId: number;
  connection: { id: number; name: string };
}

let world: World;
// Registered in creation order; deleted in reverse - the connection (created last) goes first, then the teams, the person and the user.
const teardown: string[] = [];

async function create(api: APIRequestContext, path: string, data: object): Promise<number> {
  const response = await api.post(path, { data });
  expect(response.status(), await response.text()).toBe(201);
  const id = ((await response.json()) as { id: number }).id;
  teardown.push(`${path}/${id}`);
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

// The administrator that asks for the file's runs: a run rides a per-user bucket, so the file asks as its own account, not the seed administrator's.
let runner: ThrowawayAdmin;
test.beforeAll(async () => {
  test.setTimeout(180_000); // the Test connection call may wait a 429 out (one minute)
  await setStubState("Started"); // a crashed earlier run may have left day two on; day one's figures are what this file starts from
  await expectFlowStubOnDayOne(); // ... and the other scenario (an outage left by a manual walk) is not ours to reset
  runner = await apiAsThrowawayAdmin("e2e-capdev-runner");
  const { api } = await apiAsAdmin();
  try {
    const name = uniqueText("e2e-capdev-manager");
    const account = { email: `${name.toLowerCase()}@astrolabe.local`, password: randomUUID().replace(/-/g, "") };
    const userId = await create(api, "/api/v1/users", { name, email: account.email, password: account.password });
    const person = await create(api, "/api/v1/people", { name: uniqueText("e2e-capdev-managerperson"), userId });
    const team = uniqueText("e2e-capdev-team");
    const teamId = await create(api, "/api/v1/teams", { name: team, managerPersonId: person });
    const goneTeam = uniqueText("e2e-capdev-gone");
    const goneTeamId = await create(api, "/api/v1/teams", { name: goneTeam, managerPersonId: person });
    // The connection both teams are linked through: tested once (one call of the per-IP `flow-test` bucket) and read once, so its mirror holds the stub's day-one document.
    const connectionName = uniqueText("e2e-capdev-connection");
    const connectionId = await seedFlowConnection(api, connectionName, teardown);
    await testFlowConnectionViaApi(api, connectionId);
    await refreshFlowConnectionViaApi(runner.api, connectionId);
    const teamBindingId = await bindFlowTeamViaApi(api, connectionId, teamId, E2E_TEAM);
    await bindFlowTeamViaApi(api, connectionId, goneTeamId, GONE_TEAM);
    world = { manager: account, team, teamId, teamBindingId, goneTeam, goneTeamId, connection: { id: connectionId, name: connectionName } };
  } finally {
    await api.dispose();
  }
});
test.afterAll(async () => {
  try {
    await deleteViaApi(teardown.splice(0).reverse());
  } finally {
    try {
      await runner?.dispose();
    } finally {
      await setStubState("Started");
    }
  }
});

/** An API context signed in as the throwaway team manager (no administrator right): the import's preview and apply are the team's manager's. */
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

/** Imports the team's capacity when it holds none yet (the first scenario did it, or this one runs alone). */
async function ensureImported(): Promise<void> {
  const api = await apiAsManager();
  try {
    const periods = await api.get(`/api/v1/teams/${world.teamId}/capacity`);
    expect(periods.status(), await periods.text()).toBe(200);
    if (((await periods.json()) as { items: unknown[] }).items.length === 0) await importCapacity(api);
  } finally {
    await api.dispose();
  }
}

/** The Deviations page narrowed to one team (and optionally one severity): the "Capacity from Flow" section is the only part this spec reads. */
async function openDeviations(page: Page, teamId: number, severity?: "WARNING" | "INFO"): Promise<void> {
  const narrowing = severity === undefined ? "" : `&severity=${severity}`;
  await page.goto(`/deviations?teamId=${teamId}${narrowing}`);
  await expect(page.getByRole("heading", { level: 2, name: "Deviations" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 3, name: "Capacity from Flow" })).toBeVisible();
}

const capacityTable = (page: Page) => page.getByRole("table", { name: "Capacity differences between the plan and Flow" });
const rowOf = (page: Page, team: string) => capacityTable(page).getByRole("row").filter({ has: page.getByRole("link", { name: `Open team ${team}` }) });
/** The totals badges under "Differences from Flow" (the section's own group). */
const totalsOf = (page: Page) => page.getByRole("group", { name: "Differences from Flow" });
/** The "Link to Flow" facts of the team page (the "Capacity vs Flow" row among them). */
const factsOf = (page: Page) => page.getByRole("table", { name: "Link to Flow" });

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

/** A man-days figure as the sentences print it: two decimals. */
const md = (value: number): string => value.toFixed(2);

test("the Deviations page lists the sprints a linked team has no capacity for, and importing the capacity brings it in line", async ({ page }) => {
  const { preview } = flowStub().e2e;
  const first = preview[0];
  await login(page, world.manager.email, world.manager.password);

  // Before any import the team has no capacity period at all: every current or future sprint of its Flow team is a sprint without capacity, folded into ONE line.
  await openDeviations(page, world.teamId);
  const sources = page.getByRole("table", { name: "Data from Flow" });
  await expect(sources.getByRole("row").filter({ hasText: world.connection.name })).toContainText("Current");
  const row = rowOf(page, world.team);
  await expect(row).toContainText(E2E_TEAM);
  await expect(row).toContainText(`${preview.length} sprints without capacity in the plan (from ${first.start})`);
  await expect(row).toContainText("Info:");
  await expect(totalsOf(page).getByText("0 warnings", { exact: true })).toBeVisible();
  await expect(totalsOf(page).getByText(`${preview.length} infos`, { exact: true })).toBeVisible();
  // The sprints themselves are a table behind the line's disclosure: Flow's name, the dates and Flow's figure of each.
  await row.getByRole("button", { name: "Show the sprints" }).click();
  const sprints = row.getByRole("table", { name: "Sprints without capacity in the plan" });
  for (const sprint of preview) {
    const cells = sprints.getByRole("row").filter({ has: page.getByText(sprint.name, { exact: true }) }).getByRole("cell");
    await expect(cells.nth(1), sprint.name).toHaveText(`${sprint.start} ${EN_DASH} ${sprint.end}`);
    await expect(cells.nth(2), sprint.name).toHaveText(md(sprint.flowMd));
  }

  // The team page says the same in its Flow section's facts.
  await openTeamPage(page, world.teamId, world.team);
  await expect(factsOf(page)).toContainText("Capacity vs Flow");
  await expect(factsOf(page)).toContainText(`No capacity in the plan for ${preview.length} sprints`);

  // The section with rows passes axe, light and dark (the sprints' table open, as it stands after the clicks above is a new page load: open it again).
  await scanBothSchemes(page, `/deviations?teamId=${world.teamId}`, async () => {
    await expect(page.getByRole("heading", { level: 3, name: "Capacity from Flow" })).toBeVisible();
    await rowOf(page, world.team).getByRole("button", { name: "Show the sprints" }).click();
    await expect(rowOf(page, world.team).getByRole("table", { name: "Sprints without capacity in the plan" })).toBeVisible();
  });

  // The manager (no administrator right) imports the capacity, as the modal does through the API: every row is created.
  const api = await apiAsManager();
  try {
    await importCapacity(api);
  } finally {
    await api.dispose();
  }

  // In line: the team is no longer listed (this page is narrowed to it, so the section says that no difference matches), the totals are zero, and the team page says so in green text.
  await openDeviations(page, world.teamId);
  await expect(page.getByText("No capacity difference matches the filters.")).toBeVisible();
  await expect(rowOf(page, world.team)).toHaveCount(0);
  await expect(totalsOf(page).getByText("0 warnings", { exact: true })).toBeVisible();
  await expect(totalsOf(page).getByText("0 infos", { exact: true })).toBeVisible();
  await openTeamPage(page, world.teamId, world.team);
  await expect(factsOf(page).getByText("In line with Flow", { exact: true })).toBeVisible();
  await expect(factsOf(page)).not.toContainText("No capacity in the plan");
});

test("after the stub's day two the imported team has more capacity than Flow for one sprint and less for another, and a team whose Flow team vanished reads gone", async ({ page }) => {
  const { preview } = flowStub().e2e;
  const changes = flowStub().day2.capacityChanges.filter((change) => change.team === E2E_TEAM);
  const more = changes.find((change) => change.from > change.to);
  const less = changes.find((change) => change.from < change.to);
  expect(more, "expected.json: a day-two sprint of the E2E team that loses Flow capacity").toBeDefined();
  expect(less, "expected.json: a day-two sprint of the E2E team that gains Flow capacity").toBeDefined();
  if (more === undefined || less === undefined) return;
  /** The sentence of a changed sprint as the page words it: the plan still holds the day-one figure (`from`), Flow now says `to`. */
  const sentence = (change: typeof more) => {
    const sprint = preview.find((candidate) => candidate.sprintId === change.sprintId);
    expect(sprint, `expected.json lists the sprint ${change.sprintId}`).toBeDefined();
    const gap = Math.abs(change.from - change.to);
    return `${change.name} (${sprint?.start} ${EN_DASH} ${sprint?.end}): the plan has ${md(change.from)} man-days, Flow ${md(change.to)} ${EM_DASH} ${md(gap)} ${change.from > change.to ? "more" : "less"} in the plan`;
  };

  await ensureImported();
  // Day two: Flow lowers one sprint and raises another, and drops "Billing" from its document. The flip is undone as soon as the mirror has read it (and the afterAll does it again).
  await setStubState(flowStub().scenarios.day2State);
  try {
    await refreshFlowConnectionViaApi(runner.api, world.connection.id);
  } finally {
    await setStubState("Started");
  }
  await login(page, world.manager.email, world.manager.password);

  // The imported team: the WARNING (the plan has more) first, then the INFO (less), both worded with Flow's own sprint names, and nothing else.
  await openDeviations(page, world.teamId);
  const row = rowOf(page, world.team);
  await expect(row.getByRole("listitem")).toHaveCount(2);
  const warning = row.getByRole("listitem").filter({ hasText: sentence(more) });
  await expect(warning).toContainText("Warning:");
  await expect(warning).toContainText("Capacity");
  const info = row.getByRole("listitem").filter({ hasText: sentence(less) });
  await expect(info).toContainText("Info:");
  await expect(row.getByRole("listitem").first()).toContainText(sentence(more));
  await expect(totalsOf(page).getByText("1 warning", { exact: true })).toBeVisible();
  await expect(totalsOf(page).getByText("1 info", { exact: true })).toBeVisible();

  // The severity filter in the URL drops the info row (the team's rows are narrowed, not only the team).
  await openDeviations(page, world.teamId, "WARNING");
  await expect(rowOf(page, world.team).getByRole("listitem")).toHaveCount(1);
  await expect(rowOf(page, world.team)).toContainText(sentence(more));
  await expect(rowOf(page, world.team)).not.toContainText(sentence(less));
  await expect(totalsOf(page).getByText("0 infos", { exact: true })).toBeVisible();

  // The team that was linked to the vanished Flow team: one sentence, a warning, counted among the gone.
  await openDeviations(page, world.goneTeamId);
  const gone = rowOf(page, world.goneTeam);
  await expect(gone).toContainText(GONE_TEAM);
  await expect(gone).toContainText("The Flow team is no longer in Flow's document");
  await expect(gone).toContainText("Warning:");
  await expect(gone).toContainText("Gone from Flow");
  await expect(totalsOf(page).getByText("1 warning", { exact: true })).toBeVisible();
  await expect(totalsOf(page).getByText("of which 1 team gone from Flow", { exact: true })).toBeVisible();

  // The team page of the imported team: one orange badge counting the two sprints, and the sentences under the facts.
  await openTeamPage(page, world.teamId, world.team);
  await expect(factsOf(page)).toContainText("Capacity vs Flow");
  await expect(factsOf(page)).toContainText("Differs from Flow for 2 sprints");
  const lines = page.getByRole("list", { name: "Capacity differences from Flow" });
  await expect(lines).toContainText(sentence(more));
  await expect(lines).toContainText(sentence(less));
  // ... and the gone team's page tells it once, by the panel's own badge (the comparison adds no second one).
  await openTeamPage(page, world.goneTeamId, world.goneTeam);
  await expect(page.getByText("No longer in Flow", { exact: true })).toBeVisible();
  await expect(factsOf(page)).not.toContainText("Capacity vs Flow");

  // The section with a warning, an info and a gone team passes axe, light and dark.
  await scanBothSchemes(page, `/deviations?teamId=${world.teamId}`, async () => {
    await expect(rowOf(page, world.team).getByRole("listitem")).toHaveCount(2);
  });
  await scanBothSchemes(page, `/deviations?teamId=${world.goneTeamId}`, async () => {
    await expect(rowOf(page, world.goneTeam)).toContainText("The Flow team is no longer in Flow's document");
  });
});
