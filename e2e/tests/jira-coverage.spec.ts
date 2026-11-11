// Jira coverage (v1.4), against the compose stack's Jira STUB and its isolated `COV` project (every date in 2046; COV-3 an epic with four children, two done, 13
// points; COV-4 an epic whose two children are both done, 5 points; COV-5 an open epic nobody binds; COV-10 a done one nobody binds): the administrator binds
// a project and two milestones, refreshes once, and the project page's Flags cells carry each epic's story roll-up, the Deviations page names what Jira has and
// the plan does not (and the reverse, and the epic whose children are all done), the roadmap's flag panel says the same, and an acknowledgement silences it.
// Owns: ONE Jira connection (`e2e-cov-*`, scoped to the stub's `COV` project ONLY on a unique throwaway site, manual-only, tested once per worker start of the file
// through the API in the beforeAll: one call of the shared per-IP Test bucket), its three bindings (the project to COV-2, the milestones to COV-3 and COV-4; COV-5
// and COV-10 are never bound), one run of it (plus one more in the last test), and a throwaway world (a person, a team, a work stream, a program, a project
// `e2e-cov-project-*` and three milestones, unique `e2e-cov-*` names, every date in **2046**, which nothing writes a holiday in), all seeded and removed through the
// API (the bindings, then the connection, then the project, whose milestones go with it, and the rest). It never flips the stub's `jira-day2` scenario
// (`COV` is untouched by day 2), needs no lock, and binds and works as the seed administrator (its runs ride a throwaway administrator, the per-user `sync-run` bucket): no new guard exists to prove.
import { randomUUID } from "node:crypto";
import { type APIRequestContext, type Locator, type Page } from "@playwright/test";
import {
  apiAsAdmin,
  apiAsThrowawayAdmin,
  axeViolations,
  deleteViaApi,
  expect,
  expectScheme,
  login,
  refreshJiraConnectionViaApi,
  test,
  testJiraConnectionViaApi,
  uniqueText,
  type Scheme,
  type ThrowawayAdmin,
} from "./helpers";

// One world, read by three tests in order (the third acknowledges what the second read): a serial group, and a failed test stops the rest. Each test ends
// in a light and a dark axe scan of a full timeline page, which takes most of a minute on a CI runner: 120 s each, as jira-import has.
test.describe.configure({ mode: "serial", timeout: 120_000 });

const CONNECTIONS = "/api/v1/integrations/jira/connections";

interface World {
  programId: number;
  project: string;
  projectId: number;
  epicOne: string;
  epicTwo: string;
  unlinked: string;
  connection: { id: number; name: string };
}

let world: World;
// Registered in creation order; deleted in reverse - the bindings (created last) go first, then the connection, then the plan nodes.
const teardown: string[] = [];

/** A unique throwaway Jira site: the server routes every `stub-` site to the stub, and a site of its own keeps this file's bindings apart from every other spec's. */
const uniqueSite = () => `https://stub-e2ecov${randomUUID().replace(/-/g, "").slice(0, 12)}.atlassian.net`;

async function create(api: APIRequestContext, path: string, data: object, tear: string): Promise<number> {
  const response = await api.post(path, { data });
  expect(response.status(), await response.text()).toBe(201);
  const id = ((await response.json()) as { id: number }).id;
  teardown.push(`${tear}/${id}`);
  return id;
}

/** A milestone of the team, scheduled by the administrator with the team view's current plan revision. */
async function seedMilestone(api: APIRequestContext, home: { projectId: number; teamId: number }, label: string, estimateMd: number, dates: { startDate: string; endDate: string }): Promise<{ id: number; name: string }> {
  const { projectId, teamId } = home;
  const name = uniqueText(`e2e-cov-${label}`);
  const id = await create(api, `/api/v1/projects/${projectId}/milestones`, { name, teamId, estimateMd }, "/api/v1/milestones");
  const view = (await (await api.get(`/api/v1/views/team/${teamId}`)).json()) as { revision: number };
  const placed = await api.put(`/api/v1/milestones/${id}/schedule`, { data: { expectedRevision: view.revision, ...dates } });
  expect(placed.status(), await placed.text()).toBe(200);
  return { id, name };
}

async function bind(api: APIRequestContext, connectionId: number, level: "PROJECT" | "MILESTONE", nodeId: number, issueKey: string): Promise<void> {
  await create(api, "/api/v1/integrations/jira/bindings", { connectionId, level, nodeId, issueKey }, "/api/v1/integrations/jira/bindings");
}

