// Import from Jira (v1.2), against the compose stack's Jira STUB and its isolated `IMP` project (a Program, two Initiatives, six Epics, every date in 2045):
// an administrator imports the tree into a throwaway work stream through the connection page's modal (scope, preview, import), finds the milestones
// dated in the project view and a second preview offering nothing; unticking a parent unticks what is created under it; a skipped row says how to fix
// it (a default project); the modal's three steps pass an axe scan, light and dark; so does a five-key preview of about 1,100 rows (the virtualised table) and so
// does the outcome's skipped-rows table, made to appear by a plan row created through the API between the preview and the apply (IMP-8 turns CHANGED);
// and a NON-admin who owns a throwaway work stream imports from the Plan page's work-stream menu (1.10; the connection picked from the deviations view's list).
// 1.13.2 adds the import filter (the dialog opens with "Leave out done items" on and 365 days): the IMP scenarios run under those defaults, the 1,100-row preview
// switches the filter off, and the stub's `IMF` project (done and quiet items, a two-round chain of left-out parents, a parent the connection cannot read) is
// previewed and imported at the defaults and previewed with the filter off or half off.
// Owns: ONE Jira connection (`e2e-import-connection-*`, scoped to the stub's `IMP` project on a unique throwaway site, tested once in the beforeAll; the
// five-key preview test makes, tests and deletes one more, `e2e-import-scale-*`, and never imports through it; each IMF filter test does the same with an
// `e2e-import-filter-*` scoped to `IMF`, the first importing through its own. Test
// connection shares a per-IP bucket (10 a minute by default, 30 on the e2e stacks) with the other Jira specs) and, per test, an administrator login (the preview and the apply share a
// 5-a-minute bucket PER USER, so a throwaway login keeps every test inside it), a person, a team, a work stream (unique `e2e-import-*` names) and what
// the import creates under that stream - the stub's own names, "IMP Program", "IMP Initiative Alpha/Beta" and the epics. Program names are global, so
// this is the only spec that may import `IMP` or `IMF` ("IMF Program", "IMF Program Old"), and it holds the Playwright lock `jira-import-stub`. Nothing here ever applies into an existing work
// stream, and the dates are the stub's (2045): 2045-01-06 (IMP-4's end) is Polish Epiphany, harmless while no spec loads 2045 holidays.
// Teardown (afterEach, even after a failure, through the API): the test's bindings, then its projects (their milestones go with them), programs, work
// stream, team, person and login; the afterAll deletes the connection. The beforeAll sweeps what a crashed earlier run left: connections named
// `e2e-import-*` and the trees of work streams named `e2e-import-*`. An "IMP Program" that is NOT under such a work stream is never touched - it may be
// the user's - and the run fails fast with that message instead.
import { randomUUID } from "node:crypto";
import { type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { apiAsAdmin, axeViolations, deleteViaApi, expect, expectScheme, login, test, testJiraConnectionViaApi, uniqueText, type Scheme } from "./helpers";

// The stub's IMP project is one shared fixture and "IMP Program" a global name: copies of this file (a `--repeat-each` run) take turns. The lock is
// all it does - no other spec imports `IMP`. The timeout leaves the longest inner wait (the apply's 60 s) room to fire before the test's own.
test.describe.configure({ lock: "jira-import-stub", timeout: 120_000 });

const MARK = "e2e-import-";
const PROGRAM_NAME = "IMP Program";
/** The program names the stub's two imported projects create (global names): the guard fails fast on any of them under a work stream that is not ours. */
const STUB_PROGRAM_NAMES = [PROGRAM_NAME, "IMF Program", "IMF Program Old"];

interface Account {
  email: string;
  password: string;
}

interface World {
  /** The login the test signs in as: a throwaway ADMIN in `seedWorld`, a throwaway non-admin stream owner in `seedOwnerWorld`. */
  admin: Account;
  ownerName: string;
  teamName: string;
  teamId: number;
  streamId: number;
  streamName: string;
}

interface PlanProject {
  id: number;
  name: string;
}
interface PlanProgram {
  id: number;
  name: string;
  projects: PlanProject[];
}
interface PlanStream {
  id: number;
  name: string;
  programs: PlanProgram[];
}

let connection: { id: number; name: string };
// Registered in creation order; deleted in reverse (the test's own rows, after the walk of the stream's tree).
const teardown: string[] = [];
let streamId: number | undefined;
// The connections of the running test that hold bindings besides the file's own (the IMF test's): their bindings are removed before the stream's tree.
const extraConnectionIds: number[] = [];

async function create(api: APIRequestContext, path: string, data: object, tear: string): Promise<number> {
  const response = await api.post(path, { data });
  expect(response.status(), await response.text()).toBe(201);
  const id = ((await response.json()) as { id: number }).id;
  teardown.push(`${tear}/${id}`);
  return id;
}

async function planStreams(api: APIRequestContext): Promise<PlanStream[]> {
  const response = await api.get("/api/v1/views/plan");
  expect(response.ok(), await response.text()).toBeTruthy();
  return ((await response.json()) as { workStreams: PlanStream[] }).workStreams;
}

/** The delete paths of a work stream's whole tree, children first: projects (milestones go with them), programs, the stream. */
const treePaths = (stream: PlanStream): string[] => [
  ...stream.programs.flatMap((program) => program.projects.map((project) => `/api/v1/projects/${project.id}`)),
  ...stream.programs.map((program) => `/api/v1/programs/${program.id}`),
  `/api/v1/work-streams/${stream.id}`,
];

/** Every row of a paged list (the registry endpoints answer at most 100 a page). */
async function listAll(api: APIRequestContext, path: string): Promise<{ id: number; name: string }[]> {
  const rows: { id: number; name: string }[] = [];
  for (let page = 1; ; page++) {
    const response = await api.get(`${path}${path.includes("?") ? "&" : "?"}page=${page}&pageSize=100`);
    expect(response.ok(), await response.text()).toBeTruthy();
    const body = (await response.json()) as { items: { id: number; name: string }[]; total: number };
    rows.push(...body.items);
    if (body.items.length === 0 || rows.length >= body.total) return rows;
  }
}

/**
 * Stale residue of a crashed run, found by the spec's own `e2e-import-` prefix and nothing else: the connections, the work-stream trees, then the teams,
 * people and logins (a stale row would otherwise be a second option for a picker). Then the guard that "IMP Program" is free (never deleting a program
 * that is not ours).
 */
async function sweepStale(api: APIRequestContext): Promise<void> {
  const ours = (rows: { id: number; name: string }[]) => rows.filter((row) => row.name.startsWith(MARK));
  await deleteViaApi(ours(await listAll(api, "/api/v1/integrations/jira/connections")).map((row) => `/api/v1/integrations/jira/connections/${row.id}`));
  await deleteViaApi((await planStreams(api)).filter((stream) => stream.name.startsWith(MARK)).flatMap(treePaths));
  await deleteViaApi(ours(await listAll(api, `/api/v1/teams?name=${MARK}`)).map((row) => `/api/v1/teams/${row.id}`));
  await deleteViaApi(ours(await listAll(api, `/api/v1/people?name=${MARK}`)).map((row) => `/api/v1/people/${row.id}`));
  await deleteViaApi(ours(await listAll(api, `/api/v1/users?name=${MARK}`)).map((row) => `/api/v1/users/${row.id}`));
  const names = STUB_PROGRAM_NAMES.map((name) => name.toLowerCase());
  const taken = (await planStreams(api)).find((stream) => stream.programs.some((program) => names.includes(program.name.trim().toLowerCase())));
  if (taken) {
    throw new Error(`a program named like one the stub's IMP or IMF import creates (${STUB_PROGRAM_NAMES.join(", ")}) exists under the work stream "${taken.name}", which this spec did not create: it is not touched, and the import cannot run until it is renamed or deleted`);
  }
}

// The one Test connection call (a shared per-IP bucket (10 a minute by default, 30 on the e2e stacks) across the suite) is spent once per WORKER START of this file, not once per run: a failed test
// restarts the worker and runs this again. A 429 waits the bucket out once.
test.beforeAll(async () => {
  test.setTimeout(180_000);
  const { api } = await apiAsAdmin();
  try {
    await sweepStale(api);
    const name = uniqueText(`${MARK}connection`);
    const site = `https://stub-e2eimport${randomUUID().replace(/-/g, "").slice(0, 12)}.atlassian.net`;
    const body = { name, siteUrl: site, email: "e2e-import@astrolabe.local", apiToken: "e2e-import-token", authScheme: "BASIC", projectKeys: ["IMP"], enabled: true, pollIntervalMinutes: null };
    const response = await api.post("/api/v1/integrations/jira/connections", { data: body });
    expect(response.status(), await response.text()).toBe(201);
    connection = { id: ((await response.json()) as { id: number }).id, name };
    await testJiraConnectionViaApi(api, connection.id);
  } finally {
    await api.dispose();
  }
});
test.afterAll(async () => {
  if (connection) await deleteViaApi([`/api/v1/integrations/jira/connections/${connection.id}`]);
});

test.afterEach(async () => {
  let api: APIRequestContext | undefined;
  const paths: string[] = [];
  try {
    ({ api } = await apiAsAdmin());
    // The bindings first (unlinked while their plan items are alive), then the stream's tree, whatever the test got to create.
    for (const connectionId of [connection.id, ...extraConnectionIds.splice(0)]) {
      const bindings = await api.get(`/api/v1/integrations/jira/bindings?connectionId=${connectionId}&pageSize=100`);
      if (bindings.ok()) paths.push(...((await bindings.json()) as { items: { id: number }[] }).items.map((item) => `/api/v1/integrations/jira/bindings/${item.id}`));
    }
    const stream = streamId === undefined ? undefined : (await planStreams(api)).find((candidate) => candidate.id === streamId);
    if (stream) {
      const own = treePaths(stream);
      // The stream itself is registered in `teardown`; the walk adds only what is under it.
      paths.push(...own.filter((path) => !path.includes("/work-streams/")));
    }
  } finally {
    await api?.dispose();
    const rest = teardown.splice(0).reverse();
    streamId = undefined;
    await deleteViaApi([...paths, ...rest]);
  }
});

/** A throwaway administrator, a person, a team and a work stream of their own, all removed by the afterEach. */
async function seedWorld(): Promise<World> {
  const { api } = await apiAsAdmin();
  try {
    const name = uniqueText(`${MARK}admin`);
    const admin = { email: `${name.toLowerCase()}@astrolabe.local`, password: randomUUID().replace(/-/g, "") };
    await create(api, "/api/v1/users", { name, email: admin.email, password: admin.password, roles: ["ADMIN"] }, "/api/v1/users");
    const ownerName = uniqueText(`${MARK}owner`);
    const ownerId = await create(api, "/api/v1/people", { name: ownerName }, "/api/v1/people");
    const teamName = uniqueText(`${MARK}team`);
    const teamId = await create(api, "/api/v1/teams", { name: teamName }, "/api/v1/teams");
    const streamName = uniqueText(`${MARK}stream`);
    const id = await create(api, "/api/v1/work-streams", { name: streamName, ownerPersonId: ownerId, startDate: "2045-01-02" }, "/api/v1/work-streams");
    streamId = id;
    return { admin, ownerName, teamName, teamId, streamId: id, streamName };
  } finally {
    await api.dispose();
  }
}

/** The world's own stream with an existing program and project (the default project's target), made through the API. */
async function seedDefaultProject(world: World): Promise<{ project: string; program: string; projectId: number }> {
  const { api } = await apiAsAdmin();
  try {
    const people = (await (await api.get(`/api/v1/people?name=${encodeURIComponent(world.ownerName)}`)).json()) as { items: { id: number }[] };
    const ownerId = people.items[0].id;
    const program = uniqueText(`${MARK}program`);
    const project = uniqueText(`${MARK}project`);
    const programId = await create(api, `/api/v1/work-streams/${world.streamId}/programs`, { name: program, ownerPersonId: ownerId }, "/api/v1/programs");
    const projectId = await create(api, `/api/v1/programs/${programId}/projects`, { name: project, ownerPersonId: ownerId }, "/api/v1/projects");
    return { project, program, projectId };
  } finally {
    await api.dispose();
  }
}

/**
 * A NON-admin owner: a USER login linked to a person, a work stream that person owns (the person is the owner of the new items too) and a team (no
 * manager: the milestones are created unscheduled). Registered in creation order so the afterEach deletes the stream, team, person and login in that order.
 */
async function seedOwnerWorld(): Promise<World> {
  const { api } = await apiAsAdmin();
  try {
    const name = uniqueText(`${MARK}streamowner`);
    const owner = { email: `${name.toLowerCase()}@astrolabe.local`, password: randomUUID().replace(/-/g, "") };
    const userId = await create(api, "/api/v1/users", { name, email: owner.email, password: owner.password }, "/api/v1/users");
    const ownerName = uniqueText(`${MARK}ownerperson`);
    const ownerId = await create(api, "/api/v1/people", { name: ownerName, userId }, "/api/v1/people");
    const teamName = uniqueText(`${MARK}team`);
    const teamId = await create(api, "/api/v1/teams", { name: teamName }, "/api/v1/teams");
    const streamName = uniqueText(`${MARK}stream`);
    const id = await create(api, "/api/v1/work-streams", { name: streamName, ownerPersonId: ownerId, startDate: "2045-01-02" }, "/api/v1/work-streams");
    streamId = id;
    // `admin` is the world's browser login: here the non-admin owner.
    return { admin: owner, ownerName, teamName, teamId, streamId: id, streamName };
  } finally {
    await api.dispose();
  }
}

const modal = (page: Page) => page.getByRole("dialog", { name: "Import from Jira" });
const previewTable = (page: Page) => modal(page).getByRole("table", { name: "Import preview" });
/** One preview row, found by its key link (a row's text may also name a parent's key). */
const rowOf = (page: Page, key: string): Locator => previewTable(page).getByRole("row").filter({ has: page.getByRole("link", { name: new RegExp(`^${key} \\(opens in Jira\\)`) }) });

/**
 * Pick an option of a Mantine combobox by typing its (unique) text first: the person and team pickers search the server and offer only the first rows by
 * name, so on a stack with many rows the option exists only once the list is narrowed. The list is a portal'd listbox, found by the option's own name.
 */
async function pick(page: Page, field: Locator, search: string, option = search): Promise<void> {
  await field.click();
  await field.fill(search);
  await page.getByRole("option", { name: option, exact: true }).click();
}

/**
 * The Scope phase: the world's stream, owner and default team (and the default project when given); the Jira project IMP is preselected, the dates are copied and
 * the import filter is at the dialog's defaults (done items left out, updated within 365 days).
 */
async function fillScope(page: Page, world: World, defaultProject?: { project: string; program: string }): Promise<void> {
  const dialog = modal(page);
  await pick(page, dialog.getByRole("combobox", { name: "Work stream" }), world.streamName);
  await pick(page, dialog.getByRole("combobox", { name: "Owner of the new items" }), world.ownerName);
  await pick(page, dialog.getByRole("combobox", { name: "Default team" }), world.teamName);
  if (defaultProject) await pick(page, dialog.getByRole("combobox", { name: "Default project" }), defaultProject.project, `${defaultProject.project} · ${defaultProject.program}`);
  await expect(dialog.getByRole("switch", { name: "Copy Jira's dates" })).toBeChecked();
  await expect(doneSwitch(page)).toBeChecked();
  await expect(daysField(page)).toHaveValue("365");
}

const doneSwitch = (page: Page) => modal(page).getByRole("switch", { name: /^Leave out done items/ });
const daysField = (page: Page) => modal(page).getByRole("textbox", { name: "Updated within (days)" });

/** Sets the import filter's two controls on the Scope step: the done switch and the days field (an empty string = no time limit). */
async function setFilter(page: Page, filter: { excludeDone: boolean; days: string }): Promise<void> {
  if (filter.excludeDone) await doneSwitch(page).check();
  else await doneSwitch(page).uncheck();
  await daysField(page).fill(filter.days);
  await expect(daysField(page)).toHaveValue(filter.days);
}

/** The preview's "Left out: …" note, found by its words; the note is absent without a filter or with both controls off. */
const leftOutNote = (page: Page): Locator => modal(page).getByRole("note").filter({ hasText: "Left out:" });

/** Signs in as the world's administrator and opens the modal on the connection's page (the spec's IMP connection unless another is given). */
async function openImport(page: Page, world: World, on: { id: number; name: string } = connection): Promise<void> {
  await login(page, world.admin.email, world.admin.password);
  await page.goto(`/integrations/jira/${on.id}`);
  await expect(page.getByRole("heading", { level: 2, name: on.name })).toBeVisible();
  await page.getByRole("button", { name: "Import from Jira…" }).click();
  await expect(modal(page)).toBeVisible();
  await expect(modal(page)).toHaveCSS("opacity", "1"); // axe measures contrast against the fade-in's partial opacity
}

/** Presses Preview and waits for the second phase (the browse of Jira can take seconds). */
async function preview(page: Page): Promise<void> {
  await modal(page).getByRole("button", { name: "Preview", exact: true }).click();
  await expect(modal(page).getByRole("heading", { level: 3, name: "What the import would do" })).toBeVisible({ timeout: 30_000 });
}

async function expectTotals(page: Page, totals: { found: number; create: number; bind: number; skip: number | null }): Promise<void> {
  const group = modal(page).getByRole("group", { name: "Totals" });
  await expect(group).toContainText(`Jira items: ${totals.found}`);
  await expect(group).toContainText(`To create: ${totals.create}`);
  await expect(group).toContainText(`To link: ${totals.bind}`);
  if (totals.skip === null) await expect(group).not.toContainText("Skipped:");
  else await expect(group).toContainText(`Skipped: ${totals.skip}`);
}

async function importAll(page: Page, count: number): Promise<void> {
  await modal(page).getByRole("button", { name: `Import (${count})` }).click();
  await expect(modal(page).getByRole("heading", { level: 3, name: "Import finished" })).toBeVisible({ timeout: 60_000 });
}

/** The server cuts the summary at the 100-character name limit and trims the space that cut leaves at the end (99 characters here). */
const TRUNCATED_NAME = "IMP Epic Four with a deliberately long summary that overflows the plan's one hundred character name limit".padEnd(110, "!").slice(0, 100).trimEnd();

interface PlannedProject {
  id: number;
  name: string;
  scheduled: [string, string, string][];
  unscheduled: string[];
}

/** The world's stream as the API shows it now: its programs' names and, per project (by name), the milestones with their dates, in the view's order. */
async function planOf(world: World): Promise<{ programs: string[]; projects: PlannedProject[] }> {
  const { api } = await apiAsAdmin();
  try {
    const stream = (await planStreams(api)).find((candidate) => candidate.id === world.streamId);
    if (!stream) throw new Error("the throwaway work stream is gone");
    const projects: PlannedProject[] = [];
    for (const project of stream.programs.flatMap((program) => program.projects)) {
      const response = await api.get(`/api/v1/views/project/${project.id}`);
      expect(response.ok(), await response.text()).toBeTruthy();
      const view = (await response.json()) as { scheduled: { name: string; startDate: string; endDate: string }[]; unscheduled: { name: string }[] };
      projects.push({
        id: project.id,
        name: project.name,
        scheduled: view.scheduled.map((m): [string, string, string] => [m.name, m.startDate, m.endDate]),
        unscheduled: view.unscheduled.map((m) => m.name),
      });
    }
    return { programs: stream.programs.map((program) => program.name), projects: projects.sort((x, y) => x.name.localeCompare(y.name)) };
  } finally {
    await api.dispose();
  }
}

/** A throwaway person (removed by the teardown) for a per-row owner pick. */
async function createPerson(name: string): Promise<void> {
  const { api } = await apiAsAdmin();
  try {
    await create(api, "/api/v1/people", { name }, "/api/v1/people");
  } finally {
    await api.dispose();
  }
}

async function projectOwnerName(projectId: number): Promise<string> {
  const { api } = await apiAsAdmin();
  try {
    const response = await api.get(`/api/v1/projects/${projectId}`);
    expect(response.ok(), await response.text()).toBeTruthy();
    return ((await response.json()) as { ownerName: string }).ownerName;
  } finally {
    await api.dispose();
  }
}

async function scan(page: Page): Promise<void> {
  expect(await axeViolations(page, '[role="dialog"]')).toEqual([]);
}

test("admin imports the stub's IMP project tree and a re-import creates nothing", async ({ page }) => {
  const world = await seedWorld();
  await openImport(page, world);
  const dialog = modal(page);

  // Scope: the stream, an owner and a default team (IMP-5 has no Jira team and the others' "IMP Team" matches no team here), no default project.
  await fillScope(page, world);
  await preview(page);

  // Preview: 9 Jira items, 8 would be created (1 program, 2 projects, 5 milestones), IMP-8 is skipped: its parent is the program, there is no project.
  await expectTotals(page, { found: 9, create: 8, bind: 0, skip: 1 });
  await expect(dialog.getByText("8 of 8 selected")).toBeVisible();
  await expect(dialog.getByText("Jira teams that match no team here: IMP Team.")).toBeVisible();
  await expect(rowOf(page, "IMP-8")).toContainText("Nowhere to put it");
  await expect(rowOf(page, "IMP-6")).toContainText("Jira's dates are missing or invalid: created unscheduled");
  await expect(rowOf(page, "IMP-7")).toContainText("Name cut to 100 characters");
  await expect(rowOf(page, "IMP-5").getByRole("combobox", { name: "Team for IMP-5" })).toHaveValue(String(world.teamId));

  // A per-row owner (1.14): the projects and the program have an owner picker (the dialog's owner preselected), a milestone has none; IMP-2 is given someone else.
  const otherOwner = uniqueText(`${MARK}other`);
  await createPerson(otherOwner);
  await expect(rowOf(page, "IMP-2").getByRole("combobox", { name: "Owner for IMP-2" })).toHaveValue(world.ownerName);
  await expect(rowOf(page, "IMP-4").getByRole("combobox", { name: "Owner for IMP-4" })).toHaveCount(0);
  await pick(page, rowOf(page, "IMP-2").getByRole("combobox", { name: "Owner for IMP-2" }), otherOwner);

  // Import: 1 + 2 + 5 created; the four with dates (IMP-4, 5, 7, 9) scheduled - IMP-6 is undated.
  await importAll(page, 8);
  const outcome = dialog.getByRole("status");
  await expect(outcome).toContainText("Created: 8");
  await expect(outcome).toContainText("Linked: 0");
  await expect(outcome).toContainText("Scheduled: 4");
  // IMP-8 was never ticked (a skipped preview row has no checkbox), so it is not sent and the outcome has no skipped rows of its own.
  await expect(outcome).toContainText("Skipped: 0");
  await expect(dialog.getByRole("table", { name: "Skipped rows" })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Close", exact: true }).last().click();
  await expect(dialog).toHaveCount(0);

  // The connection page lists the 8 links the import made.
  await expect(page.getByRole("table", { name: "Links to plan items" }).getByRole("row").filter({ hasText: "IMP-" })).toHaveCount(8);

  // The plan really has it: one program, two projects, the milestones dated in 2045 (read from the project views the API serves, then opened in the UI).
  const planned = await planOf(world);
  expect(planned.programs).toEqual([PROGRAM_NAME]);
  expect(planned.projects.map((project) => project.name)).toEqual(["IMP Initiative Alpha", "IMP Initiative Beta"]);
  const [alpha, beta] = planned.projects;
  expect(alpha.scheduled).toEqual([
    ["IMP Epic One", "2045-01-02", "2045-01-06"],
    ["IMP Epic Two", "2045-01-16", "2045-01-20"],
  ]);
  expect(alpha.unscheduled).toEqual([]);
  // IMP-7's 110-character summary was cut at the plan's 100-character name limit (a feature under test), IMP-6 has no dates and waits in the tray.
  expect(beta.scheduled).toEqual([
    [TRUNCATED_NAME, "2045-01-23", "2045-01-27"],
    ["IMP Epic Six", "2045-01-30", "2045-02-03"],
  ]);
  expect(TRUNCATED_NAME).toHaveLength(99);
  expect(beta.unscheduled).toEqual(["IMP Epic Three"]);
  // Alpha (IMP-2) went to the owner picked on its row, Beta (IMP-3) to the dialog's owner.
  expect(await projectOwnerName(alpha.id)).toBe(otherOwner);
  expect(await projectOwnerName(beta.id)).toBe(world.ownerName);
  await page.goto(`/projects/${alpha.id}`);
  await expect(page.getByRole("heading", { level: 2, name: "IMP Initiative Alpha" })).toBeVisible();
  await expect(page.getByText("IMP Epic One").first()).toBeVisible();

  // A second preview of the same scope offers nothing: every imported row is already linked, IMP-8 still has nowhere to go, and Import has nothing to press.
  await page.goto(`/integrations/jira/${connection.id}`);
  await page.getByRole("button", { name: "Import from Jira…" }).click();
  await fillScope(page, world);
  await preview(page);
  await expectTotals(page, { found: 9, create: 0, bind: 0, skip: 9 });
  await expect(dialog.getByText("0 of 0 selected")).toBeVisible();
  await expect(rowOf(page, "IMP-4")).toContainText("Already linked");
  await expect(rowOf(page, "IMP-8")).toContainText("Nowhere to put it");
  await expect(dialog.getByRole("button", { name: "Import (0)" })).toBeDisabled();
  await expect(page.getByRole("table", { name: "Links to plan items" }).getByRole("row").filter({ hasText: "IMP-" })).toHaveCount(8);
  // Nothing was written by the second preview: the plan under the stream is exactly what the import made.
  expect(await planOf(world)).toEqual(planned);
});

// 1.10 (decision B of 1.2): the owner of a work stream, who is no administrator, imports from the Plan page's work-stream menu. The connection comes from the deviations
// view (the registry is ADMIN only): preselected when it is the only usable one, else picked in the scope step (other specs' connections may be offered too). The stream
// is preset and read-only. A non-admin's preview redacts the skipped row (IMP-8), so only the totals are asserted for it.
test("an owner imports from the Plan page's work-stream menu", async ({ page }) => {
  const world = await seedOwnerWorld();
  await login(page, world.admin.email, world.admin.password);
  await page.goto("/plan");
  await page.getByRole("button", { name: `Operations for ${world.streamName}` }).click();
  await page.getByRole("menuitem", { name: `Import from Jira into ${world.streamName}` }).click();
  const dialog = modal(page);
  await expect(dialog).toBeVisible();

  // The connection: auto-picked when alone, else picked by its name; the stream is the one whose menu was opened and cannot be changed.
  const connectionField = dialog.getByRole("combobox", { name: "Jira connection" });
  await expect(connectionField).toBeVisible();
  if ((await connectionField.inputValue()) !== connection.name) {
    await connectionField.click();
    await page.getByRole("option", { name: connection.name, exact: true }).click();
  }
  await expect(connectionField).toHaveValue(connection.name);
  const streamField = dialog.getByRole("combobox", { name: "Work stream" });
  await expect(streamField).toHaveValue(world.streamName);
  await expect(streamField).toHaveAttribute("readonly", "");
  await pick(page, dialog.getByRole("combobox", { name: "Owner of the new items" }), world.ownerName);
  await pick(page, dialog.getByRole("combobox", { name: "Default team" }), world.teamName);
  await preview(page);

  // 9 Jira items, 8 created (1 program, 2 projects, 5 milestones), 1 skipped; the skipped row's text is redacted for a non-admin, so it is not asserted.
  await expectTotals(page, { found: 9, create: 8, bind: 0, skip: 1 });
  await importAll(page, 8);
  await expect(dialog.getByRole("status")).toContainText("Created: 8");
  await dialog.getByRole("button", { name: "Close", exact: true }).last().click();
  await expect(dialog).toHaveCount(0);

  // The plan page shows what was imported under the owner's stream.
  await expect(page.getByRole("region", { name: world.streamName }).getByRole("heading", { level: 4, name: PROGRAM_NAME })).toBeVisible();
  expect((await planOf(world)).programs).toEqual([PROGRAM_NAME]);
});

test("unticking a parent leaves its children out of the import, with the reason shown", async ({ page }) => {
  const world = await seedWorld();
  await openImport(page, world);
  const dialog = modal(page);
  await fillScope(page, world);
  await preview(page);
  await expect(dialog.getByRole("button", { name: "Import (8)" })).toBeEnabled();

  // IMP-2 (Initiative Alpha) has IMP-4 and IMP-5 under it: unticking it leaves all three out.
  await rowOf(page, "IMP-2").getByRole("checkbox", { name: "Import IMP-2" }).uncheck();
  await expect(dialog.getByRole("button", { name: "Import (5)" })).toBeEnabled();
  await expect(dialog.getByText("5 of 8 selected")).toBeVisible();
  await expect(dialog.getByText("Unticked IMP-2 and the 2 items created under it: they would be skipped.")).toBeVisible();
  for (const key of ["IMP-4", "IMP-5"]) {
    const row = rowOf(page, key);
    await expect(row.getByRole("checkbox", { name: `Import ${key}` })).not.toBeChecked();
    await expect(row).toContainText("Not imported");
    await expect(row).toContainText("Its parent IMP-2 is not ticked, so this is not imported.");
  }
  // The other branch is untouched.
  await expect(rowOf(page, "IMP-9").getByRole("checkbox", { name: "Import IMP-9" })).toBeChecked();

  // Ticking a child brings back what it is created under.
  await rowOf(page, "IMP-4").getByRole("checkbox", { name: "Import IMP-4" }).check();
  await expect(rowOf(page, "IMP-2").getByRole("checkbox", { name: "Import IMP-2" })).toBeChecked();
  await expect(dialog.getByRole("button", { name: "Import (7)" })).toBeEnabled();
  // IMP-5 stays unticked, but its parent is ticked again, so it is no longer "Not imported": it is simply not selected.
  await expect(rowOf(page, "IMP-5").getByRole("checkbox", { name: "Import IMP-5" })).not.toBeChecked();
  await expect(rowOf(page, "IMP-5")).not.toContainText("Not imported");
});

// 1.13.4: the preview's search box. It hides rows without touching a tick; "Tick shown" ticks what a shown row is created under, and the Import count stays global.
test("searching the preview cherry-picks one item to import", async ({ page }) => {
  const world = await seedWorld();
  await openImport(page, world);
  const dialog = modal(page);
  await fillScope(page, world);
  await preview(page);
  await expect(dialog.getByText("8 of 8 selected")).toBeVisible();

  // Untick everything, then find the Program by its key: only its row is shown, and ticking it makes the count read 1.
  await dialog.getByRole("button", { name: "Select none" }).click();
  await expect(dialog.getByRole("button", { name: "Import (0)" })).toBeDisabled();
  const search = dialog.getByRole("textbox", { name: "Search the preview" });
  await search.fill("IMP-1");
  await expect(dialog.getByText("Showing 1 of 9")).toBeVisible();
  await expect(previewTable(page).getByRole("row")).toHaveCount(2); // the header and IMP-1
  await expect(rowOf(page, "IMP-1")).toBeVisible();
  await dialog.getByRole("button", { name: "Tick shown", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Import (1)" })).toBeEnabled();
  await expect(dialog.getByText("1 of 8 selected")).toBeVisible();

  // An epic by its summary: ticking it also ticks the Initiative it is created under (shown or not), and the count stays global.
  await search.fill("epic one");
  await expect(rowOf(page, "IMP-4")).toBeVisible();
  await expect(rowOf(page, "IMP-1")).toHaveCount(0);
  await expect(dialog.getByText("Showing 1 of 9")).toBeVisible();
  await dialog.getByRole("button", { name: "Tick shown", exact: true }).click();
  await expect(dialog.getByText("Also ticked 1 item outside the search that the shown rows are created under.")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Import (3)" })).toBeEnabled();

  // No match: a note instead of the table; clearing the search brings every row back with the ticks as they were.
  await search.fill("no such item");
  await expect(dialog.getByText("No rows match “no such item”.")).toBeVisible();
  await expect(previewTable(page)).toHaveCount(0);
  await dialog.getByRole("button", { name: "Clear the search" }).click();
  await expect(previewTable(page).getByRole("row")).toHaveCount(10); // the header and 9 rows
  for (const key of ["IMP-1", "IMP-2", "IMP-4"]) await expect(rowOf(page, key).getByRole("checkbox", { name: `Import ${key}` })).toBeChecked();
  for (const key of ["IMP-3", "IMP-5", "IMP-9"]) await expect(rowOf(page, key).getByRole("checkbox", { name: `Import ${key}` })).not.toBeChecked();

  // The apply sends the three ticked rows, shown or not: the Program, Alpha and its first epic.
  await importAll(page, 3);
  await expect(dialog.getByRole("status")).toContainText("Created: 3");
  const planned = await planOf(world);
  expect(planned.programs).toEqual([PROGRAM_NAME]);
  expect(planned.projects.map((project) => project.name)).toEqual(["IMP Initiative Alpha"]);
  expect(planned.projects[0].scheduled).toEqual([["IMP Epic One", "2045-01-02", "2045-01-06"]]);
});

test("a skipped row says how to fix it, and a default project makes it importable", async ({ page }) => {
  const world = await seedWorld();
  const target = await seedDefaultProject(world);
  await openImport(page, world);
  const dialog = modal(page);
  await fillScope(page, world);
  await preview(page);
  await expectTotals(page, { found: 9, create: 8, bind: 0, skip: 1 });
  await expect(rowOf(page, "IMP-8")).toContainText("Pick a default program or project, or import its parent.");
  await expect(rowOf(page, "IMP-8").getByRole("checkbox")).toHaveCount(0);

  // Back to the scope (the choices are kept), name a default project, preview again: IMP-8 lands there and nothing is skipped.
  await dialog.getByRole("button", { name: "Back", exact: true }).click();
  await pick(page, dialog.getByRole("combobox", { name: "Default project" }), target.project, `${target.project} · ${target.program}`);
  await preview(page);
  await expectTotals(page, { found: 9, create: 9, bind: 0, skip: null });
  await expect(rowOf(page, "IMP-8")).toContainText(`Under default ${target.project}`);
  await expect(rowOf(page, "IMP-8").getByRole("checkbox", { name: "Import IMP-8" })).toBeChecked();
  await expect(dialog.getByRole("button", { name: "Import (9)" })).toBeEnabled();
});

/** The modal's three phases under axe: Scope (empty and filled), Preview and Outcome (after a real import: the counts, no skipped rows). */
async function scanThreeSteps(page: Page, scheme: Scheme): Promise<void> {
  const world = await seedWorld();
  await openImport(page, world);
  await expectScheme(page, scheme);
  await scan(page);
  await fillScope(page, world);
  await scan(page);
  await preview(page);
  await expect(rowOf(page, "IMP-8")).toBeVisible();
  await scan(page);
  await importAll(page, 8);
  await expect(modal(page).getByRole("status")).toContainText("Created: 8");
  await scan(page);
}

test("the import modal's three steps have no WCAG A/AA violations", async ({ page }) => {
  await scanThreeSteps(page, "light");
});

test.describe("dark scheme", () => {
  test.use({ colorScheme: "dark" });
  test("the import modal's three steps have no WCAG A/AA violations in the dark scheme", async ({ page }) => {
    await scanThreeSteps(page, "dark");
  });
});

/** The name of IMP-8, the stub's epic that sits straight under the program (so it lands in the default project). */
const IMP_8_NAME = "IMP Epic Five";

/**
 * The outcome's skipped-rows table under axe. The UI sends only ticked rows, so a first import skips nothing; a row skips when the plan moves between the preview
 * and the apply. Here IMP-8 previews as a CREATE under the default project, then (through the API, while the modal stays open) a milestone with its name is made
 * in that project: the apply's recomputation under the lock finds an unlinked same-name sibling, so IMP-8 is now a BIND, which is not what the user ticked and
 * is skipped as CHANGED. The other eight rows are written, so the outcome shows its counts, the note and the table.
 */
async function scanChangedOutcome(page: Page, scheme: Scheme): Promise<void> {
  const world = await seedWorld();
  const target = await seedDefaultProject(world);
  await openImport(page, world);
  await expectScheme(page, scheme);
  const dialog = modal(page);
  await fillScope(page, world, target);
  await preview(page);
  await expectTotals(page, { found: 9, create: 9, bind: 0, skip: null });
  await expect(rowOf(page, "IMP-8")).toContainText(`Under default ${target.project}`);
  await expect(dialog.getByRole("button", { name: "Import (9)" })).toBeEnabled();

  // The plan moves: the same name appears, unlinked, where IMP-8 would be created.
  const { api } = await apiAsAdmin();
  try {
    await create(api, `/api/v1/projects/${target.projectId}/milestones`, { name: IMP_8_NAME, teamId: world.teamId, estimateMd: 3 }, "/api/v1/milestones");
  } finally {
    await api.dispose();
  }

  await importAll(page, 9);
  const outcome = dialog.getByRole("status");
  await expect(outcome).toContainText("Created: 8");
  await expect(outcome).toContainText("Linked: 0");
  await expect(outcome).toContainText("Skipped: 1");
  await expect(dialog.getByRole("note")).toContainText("1 row changed since the preview and was skipped.");
  const skipped = dialog.getByRole("table", { name: "Skipped rows" });
  await expect(skipped).toBeVisible();
  const skippedRow = skipped.getByRole("row").filter({ has: page.getByRole("link", { name: /^IMP-8 \(opens in Jira\)/ }) });
  await expect(skippedRow).toHaveCount(1);
  await expect(skippedRow).toContainText("Changed since the preview, in Jira or in the plan. Preview again.");
  await expect(skipped.getByRole("row")).toHaveCount(2); // the header and IMP-8
  await scan(page);

  // Nothing of IMP-8 was written: the default project holds the one milestone the test made, unlinked.
  const planned = await planOf(world);
  expect(planned.projects.find((project) => project.name === target.project)?.unscheduled).toEqual([IMP_8_NAME]);
}

test("the outcome's skipped-rows table (a row changed since the preview) has no WCAG A/AA violations", async ({ page }) => {
  await scanChangedOutcome(page, "light");
});

test.describe("dark scheme (skipped rows)", () => {
  test.use({ colorScheme: "dark" });
  test("the outcome's skipped-rows table (a row changed since the preview) has no WCAG A/AA violations in the dark scheme", async ({ page }) => {
    await scanChangedOutcome(page, "dark");
  });
});

/** The stub's five work-stream projects: about 1,120 items, far above the table's 80-row virtualisation threshold. Previewed only, never imported. */
const SCALE_KEYS = ["CE", "PF", "CG", "DI", "OE"];

/**
 * A further connection, scoped to the given Jira projects on a unique throwaway site and tested once (one more call of the per-IP Test bucket (10 a minute by
 * default, 30 on the e2e stacks)); the afterEach deletes it. Its bindings (a test that imports through it) are removed first, with the file's own connection's.
 */
async function seedConnection(prefix: string, projectKeys: string[]): Promise<{ id: number; name: string }> {
  const { api } = await apiAsAdmin();
  try {
    const name = uniqueText(`${MARK}${prefix}`);
    const site = `https://stub-e2eimport${randomUUID().replace(/-/g, "").slice(0, 12)}.atlassian.net`;
    const body = { name, siteUrl: site, email: "e2e-import@astrolabe.local", apiToken: "e2e-import-token", authScheme: "BASIC", projectKeys, enabled: true, pollIntervalMinutes: null };
    const id = await create(api, "/api/v1/integrations/jira/connections", body, "/api/v1/integrations/jira/connections");
    extraConnectionIds.push(id);
    await testJiraConnectionViaApi(api, id);
    return { id, name };
  } finally {
    await api.dispose();
  }
}

const seedScaleConnection = () => seedConnection("scale", SCALE_KEYS);
const seedFilterConnection = () => seedConnection("filter", ["IMF"]);

/** Scrolls the preview's own scroller to the middle and waits until the rows mounted there are a window far from the top. */
async function scrollPreviewToMiddle(page: Page): Promise<void> {
  const scroller = modal(page).getByRole("region", { name: "Import preview" });
  await scroller.evaluate((element) => {
    element.scrollTop = element.scrollHeight / 2;
  });
  const firstMounted = previewTable(page).locator("tbody tr[aria-rowindex]").first();
  await expect.poll(async () => Number(await firstMounted.getAttribute("aria-rowindex"))).toBeGreaterThan(100);
}

// The unit tests mount at most a few hundred rows under happy-dom and the three-step scan above sees 9: this is the real browser over the VIRTUAL
// path (spacer rows, aria-rowcount/aria-rowindex, a fixed row height), at the top and mid-scroll, light and then dark on the same preview.
test("a preview of about 1,100 rows (the virtualised table) has no WCAG A/AA violations, at the top and mid-scroll, light and dark", async ({ page }) => {
  test.setTimeout(300_000);
  const scale = await seedScaleConnection();
  const world = await seedWorld();
  await openImport(page, world, scale);
  await expectScheme(page, "light");
  const dialog = modal(page);
  // The default team too: the milestone rows then carry their checkbox and team select, the cells the scan most needs to see.
  await fillScope(page, world);
  // The filter off: the sample projects are stamped in 2026, so under the 365-day default window their row count would start to fall in late August 2027.
  // Both controls off is also the proof that the request then carries no filter (1.13.1's, byte for byte): the preview reads everything and has no "Left out" note.
  await setFilter(page, { excludeDone: false, days: "" });
  await modal(page).getByRole("button", { name: "Preview", exact: true }).click();
  await expect(dialog.getByRole("heading", { level: 3, name: "What the import would do" })).toBeVisible({ timeout: 190_000 });
  await expect(leftOutNote(page)).toHaveCount(0);
  const rowCount = Number(await previewTable(page).getAttribute("aria-rowcount"));
  expect(rowCount).toBeGreaterThan(1_000);
  // Virtualised: only a window of the rows is in the DOM, and it is mounted (the virtualiser measures its scroller first) before the first scan.
  await expect(previewTable(page).locator("tbody tr[aria-rowindex]").first()).toHaveAttribute("aria-rowindex", "2");
  expect(await previewTable(page).locator("tbody tr[aria-rowindex]").count()).toBeLessThan(200);
  await scan(page);
  await scrollPreviewToMiddle(page);
  await scan(page);

  await page.emulateMedia({ colorScheme: "dark" });
  await expectScheme(page, "dark");
  await scan(page);
  await modal(page).getByRole("region", { name: "Import preview" }).evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect(previewTable(page).locator("tbody tr[aria-rowindex]").first()).toHaveAttribute("aria-rowindex", "2");
  await scan(page);
});

/** The stub's `IMF` project (`sample-data/jira/expected.json` `imf`): 15 issues in the listings and one hidden parent, IMF-16, that the connection cannot read. */
const KEPT_NOTE = "Kept as a parent of an item shown here";
const UNREADABLE_NOTE = "Its parent in Jira could not be read with the connection's account";

// 1.13.2: the import filter on the stub's IMF project. The stub does not evaluate the filter (its listings hold the done and quiet issues too): the server's rule drops
// them, reads the parents it needs by id (IMF-3, 4, 13, 16 - a 404 - and 12) and keeps them as parents. At the defaults: 11 rows, 10 created, IMF-15 skipped.
test("the import filter leaves out done and quiet items and keeps the parents of what it reads", async ({ page }) => {
  const filterConnection = await seedFilterConnection();
  const world = await seedWorld();
  await openImport(page, world, filterConnection);
  const dialog = modal(page);
  await fillScope(page, world);
  await preview(page);

  // 11 rows: 15 issues less the four left out (IMF-5 and IMF-9, IMF-10 done; IMF-11 quiet); 10 would be created, IMF-15 is skipped.
  await expectTotals(page, { found: 11, create: 10, bind: 0, skip: 1 });
  await expect(dialog.getByText("10 of 10 selected")).toBeVisible();
  await expect(leftOutNote(page)).toHaveText("Left out: done items, and items not updated for more than 365 days. Their parents in the selected projects are still read.");
  for (const key of ["IMF-5", "IMF-9", "IMF-10", "IMF-11"]) await expect(rowOf(page, key)).toHaveCount(0);
  // The parents the filter would have dropped but an item that is read sits under: a done and a quiet initiative, and the two-round chain (IMF-14 under IMF-13 under IMF-12).
  for (const key of ["IMF-3", "IMF-4", "IMF-12", "IMF-13"]) await expect(rowOf(page, key)).toContainText(KEPT_NOTE);
  for (const key of ["IMF-1", "IMF-2", "IMF-6", "IMF-7", "IMF-8", "IMF-14"]) {
    await expect(rowOf(page, key)).toHaveCount(1);
    await expect(rowOf(page, key)).not.toContainText(KEPT_NOTE);
  }
  await expect(rowOf(page, "IMF-7")).toContainText("Under new IMF Initiative Done");
  await expect(rowOf(page, "IMF-14")).toContainText("Under new IMF Initiative Old");
  // IMF-15's parent (IMF-16) answers 404 by id: the child is skipped and says why, the kept-parent mark is not on it.
  await expect(rowOf(page, "IMF-15")).toContainText("Nowhere to put it");
  await expect(rowOf(page, "IMF-15")).toContainText(UNREADABLE_NOTE);
  await expect(rowOf(page, "IMF-15").getByRole("checkbox")).toHaveCount(0);

  // The ticked rows are imported under the SAME filter (the apply re-reads the parents): 2 programs, 4 projects, 4 milestones, all four milestones dated.
  await importAll(page, 10);
  const outcome = dialog.getByRole("status");
  await expect(outcome).toContainText("Created: 10");
  await expect(outcome).toContainText("Linked: 0");
  await expect(outcome).toContainText("Scheduled: 4");
  await expect(outcome).toContainText("Skipped: 0");
  await expect(dialog.getByRole("table", { name: "Skipped rows" })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Close", exact: true }).last().click();
  await expect(dialog).toHaveCount(0);

  // Ten links, none for what was left out or skipped.
  const links = page.getByRole("table", { name: "Links to plan items" }).getByRole("row");
  await expect(links.filter({ hasText: "IMF-" })).toHaveCount(10);
  for (const key of ["IMF-5", "IMF-9", "IMF-10", "IMF-11", "IMF-15"]) await expect(links.filter({ hasText: new RegExp(`${key}(?!\\d)`) })).toHaveCount(0);

  // The plan holds exactly the kept parents and what they carry, with the stub's names and dates (2045).
  const planned = await planOf(world);
  expect([...planned.programs].sort()).toEqual(["IMF Program", "IMF Program Old"]);
  expect(planned.projects.map((project) => project.name)).toEqual(["IMF Initiative Done", "IMF Initiative Old", "IMF Initiative Open", "IMF Initiative Quiet"]);
  expect(planned.projects.map((project) => project.scheduled)).toEqual([
    [["IMF Epic Under Done", "2045-01-23", "2045-01-27"]],
    [["IMF Epic Under Old", "2045-03-06", "2045-03-10"]],
    [["IMF Epic Open", "2045-01-02", "2045-01-06"]],
    [["IMF Epic Under Quiet", "2045-02-06", "2045-02-10"]],
  ]);
  expect(planned.projects.flatMap((project) => project.unscheduled)).toEqual([]);
});

test("with the filter off the whole IMF project previews and no parent is read; with only the done switch on the quiet items stay", async ({ page }) => {
  const filterConnection = await seedFilterConnection();
  const world = await seedWorld();
  await openImport(page, world, filterConnection);
  const dialog = modal(page);
  await fillScope(page, world);

  // Both controls off: 15 rows, 14 would be created, no "Left out" note, nothing marked as kept, and IMF-15 (nothing was read, so nothing is known about its parent)
  // is skipped without the unreadable-parent note.
  await setFilter(page, { excludeDone: false, days: "" });
  await preview(page);
  await expectTotals(page, { found: 15, create: 14, bind: 0, skip: 1 });
  await expect(leftOutNote(page)).toHaveCount(0);
  for (const key of ["IMF-5", "IMF-9", "IMF-10", "IMF-11"]) await expect(rowOf(page, key)).toHaveCount(1);
  await expect(previewTable(page)).not.toContainText(KEPT_NOTE);
  await expect(rowOf(page, "IMF-15")).toContainText("Nowhere to put it");
  await expect(rowOf(page, "IMF-15")).not.toContainText(UNREADABLE_NOTE);

  // Back (the choices are kept), only the done switch on, the field still empty: the done items go, the quiet IMF-11 stays and IMF-4 is a real row again.
  await dialog.getByRole("button", { name: "Back", exact: true }).click();
  await setFilter(page, { excludeDone: true, days: "" });
  await preview(page);
  await expectTotals(page, { found: 12, create: 11, bind: 0, skip: 1 });
  await expect(leftOutNote(page)).toHaveText("Left out: done items. Their parents in the selected projects are still read.");
  for (const key of ["IMF-5", "IMF-9", "IMF-10"]) await expect(rowOf(page, key)).toHaveCount(0);
  await expect(rowOf(page, "IMF-11")).toHaveCount(1);
  for (const key of ["IMF-3", "IMF-12", "IMF-13"]) await expect(rowOf(page, key)).toContainText(KEPT_NOTE);
  await expect(rowOf(page, "IMF-4")).not.toContainText(KEPT_NOTE);
  await expect(rowOf(page, "IMF-15")).toContainText(UNREADABLE_NOTE);
  // Nothing was imported, so no IMF program is ever created.
});
