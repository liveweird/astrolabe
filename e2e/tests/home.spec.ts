// The Home page (/): "Yours" lists what the signed-in login's linked person may manage through the owner chain (what they own and everything under a
// work stream or program they own, each row naming its owner) and the teams that person manages, with what is flagged and not scheduled, and a name
// opens its page; a switch narrows the lists to what the person owns themselves; the cards show the plan's figures, and a login without a person is
// told so. The plan is shared by four workers, so a plan-wide figure is only ever asserted PRESENT (a number with its word), never as a value; "Yours" is
// the throwaway owner's own and is asserted exactly. Owns: its two throwaway logins (`e2e-home-owner-*`, `e2e-home-nobody-*`), the owner's person, one
// team that person manages, one work stream, program and project that person owns (the project with the target window 2027-03-01..05), two milestones
// of the project on the team (one scheduled 2027-03-08..12, one left unscheduled) and a second person without a login (`e2e-home-other-*`) who owns a
// second, milestone-less project in the owner's program, unique `e2e-home-*` names, all seeded through the API in the beforeAll and removed in
// the afterAll through the API (the second project and its person, the milestones, the project, the program, the stream, the team, the owner's person, the
// users), even after a failure. Dated March 2027 on purpose: the two flags it
// pins are drift in CALENDAR days (the end 7 days late is a warning, the start 7 days late an info), so no holiday and no far-off year is needed; it
// writes no ranking, no holiday and no connection, and needs no lock.
import { randomUUID } from "node:crypto";
import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { apiAsAdmin, axeViolations, deleteViaApi, expect, login, openFilters, test, uniqueText } from "./helpers";

interface Account {
  email: string;
  password: string;
}

interface World {
  owner: Account;
  nobody: Account;
  personName: string;
  stream: string;
  program: string;
  project: string;
  otherPersonName: string;
  otherProject: string;
  team: string;
  unscheduled: string;
}

let world: World;

// Registered in creation order; torn down in reverse (a project before its program before its stream before the team and the people).
const teardown: string[] = [];
test.afterAll(async () => {
  await deleteViaApi(teardown.splice(0).reverse());
});

async function seed(api: APIRequestContext, path: string, data: object, tear: string): Promise<number> {
  const response = await api.post(path, { data });
  expect(response.status(), await response.text()).toBe(201);
  const id = ((await response.json()) as { id: number }).id;
  teardown.push(`${tear}/${id}`);
  return id;
}

async function seedUser(api: APIRequestContext, label: string): Promise<{ id: number; account: Account }> {
  const name = uniqueText(`e2e-home-${label}`);
  const account = { email: `${name.toLowerCase()}@astrolabe.local`, password: randomUUID().replace(/-/g, "") };
  const id = await seed(api, "/api/v1/users", { name, email: account.email, password: account.password }, "/api/v1/users");
  return { id, account };
}

/**
 * The owner login with its person, who owns the work stream, the program and the project (target window 2027-03-01..05) and manages the team, and two
 * milestones of that team in the project: one scheduled 2027-03-08..12 (the end 7 days late: a warning, the start 7 days late: an info), one unscheduled.
 * A second person, linked to no login, owns a second project (no milestone) in the owner's program: it is in the owner's "Yours" because the owner owns the
 * program above it, but not owned by the owner themselves. A second login is linked to no person.
 */
