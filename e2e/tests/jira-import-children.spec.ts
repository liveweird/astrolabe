// Import what Jira lists under a LINKED program or project (v1.14), against the compose stack's Jira STUB and its isolated `IMC` project (a Program with three
// Initiatives and the Epics under them, every date in 2045; `IMC-14` a Program with nothing under it): the owner of a linked program - a NON-admin who owns the
// program and nothing above it - opens the Plan page's program menu, imports the projects and milestones Jira lists under the link, and the owner of a linked project
// does the same from the project page. A program linked to an item with nothing under it says so. The dialog (scope note, preview, empty note) passes axe, light and dark.
// Owns: ONE Jira connection (`e2e-impchild-connection-*`, scoped to the stub's `IMC` project ONLY on a unique throwaway site, tested once per worker start of the file
// through the API in the beforeAll: one call of the shared per-IP Test bucket) and, per test, a throwaway NON-admin login with its person, a second person who owns the
// work stream, a team, the work stream, one or two programs (and a project) and ONE binding made through the API as the administrator (the program to `IMC-1` or `IMC-14`,
// or the project to `IMC-2`), unique `e2e-impchild-*` names, plus what the import creates under the program with the stub's own names ("IMC Initiative North/South", the
// epics), dated 2045 (the milestones are created unscheduled: the login manages no team). A rooted import creates no program, so there is no global name to guard
// and no Playwright lock. The preview and the apply share a 5-a-minute bucket PER USER: every test has its own login and spends at most three calls.
// Teardown (afterEach, even after a failure, through the API): the connection's bindings, then the tree (projects, programs, the stream), the team, the people and the
// login; the afterAll deletes the connection. The beforeAll sweeps what a crashed earlier run left, found by the `e2e-impchild-` prefix and nothing else.
import { randomUUID } from "node:crypto";
import { type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { apiAsAdmin, axeViolations, deleteViaApi, expect, expectScheme, login, test, testJiraConnectionViaApi, uniqueText, type Scheme } from "./helpers";

// The Test connection call of the beforeAll may wait a 429 out, and the longest inner wait (the apply's 60 s) needs room to fire before the test's own timeout.
test.describe.configure({ timeout: 120_000 });

const MARK = "e2e-impchild-";

interface Account {
  email: string;
  password: string;
}

interface World {
  /** The throwaway NON-admin login the test signs in as. */
  login: Account;
  /** The login's person: the owner of the program (programs test) or of the project (project test). */
  ownerName: string;
  teamName: string;
  streamId: number;
  streamName: string;
  programId: number;
  programName: string;
  /** A second program of the same stream, owned by the login too and linked to nothing (the programs test only). */
  siblingName: string | null;
  projectId: number | null;
  projectName: string | null;
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

/** Stale residue of a crashed run, found by the spec's own `e2e-impchild-` prefix and nothing else: connections, work-stream trees, then teams, people and logins. */
async function sweepStale(api: APIRequestContext): Promise<void> {
  const ours = (rows: { id: number; name: string }[]) => rows.filter((row) => row.name.startsWith(MARK));
  await deleteViaApi(ours(await listAll(api, "/api/v1/integrations/jira/connections")).map((row) => `/api/v1/integrations/jira/connections/${row.id}`));
  await deleteViaApi((await planStreams(api)).filter((stream) => stream.name.startsWith(MARK)).flatMap(treePaths));
  await deleteViaApi(ours(await listAll(api, `/api/v1/teams?name=${MARK}`)).map((row) => `/api/v1/teams/${row.id}`));
  await deleteViaApi(ours(await listAll(api, `/api/v1/people?name=${MARK}`)).map((row) => `/api/v1/people/${row.id}`));
  await deleteViaApi(ours(await listAll(api, `/api/v1/users?name=${MARK}`)).map((row) => `/api/v1/users/${row.id}`));
}

// The one Test connection call (a per-IP bucket shared by the Jira specs) is spent once per WORKER START of this file: a failed test restarts the worker and runs this
// again. A 429 waits the bucket out once.
test.beforeAll(async () => {
  test.setTimeout(180_000);
  const { api } = await apiAsAdmin();
  try {
    await sweepStale(api);
    const name = uniqueText(`${MARK}connection`);
    const site = `https://stub-e2eimpchild${randomUUID().replace(/-/g, "").slice(0, 12)}.atlassian.net`;
    const body = { name, siteUrl: site, email: "e2e-impchild@astrolabe.local", apiToken: "e2e-impchild-token", authScheme: "BASIC", projectKeys: ["IMC"], enabled: true, pollIntervalMinutes: null };
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
    const bindings = await api.get(`/api/v1/integrations/jira/bindings?connectionId=${connection.id}&pageSize=100`);
    if (bindings.ok()) paths.push(...((await bindings.json()) as { items: { id: number }[] }).items.map((item) => `/api/v1/integrations/jira/bindings/${item.id}`));
    const stream = streamId === undefined ? undefined : (await planStreams(api)).find((candidate) => candidate.id === streamId);
    // The stream itself is registered in `teardown`; the walk adds only what is under it.
    if (stream) paths.push(...treePaths(stream).filter((path) => !path.includes("/work-streams/")));
  } finally {
    await api?.dispose();
    const rest = teardown.splice(0).reverse();
    streamId = undefined;
    await deleteViaApi([...paths, ...rest]);
  }
});

/**
 * A throwaway NON-admin login linked to a person, a second person who owns the work stream, a team (no manager: the milestones are created unscheduled) and the stream.
 * `kind: "program"` adds a program owned by the login's person (linked to `issueKey`) and an unlinked sibling program owned by them too; `kind: "project"` adds a program
 * owned by the OTHER person and a project in it owned by the login's person (linked to `issueKey`). The link is made through the API as the administrator.
 */
async function seedWorld(kind: "program" | "project", issueKey: string): Promise<World> {
  const { api } = await apiAsAdmin();
  try {
    const name = uniqueText(`${MARK}owner`);
    const account = { email: `${name.toLowerCase()}@astrolabe.local`, password: randomUUID().replace(/-/g, "") };
    const userId = await create(api, "/api/v1/users", { name, email: account.email, password: account.password }, "/api/v1/users");
    const ownerName = uniqueText(`${MARK}ownerperson`);
    const ownerId = await create(api, "/api/v1/people", { name: ownerName, userId }, "/api/v1/people");
    const streamOwnerId = await create(api, "/api/v1/people", { name: uniqueText(`${MARK}streamowner`) }, "/api/v1/people");
    const teamName = uniqueText(`${MARK}team`);
    await create(api, "/api/v1/teams", { name: teamName }, "/api/v1/teams");
    const streamName = uniqueText(`${MARK}stream`);
    const id = await create(api, "/api/v1/work-streams", { name: streamName, ownerPersonId: streamOwnerId, startDate: "2045-01-02" }, "/api/v1/work-streams");
    streamId = id;
    const programName = uniqueText(`${MARK}program`);
    const programId = await create(api, `/api/v1/work-streams/${id}/programs`, { name: programName, ownerPersonId: kind === "program" ? ownerId : streamOwnerId }, "/api/v1/programs");
    let siblingName: string | null = null;
    let projectId: number | null = null;
    let projectName: string | null = null;
    if (kind === "program") {
      siblingName = uniqueText(`${MARK}sibling`);
      await create(api, `/api/v1/work-streams/${id}/programs`, { name: siblingName, ownerPersonId: ownerId }, "/api/v1/programs");
    } else {
      projectName = uniqueText(`${MARK}project`);
      projectId = await create(api, `/api/v1/programs/${programId}/projects`, { name: projectName, ownerPersonId: ownerId }, "/api/v1/projects");
    }
    const linked = await api.post("/api/v1/integrations/jira/bindings", {
      data: { connectionId: connection.id, level: kind === "program" ? "PROGRAM" : "PROJECT", nodeId: kind === "program" ? programId : projectId, issueKey },
    });
    expect(linked.status(), await linked.text()).toBe(201);
    return { login: account, ownerName, teamName, streamId: id, streamName, programId, programName, siblingName, projectId, projectName };
  } finally {
    await api.dispose();
  }
}

const modal = (page: Page) => page.getByRole("dialog", { name: "Import from Jira" });
const previewTable = (page: Page) => modal(page).getByRole("table", { name: "Import preview" });
/** One preview row, found by its key link (a row's text may also name a parent's key). */
const rowOf = (page: Page, key: string): Locator => previewTable(page).getByRole("row").filter({ has: page.getByRole("link", { name: new RegExp(`^${key} \\(opens in Jira\\)`) }) });
const doneSwitch = (page: Page) => modal(page).getByRole("switch", { name: /^Leave out done items/ });
const daysField = (page: Page) => modal(page).getByRole("textbox", { name: "Updated within (days)" });
/** The preview's "Left out: …" note, found by its words. */
const leftOutNote = (page: Page): Locator => modal(page).getByRole("note").filter({ hasText: "Left out:" });
const KEPT_NOTE = "Kept as a parent of an item shown here";

/** Pick an option of a Mantine combobox by typing its (unique) text first: the team picker searches the server and offers only the first rows by name. */
async function pick(page: Page, field: Locator, search: string): Promise<void> {
  await field.click();
  await field.fill(search);
  await page.getByRole("option", { name: search, exact: true }).click();
}

async function pickTeam(page: Page, world: World): Promise<void> {
  await pick(page, modal(page).getByRole("combobox", { name: "Default team" }), world.teamName);
}

/** The Plan page's program menu: the button "Operations for <program>" (the menu item is found by its caller). */
async function openProgramMenu(page: Page, programName: string): Promise<void> {
  await page.getByRole("button", { name: `Operations for ${programName}` }).click();
  await expect(page.getByRole("menu")).toBeVisible();
}

const importItem = (page: Page, programName: string) => page.getByRole("menuitem", { name: `Import from Jira what is listed under ${programName}` });

/** Signs in as the world's login, opens the Plan page and the dialog from the program's menu (the entry waits for the Plan page's link read). */
async function openProgramImport(page: Page, world: World): Promise<void> {
  await login(page, world.login.email, world.login.password);
  await page.goto("/plan");
  await openProgramMenu(page, world.programName);
  await importItem(page, world.programName).click();
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

const programNote = (key: string, name: string) => `Importing what Jira lists under ${key} into the program “${name}”: its projects and their milestones.`;
const projectNote = (key: string, name: string) => `Importing what Jira lists under ${key} into the project “${name}”: its milestones.`;

interface PlannedProject {
  name: string;
  unscheduled: string[];
  scheduled: string[];
}

/** The world's program as the API shows it now: its projects (by name) with their milestones, scheduled or in the tray. */
async function projectsOf(programId: number): Promise<PlannedProject[]> {
  const { api } = await apiAsAdmin();
  try {
    const projects = (await planStreams(api)).flatMap((stream) => stream.programs).find((program) => program.id === programId)?.projects ?? [];
    const planned: PlannedProject[] = [];
    for (const project of projects) {
      const response = await api.get(`/api/v1/views/project/${project.id}`);
      expect(response.ok(), await response.text()).toBeTruthy();
      const view = (await response.json()) as { scheduled: { name: string }[]; unscheduled: { name: string }[] };
      planned.push({ name: project.name, scheduled: view.scheduled.map((m) => m.name), unscheduled: view.unscheduled.map((m) => m.name).sort() });
    }
    return planned.sort((x, y) => x.name.localeCompare(y.name));
  } finally {
    await api.dispose();
  }
}

/** The names of the world's stream's programs, as the API shows them now. */
async function programNamesOf(world: World): Promise<string[]> {
  const { api } = await apiAsAdmin();
  try {
    const stream = (await planStreams(api)).find((candidate) => candidate.id === world.streamId);
    return (stream?.programs ?? []).map((program) => program.name).sort();
  } finally {
    await api.dispose();
  }
}

async function scan(page: Page): Promise<void> {
  expect(await axeViolations(page, '[role="dialog"]')).toEqual([]);
}

test("a program's owner imports the projects and milestones under their linked program", async ({ page }) => {
  const world = await seedWorld("program", "IMC-1");
  const siblingName = world.siblingName ?? "";
  await login(page, world.login.email, world.login.password);
  await page.goto("/plan");

  // The linked program has the entry; the unlinked sibling (owned by the same login) has a menu but no such item.
  await openProgramMenu(page, world.programName);
  await expect(importItem(page, world.programName)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await openProgramMenu(page, siblingName);
  await expect(page.getByRole("menuitem", { name: `Edit ${siblingName}` })).toBeVisible();
  await expect(importItem(page, siblingName)).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: /^Import from Jira what is listed under/ })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);

  // The dialog: the note names IMC-1 and the program; no work stream, Jira projects or default program is asked; the owner is the program's own.
  await openProgramMenu(page, world.programName);
  await importItem(page, world.programName).click();
  const dialog = modal(page);
  await expect(dialog.getByRole("note").filter({ hasText: "Importing what Jira lists under" })).toHaveText(programNote("IMC-1", world.programName));
  await expect(dialog.getByLabel("Work stream", { exact: true })).toHaveCount(0);
  await expect(dialog.getByLabel("Jira projects", { exact: true })).toHaveCount(0);
  await expect(dialog.getByLabel("Default program", { exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("combobox", { name: "Owner of the new items" })).toHaveValue(world.ownerName);
  await expect(dialog.getByRole("combobox", { name: "Project for items directly under IMC-1" })).toBeVisible();
  // "IMC Team" (the Jira team of the milestones) matches no team here: the default team takes them. The filter is at the dialog's defaults.
  await pickTeam(page, world);
  await expect(doneSwitch(page)).toBeChecked();
  await expect(daysField(page)).toHaveValue("365");
  await preview(page);

  // At the defaults: IMC-2, 3, 5, 7 and IMC-9 (nowhere to put it: it hangs straight under the program) = 5 found, 4 to create; IMC-4, 6, 8, 10 are left out and
  // IMC-3 (done) is kept because IMC-7 (open) sits under it. The skipped row is redacted for a non-admin under a filter. The root and IMC-11..13 are never rows.
  await expectTotals(page, { found: 5, create: 4, bind: 0, skip: 1 });
  await expect(dialog.getByText("4 of 4 selected")).toBeVisible();
  await expect(dialog.getByText("Jira teams that match no team here: IMC Team.")).toBeVisible();
  await expect(leftOutNote(page)).toHaveText("Left out: done items, and items not updated for more than 365 days. Their parents in the selected projects are still read.");
  for (const key of ["IMC-2", "IMC-3", "IMC-5", "IMC-7"]) await expect(rowOf(page, key)).toHaveCount(1);
  await expect(rowOf(page, "IMC-3")).toContainText(KEPT_NOTE);
  for (const key of ["IMC-2", "IMC-5", "IMC-7"]) await expect(rowOf(page, key)).not.toContainText(KEPT_NOTE);
  for (const key of ["IMC-1", "IMC-4", "IMC-6", "IMC-8", "IMC-9", "IMC-10", "IMC-11", "IMC-12", "IMC-13"]) await expect(rowOf(page, key)).toHaveCount(0);
  await expect(previewTable(page).getByText("Hidden")).toHaveCount(1);

  // Import: two projects and two milestones, created unscheduled (the login manages no team).
  await importAll(page, 4);
  const outcome = dialog.getByRole("status");
  await expect(outcome).toContainText("Created: 4");
  await expect(outcome).toContainText("Linked: 0");
  await expect(outcome).toContainText("Scheduled: 0");
  await expect(outcome).toContainText("Skipped: 0");
  await dialog.getByRole("button", { name: "Close", exact: true }).last().click();
  await expect(dialog).toHaveCount(0);

  // The Plan page lists both projects under the program; the API agrees, and no program was created.
  const table = page.getByRole("table", { name: `Projects of ${world.programName}` });
  await expect(table.getByRole("link", { name: "Open IMC Initiative North" })).toBeVisible();
  await expect(table.getByRole("link", { name: "Open IMC Initiative South" })).toBeVisible();
  const planned = await projectsOf(world.programId);
  expect(planned).toEqual([
    { name: "IMC Initiative North", scheduled: [], unscheduled: ["IMC Epic One"] },
    { name: "IMC Initiative South", scheduled: [], unscheduled: ["IMC Epic Three"] },
  ]);
  expect(await programNamesOf(world)).toEqual([world.programName, siblingName].sort());

  // A second preview offers nothing: every row is already linked (IMC-9 still has nowhere to go), and Import has nothing to press.
  await openProgramMenu(page, world.programName);
  await importItem(page, world.programName).click();
  await pickTeam(page, world);
  await preview(page);
  await expectTotals(page, { found: 5, create: 0, bind: 0, skip: 5 });
  await expect(dialog.getByText("0 of 0 selected")).toBeVisible();
  await expect(rowOf(page, "IMC-2")).toContainText("Already linked");
  await expect(dialog.getByRole("button", { name: "Import (0)" })).toBeDisabled();
  expect(await projectsOf(world.programId)).toEqual(planned);
});

test("a linked program with nothing under it in Jira says so", async ({ page }) => {
  const world = await seedWorld("program", "IMC-14");
  await openProgramImport(page, world);
  const dialog = modal(page);
  await expect(dialog.getByRole("note").filter({ hasText: "Importing what Jira lists under" })).toHaveText(programNote("IMC-14", world.programName));
  await preview(page);

  // Under the default filter the empty note names the filter as a possible reason, and the way to check Jira itself; Import has nothing to press.
  await expectTotals(page, { found: 0, create: 0, bind: 0, skip: null });
  const empty = dialog.getByRole("note").filter({ hasText: "Jira lists nothing under" });
  await expect(empty).toContainText("Jira lists nothing under IMC-14 at the levels this connection maps.");
  await expect(empty).toContainText("The filter may be why: go back and switch “Leave out done items” off or widen the days.");
  await expect(empty).toContainText("If IMC-14 has child items in Jira, search Jira for parent = IMC-14.");
  await expect(dialog.getByRole("button", { name: "Import (0)" })).toBeDisabled();
  await expect(previewTable(page)).toHaveCount(0);

  // With the filter off the filter sentence goes; the other two stay (nothing under IMC-14 either way).
  await dialog.getByRole("button", { name: "Back", exact: true }).click();
  await doneSwitch(page).uncheck();
  await daysField(page).fill("");
  await expect(daysField(page)).toHaveValue("");
  await preview(page);
  await expect(empty).toContainText("Jira lists nothing under IMC-14 at the levels this connection maps.");
  await expect(empty).not.toContainText("The filter may be why");
  await expect(empty).toContainText("If IMC-14 has child items in Jira, search Jira for parent = IMC-14.");
  await expect(dialog.getByRole("button", { name: "Import (0)" })).toBeDisabled();
  expect(await projectsOf(world.programId)).toEqual([]);
});

test("a project's owner imports the linked project's milestones from the project page", async ({ page }) => {
  const world = await seedWorld("project", "IMC-2");
  const projectName = world.projectName ?? "";
  await login(page, world.login.email, world.login.password);
  await page.goto(`/projects/${world.projectId}`);
  await expect(page.getByRole("heading", { level: 2, name: projectName })).toBeVisible();
  await page.getByRole("button", { name: "Import from Jira…" }).click();
  const dialog = modal(page);
  await expect(dialog).toBeVisible();

  // The note names IMC-2 and the project; no owner, work stream, Jira projects, default program or default project is asked.
  await expect(dialog.getByRole("note").filter({ hasText: "Importing what Jira lists under" })).toHaveText(projectNote("IMC-2", projectName));
  for (const label of ["Work stream", "Jira projects", "Default program", "Owner of the new items", "Project for items directly under IMC-2"]) {
    await expect(dialog.getByLabel(label, { exact: true })).toHaveCount(0);
  }
  await pickTeam(page, world);
  await preview(page);

  // At the defaults only IMC-5 is read (IMC-6 is done, IMC-10 quiet); with the filter off all three epics under IMC-2 are.
  await expectTotals(page, { found: 1, create: 1, bind: 0, skip: null });
  await expect(rowOf(page, "IMC-5")).toHaveCount(1);
  await expect(leftOutNote(page)).toHaveText("Left out: done items, and items not updated for more than 365 days. Their parents in the selected projects are still read.");
  await dialog.getByRole("button", { name: "Back", exact: true }).click();
  await doneSwitch(page).uncheck();
  await daysField(page).fill("");
  await expect(daysField(page)).toHaveValue("");
  await preview(page);
  await expectTotals(page, { found: 3, create: 3, bind: 0, skip: null });
  for (const key of ["IMC-5", "IMC-6", "IMC-10"]) await expect(rowOf(page, key)).toHaveCount(1);
  await expect(leftOutNote(page)).toHaveCount(0);

  await importAll(page, 3);
  await expect(dialog.getByRole("status")).toContainText("Created: 3");
  await dialog.getByRole("button", { name: "Close", exact: true }).last().click();
  await expect(dialog).toHaveCount(0);

  // The project page lists the three milestones, all unscheduled: the login manages no team.
  for (const name of ["IMC Epic One", "IMC Epic Two", "IMC Epic Six"]) await expect(page.getByText(name).first()).toBeVisible();
  expect(await projectsOf(world.programId)).toEqual([{ name: projectName, scheduled: [], unscheduled: ["IMC Epic One", "IMC Epic Six", "IMC Epic Two"] }]);
});

/** The rooted dialog under axe: the scope step with its note (empty, then with the default team) and the preview. Nothing is imported. */
async function scanRootedDialog(page: Page, scheme: Scheme): Promise<void> {
  const world = await seedWorld("program", "IMC-1");
  await openProgramImport(page, world);
  await expectScheme(page, scheme);
  await scan(page);
  await pickTeam(page, world);
  await scan(page);
  await preview(page);
  await expect(rowOf(page, "IMC-3")).toContainText(KEPT_NOTE);
  await scan(page);
}

test("the import from a linked program has no WCAG A/AA violations", async ({ page }) => {
  await scanRootedDialog(page, "light");
});

test.describe("dark scheme", () => {
  test.use({ colorScheme: "dark" });
  test("the import from a linked program has no WCAG A/AA violations in the dark scheme", async ({ page }) => {
    await scanRootedDialog(page, "dark");
  });
});
