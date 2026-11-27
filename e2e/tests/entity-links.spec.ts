// Every entity name is a link (1.31): a work stream, program, project, milestone, team or person name leads to what it stands for, walked by real clicks and read at the
// landing page. The Plan tree sends a work stream or program name to the Roadmap overview narrowed to it, a project name to its page and an owner to the person's page; on the
// project page a milestone of ANOTHER project (the Dependencies table) lands on that project with the milestone's row marked and focused, the team, program, work stream
// and owner names go where they say; the team page's milestone and manager names do the same; a regular user follows the names too, and a baseline's author is a link to
// their person's page only when the login has one (a login's own edit page is the ADMIN's, so for a user it is text); the Roadmap's project row menu offers "Open program"
// to the keyboard; a link in a table or a Gantt's left pane is the brand colour and underlines on hover and keyboard focus (1.37). Nothing is written by the tests themselves: the world (below) is seeded once through the API and only navigated. Owns: its throwaway people, team,
// two work streams (one is the decoy the narrowing must leave out) with a program each, three projects, two scheduled milestones (2027-05, the link between them holds, so
// no figure depends on a holiday: no far-off year, no lock), one regular user, all `e2e-el-*`, seeded in the beforeAll and removed in the afterAll through the API, children
// first; and, in the user test alone, two throwaway administrators with a baseline each and one person linked to one of them (removed in that test's finally). It never
// touches the global ranking: its projects stay unranked.
import { randomUUID } from "node:crypto";
import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { apiAsAdmin, apiAsThrowawayAdmin, deleteViaApi, expect, login, test, uniqueText } from "./helpers";

interface World {
  viewer: { email: string; password: string };
  stream: string;
  streamId: number;
  program: string;
  programId: number;
  decoyProgram: string;
  project: string;
  projectId: number;
  other: string;
  otherId: number;
  milestone: string;
  otherMilestone: string;
  team: string;
  teamId: number;
  projectOwner: string;
  manager: string;
}

let world: World;

// Registered in creation order; torn down in reverse (a project before its program before its stream before the team and the people).
const teardown: string[] = [];
test.afterAll(async () => {
  await deleteViaApi(teardown.splice(0).reverse());
});

async function seed(api: APIRequestContext, path: string, data: object, tear: string | null): Promise<number> {
  const response = await api.post(path, { data });
  expect(response.status(), await response.text()).toBe(201);
  const id = ((await response.json()) as { id: number }).id;
  if (tear !== null) teardown.push(`${tear}/${id}`);
  return id;
}

/** A schedule write as the ADMIN, with the project view's current revision. */
async function schedule(api: APIRequestContext, projectId: number, milestoneId: number, startDate: string, endDate: string): Promise<void> {
  const view = await api.get(`/api/v1/views/project/${projectId}`);
  const { revision } = (await view.json()) as { revision: number };
  const response = await api.put(`/api/v1/milestones/${milestoneId}/schedule`, { data: { expectedRevision: revision, startDate, endDate } });
  expect(response.status(), await response.text()).toBe(200);
}

/**
 * Work stream S (program G: projects P and O, each with one scheduled milestone on team T; O's milestone is P's predecessor, so P's Dependencies table names a
 * milestone of another project) and a decoy work stream with a program and a project. The owners and the manager are three people without a login; a regular user is
 * the fourth login.
 */
