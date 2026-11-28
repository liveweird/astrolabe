// The cross-team schedule proposal (1.8) on the Roadmap overview (1.33), in 2048: ANY login previews one, a manager accepts only the moves of the teams they manage.
// A login that manages nothing previews (the dashed bars, the table of the projects that would move) and is offered no accept; a login that manages both teams
// runs ONE proposal over them, reads the second team's milestone landing after the first team's PROPOSED date and accepts both teams' moves in one write; unticking
// the first team's move turns the link into a warning through the ticked-subset check; a manager of one team accepts that team's moves alone (the accept names only
// them); a manager narrows the run to their own team with the team picker (1.38: only that team is asked, Save is offered, Reset restores the page's set); a saved proposal (1.26) is listed under the timeline, opened by a manager of another team, who cannot accept it, and accepted by the manager of both
// teams, after which it reads as changed; the retired Schedule proposals addresses lead to the overview.
// Every overview run here narrows the page to the spec's OWN program (`?mode=overview&programId=`): the run covers the teams of the projects the page shows, and
// the plan is shared by every worker. Owns: its throwaway users, people, TWO teams (each with ONE capacity period from Monday 2048-01-06, 10 MD/week, no WIP
// limit; the saved-proposal test adds a third, the SINGLE manager's), work stream, program, project, two milestones and the link between them (unique `e2e-ct-*`
// names), and the ONE saved proposal that test saves (named `e2e-ct-saved-*`), all deleted by the afterEach below (the saved proposal first, then the project -
// its milestones and link go with it - then program, work stream, teams, people, users). Every date it pins is in 2048,
// which no other spec writes a holiday in; the real clock is the proposal's `asOf`, and nothing can land before a team's first capacity period.
import { randomUUID } from "node:crypto";
import type { APIRequestContext, Page, Response } from "@playwright/test";
import { apiAsAdmin, deleteViaApi, expect, login, signOut, test, uniqueText } from "./helpers";

// A cross-team proposal's scope token carries the global holiday dictionary, which `public-holidays` writes (2040): a holiday written while a run is open
// can stale the accept (409 `stale-scope`, when it changes an accepted date). The specs that write the dictionary or compare the figures never run at the same time.
test.describe.configure({ lock: "holiday-dictionary" });

// Registered in creation order; torn down in reverse (a project before its program before its stream before the teams and the people).
const teardown: string[] = [];
test.afterEach(async () => {
  await deleteViaApi(teardown.splice(0).reverse());
});

interface Account {
  email: string;
  password: string;
}

interface Milestone {
  id: number;
  name: string;
}

interface World {
  api: APIRequestContext;
  owner: Account;
  manager: Account;
  single: Account;
  teamX: string;
  teamY: string;
  teamYId: number;
  programId: number;
  x1: Milestone;
  y1: Milestone;
}

async function seed(api: APIRequestContext, path: string, data: object, tear: string): Promise<number> {
  const response = await api.post(path, { data });
  expect(response.status(), await response.text()).toBe(201);
  const id = ((await response.json()) as { id: number }).id;
  teardown.push(`${tear}/${id}`);
  return id;
}

async function seedUser(api: APIRequestContext, label: string): Promise<{ id: number; account: Account }> {
  const name = uniqueText(`e2e-ct-${label}`);
  const account = { email: `${name.toLowerCase()}@astrolabe.local`, password: randomUUID().replace(/-/g, "") };
  const id = await seed(api, "/api/v1/users", { name, email: account.email, password: account.password }, "/api/v1/users");
  return { id, account };
}

/**
 * The world: three throwaway logins (a project OWNER who manages nothing, a MANAGER and a SINGLE manager), two teams whose FIRST capacity period starts
 * on Monday 2048-01-06 (10 MD/week, no WIP limit: 2 MD a working day), a plan holding one project owned by the owner, and its milestones: `x1` 4 MD on
 * team X scheduled late (Monday 2048-03-02 to Tuesday 03-03), `y1` 2 MD on team Y unscheduled, and the finish-to-start link `x1 -> y1`. Team X is
 * managed by the MANAGER's person; team Y by the same person (the manager runs both teams) or, with `split`, by the SINGLE manager's (a team has
 * one manager, so the fourth scenario's world gives Y away). With `soloTeam`, a third team Z (the same capacity, no milestones) is managed by the
 * SINGLE manager, who then manages one team and none of the two the run is about (the fifth scenario).
 *
 * The run, counted by hand (2048 has no holiday on this stack): X is placed first (the link points from it), x1 takes two working days from the
 * first day with capacity, **2048-01-06 to 2048-01-07**; Y is placed with X's PROPOSED dates as facts, so y1 starts the working day after x1's
 * proposed end, a one-day milestone on **2048-01-08**; one pass, settled. Against x1's STORED end (03-03) y1 would start on 2048-03-04. The project's
 * own span (its milestones' dates) is 2048-03-02 to 2048-03-03 now and **2048-01-06 to 2048-01-08** after the run.
 */
