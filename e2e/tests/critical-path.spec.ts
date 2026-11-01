// The critical path and the idle gaps (v0.7) on the project and team pages: the owner of a project that depends on a two-project chain
// X -> Y -> P turns the "Critical path" toggle on and reads the server's figures - the zero-slack milestone and the neighbouring ghost row
// emphasised, the critical arrow and badge, the Slack column, and the Critical chain list naming the member BEYOND the neighbour (x1, two
// hops away, a milestone with no row on P's timeline); the toggle survives a reload and takes everything away when it goes off. The same
// world has a five-working-day hole in P's schedule: the hatched idle band, the Idle gaps table and the badge on P's page and on the page of
// P's team. Owns: its throwaway user, people, two teams, plan nodes (unique `e2e-cp-*` names), all seeded through the API and deleted by
// the afterEach below (the projects first - their milestones and links go with them - then program, work stream, teams, people, user).
// Every date is in 2041 and nothing else in the suite touches that year: the holiday dictionary is global, and `public-holidays.spec.ts`
// owns 2040, so the working-day figures asserted here (slack, idle gaps) can never see a holiday.
import { randomUUID } from "node:crypto";
import type { APIRequestContext, Page } from "@playwright/test";
import { apiAsAdmin, deleteViaApi, expect, login, test, uniqueText } from "./helpers";

// Registered in creation order; torn down in reverse (the projects before their program before its stream before the teams and the people).
const teardown: string[] = [];
test.afterEach(async () => {
  await deleteViaApi(teardown.splice(0).reverse());
});

// Three consecutive Monday-to-Friday weeks of 2041 (2041-01-07 is a Monday).
const WEEK_1 = { start: "2041-01-07", end: "2041-01-11" };
const WEEK_2 = { start: "2041-01-14", end: "2041-01-18" };
const WEEK_3 = { start: "2041-01-21", end: "2041-01-25" };

interface Account {
  email: string;
  password: string;
}

interface Named {
  id: number;
  name: string;
}

interface World {
  owner: Account;
  x: Named;
  y: Named;
  p: Named;
  /** Milestones by name: x1 (X, week 1), y1 (Y, week 2), p1 (P, week 3), p2 (P, week 1). */
  x1: Named;
  y1: Named;
  p1: Named;
  p2: Named;
  /** The team of p1 and p2: its own schedule has the same hole as P's. */
  teamP: Named;
}

async function seed(api: APIRequestContext, path: string, data: object, tear: string): Promise<number> {
  const response = await api.post(path, { data });
  expect(response.status(), await response.text()).toBe(201);
  const id = ((await response.json()) as { id: number }).id;
  teardown.push(`${tear}/${id}`);
  return id;
}

/** A schedule write as the ADMIN, with the project view's current revision (a client that has just read the view). */
async function schedule(api: APIRequestContext, projectId: number, milestoneId: number, week: { start: string; end: string }): Promise<void> {
  const view = await api.get(`/api/v1/views/project/${projectId}`);
  const { revision } = (await view.json()) as { revision: number };
  const response = await api.put(`/api/v1/milestones/${milestoneId}/schedule`, { data: { expectedRevision: revision, startDate: week.start, endDate: week.end } });
  expect(response.status(), await response.text()).toBe(200);
}

/**
 * A project OWNER login (the person who owns the program, so all three projects), two teams (X's and Y's milestones on one, P's on the
 * other) and three projects with finish-to-start links x1 -> y1 -> p1, each back to back with the next so every link has no spare day:
 * x1 week 1, y1 week 2, p1 week 3, plus an unlinked p2 in P on week 1. P's span is weeks 1 to 3, so p2 has 10 working days of slack
 * (it could slip to the end of week 3 before P's end moves), p1 and the whole chain have none, and week 2 is a five-day hole in P's
 * own schedule (p2 ends before it, p1 starts after it; y1 belongs to Y).
 */
