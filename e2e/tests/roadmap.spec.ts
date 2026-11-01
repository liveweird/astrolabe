// The Roadmap page: an admin grants the ROADMAP_EDITOR right on Users -> Permissions; that editor ranks two projects, reorders them
// with the Move up button, the dnd-kit keyboard sensor and a pointer drag, unranks one, and meets the stale-roadmap notice when the
// plan changed under their page; a user without the right sees the same list read-only. The ranking is ONE global, shared list
// that other specs' ranking writes (and deletes of ranked projects) also touch, so every assertion is about the relative order of this spec's OWN projects, and
// every ranking write is retried on a stale-revision answer. Owns: its throwaway people, plan nodes (unique `e2e-rm-*` names)
// and users, deleted by the end of each test and, if a step fails first, by the afterEach below (the plan nodes and people, children
// first - deleting a project also removes it from the ranking; the users through the Users page).
import type { APIRequestContext, Page } from "@playwright/test";
import { apiAsAdmin, createUserViaUi, deleteUserRow, deleteViaApi, expect, login, openFilters, rowOperation, signOut, test, uniqueText, updateRankingViaApi } from "./helpers";

// Registered in creation order; torn down in reverse (a project before its program before its stream before the person).
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

/** A person, a work stream, a program and one project per name, all through the API; answers the project ids in name order. */
async function seedProjects(names: string[]): Promise<number[]> {
  const { api } = await apiAsAdmin();
  try {
    const personId = await seed(api, "/api/v1/people", { name: uniqueText("e2e-rm-owner") }, "/api/v1/people");
    const streamId = await seed(api, "/api/v1/work-streams", { name: uniqueText("e2e-rm-stream"), ownerPersonId: personId, startDate: "2026-01-05" }, "/api/v1/work-streams");
    const programId = await seed(api, `/api/v1/work-streams/${streamId}/programs`, { name: uniqueText("e2e-rm-program"), ownerPersonId: personId }, "/api/v1/programs");
    const ids: number[] = [];
    for (const name of names) {
      ids.push(await seed(api, `/api/v1/programs/${programId}/projects`, { name, ownerPersonId: personId, targetStart: "2026-02-02", targetEnd: "2026-03-31" }, "/api/v1/projects"));
    }
    return ids;
  } finally {
    await api.dispose();
  }
}

/** The admin grants ROADMAP_EDITOR the way an admin does: Users -> the row's Permissions -> the switch -> Save. */
async function grantRoadmapEditor(page: Page, userName: string): Promise<void> {
  await page.goto("/users");
  await openFilters(page);
  await page.getByLabel("Name", { exact: true }).fill(userName);
  await rowOperation(page, userName, `Permissions for ${userName}`);
  await expect(page.getByRole("heading", { level: 2, name: "Permissions" })).toBeVisible();
  const grant = page.getByRole("switch", { name: "Roadmap editor" });
  await expect(grant).not.toBeChecked();
  await grant.check();
  await Promise.all([
    page.waitForResponse((r) => r.request().method() === "PUT" && /\/api\/v1\/users\/\d+\/permissions$/.test(r.url()) && r.ok()),
    page.getByRole("button", { name: "Save", exact: true }).click(),
  ]);
  await expect(page).toHaveURL(/\/users$/);
}

const rankedTable = (page: Page) => page.getByRole("table", { name: "Ranked projects" });
const rankedRow = (page: Page, name: string) => rankedTable(page).getByRole("row", { name: new RegExp(name) });

/** The names of `mine` in the order the ranked list shows them (other specs' rows may be ranked too; they are filtered out). */
async function ownOrder(page: Page, mine: string[]): Promise<string[]> {
  const names = await rankedTable(page).getByRole("row").evaluateAll((rows) => rows.map((row) => row.querySelectorAll("td")[1]?.textContent ?? ""));
  return names.filter((name) => mine.includes(name));
}

/**
 * Do one change and wait for its PUT. Another spec's ranking write can move the ranking's revision under this page, which the page answers with
 * the stale notice and a reload (the PUT is a 409): wait the reload out and do the change again, from the list the server really has.
 */
async function change(page: Page, act: () => Promise<void>): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt++) {
    // The page ignores a change while its previous save (or the reload after a refused one) is still running.
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
    const [response] = await Promise.all([
      page.waitForResponse((r) => r.request().method() === "PUT" && r.url().endsWith("/api/v1/roadmap/ranking")),
      act(),
    ]);
    if (response.status() === 200) return;
    expect(response.status()).toBe(409);
  }
  throw new Error("the roadmap kept changing under the page");
}

/** Press and release the pointer on a row's handle, dragging it onto another row's middle in steps (dnd-kit's 5 px activation first). */
async function dragOnto(page: Page, from: string, onto: string): Promise<void> {
  const handle = await page.getByRole("button", { name: `Drag ${from}` }).boundingBox();
  const target = await rankedRow(page, onto).boundingBox();
  if (!handle || !target) throw new Error("the drag handle or the target row is not laid out");
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2 + 8, { steps: 4 });
  await page.mouse.move(handle.x + handle.width / 2, target.y + target.height / 2, { steps: 15 });
  await page.mouse.up();
}