async function seedWorld(split = false, soloTeam = false): Promise<World> {
  const { api } = await apiAsAdmin();
  const owner = await seedUser(api, "owner");
  const manager = await seedUser(api, "manager");
  const single = await seedUser(api, "single");
  const lead = await seed(api, "/api/v1/people", { name: uniqueText("e2e-ct-lead") }, "/api/v1/people");
  const ownerPerson = await seed(api, "/api/v1/people", { name: uniqueText("e2e-ct-ownerperson"), userId: owner.id }, "/api/v1/people");
  const managerPerson = await seed(api, "/api/v1/people", { name: uniqueText("e2e-ct-managerperson"), userId: manager.id }, "/api/v1/people");
  const singlePerson = await seed(api, "/api/v1/people", { name: uniqueText("e2e-ct-singleperson"), userId: single.id }, "/api/v1/people");
  const team = async (label: string, managerPersonId: number) => {
    const name = uniqueText(`e2e-ct-team${label}`);
    const id = await seed(api, "/api/v1/teams", { name, managerPersonId }, "/api/v1/teams");
    const capacity = await api.post(`/api/v1/teams/${id}/capacity`, { data: { effectiveFrom: "2048-01-06", mdPerWeek: 10 } });
    expect(capacity.status(), await capacity.text()).toBe(201);
    return { id, name };
  };
  const teamX = await team("x", managerPerson);
  const teamY = await team("y", split ? singlePerson : managerPerson);
  if (soloTeam) await team("z", singlePerson);
  const streamId = await seed(api, "/api/v1/work-streams", { name: uniqueText("e2e-ct-stream"), ownerPersonId: lead, startDate: "2026-01-05" }, "/api/v1/work-streams");
  const programId = await seed(api, `/api/v1/work-streams/${streamId}/programs`, { name: uniqueText("e2e-ct-program"), ownerPersonId: lead }, "/api/v1/programs");
  const projectId = await seed(api, `/api/v1/programs/${programId}/projects`, { name: uniqueText("e2e-ct-project"), ownerPersonId: ownerPerson }, "/api/v1/projects");
  const milestone = async (label: string, teamId: number, estimateMd: number): Promise<Milestone> => {
    const name = uniqueText(`e2e-ct-${label}`);
    const response = await api.post(`/api/v1/projects/${projectId}/milestones`, { data: { name, teamId, estimateMd } });
    expect(response.status(), await response.text()).toBe(201);
    return { id: ((await response.json()) as { id: number }).id, name };
  };
  const x1 = await milestone("x1", teamX.id, 4);
  const y1 = await milestone("y1", teamY.id, 2);
  const view = await api.get(`/api/v1/views/team/${teamX.id}`);
  const { revision } = (await view.json()) as { revision: number };
  const scheduled = await api.put(`/api/v1/milestones/${x1.id}/schedule`, { data: { expectedRevision: revision, startDate: "2048-03-02", endDate: "2048-03-03" } });
  expect(scheduled.status(), await scheduled.text()).toBe(200);
  const link = await api.post(`/api/v1/projects/${projectId}/dependencies`, {
    data: { predecessor: { kind: "MILESTONE", id: x1.id }, successor: { kind: "MILESTONE", id: y1.id }, type: "FS", lagDays: 0 },
  });
  expect(link.status(), await link.text()).toBe(201);
  return { api, owner: owner.account, manager: manager.account, single: single.account, teamX: teamX.name, teamY: teamY.name, teamYId: teamY.id, programId, x1, y1 };
}