async function seedWorld(): Promise<World> {
  const { api } = await apiAsAdmin();
  try {
    const name = uniqueText("e2e-cp-owner");
    const owner = { email: `${name.toLowerCase()}@astrolabe.local`, password: randomUUID().replace(/-/g, "") };
    const userId = await seed(api, "/api/v1/users", { name, email: owner.email, password: owner.password }, "/api/v1/users");
    const ownerPerson = await seed(api, "/api/v1/people", { name: uniqueText("e2e-cp-ownerperson"), userId }, "/api/v1/people");
    const teamX = { id: 0, name: uniqueText("e2e-cp-team-x") };
    teamX.id = await seed(api, "/api/v1/teams", { name: teamX.name }, "/api/v1/teams");
    const teamP = { id: 0, name: uniqueText("e2e-cp-team-p") };
    teamP.id = await seed(api, "/api/v1/teams", { name: teamP.name }, "/api/v1/teams");
    const streamId = await seed(api, "/api/v1/work-streams", { name: uniqueText("e2e-cp-stream"), ownerPersonId: ownerPerson, startDate: "2041-01-01" }, "/api/v1/work-streams");
    const programId = await seed(api, `/api/v1/work-streams/${streamId}/programs`, { name: uniqueText("e2e-cp-program"), ownerPersonId: ownerPerson }, "/api/v1/programs");

    async function project(label: string): Promise<Named> {
      const projectName = uniqueText(`e2e-cp-proj-${label}`);
      return { id: await seed(api, `/api/v1/programs/${programId}/projects`, { name: projectName, ownerPersonId: ownerPerson }, "/api/v1/projects"), name: projectName };
    }
    async function milestone(owning: Named, label: string, team: Named, week: { start: string; end: string }): Promise<Named> {
      const milestoneName = uniqueText(`e2e-cp-${label}`);
      const response = await api.post(`/api/v1/projects/${owning.id}/milestones`, { data: { name: milestoneName, teamId: team.id, estimateMd: 3 } });
      expect(response.status(), await response.text()).toBe(201);
      const id = ((await response.json()) as { id: number }).id;
      await schedule(api, owning.id, id, week);
      return { id, name: milestoneName };
    }
    async function link(successorProject: Named, predecessor: Named, successor: Named): Promise<void> {
      const response = await api.post(`/api/v1/projects/${successorProject.id}/dependencies`, {
        data: { predecessor: { kind: "MILESTONE", id: predecessor.id }, successor: { kind: "MILESTONE", id: successor.id }, type: "FS", lagDays: 0 },
      });
      expect(response.status(), await response.text()).toBe(201);
    }

    const x = await project("x");
    const y = await project("y");
    const p = await project("p");
    const x1 = await milestone(x, "x1", teamX, WEEK_1);
    const y1 = await milestone(y, "y1", teamX, WEEK_2);
    const p1 = await milestone(p, "p1", teamP, WEEK_3);
    const p2 = await milestone(p, "p2", teamP, WEEK_1);
    await link(y, x1, y1);
    await link(p, y1, p1);
    return { owner, x, y, p, x1, y1, p1, p2, teamP };
  } finally {
    await api.dispose();
  }
}

async function openProject(page: Page, project: Named): Promise<void> {
  await page.goto(`/projects/${project.id}`);
  await expect(page.getByRole("heading", { level: 2, name: project.name })).toBeVisible();
  await expect(page.getByRole("grid", { name: "Milestone timeline" })).toBeVisible();
}

const toggle = (page: Page) => page.getByRole("button", { name: "Critical path", exact: true });
const grid = (page: Page) => page.getByRole("grid", { name: "Milestone timeline" });
const arrows = (page: Page) => page.locator("[data-arrow]");
const dependenciesTable = (page: Page) => page.getByRole("table", { name: "Dependencies of the project" });
const chainTable = (page: Page) => page.getByRole("table", { name: "Critical chain members in other projects" });
/** A timeline row's Slack cell text: the third grid cell after the name (team, estimate, slack), the hidden words included. */
const slackOf = (page: Page, name: RegExp) => grid(page).getByRole("row").filter({ has: page.getByRole("rowheader", { name }) }).getByRole("gridcell").nth(2);