/** Saves the mapping the discovery proposes with 0.5 man-days per story point, so the milestones' estimates (4 and 2.5) match COV-3's 8 and COV-4's 5 points and say nothing. */
async function declareHalfManDayPerPoint(api: APIRequestContext, connectionId: number): Promise<void> {
  const path = `${CONNECTIONS}/${connectionId}/mapping`;
  const read = await api.get(path);
  expect(read.status(), await read.text()).toBe(200);
  const { defaults } = (await read.json()) as { defaults: { estimate: { unit: string } } };
  const saved = await api.put(path, { data: { ...defaults, estimate: { ...defaults.estimate, unit: "POINTS", manDaysPerUnit: 0.5 } } });
  expect(saved.status(), await saved.text()).toBe(204);
}

// The administrator that asks for the file's runs: a run rides a per-user bucket, so the file asks as its own account, not the seed administrator's.
let runner: ThrowawayAdmin;
test.beforeAll(async () => {
  test.setTimeout(180_000); // the Test connection call may wait a 429 out (one minute)
  runner = await apiAsThrowawayAdmin("e2e-cov-runner");
  const { api } = await apiAsAdmin();
  try {
    const owner = await create(api, "/api/v1/people", { name: uniqueText("e2e-cov-owner") }, "/api/v1/people");
    const teamId = await create(api, "/api/v1/teams", { name: uniqueText("e2e-cov-team") }, "/api/v1/teams");
    const streamId = await create(api, "/api/v1/work-streams", { name: uniqueText("e2e-cov-stream"), ownerPersonId: owner, startDate: "2046-01-01" }, "/api/v1/work-streams");
    const programId = await create(api, `/api/v1/work-streams/${streamId}/programs`, { name: uniqueText("e2e-cov-program"), ownerPersonId: owner }, "/api/v1/programs");
    const project = uniqueText("e2e-cov-project");
    const projectId = await create(api, `/api/v1/programs/${programId}/projects`, { name: project, ownerPersonId: owner }, "/api/v1/projects");
    // COV-3 runs Mon 2046-03-05 to Fri 03-09, COV-4 Mon 03-19 to Fri 03-23. Epic one ends on Wed 03-14: three working days later (the warning that shares its
    // Flags cell with the roll-up); epic two is in line with Jira. The third milestone is scheduled but linked to nothing in Jira.
    const epicOne = await seedMilestone(api, { projectId, teamId }, "epic-one", 4, { startDate: "2046-03-05", endDate: "2046-03-14" });
    const epicTwo = await seedMilestone(api, { projectId, teamId }, "epic-two", 2.5, { startDate: "2046-03-19", endDate: "2046-03-23" });
    const unlinked = await seedMilestone(api, { projectId, teamId }, "unlinked", 1, { startDate: "2046-04-02", endDate: "2046-04-06" });
    const name = uniqueText("e2e-cov-connection");
    const body = { name, siteUrl: uniqueSite(), email: "e2e-cov@astrolabe.local", apiToken: "e2e-cov-token", authScheme: "BASIC", projectKeys: ["COV"], enabled: true, pollIntervalMinutes: null };
    const connectionId = await create(api, CONNECTIONS, body, CONNECTIONS);
    await testJiraConnectionViaApi(api, connectionId);
    await declareHalfManDayPerPoint(api, connectionId);
    await bind(api, connectionId, "PROJECT", projectId, "COV-2");
    await bind(api, connectionId, "MILESTONE", epicOne.id, "COV-3");
    await bind(api, connectionId, "MILESTONE", epicTwo.id, "COV-4");
    await refreshJiraConnectionViaApi(runner.api, connectionId);
    world = { programId, project, projectId, epicOne: epicOne.name, epicTwo: epicTwo.name, unlinked: unlinked.name, connection: { id: connectionId, name } };
  } finally {
    await api.dispose();
  }
});
test.afterAll(async () => {
  try {
    await deleteViaApi(teardown.splice(0).reverse());
  } finally {
    await runner?.dispose();
  }
});

const SENTENCE_ONE = "4 child issues in Jira, done: 2, story points: 13";
const SENTENCE_TWO = "2 child issues in Jira, done: 2, story points: 5";

const rowsOf = (page: Page) => page.getByRole("table", { name: "Differences between the plan and Jira" }).getByRole("row");
/** The Deviations row of one Jira item, found by its key link (a row's other cells also name keys, e.g. COV-5 in COV-2's sentence). */
const rowOfKey = (page: Page, key: string) => rowsOf(page).filter({ has: page.getByRole("link", { name: `${key} (opens in Jira)` }) });