const proposeButton = (page: Page) => page.getByRole("button", { name: "Propose schedule", exact: true });
const acceptButton = (page: Page, count: number) => page.getByRole("button", { name: `Accept selected (${count})`, exact: true });
const sectionTable = (page: Page, team: string) => page.getByRole("table", { name: `Proposed moves of ${team}` });
const row = (page: Page, team: string, milestone: Milestone) => sectionTable(page, team).getByRole("row").filter({ hasText: milestone.name });
const note = (page: Page, text: string) => page.getByRole("note").filter({ hasText: text });
const runHeading = (page: Page) => page.getByRole("heading", { level: 3, name: "Schedule proposal", exact: true });
const stateBadge = (page: Page, state: string) => page.locator(`[data-state="${state}"]`);
// Matches the call whatever its status; each caller asserts the 200 with `expectOk`, so a refused call fails at once with its problem body
// instead of timing out with nothing (the 2026-11-02 flake of the single-team accept).
const isApi = (method: string, suffix: string) => (r: { request(): { method(): string }; url(): string }) =>
  r.request().method() === method && r.url().endsWith(`/api/v1/schedule-proposals${suffix}`);
const isSave = (r: { request(): { method(): string }; url(): string }) => r.request().method() === "POST" && r.url().endsWith("/api/v1/saved-schedule-proposals");
async function expectOk(response: Response): Promise<Response> {
  expect(response.status(), await response.text()).toBe(200);
  return response;
}

/** The Roadmap overview narrowed to the world's own program (the plan is shared: a run covers only the teams of the projects shown). */
async function openOverview(page: Page, world: World): Promise<void> {
  await page.goto(`/roadmap?mode=overview&programId=${world.programId}`);
  await expect(page.getByRole("grid", { name: "Programs timeline" })).toBeVisible();
  // Propose waits for the viewer's rights to be read.
  await expect(proposeButton(page)).toBeEnabled();
}

/** Press Propose and wait for the run; returns its plan revision. */
async function propose(page: Page): Promise<number> {
  const [response] = await Promise.all([page.waitForResponse(isApi("POST", "")), proposeButton(page).click()]);
  await expectOk(response);
  await expect(runHeading(page)).toBeVisible();
  // The run opens on its heading (1.37): focused and below the sticky 56 px header, not scrolled down to the Discard button at the end of the section.
  await expect(runHeading(page)).toBeFocused();
  await expect.poll(async () => (await runHeading(page).boundingBox())?.y ?? 0).toBeGreaterThanOrEqual(56);
  await expect(page.getByRole("button", { name: "Discard", exact: true })).toBeVisible();
  return ((await response.json()) as { revision: number }).revision;
}

/** The "Saved proposals (N)" panel, shown (it is hidden until asked for). */
async function showSaved(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Show the saved proposals", exact: true }).click();
  await expect(page.getByRole("table", { name: "Saved proposals", exact: true })).toBeVisible();
}

test("a login that manages no team previews a proposal: the dashed bars and the projects that would move, and nothing to accept", async ({ page }) => {
  const world = await seedWorld();
  await world.api.dispose();

  // The project OWNER manages no team. Everyone previews: Propose is offered, the run opens, only the weighing of what may be written differs.
  await login(page, world.owner.email, world.owner.password);
  await openOverview(page, world);
  await propose(page);
  await expect(note(page, "This is a preview.")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Accept selected/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save proposal", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Propose again", exact: true })).toBeVisible();
  // The dashed bars: the work stream and the program (the project row is folded) read the dates the run gives them.
  await expect(page.locator('[data-tone="proposal"]').first()).toBeVisible();
  // The table of the projects whose dates would move: the project's span now (x1's March dates) and after (x1 in January, y1 on 01-08).
  const moved = page.getByRole("table", { name: "Projects whose dates would move", exact: true });
  await expect(moved).toContainText("2048-03-02 to 2048-03-03");
  await expect(moved).toContainText("2048-01-06 to 2048-01-08");
  // The sections show the run as it would be if each team's manager accepted: collapsed, read-only, the moves one click away.
  await page.getByRole("button", { name: `Show the moves of ${world.teamY}`, exact: true }).click();
  await expect(row(page, world.teamY, world.y1)).toContainText("Unscheduled → 2048-01-08 to 2048-01-08, 1 working day");
  await expect(page.getByRole("checkbox", { name: `Accept ${world.y1.name}` })).toBeDisabled();
  // Discard closes the preview; nothing was written.
  await page.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(runHeading(page)).toHaveCount(0);
  await expect(page.locator('[data-tone="proposal"]')).toHaveCount(0);
});