async function seedWorld(): Promise<World> {
  const { api } = await apiAsAdmin();
  try {
    const lead = uniqueText("e2e-el-lead");
    const projectOwner = uniqueText("e2e-el-owner");
    const manager = uniqueText("e2e-el-manager");
    const leadId = await seed(api, "/api/v1/people", { name: lead }, "/api/v1/people");
    const ownerId = await seed(api, "/api/v1/people", { name: projectOwner }, "/api/v1/people");
    const managerId = await seed(api, "/api/v1/people", { name: manager }, "/api/v1/people");
    const viewerName = uniqueText("e2e-el-viewer");
    const viewer = { email: `${viewerName.toLowerCase()}@astrolabe.local`, password: randomUUID().replace(/-/g, "") };
    await seed(api, "/api/v1/users", { name: viewerName, email: viewer.email, password: viewer.password }, "/api/v1/users");
    const team = uniqueText("e2e-el-team");
    const teamId = await seed(api, "/api/v1/teams", { name: team, managerPersonId: managerId }, "/api/v1/teams");
    const stream = uniqueText("e2e-el-stream");
    const streamId = await seed(api, "/api/v1/work-streams", { name: stream, ownerPersonId: leadId, startDate: "2026-01-05" }, "/api/v1/work-streams");
    const program = uniqueText("e2e-el-program");
    const programId = await seed(api, `/api/v1/work-streams/${streamId}/programs`, { name: program, ownerPersonId: leadId }, "/api/v1/programs");
    const project = uniqueText("e2e-el-project");
    const other = uniqueText("e2e-el-other");
    const projectId = await seed(api, `/api/v1/programs/${programId}/projects`, { name: project, ownerPersonId: ownerId }, "/api/v1/projects");
    const otherId = await seed(api, `/api/v1/programs/${programId}/projects`, { name: other, ownerPersonId: ownerId }, "/api/v1/projects");
    const milestone = uniqueText("e2e-el-ms-p");
    const otherMilestone = uniqueText("e2e-el-ms-o");
    const milestoneId = await seed(api, `/api/v1/projects/${projectId}/milestones`, { name: milestone, teamId, estimateMd: 3 }, null);
    const otherMilestoneId = await seed(api, `/api/v1/projects/${otherId}/milestones`, { name: otherMilestone, teamId, estimateMd: 3 }, null);
    await schedule(api, otherId, otherMilestoneId, "2027-05-03", "2027-05-07");
    await schedule(api, projectId, milestoneId, "2027-05-10", "2027-05-14");
    // A link is written on its successor's project (the milestones go with their projects, the link with its successor).
    await seed(api, `/api/v1/projects/${projectId}/dependencies`, { predecessor: { kind: "MILESTONE", id: otherMilestoneId }, successor: { kind: "MILESTONE", id: milestoneId }, type: "FS", lagDays: 0 }, null);
    const decoyStream = await seed(api, "/api/v1/work-streams", { name: uniqueText("e2e-el-decoy-stream"), ownerPersonId: leadId, startDate: "2026-01-05" }, "/api/v1/work-streams");
    const decoyProgram = uniqueText("e2e-el-decoy-program");
    const decoyProgramId = await seed(api, `/api/v1/work-streams/${decoyStream}/programs`, { name: decoyProgram, ownerPersonId: leadId }, "/api/v1/programs");
    await seed(api, `/api/v1/programs/${decoyProgramId}/projects`, { name: uniqueText("e2e-el-decoy-project"), ownerPersonId: ownerId }, "/api/v1/projects");
    return { viewer, stream, streamId, program, programId, decoyProgram, project, projectId, other, otherId, milestone, otherMilestone, team, teamId, projectOwner, manager };
  } finally {
    await api.dispose();
  }
}

test.beforeAll(async () => {
  world = await seedWorld();
});

const heading = (page: Page, name: string) => page.getByRole("heading", { level: 2, name, exact: true });
const link = (scope: Page | Locator, kind: string, name: string) => scope.getByRole("link", { name: `Open ${kind} ${name}`, exact: true });
const treeRow = (page: Page, kind: "workStream" | "program" | "project", name: string) => page.locator(`tr[data-scope="tree"][data-kind="${kind}"]`).filter({ hasText: name });
const overview = (page: Page) => page.getByRole("grid", { name: "Programs timeline", exact: true });
const nodeButton = (page: Page, label: string) => overview(page).getByRole("button", { name: label, exact: true });

async function openPlan(page: Page): Promise<void> {
  await page.goto("/plan");
  await expect(treeRow(page, "project", world.project)).toBeVisible();
}

async function openTeam(page: Page): Promise<void> {
  await page.goto(`/teams/${world.teamId}`);
  await expect(heading(page, world.team)).toBeVisible();
}

async function openProject(page: Page, id: number, name: string): Promise<void> {
  await page.goto(`/projects/${id}`);
  await expect(heading(page, name)).toBeVisible();
  await expect(page.getByRole("grid", { name: "Milestone timeline", exact: true })).toBeVisible();
}

/** The landing page of a milestone's address: its project, the timeline row header marked (`aria-current`) and focused, the parameter gone. */
async function expectMilestoneMarked(page: Page, projectId: number, projectName: string, milestone: string): Promise<void> {
  await expect(heading(page, projectName)).toBeVisible();
  const header = page.getByRole("grid", { name: "Milestone timeline", exact: true }).getByRole("rowheader", { name: new RegExp(`^${milestone}`) });
  await expect(header).toHaveAttribute("aria-current", "true");
  await expect(header).toBeFocused();
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}$`));
}

test("from the Plan tree a work stream or program name opens the Roadmap overview narrowed to it, a project name its page and an owner name their page", async ({ page }) => {
  await login(page);
  await openPlan(page);

  // A work stream: the overview narrowed to it - its program and project, not the decoy stream's program.
  await link(treeRow(page, "workStream", world.stream), "work stream", world.stream).click();
  await expect(page).toHaveURL(new RegExp(`/roadmap\\?mode=overview&workStreamId=${world.streamId}$`));
  await expect(page.getByText(`Work stream: ${world.stream}`, { exact: true })).toBeVisible();
  await expect(nodeButton(page, `Program ${world.program}`)).toBeVisible();
  await expect(link(overview(page), "project", world.project)).toBeVisible();
  await expect(nodeButton(page, `Program ${world.decoyProgram}`)).toHaveCount(0);

  // A program: the overview narrowed to that program.
  await page.goBack();
  await link(treeRow(page, "program", world.program), "program", world.program).click();
  await expect(page).toHaveURL(new RegExp(`/roadmap\\?mode=overview&programId=${world.programId}$`));
  await expect(nodeButton(page, `Program ${world.program}`)).toBeVisible();
  await expect(nodeButton(page, `Program ${world.decoyProgram}`)).toHaveCount(0);

  // A project: its page.
  await page.goBack();
  await link(treeRow(page, "project", world.project), "project", world.project).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${world.projectId}$`));
  await expect(heading(page, world.project)).toBeVisible();

  // An owner: the person's page.
  await page.goBack();
  await link(treeRow(page, "project", world.project), "person", world.projectOwner).click();
  await expect(page).toHaveURL(/\/people\/\d+$/);
  await expect(heading(page, world.projectOwner)).toBeVisible();
});