/** The project page's row of a milestone and, in it, its Flags cell (the cells after the name: team, estimate, Flags, Operations, then the track). */
const timelineRow = (page: Page, name: string) => page.getByRole("grid", { name: "Milestone timeline" }).getByRole("row").filter({ hasText: name });
const flagsCell = (page: Page, name: string): Locator => timelineRow(page, name).getByRole("gridcell").nth(2);

/** The roadmap narrowed to the world's own program (the pick is a browser setting; the page is shared by every spec's projects), its flag panel open. */
async function openRoadmapFlags(page: Page): Promise<Locator> {
  await page.evaluate(([key, value]) => localStorage.setItem(key, value), ["astrolabe.viewSettings.planning.programPick", JSON.stringify([world.programId])]);
  await page.goto("/roadmap");
  await expect(page.getByRole("grid", { name: "Roadmap timeline" })).toBeVisible();
  await expect(page.getByRole("link", { name: `Open ${world.project}`, exact: true })).toBeVisible();
  await page.getByRole("button", { name: /^Show the \d+ flags?$/ }).click();
  return page.getByRole("table", { name: "Flags of the projects shown" });
}

/** An axe scan of the open page in both schemes: the light one as it stands, then the same page re-rendered dark (the `auto` scheme follows the emulated media). */
async function scanLightAndDark(page: Page, what: string): Promise<void> {
  for (const scheme of ["light", "dark"] satisfies Scheme[]) {
    await page.emulateMedia({ colorScheme: scheme });
    await expectScheme(page, scheme);
    expect(await axeViolations(page), `${what}, ${scheme} scheme`).toEqual([]);
  }
}