test("the manager of two teams runs a cross-team proposal: the second team's milestone lands after the first team's proposed date, and one accept writes both", async ({ page }) => {
  const world = await seedWorld();
  const { api } = world;

  await login(page, world.manager.email, world.manager.password);
  await openOverview(page, world);
  const proposedAt = await propose(page);

  // One pass, settled; the sections in placement order (X, whose link points ahead, then Y), each open (both teams are the viewer's).
  await expect(note(page, "Placed in 1 pass · settled")).toBeVisible();
  await expect(page.getByRole("heading", { level: 3, name: world.teamX, exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { level: 3, name: world.teamY, exact: true })).toBeVisible();
  await expect(page.getByText("placed 1 of 2")).toBeVisible();
  await expect(page.getByText("placed 2 of 2")).toBeVisible();
  // x1 moves from March to the first days of the year; y1 lands the working day AFTER x1's proposed end, not after its stored one.
  await expect(row(page, world.teamX, world.x1)).toContainText("2048-03-02 to 2048-03-03");
  await expect(row(page, world.teamX, world.x1)).toContainText("2048-01-06 to 2048-01-07");
  await expect(row(page, world.teamY, world.y1)).toContainText("Unscheduled → 2048-01-08 to 2048-01-08, 1 working day");
  await expect(page.getByRole("checkbox", { name: `Accept ${world.x1.name}` })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: `Accept ${world.y1.name}` })).toBeChecked();
  await expect(page.getByText("Conflict", { exact: true })).toHaveCount(0);

  // ONE accept writes both teams' moves, and names both teams.
  const [accepted] = await Promise.all([page.waitForResponse(isApi("POST", "/accept")), acceptButton(page, 2).click()]);
  await expectOk(accepted);
  expect((accepted.request().postDataJSON() as { acceptTeamIds: number[] }).acceptTeamIds).toHaveLength(2);
  const body = (await accepted.json()) as { revision: number; accepted: unknown[]; skipped: unknown[] };
  expect(body.accepted).toHaveLength(2);
  expect(body.skipped).toHaveLength(0);
  // One plan write, one bump: the revision rose above the run's (other specs write the plan too, so "above", never an exact figure).
  expect(body.revision).toBeGreaterThan(proposedAt);
  await expect(note(page, "2 scheduled")).toBeVisible();
  await expect(runHeading(page)).toHaveCount(0);
  await expect(sectionTable(page, world.teamX)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Discard", exact: true })).toHaveCount(0);

  // The API shows what the server stored, on both teams.
  for (const [milestone, start, end] of [
    [world.x1, "2048-01-06", "2048-01-07"],
    [world.y1, "2048-01-08", "2048-01-08"],
  ] as const) {
    const stored = await api.get(`/api/v1/milestones/${milestone.id}`);
    expect(await stored.json()).toMatchObject({ startDate: start, endDate: end });
  }
  await api.dispose();
});

test("unticking the first team's move keeps it in March, and the check turns the second team's link into a warning", async ({ page }) => {
  const world = await seedWorld();
  await world.api.dispose();

  await login(page, world.manager.email, world.manager.password);
  await openOverview(page, world);
  await propose(page);
  await expect(acceptButton(page, 2)).toBeVisible();
  await expect(sectionTable(page, world.teamY).getByText("Conflict", { exact: true })).toHaveCount(0);

  // Untick x1: it stays in March (ends 03-03), so y1 at 01-08 would start before its predecessor ends. The check answers for the ticked subset.
  const [checked] = await Promise.all([page.waitForResponse(isApi("POST", "/check")), page.getByRole("checkbox", { name: `Accept ${world.x1.name}` }).uncheck()]);
  await expectOk(checked);
  await expect(acceptButton(page, 1)).toBeVisible();
  const y1 = row(page, world.teamY, world.y1);
  await expect(y1.getByText("Conflict", { exact: true })).toBeVisible();
  await expect(y1).toContainText("must start on 2048-03-04 or later");
  await expect(y1).toContainText(world.x1.name);
  // The project's dates follow the ticks (the server's own answer for the ticked moves): x1 stays in March, so the span is y1's day through x1's March end.
  const moved = page.getByRole("table", { name: "Projects whose dates would move", exact: true });
  await expect(moved).toContainText("2048-01-08 to 2048-03-03");
  await expect(moved).not.toContainText("2048-01-06 to 2048-01-08");
  await expect(moved.getByRole("row")).toHaveCount(2); // the header and the project's row: the rows are the run's, only their dates follow the tick

  // Tick it again: every move ticked, the proposal's own verdicts are exact (no check is asked) and the warning is gone.
  await page.getByRole("checkbox", { name: `Accept ${world.x1.name}` }).check();
  await expect(moved).toContainText("2048-01-06 to 2048-01-08");
  await expect(acceptButton(page, 2)).toBeVisible();
  await expect(sectionTable(page, world.teamY).getByText("Conflict", { exact: true })).toHaveCount(0);
  await expect(y1).not.toContainText("must start on");
});