async function seedWorld(): Promise<World> {
  const { api } = await apiAsAdmin();
  try {
    const owner = await seedUser(api, "owner");
    const nobody = await seedUser(api, "nobody");
    const personName = uniqueText("e2e-home-person");
    const person = await seed(api, "/api/v1/people", { name: personName, userId: owner.id }, "/api/v1/people");
    const team = uniqueText("e2e-home-team");
    const teamId = await seed(api, "/api/v1/teams", { name: team, managerPersonId: person }, "/api/v1/teams");
    const stream = uniqueText("e2e-home-stream");
    const streamId = await seed(api, "/api/v1/work-streams", { name: stream, ownerPersonId: person, startDate: "2026-01-05" }, "/api/v1/work-streams");
    const program = uniqueText("e2e-home-program");
    const programId = await seed(api, `/api/v1/work-streams/${streamId}/programs`, { name: program, ownerPersonId: person }, "/api/v1/programs");
    const project = uniqueText("e2e-home-project");
    const projectId = await seed(
      api,
      `/api/v1/programs/${programId}/projects`,
      { name: project, ownerPersonId: person, targetStart: "2027-03-01", targetEnd: "2027-03-05" },
      "/api/v1/projects",
    );
    const scheduled = await seed(api, `/api/v1/projects/${projectId}/milestones`, { name: uniqueText("e2e-home-scheduled"), teamId, estimateMd: 2 }, "/api/v1/milestones");
    const unscheduled = uniqueText("e2e-home-unscheduled");
    await seed(api, `/api/v1/projects/${projectId}/milestones`, { name: unscheduled, teamId, estimateMd: 1 }, "/api/v1/milestones");
    const otherPersonName = uniqueText("e2e-home-other");
    const otherPerson = await seed(api, "/api/v1/people", { name: otherPersonName }, "/api/v1/people");
    const otherProject = uniqueText("e2e-home-other-project");
    await seed(api, `/api/v1/programs/${programId}/projects`, { name: otherProject, ownerPersonId: otherPerson }, "/api/v1/projects");
    const view = await api.get(`/api/v1/views/project/${projectId}`);
    const { revision } = (await view.json()) as { revision: number };
    const put = await api.put(`/api/v1/milestones/${scheduled}/schedule`, { data: { expectedRevision: revision, startDate: "2027-03-08", endDate: "2027-03-12" } });
    expect(put.status(), await put.text()).toBe(200);
    return { owner: owner.account, nobody: nobody.account, personName, stream, program, project, otherPersonName, otherProject, team, unscheduled };
  } finally {
    await api.dispose();
  }
}

test.beforeAll(async () => {
  world = await seedWorld();
});

/** The table under "Yours" with this accessible name (the scroll region around it carries the same name, hence the role). */
const table = (page: Page, name: string) => page.getByRole("table", { name, exact: true });
/** The body rows of a table (not its header row); cells are read by column position. */
const bodyRows = (list: Locator) => list.locator("tbody tr");
/** The row of "Your projects" whose name link is this project's (the order of unranked rows is by name, so a position says nothing). */
const projectRowOf = (page: Page, project: string) =>
  bodyRows(table(page, "Your projects")).filter({ has: page.getByRole("link", { name: `Open ${project}`, exact: true }) });