test("on the project page a milestone of another project opens that project with its row marked, and the team, program, work stream and owner names go where they say", async ({ page }) => {
  await login(page);
  await openProject(page, world.projectId, world.project);

  // The Dependencies table names the predecessor's milestone and its project: the milestone name lands on the other project with the row marked and focused.
  await link(page.getByRole("table", { name: "Dependencies of the project", exact: true }), "milestone", world.otherMilestone).click();
  await expectMilestoneMarked(page, world.otherId, world.other, world.otherMilestone);

  // The team of a milestone, in the timeline's Team column: the team's page.
  await openProject(page, world.projectId, world.project);
  await link(page.getByRole("grid", { name: "Milestone timeline", exact: true }), "team", world.team).first().click();
  await expect(page).toHaveURL(/\/teams\/\d+$/);
  await expect(heading(page, world.team)).toBeVisible();

  // The header's program and work stream: the overview narrowed to each; the owner: the person's page.
  await openProject(page, world.projectId, world.project);
  await link(page, "program", world.program).click();
  await expect(page).toHaveURL(new RegExp(`/roadmap\\?mode=overview&programId=${world.programId}$`));
  await expect(nodeButton(page, `Program ${world.program}`)).toBeVisible();
  await openProject(page, world.projectId, world.project);
  await link(page, "work stream", world.stream).click();
  await expect(page).toHaveURL(new RegExp(`/roadmap\\?mode=overview&workStreamId=${world.streamId}$`));
  await expect(page.getByText(`Work stream: ${world.stream}`, { exact: true })).toBeVisible();
  await openProject(page, world.projectId, world.project);
  await link(page, "person", world.projectOwner).click();
  await expect(page).toHaveURL(/\/people\/\d+$/);
  await expect(heading(page, world.projectOwner)).toBeVisible();
});

test("a name link in a table or in a Gantt's left pane is the brand colour and underlines on hover and keyboard focus, the header's link stays text-coloured and underlined (1.37)", async ({ page }) => {
  await login(page);
  await openProject(page, world.projectId, world.project);
  const ink = (target: Locator) => target.evaluate((element) => getComputedStyle(element).color);
  const bodyInk = await page.evaluate(() => getComputedStyle(document.body).color);

  // The header's link sits in a sentence, outside every table: the text colour, underlined always.
  const header = link(page, "program", world.program);
  await expect(header).toHaveCSS("text-decoration-line", "underline");
  expect(await ink(header)).toBe(bodyInk);

  // A table's link (the Dependencies table's milestone) and the Gantt's left pane link (the Team column): another colour, no underline at rest.
  const tableLink = link(page.getByRole("table", { name: "Dependencies of the project", exact: true }), "milestone", world.otherMilestone);
  const paneLink = link(page.getByRole("grid", { name: "Milestone timeline", exact: true }), "team", world.team).first();
  for (const target of [tableLink, paneLink]) {
    expect(await ink(target)).not.toBe(bodyInk);
    await expect(target).toHaveCSS("text-decoration-line", "none");
    // Hover underlines it; the pointer away takes the underline off.
    await target.hover();
    await expect(target).toHaveCSS("text-decoration-line", "underline");
    await page.mouse.move(0, 0);
    await expect(target).toHaveCSS("text-decoration-line", "none");
  }

  // Keyboard focus underlines the table's link too: Shift+Tab away, Tab back, so the browser counts it as a keyboard focus (:focus-visible).
  await tableLink.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(tableLink).toBeFocused();
  await expect(tableLink).toHaveCSS("text-decoration-line", "underline");
});