test("the critical path: the owner turns it on and reads the chain beyond the neighbouring project; it survives a reload and goes away when off", async ({ page }) => {
  const world = await seedWorld();
  const { x, y, p, x1, y1, p1, p2 } = world;

  await login(page, world.owner.email, world.owner.password);
  await openProject(page, p);

  // Off by default: not pressed, and nothing of the critical path is in the page.
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("[data-critical]")).toHaveCount(0);
  await expect(page.getByRole("columnheader", { name: "Slack" })).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 3, name: "Critical chain" })).toHaveCount(0);
  await expect(dependenciesTable(page).getByText("Critical path", { exact: true })).toHaveCount(0);
  // The direct neighbour y1 is a ghost row (the link y1 -> p1); x1, two hops away, is not.
  await expect(grid(page).getByRole("rowheader", { name: new RegExp(`${y.name} › ${y1.name}`) })).toBeVisible();

  await toggle(page).click();
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "true");

  // The Slack column: p1 drives P's end (0, with the hidden words), p2 could slip 10 working days (weeks 2 and 3), and the ghost row y1 reads
  // its own slack (0: it drives p1 through the link).
  await expect(grid(page).getByRole("columnheader", { name: "Slack" })).toBeVisible();
  await expect(slackOf(page, new RegExp(`^${p1.name}`))).toHaveText("0 critical path");
  await expect(slackOf(page, new RegExp(`^${p2.name}`))).toHaveText("10 working days");
  await expect(slackOf(page, new RegExp(`${y.name} › ${y1.name}`))).toHaveText("0 critical path");

  // The emphasis (the owner is not the team's manager, so the bars are read-only images): p1 and the ghost y1 carry the flag and say so in their names, p2 does not; the one arrow y1 -> p1 is the critical one.
  await expect(page.getByRole("img", { name: new RegExp(`^${p1.name}, .*on the critical path, read-only$`) })).toHaveAttribute("data-critical", "true");
  await expect(page.getByRole("img", { name: new RegExp(`^${p2.name}, `) })).not.toHaveAttribute("data-critical", "true");
  await expect(page.getByRole("img", { name: new RegExp(`^${y1.name}, .*from project ${y.name}, on the critical path, read-only$`) })).toHaveAttribute("data-critical", "true");
  await expect(page.locator('[data-critical="true"]')).toHaveCount(3); // exactly the bar p1, the ghost bar y1 and the arrow
  await expect(arrows(page)).toHaveCount(1);
  await expect(arrows(page)).toHaveAttribute("data-critical", "true");
  await expect(arrows(page)).toHaveAttribute("data-violated", "false");

  // The Dependencies row of that link carries the gray badge.
  const linkRow = dependenciesTable(page).getByRole("row").filter({ hasText: y1.name });
  await expect(linkRow).toContainText("OK");
  await expect(linkRow.getByText("Critical path", { exact: true })).toBeVisible();

  // The Critical chain: x1 is the only member the timeline does not draw - two hops away, zero slack, with its project and dates, and a
  // link into it. y1 is not listed (the ghost row shows it); nothing else is upstream with slack.
  await expect(page.getByRole("heading", { level: 3, name: "Critical chain" })).toBeVisible();
  const rows = chainTable(page).getByRole("row");
  await expect(rows).toHaveCount(2); // the header and x1
  await expect(rows.nth(1).getByRole("cell")).toHaveText(["2", x1.name, "Milestone", x.name, `${WEEK_1.start} – ${WEEK_1.end}`, "0 working days"]);
  await expect(chainTable(page).getByRole("link", { name: `${x1.name} - open project ${x.name}` })).toHaveAttribute("href", `/projects/${x.id}`);
  await expect(chainTable(page).getByText(y1.name)).toHaveCount(0);
  await expect(page.getByText("None.", { exact: true })).toBeVisible(); // "Upstream with slack"
  // x1 has no row and no bar on P's timeline.
  await expect(grid(page).getByRole("rowheader", { name: new RegExp(x1.name) })).toHaveCount(0);
  await expect(grid(page).getByText(x1.name)).toHaveCount(0);

  // A reload keeps the toggle and the figures.
  await page.reload();
  await expect(grid(page)).toBeVisible();
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "true");
  await expect(slackOf(page, new RegExp(`^${p2.name}`))).toHaveText("10 working days");
  await expect(chainTable(page).getByRole("row")).toHaveCount(2);

  // Off again: the attributes, the column, the badge and the section are gone.
  await toggle(page).click();
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("[data-critical]")).toHaveCount(0);
  await expect(page.getByRole("columnheader", { name: "Slack" })).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 3, name: "Critical chain" })).toHaveCount(0);
  await expect(dependenciesTable(page).getByText("Critical path", { exact: true })).toHaveCount(0);
});

test("idle gaps: a five-working-day hole in the schedule is hatched, counted and listed on the project page and on its team's page", async ({ page }) => {
  const world = await seedWorld();
  const { p, teamP } = world;
  const gap = { from: WEEK_2.start, to: WEEK_2.end };
  const bandTitle = `Idle ${gap.from} to ${gap.to}, 5 working days`;

  await login(page, world.owner.email, world.owner.password);
  await openProject(page, p);
  // P's milestones are p2 (week 1) and p1 (week 3): week 2 is the hole. The band is drawn across every row, the badge counts the gap and the
  // table (behind its disclosure) gives the first and last working day and the length.
  await expect(page.locator('[data-band-tone="idle"]').first()).toHaveAttribute("title", bandTitle);
  await expect(page.getByRole("group", { name: "Project facts" }).getByText("1 idle gap", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { level: 3, name: "Idle gaps" })).toBeVisible();
  await expect(page.getByRole("table", { name: "Idle gaps" })).toHaveCount(0);
  await page.getByRole("button", { name: "Show the idle gaps" }).click();
  const projectTable = page.getByRole("table", { name: "Idle gaps" });
  await expect(projectTable.getByRole("row")).toHaveCount(2);
  await expect(projectTable.getByRole("row").nth(1).getByRole("cell")).toHaveText([gap.from, gap.to, "5"]);

  // The page of the team that does the work shows the same hole (its two milestones are P's).
  await page.goto(`/teams/${teamP.id}`);
  await expect(page.getByRole("heading", { level: 2, name: teamP.name })).toBeVisible();
  await expect(page.getByRole("grid", { name: "Team milestone timeline" })).toBeVisible();
  await expect(page.locator('[data-band-tone="idle"]').first()).toHaveAttribute("title", bandTitle);
  await expect(page.getByRole("group", { name: "Team facts" }).getByText("1 idle gap", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Show the idle gaps" }).click();
  const teamTable = page.getByRole("table", { name: "Idle gaps" });
  await expect(teamTable.getByRole("row")).toHaveCount(2);
  await expect(teamTable.getByRole("row").nth(1).getByRole("cell")).toHaveText([gap.from, gap.to, "5"]);
});