test("the milestone chips show each epic's story roll-up after a refresh", async ({ page }) => {
  await login(page);
  await page.goto(`/projects/${world.projectId}`);
  await expect(page.getByRole("heading", { level: 2, name: world.project })).toBeVisible();
  await expect(page.getByRole("grid", { name: "Milestone timeline" })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Flags" })).toBeVisible();

  // Epic one: the key, its warning (three working days later than COV-3) and the roll-up LAST - the short text for the eye, the sentence as the accessible name.
  const one = flagsCell(page, world.epicOne);
  await expect(one.getByRole("link", { name: "COV-3 (opens in Jira)" })).toBeVisible();
  const chipOne = one.getByTitle(SENTENCE_ONE);
  await expect(chipOne.locator('[aria-hidden="true"]')).toHaveText("2/4 · 13 pt");
  await expect(chipOne).toContainText(SENTENCE_ONE); // the visually hidden span: the text assistive technology reads instead of the short one
  const warning = one.locator('[data-flags][title*="Jira COV-3: Ends 3 working days later than Jira"]');
  await expect(warning).toHaveCount(1);

  // Epic two: all its children are done, 5 points.
  const twoCell = flagsCell(page, world.epicTwo);
  await expect(twoCell.getByRole("link", { name: "COV-4 (opens in Jira)" })).toBeVisible();
  const chipTwo = twoCell.getByTitle(SENTENCE_TWO);
  await expect(chipTwo.locator('[aria-hidden="true"]')).toHaveText("2/2 · 5 pt");
  await expect(chipTwo).toContainText(SENTENCE_TWO);

  // The unlinked milestone is scheduled, so it has a row and a Flags cell, and the cell is empty.
  await expect(timelineRow(page, world.unlinked)).toHaveCount(1);
  const none = flagsCell(page, world.unlinked);
  await expect(none).toBeEmpty();
  await expect(none.getByTitle(/child issues? in Jira/)).toHaveCount(0);

  // The widened Flags column (210 px while a roll-up shows) does not clip. Epic one's cell is the fullest a row gets (the key, a warning and an info badge, then
  // the roll-up) and epic two's the usual one: neither scrolls wider than it is, and the key and the warning badge end inside the cell.
  for (const [label, cell] of [["one", one], ["two", flagsCell(page, world.epicTwo)]] as const) {
    const fit = await cell.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
    expect(fit.scroll, `epic ${label}'s Flags cell scrolls ${fit.scroll} px in a cell ${fit.client} px wide`).toBeLessThanOrEqual(fit.client);
  }
  const cellBox = await one.boundingBox();
  const flagsBox = await warning.boundingBox();
  const keyBox = await one.getByRole("link", { name: "COV-3 (opens in Jira)" }).boundingBox();
  expect(cellBox, "the Flags cell is laid out").not.toBeNull();
  expect(flagsBox, "the flag badges are laid out").not.toBeNull();
  expect(keyBox, "the key link is laid out").not.toBeNull();
  if (cellBox !== null && flagsBox !== null && keyBox !== null) {
    expect(keyBox.x + keyBox.width, "the key ends inside the Flags cell").toBeLessThanOrEqual(cellBox.x + cellBox.width);
    expect(flagsBox.x + flagsBox.width, "the warning badge ends inside the Flags cell").toBeLessThanOrEqual(cellBox.x + cellBox.width);
  }

  await scanLightAndDark(page, "the project page with the roll-up chips");
});

test("the Deviations page lists the work Jira has that the plan does not, and the reverse", async ({ page }) => {
  await login(page);
  await page.goto(`/deviations?projectId=${world.projectId}`);
  await expect(page.getByRole("heading", { level: 2, name: "Deviations" })).toBeVisible();

  // The project's binding (COV-2): the open Jira epic nobody linked (a warning), and the plan milestone nobody linked to Jira (an info).
  const project = rowOfKey(page, "COV-2");
  await expect(project).toHaveCount(1);
  await expect(project).toContainText("Not in plan");
  await expect(project).toContainText("1 Jira item is not in the plan: COV-5");
  await expect(project).toContainText("Not in Jira");
  await expect(project).toContainText(`1 plan item is not linked to Jira: ${world.unlinked}`);

  // Epic two's binding (COV-4): every child is done while the plan still ends later. The roll-up sits under the Jira item.
  const epicTwo = rowOfKey(page, "COV-4");
  await expect(epicTwo).toHaveCount(1);
  await expect(epicTwo).toContainText("Children done");
  await expect(epicTwo).toContainText(/All 2 child issues are done in Jira while the plan ends 2046-03-23/);
  await expect(epicTwo.getByTitle(SENTENCE_TWO)).toHaveCount(1);
  await expect(rowOfKey(page, "COV-3").getByTitle(SENTENCE_ONE)).toHaveCount(1);

  // COV-10 is done: closed work is history and is named nowhere on the page, in no sentence and in no row.
  await expect(page.getByRole("table", { name: "Differences between the plan and Jira" })).not.toContainText("COV-10");
  await expect(page.getByRole("table", { name: "Differences between the plan and Jira" })).not.toContainText("Epic Four");

  await scanLightAndDark(page, "the Deviations page with the coverage rows");

  // The roadmap, narrowed to the world's program: the same sentence in the open flag panel.
  await page.emulateMedia({ colorScheme: "light" });
  const flags = await openRoadmapFlags(page);
  await expect(flags).toContainText("Jira COV-2: 1 Jira item is not in the plan: COV-5");
  await expect(flags).not.toContainText("COV-10");
});

test("acknowledging the coverage deviation silences the flag", async ({ page }) => {
  const { api } = await apiAsAdmin();
  try {
    await login(page);
    await page.goto(`/deviations?projectId=${world.projectId}&all=false`);
    await expect(page.getByRole("heading", { level: 2, name: "Deviations" })).toBeVisible();
    const project = rowOfKey(page, "COV-2");
    await expect(project).toContainText("1 Jira item is not in the plan: COV-5");
    // Since 1.12 each line has its own button and the batch one takes every open line of the binding (the roadmap's flag entries are per open line, so all of them go).
    await project.getByRole("button", { name: /^Acknowledge all \(\d+\) open deviations of COV-2$/ }).click();
    await expect(project).toHaveCount(0); // the row leaves the Open list; the other bindings' rows stay (nothing else was acknowledged)
    await expect(rowOfKey(page, "COV-3")).toHaveCount(1);
    await expect(rowOfKey(page, "COV-4")).toContainText("Children done");

    // The roadmap's flag entry for the project is gone; the key links of the project page stay.
    const flags = await openRoadmapFlags(page);
    await expect(flags).not.toContainText("Jira COV-2:");
    await page.goto(`/projects/${world.projectId}`);
    await expect(page.getByRole("link", { name: "COV-3 (opens in Jira)" })).toBeVisible();
    await expect(page.getByRole("link", { name: "COV-4 (opens in Jira)" })).toBeVisible();

    // A new run reads the same coverage again: the acknowledgement was of exactly these deviations, so nothing is reopened.
    await refreshJiraConnectionViaApi(runner.api, world.connection.id);
    await page.goto(`/deviations?projectId=${world.projectId}&all=false`);
    await expect(rowOfKey(page, "COV-3")).toHaveCount(1);
    await expect(rowOfKey(page, "COV-2")).toHaveCount(0);
    const reopened = await openRoadmapFlags(page);
    await expect(reopened).not.toContainText("Jira COV-2:");
  } finally {
    await api.dispose();
  }
});