test("an admin grants the roadmap editor right; the editor ranks two projects, reorders them by keyboard and by drag, and unranks one", async ({ page }) => {
  const first = uniqueText("e2e-rm-first");
  const second = uniqueText("e2e-rm-second");
  const mine = [first, second];

  await login(page);
  const account = await createUserViaUi(page, "E2E Roadmap Editor");
  await seedProjects(mine);
  await grantRoadmapEditor(page, account.name);
  await signOut(page);

  // The editor opens the Roadmap from the Planning section; both projects wait in the Unranked group.
  await login(page, account.email, account.password);
  await page.getByRole("group", { name: "Planning" }).getByRole("link", { name: "Roadmap" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Roadmap" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 3, name: "Unranked" })).toBeVisible();
  const unranked = page.getByRole("table", { name: "Unranked projects" });
  await expect(unranked.getByRole("row", { name: new RegExp(first) })).toBeVisible();

  // Rank appends at the END: first, then second.
  await change(page, () => page.getByRole("button", { name: `Rank ${first}`, exact: true }).click());
  await change(page, () => page.getByRole("button", { name: `Rank ${second}`, exact: true }).click());
  await expect.poll(() => ownOrder(page, mine)).toEqual([first, second]);
  await expect(unranked.getByRole("row", { name: new RegExp(first) })).toHaveCount(0);

  // Move up, with the keyboard: Tab-reachable real buttons, Enter activates; focus stays on the row's buttons through the move.
  await change(page, async () => {
    await page.getByRole("button", { name: `Move up ${second}`, exact: true }).focus();
    await page.keyboard.press("Enter");
  });
  await expect.poll(() => ownOrder(page, mine)).toEqual([second, first]);
  await expect(rankedRow(page, second).locator(":focus")).toHaveCount(1);
  await expect(page.getByText(`${second} moved to position`)).toBeAttached();

  // dnd-kit's keyboard sensor on the handle: Space picks up, ArrowUp moves over the row above, Space drops. dnd-kit measures the rows a
  // moment after the pick-up, so each step waits for the announcement it causes (the live region holds only the latest one, and the pick-up is followed at once by "over its own row").
  const here = Number(await rankedRow(page, first).getByRole("cell").first().textContent());
  await change(page, async () => {
    await page.getByRole("button", { name: `Drag ${first}`, exact: true }).focus();
    await page.keyboard.press("Space");
    await expect(page.getByText(`${first} is over position ${here} of`)).toBeAttached();
    // A key pressed before dnd-kit has measured the rows is dropped (never queued), so press again until the row above is reached.
    await expect(async () => {
      await page.keyboard.press("ArrowUp");
      await expect(page.getByText(`${first} is over position ${here - 1} of`)).toBeAttached({ timeout: 1_000 });
    }).toPass({ timeout: 10_000 });
    await page.keyboard.press("Space");
  });
  await expect.poll(() => ownOrder(page, mine)).toEqual([first, second]);

  // A pointer drag: the second project onto the first.
  await change(page, () => dragOnto(page, second, first));
  await expect.poll(() => ownOrder(page, mine)).toEqual([second, first]);

  // Unrank one: it leaves the list and waits in the Unranked group.
  await change(page, () => page.getByRole("button", { name: `Unrank ${second}`, exact: true }).click());
  await expect.poll(() => ownOrder(page, mine)).toEqual([first]);
  await expect(unranked.getByRole("row", { name: new RegExp(second) })).toBeVisible();

  // The ranking changes under the open page (the same list, a new revision): the next change is refused, said in words, and the list reloads.
  const { api } = await apiAsAdmin();
  try {
    await updateRankingViaApi(api, (ranked) => ranked);
  } finally {
    await api.dispose();
  }
  const [stale] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === "PUT" && r.url().endsWith("/api/v1/roadmap/ranking")),
    page.getByRole("button", { name: `Rank ${second}`, exact: true }).click(),
  ]);
  expect(stale.status()).toBe(409);
  await expect(page.getByRole("alert")).toContainText("The roadmap changed in the meantime");
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  await expect.poll(() => ownOrder(page, mine)).toEqual([first]);
  await expect(page.getByRole("button", { name: `Rank ${second}`, exact: true })).toBeVisible();

  // The same change again, from the reloaded list, goes through.
  await change(page, () => page.getByRole("button", { name: `Rank ${second}`, exact: true }).click());
  await expect.poll(() => ownOrder(page, mine)).toEqual([first, second]);

  // Cleanup: the projects leave the ranking with their deletion (afterEach); the admin removes the user.
  await signOut(page);
  await login(page);
  await deleteUserRow(page, account.name);
});

test("a user without the roadmap right sees the ranked list read-only", async ({ page }) => {
  const first = uniqueText("e2e-rm-read-first");
  const second = uniqueText("e2e-rm-read-second");
  const third = uniqueText("e2e-rm-read-third");
  const mine = [first, second];

  await login(page);
  const account = await createUserViaUi(page, "E2E Roadmap Reader");
  const [firstId, secondId] = await seedProjects([first, second, third]);
  const { api } = await apiAsAdmin();
  try {
    await updateRankingViaApi(api, (ranked) => [...ranked, firstId, secondId]);
  } finally {
    await api.dispose();
  }
  await signOut(page);

  await login(page, account.email, account.password);
  await page.goto("/roadmap");
  await expect(page.getByRole("heading", { level: 2, name: "Roadmap" })).toBeVisible();
  await expect.poll(() => ownOrder(page, mine)).toEqual([first, second]);
  await expect(rankedRow(page, first)).toContainText("2026-02-02 – 2026-03-31");
  await expect(page.getByRole("table", { name: "Unranked projects" }).getByRole("row", { name: new RegExp(third) })).toBeVisible();

  // Read-only: no handle, no Move, no Unrank, no Rank, no operations column - the lists are plain tables.
  await expect(page.getByRole("button", { name: /^(Drag|Move up|Move down|Unrank|Rank) / })).toHaveCount(0);
  await expect(page.getByRole("main").getByRole("button")).toHaveCount(0);
  await expect(page.getByText("Everyone can read it")).toBeVisible();

  await signOut(page);
  await login(page);
  await deleteUserRow(page, account.name);
});