// The Home page: "Yours" is what the signed-in login's linked person may manage through the owner chain, each row naming its owner. Every row below is
// the throwaway owner's chain, so the counts are exact; the plan-wide figures of the cards are not asserted here (scenario two, and vitest, pin their
// presence and values).
test("the Home page shows a person the projects, teams, programs and work streams that are theirs, with what is flagged and not scheduled, and a name opens its page", async ({ page }) => {
  await login(page, world.owner.email, world.owner.password);
  await expect(page.getByRole("heading", { level: 3, name: "Yours", exact: true })).toBeVisible();
  await expect(page.getByText(`Your login is linked to the person ${world.personName}.`, { exact: true })).toBeVisible();

  // The owner's own project and the second person's project below the owner's program: two rows, each naming its owner, both unranked.
  const projects = table(page, "Your projects");
  await expect(bodyRows(projects)).toHaveCount(2);
  const projectRow = projectRowOf(page, world.project);
  await expect(projectRow.getByRole("link", { name: `Open ${world.project}`, exact: true })).toHaveText(world.project);
  await expect(projectRow.getByRole("cell").nth(1)).toHaveText(world.program);
  await expect(projectRow.getByRole("cell").nth(2)).toHaveText(world.personName);
  await expect(projectRow.getByRole("cell").nth(3)).toHaveText("Unranked");
  await expect(projectRow.getByRole("cell").nth(4)).toHaveText("2");
  await expect(projectRow.getByRole("cell").nth(5)).toHaveText("1");
  await expect(projectRow.getByText("1 warning", { exact: true })).toBeVisible();
  await expect(projectRow.getByText("1 info", { exact: true })).toBeVisible();
  const otherRow = projectRowOf(page, world.otherProject);
  await expect(otherRow.getByRole("cell").nth(1)).toHaveText(world.program);
  await expect(otherRow.getByRole("cell").nth(2)).toHaveText(world.otherPersonName);
  await expect(otherRow.getByRole("cell").nth(3)).toHaveText("Unranked");
  await expect(otherRow.getByRole("cell").nth(4)).toHaveText("0");

  const teams = table(page, "Your teams");
  await expect(bodyRows(teams)).toHaveCount(1);
  const teamRow = bodyRows(teams).first();
  await expect(teamRow.getByRole("link", { name: `Open team ${world.team}`, exact: true })).toHaveText(world.team);
  await expect(teamRow.getByRole("cell").nth(1)).toHaveText("2");
  await expect(teamRow.getByRole("cell").nth(2)).toHaveText("1");

  // Work streams first, then programs; each rolls up the two projects below it and names its owner.
  const nodes = table(page, "Your programs and work streams");
  await expect(bodyRows(nodes)).toHaveCount(2);
  const streamRow = bodyRows(nodes).nth(0);
  await expect(streamRow.getByRole("cell").nth(0)).toHaveText(world.stream);
  await expect(streamRow.getByRole("cell").nth(1)).toHaveText("Work stream");
  await expect(streamRow.getByRole("cell").nth(3)).toHaveText(world.personName);
  await expect(streamRow.getByRole("cell").nth(4)).toHaveText("1");
  await expect(streamRow.getByRole("cell").nth(5)).toHaveText("2");
  await expect(streamRow.getByText("1 warning", { exact: true })).toBeVisible();
  await expect(streamRow.getByText("1 info", { exact: true })).toBeVisible();
  const programRow = bodyRows(nodes).nth(1);
  await expect(programRow.getByRole("cell").nth(0)).toHaveText(world.program);
  await expect(programRow.getByRole("cell").nth(1)).toHaveText("Program");
  await expect(programRow.getByRole("cell").nth(2)).toHaveText(world.stream);
  await expect(programRow.getByRole("cell").nth(3)).toHaveText(world.personName);
  await expect(programRow.getByRole("cell").nth(5)).toHaveText("2");
  await expect(programRow.getByText("1 warning", { exact: true })).toBeVisible();
  await expect(programRow.getByText("1 info", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open the programs", exact: true })).toBeVisible();
  await expect(page.getByText(/^Listed below: what you own, everything under a work stream or program you own/)).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);

  // A name opens its page; Home is one click away from either.
  await projectRow.getByRole("link", { name: `Open ${world.project}`, exact: true }).click();
  await expect(page.getByRole("heading", { level: 2, name: world.project, exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Home", exact: true }).click();
  await teamRow.getByRole("link", { name: `Open team ${world.team}`, exact: true }).click();
  await expect(page.getByRole("heading", { level: 2, name: world.team, exact: true })).toBeVisible();
});

// The person-less login owns nothing here, so the page can only say so; the cards still show the plan's figures (present, never a value: four workers
// share the plan).
test("the Home page shows the plan in figures on its cards and tells a login without a person that nothing is linked to it", async ({ page }) => {
  await login(page, world.nobody.email, world.nobody.password);
  await expect(page.getByText(/^Your login is not linked to a person/)).toBeVisible();

  const plan = page.getByRole("group", { name: "The plan in figures", exact: true });
  await expect(plan.getByText(/^\d+ projects?$/)).toBeVisible();
  await expect(plan.getByText(/^\d+ milestones?$/)).toBeVisible();
  const roadmap = page.getByRole("group", { name: "The roadmap in figures", exact: true });
  await expect(roadmap.getByText(/^\d+ ranked$/)).toBeVisible();

  await expect(page.getByRole("table")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Open the People page", exact: true })).toHaveCount(0);
});

// A figure under "Yours" is a link to the list it counts (1.19): the project's and the team's "1 not scheduled" open the Milestones page for that project
// or team, and "Open the projects you own yourself on the roadmap" opens the Roadmap filtered to the projects the owner owns themselves (not the second
// person's project below their program). Every list is narrowed by an id of the throwaway owner's own, so the rows are counted exactly; the plan-wide
// figures of the cards are not touched here.
test("a figure under Yours opens the list it counts, and the owner's projects open on the roadmap filtered to them", async ({ page }) => {
  await login(page, world.owner.email, world.owner.password);
  const teams = table(page, "Your teams");
  const milestones = page.getByRole("table", { name: "Milestones", exact: true }).locator("tbody tr");

  // The project's count opens the Milestones page for that project, "Not scheduled": one row, the unscheduled milestone.
  await projectRowOf(page, world.project).getByRole("link", { name: `1 not scheduled: ${world.project}`, exact: true }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Milestones", exact: true })).toBeVisible();
  await expect(page.getByText(`Project: ${world.project}`, { exact: true })).toBeVisible();
  await openFilters(page);
  await expect(page.getByRole("combobox", { name: "Schedule", exact: true })).toHaveValue("Not scheduled");
  await expect(milestones).toHaveCount(1);
  await expect(milestones.first()).toContainText(world.unscheduled);

  // Back on Home: the projects the owner owns themselves on the roadmap - one project row (the second person's project is not among them), and the Owner
  // filter shows the person.
  await page.getByRole("link", { name: "Home", exact: true }).click();
  await page.getByRole("link", { name: "Open the projects you own yourself on the roadmap", exact: true }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Roadmap", exact: true })).toBeVisible();
  const roadmap = page.getByRole("grid", { name: "Roadmap timeline", exact: true });
  await expect(roadmap.getByRole("link", { name: `Open ${world.project}`, exact: true })).toBeVisible();
  await expect(roadmap.getByRole("link", { name: `Open ${world.otherProject}`, exact: true })).toHaveCount(0);
  await expect(roadmap.locator('a[href^="/projects/"]')).toHaveCount(1);
  await openFilters(page);
  await expect(page.getByRole("combobox", { name: "Owner", exact: true })).toHaveValue(world.personName);

  // Back on Home: the team's count opens the Milestones page for that team: one row, on that team.
  await page.getByRole("link", { name: "Home", exact: true }).click();
  await bodyRows(teams).first().getByRole("link", { name: `1 not scheduled: ${world.team}`, exact: true }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Milestones", exact: true })).toBeVisible();
  await expect(milestones).toHaveCount(1);
  await expect(milestones.first().getByRole("link", { name: `Open team ${world.team}`, exact: true })).toBeVisible();
  await expect(milestones.first()).toContainText(world.unscheduled);
});

// "Only what I own myself" (1.23) narrows both tables to the rows that are the person's own: the second person's project goes, the owner's project, the
// work stream and the program stay (a program the owner owns is theirs), the team table is untouched; the choice survives a reload (it is kept in this
// browser, and each test has its own). A table the switch empties (a login that owns only what sits under a program) needs a second login: vitest.
test("the Home page can narrow Yours to what the person owns themselves, and remembers the choice in this browser", async ({ page }) => {
  await login(page, world.owner.email, world.owner.password);
  const toggle = page.getByRole("switch", { name: "Only what I own myself", exact: true });
  await expect(toggle).not.toBeChecked();
  await expect(bodyRows(table(page, "Your projects"))).toHaveCount(2);

  await toggle.click();
  await expect(toggle).toBeChecked();
  await expect(page.getByText("Listed below: what you own yourself and the teams you manage.", { exact: true })).toBeVisible();
  await expect(bodyRows(table(page, "Your projects"))).toHaveCount(1);
  await expect(projectRowOf(page, world.project)).toHaveCount(1);
  await expect(projectRowOf(page, world.otherProject)).toHaveCount(0);
  await expect(bodyRows(table(page, "Your programs and work streams"))).toHaveCount(2);
  await expect(bodyRows(table(page, "Your teams"))).toHaveCount(1);
  await expect(page.getByRole("link", { name: "Open the projects you own yourself on the roadmap", exact: true })).toBeVisible();

  // Remembered: after a reload the switch is on and the second project is still out.
  await page.reload();
  await expect(page.getByRole("switch", { name: "Only what I own myself", exact: true })).toBeChecked();
  await expect(bodyRows(table(page, "Your projects"))).toHaveCount(1);
  await expect(projectRowOf(page, world.otherProject)).toHaveCount(0);

  await page.getByRole("switch", { name: "Only what I own myself", exact: true }).click();
  await expect(page.getByRole("switch", { name: "Only what I own myself", exact: true })).not.toBeChecked();
  await expect(bodyRows(table(page, "Your projects"))).toHaveCount(2);
  await expect(projectRowOf(page, world.otherProject)).toHaveCount(1);
});