test("on the team page a milestone name opens its project with the row marked and the manager name opens their page", async ({ page }) => {
  await login(page);
  await openTeam(page);
  await link(page.getByRole("grid", { name: "Team milestone timeline", exact: true }), "milestone", world.milestone).click();
  await expectMilestoneMarked(page, world.projectId, world.project, world.milestone);

  await openTeam(page);
  await link(page, "person", world.manager).click();
  await expect(page).toHaveURL(/\/people\/\d+$/);
  await expect(heading(page, world.manager)).toBeVisible();
});

test("a regular user follows the names to the plan, the project and the team, and a baseline author is a link to their person only when the login has one", async ({ page }) => {
  const linked = await apiAsThrowawayAdmin("e2e-el-linked");
  const bare = await apiAsThrowawayAdmin("e2e-el-bare");
  const local: string[] = [];
  try {
    // Two baselines, taken by two administrators: one linked to a person (its author is that person's name and page), one linked to none (its author is the login's own name).
    const { api } = await apiAsAdmin();
    try {
      const personId = await seed(api, "/api/v1/people", { name: uniqueText("e2e-el-author"), userId: linked.userId }, null);
      local.push(`/api/v1/people/${personId}`);
    } finally {
      await api.dispose();
    }
    const take = async (taker: typeof linked, label: string) => {
      const name = uniqueText(`e2e-el-baseline-${label}`);
      const response = await taker.api.post("/api/v1/baselines", { data: { name } });
      expect(response.status(), await response.text()).toBe(201);
      const body = (await response.json()) as { id: number; createdBy: { name: string; personId: number | null } };
      local.push(`/api/v1/baselines/${body.id}`);
      return { name, author: body.createdBy.name, personId: body.createdBy.personId };
    };
    const withPerson = await take(linked, "linked");
    const withoutPerson = await take(bare, "bare");
    expect(withPerson.personId).not.toBeNull();
    expect(withoutPerson.personId).toBeNull();

    await login(page, world.viewer.email, world.viewer.password);
    // The plan, the project page and the team page: the names are links for a user with no right to edit anything.
    await page.goto("/plan");
    await expect(link(treeRow(page, "workStream", world.stream), "work stream", world.stream)).toBeVisible();
    await expect(link(treeRow(page, "project", world.project), "project", world.project)).toBeVisible();
    await openProject(page, world.projectId, world.project);
    await expect(link(page, "program", world.program)).toBeVisible();
    await expect(link(page.getByRole("grid", { name: "Milestone timeline", exact: true }), "team", world.team).first()).toBeVisible();
    await openTeam(page);
    await expect(link(page.getByRole("grid", { name: "Team milestone timeline", exact: true }), "milestone", world.milestone)).toBeVisible();
    await expect(link(page, "person", world.manager)).toBeVisible();

    // A baseline's author: the person's page when the login has a person; the bare login is text (its edit page is the administrator's) and no "Open user" link exists.
    await page.goto("/baselines");
    const linkedRow = page.getByRole("row").filter({ hasText: withPerson.name });
    const bareRow = page.getByRole("row").filter({ hasText: withoutPerson.name });
    await expect(bareRow.getByText(withoutPerson.author, { exact: true })).toBeVisible();
    await expect(bareRow.getByRole("link", { name: /^Open (person|user) / })).toHaveCount(0);
    await expect(page.getByRole("link", { name: /^Open user / })).toHaveCount(0);
    await link(linkedRow, "person", withPerson.author).click();
    await expect(page).toHaveURL(new RegExp(`/people/${withPerson.personId}$`));
    await expect(heading(page, withPerson.author)).toBeVisible();
  } finally {
    try {
      await deleteViaApi(local.reverse());
    } finally {
      await linked.dispose();
      await bare.dispose();
    }
  }
});

test("on the Roadmap a project row menu offers Open program, and Enter on it opens that program in the overview", async ({ page }) => {
  await login(page);
  await page.goto(`/roadmap?mode=prioritization&programId=${world.programId}`);
  const row = page.getByRole("grid", { name: "Roadmap timeline", exact: true }).getByRole("row").filter({ has: link(page, "project", world.project) });
  await expect(row).toBeVisible();

  // The keyboard path: the menu button takes Enter, ArrowDown walks to the item (a bounded walk: the items before it vary with the viewer's rights), Enter follows it.
  const trigger = page.getByRole("button", { name: `Operations for ${world.project}`, exact: true });
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  const item = page.getByRole("menuitem", { name: `Open program ${world.program}`, exact: true });
  for (let step = 0; step < 12 && !(await item.evaluate((element) => element === document.activeElement)); step++) await page.keyboard.press("ArrowDown");
  await expect(item).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/roadmap\\?mode=overview&programId=${world.programId}$`));
  await expect(nodeButton(page, `Program ${world.program}`)).toBeVisible();
  await expect(nodeButton(page, `Program ${world.decoyProgram}`)).toHaveCount(0);
});
