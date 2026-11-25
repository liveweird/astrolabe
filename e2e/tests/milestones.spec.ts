// The Milestones page (/milestones, 1.19): every milestone of the plan, narrowed by the Schedule, Team, project and name filters that live in the URL.
// The plan is shared by four workers, so the page is always narrowed to this spec's own team before a row is counted. Owns: its throwaway person,
// team, work stream, program, project and three milestones of that team (unique `e2e-ms-*` names; one scheduled 2027-05-03..07, two left unscheduled),
// all seeded through the API in the test and removed through the API (the project first - its milestones go with it - then program, work stream,
// team, person), even after a failure. Dated May 2027 on purpose (no holiday, no far-off year: nothing here depends on working days); the first two
// tests write no ranking, no holiday and no connection, and need no lock.
// The 1.27 tests own a second world (`e2e-msrank-*`: one team, two work streams, three programs, five projects of one unscheduled milestone each) and
// write the GLOBAL ranking, which four workers share: two of its projects are appended to it through `updateRankingViaApi` (a read-modify-write that
// keeps everyone else's entries) and leave it with their deletion, and no position is asserted as a number, only their order relative to each other.
// The Team and Project selects list every team and every project of the plan (read to the end, 1.21), so no count of other specs' rows can hide this
// spec's own from them (test-fixtures.md, the 1.19 worlds). The second test (1.21) picks the spec's project in the Project select.
import type { APIRequestContext, Page } from "@playwright/test";
import { apiAsAdmin, deleteViaApi, expect, login, openFilters, test, uniqueText, updateRankingViaApi } from "./helpers";

// Registered in creation order; torn down in reverse (a project before its program before its stream before the team and the person).
const teardown: string[] = [];
test.afterEach(async () => {
  await deleteViaApi(teardown.splice(0).reverse());
});

async function seed(api: APIRequestContext, path: string, data: object, tear: string): Promise<number> {
  const response = await api.post(path, { data });
  expect(response.status(), await response.text()).toBe(201);
  const id = ((await response.json()) as { id: number }).id;
  teardown.push(`${tear}/${id}`);
  return id;
}

interface World {
  team: string;
  teamId: number;
  project: string;
  projectId: number;
  scheduled: string;
  unscheduled: string[];
}

/** One team, one project, three milestones of that team: `scheduled` 2027-05-03..07 and two left unscheduled. */
async function seedWorld(): Promise<World> {
  const { api } = await apiAsAdmin();
  try {
    const person = await seed(api, "/api/v1/people", { name: uniqueText("e2e-ms-person") }, "/api/v1/people");
    const team = uniqueText("e2e-ms-team");
    const teamId = await seed(api, "/api/v1/teams", { name: team }, "/api/v1/teams");
    const stream = await seed(api, "/api/v1/work-streams", { name: uniqueText("e2e-ms-stream"), ownerPersonId: person, startDate: "2026-01-05" }, "/api/v1/work-streams");
    const program = await seed(api, `/api/v1/work-streams/${stream}/programs`, { name: uniqueText("e2e-ms-program"), ownerPersonId: person }, "/api/v1/programs");
    const project = uniqueText("e2e-ms-project");
    const projectId = await seed(api, `/api/v1/programs/${program}/projects`, { name: project, ownerPersonId: person }, "/api/v1/projects");
    const milestone = async (name: string) => seed(api, `/api/v1/projects/${projectId}/milestones`, { name, teamId, estimateMd: 2 }, "/api/v1/milestones");
    const scheduled = uniqueText("e2e-ms-scheduled");
    const scheduledId = await milestone(scheduled);
    const unscheduled = [uniqueText("e2e-ms-open-a"), uniqueText("e2e-ms-open-b")];
    for (const name of unscheduled) await milestone(name);
    const view = (await (await api.get(`/api/v1/views/project/${projectId}`)).json()) as { revision: number };
    const put = await api.put(`/api/v1/milestones/${scheduledId}/schedule`, { data: { expectedRevision: view.revision, startDate: "2027-05-03", endDate: "2027-05-07" } });
    expect(put.status(), await put.text()).toBe(200);
    return { team, teamId, project, projectId, scheduled, unscheduled };
  } finally {
    await api.dispose();
  }
}

/** The body rows of the Milestones table (the scroll region around it carries the same name, hence the role). */
const rows = (page: Page) => page.getByRole("table", { name: "Milestones", exact: true }).locator("tbody tr");