test("a manager of one team accepts that team's moves alone, and the other team's section is a preview", async ({ page }) => {
  const world = await seedWorld(true);
  const { api } = world;

  // SINGLE manages Y alone: the run still covers both teams of the project (X is the MANAGER's), but only Y's moves are theirs to tick and accept.
  await login(page, world.single.email, world.single.password);
  await openOverview(page, world);
  await propose(page);
  await expect(page.getByRole("heading", { level: 3, name: world.teamX, exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { level: 3, name: world.teamY, exact: true })).toBeVisible();
  // X's section is collapsed and read-only ("as it would be if its manager accepts"); Y's is open with y1 ticked.
  await expect(page.getByRole("button", { name: `Show the moves of ${world.teamX}`, exact: true })).toHaveAttribute("aria-expanded", "false");
  await expect(row(page, world.teamY, world.y1)).toContainText("Unscheduled → 2048-01-08 to 2048-01-08, 1 working day");
  await expect(page.getByRole("checkbox", { name: `Accept ${world.y1.name}` })).toBeChecked();
  // x1 stays in March unless its manager accepts, so the check of the ticked subset turns y1's link into a warning.
  await expect(row(page, world.teamY, world.y1)).toContainText("must start on 2048-03-04 or later");
  await expect(acceptButton(page, 1)).toBeVisible();
  // Save is the all-teams right: not offered to a manager of one.
  await expect(page.getByRole("button", { name: "Save proposal", exact: true })).toHaveCount(0);

  const [accepted] = await Promise.all([page.waitForResponse(isApi("POST", "/accept")), acceptButton(page, 1).click()]);
  await expectOk(accepted);
  // The accept names the one team ticked, though the run covers two.
  const sent = accepted.request().postDataJSON() as { teamIds: number[]; acceptTeamIds: number[] };
  expect(sent.teamIds).toHaveLength(2);
  expect(sent.acceptTeamIds).toEqual([world.teamYId]);
  const body = (await accepted.json()) as { accepted: unknown[]; skipped: unknown[] };
  expect(body.accepted).toHaveLength(1);
  expect(body.skipped).toHaveLength(0);
  await expect(note(page, "1 scheduled")).toBeVisible();
  await expect(runHeading(page)).toHaveCount(0);

  // Only y1 moved: x1 is where it was.
  const y1 = await api.get(`/api/v1/milestones/${world.y1.id}`);
  expect(await y1.json()).toMatchObject({ startDate: "2048-01-08", endDate: "2048-01-08" });
  const x1 = await api.get(`/api/v1/milestones/${world.x1.id}`);
  expect(await x1.json()).toMatchObject({ startDate: "2048-03-02", endDate: "2048-03-03" });
  await api.dispose();
});

test("a manager of two teams saves a proposal, a manager of another team opens it from the list and cannot accept, and the first accepts it from there, after which it reads as changed", async ({ page }) => {
  const world = await seedWorld(false, true);
  const { api } = world;
  const savedName = uniqueText("e2e-ct-saved");
  const savedRow = (name: string) => page.getByRole("table", { name: "Saved proposals", exact: true }).getByRole("row").filter({ hasText: name });
  const savedHeading = page.getByRole("heading", { level: 3, name: `Saved proposal: ${savedName}`, exact: true });

  // The manager of both teams runs the proposal and saves it with both moves ticked.
  await login(page, world.manager.email, world.manager.password);
  await openOverview(page, world);
  await propose(page);
  await page.getByRole("button", { name: "Save proposal", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Save proposal", exact: true });
  await dialog.getByRole("textbox", { name: "Name" }).fill(savedName);
  const [saved] = await Promise.all([page.waitForResponse(isSave), dialog.getByRole("button", { name: "Save proposal", exact: true }).click()]);
  expect(saved.status(), await saved.text()).toBe(201);
  // Registered at once, so a failed assertion below still deletes it (the saved table keeps 20 rows for everyone: never leave one behind).
  teardown.push(`/api/v1/saved-schedule-proposals/${((await saved.json()) as { id: number }).id}`);
  await expect(dialog).toHaveCount(0);
  // The panel under the timeline lists it with both teams and both ticked moves; its saver may delete it. Saving moved nothing of the plan.
  await showSaved(page);
  await expect(savedRow(savedName)).toContainText(world.teamX);
  await expect(savedRow(savedName)).toContainText(world.teamY);
  await expect(savedRow(savedName)).toContainText("2 of 2");
  await expect(savedRow(savedName).getByRole("button", { name: `Delete ${savedName}`, exact: true })).toBeVisible();
  const unmoved = await api.get(`/api/v1/milestones/${world.y1.id}`);
  expect(((await unmoved.json()) as { startDate?: string | null }).startDate ?? null).toBeNull();

  // The manager of team Z only opens it from the list: the stored run is on screen, current, with no Accept and no Delete.
  await signOut(page);
  await login(page, world.single.email, world.single.password);
  await openOverview(page, world);
  await showSaved(page);
  await expect(savedRow(savedName).getByRole("button", { name: `Delete ${savedName}`, exact: true })).toHaveCount(0);
  await page.getByRole("link", { name: `Open ${savedName}`, exact: true }).click();
  await expect(page).toHaveURL(/[?&]proposal=\d+/);
  await expect(savedHeading).toBeVisible();
  // It lands on the TOP of the proposal (1.37): the heading holds the focus and is in view (the focus used to go to the Close button at the end, which scrolled to the bottom), and the list marks the open one.
  await expect(savedHeading).toBeFocused();
  await expect(savedHeading).toBeInViewport();
  await expect.poll(async () => (await savedHeading.boundingBox())?.y ?? 0).toBeGreaterThanOrEqual(56);
  await expect(savedRow(savedName)).toHaveAttribute("aria-current", "true");
  // An initial deep link (a fresh load of `?proposal=<id>`, no click before it) lands the same way.
  await page.goto(page.url());
  await expect(savedHeading).toBeVisible();
  await expect(savedHeading).toBeFocused();
  await expect.poll(async () => (await savedHeading.boundingBox())?.y ?? 0).toBeGreaterThanOrEqual(56);
  await expect(stateBadge(page, "CURRENT")).toHaveText("Current");
  await expect(note(page, "You can read it; only an administrator or the manager of one of its teams can change the ticks and accept their moves.")).toBeVisible();
  await page.getByRole("button", { name: `Show the moves of ${world.teamY}`, exact: true }).click();
  await expect(row(page, world.teamY, world.y1)).toContainText("Unscheduled → 2048-01-08 to 2048-01-08, 1 working day");
  await expect(page.getByRole("button", { name: /^Accept selected/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save proposal", exact: true })).toHaveCount(0);
  // Close ends the run and takes the proposal out of the address.
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(savedHeading).toHaveCount(0);
  await expect(page).not.toHaveURL(/proposal=/);
  await expect(savedRow(savedName)).not.toHaveAttribute("aria-current", "true");

  // The manager of both teams opens it from the list: the stored run is the editable preview, and ONE accept writes both teams' moves.
  await signOut(page);
  await login(page, world.manager.email, world.manager.password);
  await openOverview(page, world);
  await showSaved(page);
  await page.getByRole("link", { name: `Open ${savedName}`, exact: true }).click();
  await expect(savedHeading).toBeVisible();
  await expect(stateBadge(page, "CURRENT")).toHaveText("Current");
  await expect(acceptButton(page, 2)).toBeVisible();
  const [accepted] = await Promise.all([page.waitForResponse(isApi("POST", "/accept")), acceptButton(page, 2).click()]);
  await expectOk(accepted);
  const body = (await accepted.json()) as { accepted: unknown[]; skipped: unknown[] };
  expect(body.accepted).toHaveLength(2);
  expect(body.skipped).toHaveLength(0);
  await expect(note(page, "2 scheduled")).toBeVisible();
  await expect(savedHeading).toHaveCount(0);
  await expect(page).not.toHaveURL(/proposal=/);
  const stored = await api.get(`/api/v1/milestones/${world.y1.id}`);
  expect(await stored.json()).toMatchObject({ startDate: "2048-01-08", endDate: "2048-01-08" });

  // The plan moved under the saved run, so opening it again reads it as changed: the stored ticks read-only and no second accept.
  await page.getByRole("link", { name: `Open ${savedName}`, exact: true }).click();
  await expect(savedHeading).toBeVisible();
  await expect(stateBadge(page, "CHANGED")).toHaveText("Changed");
  await expect(note(page, "The plan changed after it was saved, so it can no longer be accepted.")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Accept selected/ })).toHaveCount(0);
  await api.dispose();
});

test("a manager narrows the run to their own team: only that team is asked and sectioned, Save is offered, and Reset brings the page's teams back", async ({ page }) => {
  // SINGLE manages Y alone; the page's own set is both teams of the project (X is the MANAGER's), so with the page's set there is no Save.
  const world = await seedWorld(true);
  await world.api.dispose();
  const picker = page.getByRole("combobox", { name: "Teams in the run", exact: true });
  // Scoped to the team picker's own field (a pill has no role; the page has other multi-selects).
  const chosen = (team: string) => page.locator(".mantine-MultiSelect-root").filter({ has: picker }).locator(".mantine-MultiSelect-pill").filter({ hasText: team });
  const reset = page.getByRole("button", { name: "Use this page's teams", exact: true });

  await login(page, world.single.email, world.single.password);
  await openOverview(page, world);
  await expect(chosen(world.teamX)).toHaveCount(1);
  await expect(chosen(world.teamY)).toHaveCount(1);
  await expect(reset).toHaveCount(0);

  // Take team X out: the reset appears, the row says the teams are chosen.
  await picker.click();
  await page.getByRole("option", { name: world.teamX, exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(chosen(world.teamX)).toHaveCount(0);
  await expect(reset).toBeVisible();
  await expect(page.getByText("Proposes dates for the 1 team you chose.")).toBeVisible();

  // The request names team Y alone, the run has team Y's section only, and the viewer manages every team of it: Save is offered. The picker is not drawn while the run is open.
  const [response] = await Promise.all([page.waitForResponse(isApi("POST", "")), proposeButton(page).click()]);
  await expectOk(response);
  expect((response.request().postDataJSON() as { teamIds: number[] }).teamIds).toEqual([world.teamYId]);
  await expect(runHeading(page)).toBeVisible();
  await expect(page.getByRole("heading", { level: 3, name: world.teamY, exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { level: 3, name: world.teamX, exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save proposal", exact: true })).toBeEnabled();
  await expect(picker).toHaveCount(0);
  await expect(reset).toHaveCount(0);

  // Discard gives the picker back with the choice kept; Reset puts the page's two teams back, and the next run asks for both.
  await page.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(picker).toBeVisible();
  await expect(chosen(world.teamX)).toHaveCount(0);
  await reset.click();
  await expect(chosen(world.teamX)).toHaveCount(1);
  await expect(chosen(world.teamY)).toHaveCount(1);
  await expect(reset).toHaveCount(0);
  const [again] = await Promise.all([page.waitForResponse(isApi("POST", "")), proposeButton(page).click()]);
  await expectOk(again);
  const asked = (again.request().postDataJSON() as { teamIds: number[] }).teamIds;
  expect(asked).toHaveLength(2);
  expect(asked).toContain(world.teamYId);
  await expect(page.getByRole("heading", { level: 3, name: world.teamX, exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save proposal", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(runHeading(page)).toHaveCount(0);
});

test("the retired Schedule proposals addresses lead to the Roadmap overview, and a saved proposal that does not exist says so there", async ({ page }) => {
  await login(page);
  // The page's address: the overview, whatever the old query said.
  await page.goto("/schedule-proposals?x=1");
  await expect(page).toHaveURL(/\/roadmap\?mode=overview$/);
  await expect(page.getByRole("heading", { level: 2, name: "Roadmap", exact: true })).toBeVisible();
  // A saved proposal's address: the overview with that proposal asked for; one that is gone says so and leaves the address (no id this large exists).
  await page.goto("/schedule-proposals/saved/2147483000");
  await expect(note(page, "This saved proposal does not exist — it may have been deleted.")).toBeVisible();
  await expect(page).toHaveURL(/\/roadmap\?mode=overview$/);
  // No leaf for the retired page in the navigation.
  await expect(page.getByRole("link", { name: "Schedule proposals", exact: true })).toHaveCount(0);
});