test("the Milestones page lists a team's milestones, and the schedule filter narrows them to the ones not scheduled yet", async ({ page }) => {
  const world = await seedWorld();
  await login(page);

  // From the menu; the plan is shared, so the team filter is what makes the rows this spec's own.
  await page.getByRole("group", { name: "Planning" }).getByRole("link", { name: "Milestones", exact: true }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Milestones", exact: true })).toBeVisible();
  await openFilters(page);
  const team = page.getByRole("combobox", { name: "Team", exact: true });
  await team.click();
  await team.fill(world.team);
  await page.getByRole("option", { name: world.team, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`[?&]teamId=${world.teamId}(&|$)`));

  await expect(rows(page)).toHaveCount(3);
  const scheduledRow = rows(page).filter({ hasText: world.scheduled });
  await expect(scheduledRow).toHaveCount(1);
  await expect(scheduledRow).toContainText("2027-05-03");
  await expect(scheduledRow).toContainText("2027-05-07");
  for (const name of world.unscheduled) {
    await expect(rows(page).filter({ hasText: name })).toContainText("Not scheduled");
  }

  // "Not scheduled" leaves the two milestones without dates, in the address too, and survives a reload.
  await page.getByRole("combobox", { name: "Schedule", exact: true }).click();
  await page.getByRole("option", { name: "Not scheduled", exact: true }).click();
  await expect(page).toHaveURL(/[?&]scheduled=false(&|$)/);
  await expect(rows(page)).toHaveCount(2);
  await expect(rows(page).filter({ hasText: world.scheduled })).toHaveCount(0);
  await page.reload();
  await expect(rows(page)).toHaveCount(2);
  for (const name of world.unscheduled) {
    await expect(rows(page).filter({ hasText: name })).toHaveCount(1);
  }

  // A project's name is the way into its page.
  await rows(page).first().getByRole("link", { name: `Open ${world.project}`, exact: true }).click();
  await expect(page.getByRole("heading", { level: 2, name: world.project, exact: true })).toBeVisible();
});

test("the Milestones page's Project select narrows the list to one project and shows it as a chip", async ({ page }) => {
  const world = await seedWorld();
  await login(page);

  // From the menu, then the Project select of the filter panel (searched by the project's unique name): the address, the chip and exactly the project's milestones.
  await page.getByRole("group", { name: "Planning" }).getByRole("link", { name: "Milestones", exact: true }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Milestones", exact: true })).toBeVisible();
  await openFilters(page);
  const project = page.getByRole("combobox", { name: "Project", exact: true });
  await project.click();
  await project.fill(world.project);
  await page.getByRole("option", { name: world.project, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`[?&]projectId=${world.projectId}(&|$)`));
  await expect(page.getByText(`Project: ${world.project}`, { exact: true })).toBeVisible();
  await expect(rows(page)).toHaveCount(3);
  for (const name of [world.scheduled, ...world.unscheduled]) {
    await expect(rows(page).filter({ hasText: name })).toHaveCount(1);
  }

  // Removing the chip lifts the filter: no projectId in the address, and the select is empty again.
  await page.getByRole("button", { name: "Remove the project filter", exact: true }).click();
  await expect(page).not.toHaveURL(/[?&]projectId=/);
  await expect(page.getByText(`Project: ${world.project}`, { exact: true })).toHaveCount(0);
  await expect(project).toHaveValue("");
});

interface RankWorld {
  /** The first work stream (programs one and two: projects a, b, c under the first, d under the second) and the second (program three: project e). */
  streams: [{ id: number; name: string }, { id: number; name: string }];
  programs: [{ id: number; name: string }, { id: number; name: string }, { id: number; name: string }];
  /** The one milestone of each project a to e; b and a are ranked, in that order; c, d and e are not. */
  milestone: { a: string; b: string; c: string; d: string; e: string };
}

/**
 * Two work streams, three programs and five projects named `...-proj-a` to `...-proj-e`, each with one unscheduled milestone of one team. With `ranked`,
 * projects a and b are appended to the global ranking as b then a (the reverse of their names' order); the others stay unranked. The projects are created in the order
 * d, e, c, b, a, so neither their ids nor the project names alone give the order the page must show.
 */
async function seedRankWorld({ ranked }: { ranked: boolean }): Promise<RankWorld> {
  const { api } = await apiAsAdmin();
  try {
    const person = await seed(api, "/api/v1/people", { name: uniqueText("e2e-msrank-person") }, "/api/v1/people");
    const teamId = await seed(api, "/api/v1/teams", { name: uniqueText("e2e-msrank-team") }, "/api/v1/teams");
    const stream = async (label: string) => {
      const name = uniqueText(`e2e-msrank-stream-${label}`);
      return { id: await seed(api, "/api/v1/work-streams", { name, ownerPersonId: person, startDate: "2026-01-05" }, "/api/v1/work-streams"), name };
    };
    const program = async (streamId: number, label: string) => {
      const name = uniqueText(`e2e-msrank-program-${label}`);
      return { id: await seed(api, `/api/v1/work-streams/${streamId}/programs`, { name, ownerPersonId: person }, "/api/v1/programs"), name };
    };
    const first = await stream("one");
    const second = await stream("two");
    const programs: RankWorld["programs"] = [await program(first.id, "one"), await program(first.id, "two"), await program(second.id, "three")];
    const milestone = { a: "", b: "", c: "", d: "", e: "" };
    const project = async (programId: number, label: keyof typeof milestone) => {
      const projectId = await seed(api, `/api/v1/programs/${programId}/projects`, { name: uniqueText(`e2e-msrank-proj-${label}`), ownerPersonId: person }, "/api/v1/projects");
      milestone[label] = uniqueText(`e2e-msrank-ms-${label}`);
      await seed(api, `/api/v1/projects/${projectId}/milestones`, { name: milestone[label], teamId, estimateMd: 2 }, "/api/v1/milestones");
      return projectId;
    };
    await project(programs[1].id, "d");
    await project(programs[2].id, "e");
    await project(programs[0].id, "c");
    const b = await project(programs[0].id, "b");
    const a = await project(programs[0].id, "a");
    if (ranked) await updateRankingViaApi(api, (current) => [...current, b, a]);
    return { streams: [first, second], programs, milestone };
  } finally {
    await api.dispose();
  }
}

/** The text of the first cell of each row, in order: a ranked project's position or the words of the dash. */
const rankCells = (page: Page) => rows(page).locator("td:first-child");

test("the Milestones page sorts by the project's rank, with the milestones of unranked projects last whichever way it sorts", async ({ page }) => {
  const world = await seedRankWorld({ ranked: true });
  const { a, b, c, d } = world.milestone;
  await login(page);

  // The first work stream holds projects a to d (programs one and two); the plan is shared, so its address is what makes the rows this spec's own.
  await page.goto(`/milestones?workStreamId=${world.streams[0].id}`);
  await expect(page.getByRole("heading", { level: 2, name: "Milestones", exact: true })).toBeVisible();
  // By default the project name: a, b, c, d.
  await expect(rows(page)).toContainText([a, b, c, d]);
  const rank = page.getByRole("columnheader", { name: "Rank" });
  await expect(rank).toHaveAttribute("aria-sort", "none");

  // Ascending: b is ranked before a, then the two unranked ones in the order of their project names.
  await rank.getByRole("button", { name: "Rank" }).click();
  await expect(rank).toHaveAttribute("aria-sort", "ascending");
  await expect(rows(page)).toContainText([b, a, c, d]);
  const ascending = (await rankCells(page).allInnerTexts()).map((text) => Number.parseInt(text, 10));
  expect(ascending[0]).toBeLessThan(ascending[1]);
  await expect(rankCells(page).nth(2)).toContainText("Unranked");
  await expect(rankCells(page).nth(3)).toContainText("Unranked");

  // Descending flips the ranked ones only: a before b, and the unranked ones are still last, in the same order.
  await rank.getByRole("button", { name: "Rank" }).click();
  await expect(rank).toHaveAttribute("aria-sort", "descending");
  await expect(rows(page)).toContainText([a, b, c, d]);
  const descending = (await rankCells(page).allInnerTexts()).map((text) => Number.parseInt(text, 10));
  expect(descending[0]).toBeGreaterThan(descending[1]);
  await expect(rankCells(page).nth(2)).toContainText("Unranked");
  await expect(rankCells(page).nth(3)).toContainText("Unranked");
});

test("the Milestones page narrows to a work stream and to a program from the address, and a work stream pick drops a program outside it", async ({ page }) => {
  const world = await seedRankWorld({ ranked: false });
  const { a, b, c, d, e } = world.milestone;
  const [streamOne, streamTwo] = world.streams;
  const [programOne, programTwo, programThree] = world.programs;
  await login(page);

  // A program from the address: its projects' milestones only (a, b and c are in the first program, d in the second).
  await page.goto(`/milestones?programId=${programOne.id}`);
  await expect(rows(page)).toHaveCount(3);
  for (const name of [a, b, c]) await expect(rows(page).filter({ hasText: name })).toHaveCount(1);
  await openFilters(page);
  await expect(page.getByRole("combobox", { name: "Program", exact: true })).toHaveValue(programOne.name);
  await page.goto(`/milestones?programId=${programTwo.id}`);
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page)).toContainText(d);

  // A work stream from the address: every program under it; the Program select then lists only that stream's programs.
  await page.goto(`/milestones?workStreamId=${streamOne.id}`);
  await expect(rows(page)).toHaveCount(4);
  await openFilters(page);
  const workStream = page.getByRole("combobox", { name: "Work stream", exact: true });
  await expect(workStream).toHaveValue(streamOne.name);
  const program = page.getByRole("combobox", { name: "Program", exact: true });
  await program.click();
  await expect(page.getByRole("option", { name: programOne.name, exact: true })).toBeVisible();
  await expect(page.getByRole("option", { name: programTwo.name, exact: true })).toBeVisible();
  await expect(page.getByRole("option", { name: programThree.name, exact: true })).toHaveCount(0);

  // Picking the second program narrows the four to its one, in the address too, and survives a reload.
  await page.getByRole("option", { name: programTwo.name, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`[?&]programId=${programTwo.id}(&|$)`));
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page)).toContainText(d);
  await page.reload();
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page)).toContainText(d);

  // Picking the other work stream drops the program (it is not under it): the address loses `programId` and the second stream's one milestone is listed.
  await openFilters(page);
  await workStream.click();
  await workStream.fill(streamTwo.name);
  await page.getByRole("option", { name: streamTwo.name, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`[?&]workStreamId=${streamTwo.id}(&|$)`));
  await expect(page).not.toHaveURL(/[?&]programId=/);
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page)).toContainText(e);
  await expect(page.getByRole("combobox", { name: "Program", exact: true })).toHaveValue("");
});
