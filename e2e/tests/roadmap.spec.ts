// The Roadmap page (a timeline): an admin grants the ROADMAP_EDITOR right on Users -> Permissions; that editor ranks two projects from the
// row menu, moves one up from the keyboard (the menu button keeps focus, the live region says it), drags rows by their handle (inside the
// ranked rows, and below the "Unranked" divider = Unrank), and meets the stale-roadmap notice when the ranking changed under their page;
// a user without the right reads the same rows with no handle and no ranking item in the menu. The ranking is ONE global, shared list that
// other specs' ranking writes (and deletes of ranked projects) also touch, so every assertion is about the relative order of this spec's OWN
// projects (the program pick - a remembered browser setting - narrows the page to this spec's program), and every ranking write is retried
// on a stale-revision answer. Owns: its throwaway people, plan nodes (unique `e2e-rm-*` names) and users, deleted by the end of each test
// and, if a step fails first, by the afterEach below (the plan nodes and people, children first - deleting a project also removes it from
// the ranking; the users through the Users page).
import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { apiAsAdmin, createUserViaUi, deleteUserRow, deleteViaApi, expect, login, openFilters, rowOperation, signOut, test, uniqueText, updateRankingViaApi } from "./helpers";

// Registered in creation order; torn down in reverse (a project before its program before its stream before the person).
const teardown: string[] = [];
test.afterEach(async () => {
  await deleteViaApi(teardown.splice(0).reverse());
});

/** The program pick's ONE shared key (a browser setting, `astrolabe.viewSettings.planning.programPick`). */
const PICK_KEY = "astrolabe.viewSettings.planning.programPick";

async function seed(api: APIRequestContext, path: string, data: object, tear: string): Promise<number> {
  const response = await api.post(path, { data });
  expect(response.status(), await response.text()).toBe(201);
  const id = ((await response.json()) as { id: number }).id;
  teardown.push(`${tear}/${id}`);
  return id;
}

/** A person, a work stream, a program and one project per name, all through the API; answers the program id and the project ids in name order. */
async function seedProjects(names: string[]): Promise<{ programId: number; projectIds: number[] }> {
  const { api } = await apiAsAdmin();
  try {
    const personId = await seed(api, "/api/v1/people", { name: uniqueText("e2e-rm-owner") }, "/api/v1/people");
    const streamId = await seed(api, "/api/v1/work-streams", { name: uniqueText("e2e-rm-stream"), ownerPersonId: personId, startDate: "2026-01-05" }, "/api/v1/work-streams");
    const programId = await seed(api, `/api/v1/work-streams/${streamId}/programs`, { name: uniqueText("e2e-rm-program"), ownerPersonId: personId }, "/api/v1/programs");
    const projectIds: number[] = [];
    for (const name of names) {
      projectIds.push(await seed(api, `/api/v1/programs/${programId}/projects`, { name, ownerPersonId: personId, targetStart: "2026-02-02", targetEnd: "2026-03-31" }, "/api/v1/projects"));
    }
    return { programId, projectIds };
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

/** Open the Roadmap from the sidebar with the program pick set to this spec's program, so the page shows only its own rows (and the divider). */
async function openRoadmapOf(page: Page, programId: number): Promise<void> {
  await page.evaluate(([key, value]) => localStorage.setItem(key, value), [PICK_KEY, JSON.stringify([programId])]);
  await page.getByRole("group", { name: "Planning" }).getByRole("link", { name: "Roadmap" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Roadmap" })).toBeVisible();
  await expect(grid(page)).toBeVisible();
}

const grid = (page: Page) => page.getByRole("grid", { name: "Roadmap timeline" });
/** The row of a project: the one that holds its "Open <name>" link. */
const rowOf = (page: Page, name: string): Locator => grid(page).getByRole("row").filter({ has: page.getByRole("link", { name: `Open ${name}`, exact: true }) });
const operations = (page: Page, name: string): Locator => page.getByRole("button", { name: `Operations for ${name}`, exact: true });

/** The rows of the page top to bottom, as a project's name or "Unranked" for the divider (the picked program hides every other spec's rows). */
async function layout(page: Page, mine: string[]): Promise<string[]> {
  const labels = await grid(page)
    .getByRole("row")
    .evaluateAll((rows) => rows.slice(1).map((row) => row.querySelector('a[href^="/projects/"]')?.textContent ?? row.textContent?.trim() ?? ""));
  return labels.filter((label) => label === "Unranked" || mine.includes(label));
}

const settled = (page: Page) => expect(page.locator('[aria-busy="true"]')).toHaveCount(0);

/**
 * Do one change and wait for its PUT. Another spec's ranking write can move the ranking's revision under this page, which the page answers with
 * the stale notice and a reload (the PUT is a 409): wait the reload out and do the change again, from the list the server really has.
 */
async function change(page: Page, act: () => Promise<void>): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt++) {
    // The page refuses a change while its previous save (or the reload after a refused one) is still running.
    await settled(page);
    const [response] = await Promise.all([
      page.waitForResponse((r) => r.request().method() === "PUT" && r.url().endsWith("/api/v1/roadmap/ranking")),
      act(),
    ]);
    if (response.status() === 200) return;
    expect(response.status()).toBe(409);
  }
  throw new Error("the roadmap kept changing under the page");
}

/**
 * Press a row's handle, drag it down or up the page to `fraction` of the target row's height and release. dnd-kit activates after 5 px, so the
 * first step is a short move; the pointer then travels in steps so the slot follows it. The upper half of a row is the slot before it, the lower
 * half the slot after it.
 */
async function dragRow(page: Page, from: string, onto: string, fraction: number): Promise<void> {
  await rowOf(page, from).scrollIntoViewIfNeeded();
  const handle = await rowOf(page, from).locator("[data-row-handle]").boundingBox();
  const target = await rowOf(page, onto).boundingBox();
  if (!handle || !target) throw new Error("the row handle or the target row is not laid out");
  const x = handle.x + handle.width / 2;
  await page.mouse.move(x, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(x, handle.y + handle.height / 2 + (target.y > handle.y ? 8 : -8), { steps: 4 });
  await page.mouse.move(x, target.y + target.height * fraction, { steps: 15 });
  await page.mouse.up();
}

test("an admin grants the roadmap editor right; the editor ranks two projects from the row menu, moves and drags them, unranks by drag, and meets the stale notice", async ({ page }) => {
  const first = uniqueText("e2e-rm-first");
  const second = uniqueText("e2e-rm-second");
  const mine = [first, second];

  await login(page);
  const account = await createUserViaUi(page, "E2E Roadmap Editor");
  const { programId } = await seedProjects(mine);
  await grantRoadmapEditor(page, account.name);
  await signOut(page);

  // The editor opens the Roadmap from the Planning section: both projects wait under the "Unranked" divider, with their target window as a band.
  await login(page, account.email, account.password);
  await openRoadmapOf(page, programId);
  await expect(page.getByRole("heading", { level: 3, name: "Timeline" })).toBeVisible();
  await expect.poll(() => layout(page, mine)).toEqual(["Unranked", first, second]);
  await expect(rowOf(page, first).getByRole("img", { name: `${first}, target window 2026-02-02 to 2026-03-31, read-only` })).toHaveCount(1);

  // Rank appends at the END: first, then second. The divider goes once nothing is unranked.
  await change(page, () => rowOperation(page, first, `Rank ${first}`));
  await expect.poll(() => layout(page, mine)).toEqual([first, "Unranked", second]);
  await change(page, () => rowOperation(page, second, `Rank ${second}`));
  await expect.poll(() => layout(page, mine)).toEqual([first, second]);

  // Move up, with the keyboard: the menu button takes Enter, the item takes Enter; focus is back on the menu button after the move and the
  // screen-reader status says where the row went.
  await change(page, async () => {
    await operations(page, second).focus();
    await page.keyboard.press("Enter");
    await expect(operations(page, second)).toHaveAttribute("aria-expanded", "true");
    const item = page.getByRole("menuitem", { name: `Move up ${second}`, exact: true });
    await item.focus();
    await page.keyboard.press("Enter");
  });
  await expect.poll(() => layout(page, mine)).toEqual([second, first]);
  await expect(operations(page, second)).toBeFocused();
  await expect(page.getByRole("status").filter({ hasText: `${second} moved to position` })).toBeAttached();

  // A pointer drag by the handle inside the ranked rows: the first project onto the upper half of the second's row.
  await settled(page);
  await change(page, () => dragRow(page, first, second, 0.25));
  await expect.poll(() => layout(page, mine)).toEqual([first, second]);

  // Unrank from the menu: the second project drops under the divider.
  await change(page, () => rowOperation(page, second, `Unrank ${second}`));
  await expect.poll(() => layout(page, mine)).toEqual([first, "Unranked", second]);

  // Dropping a ranked row below the divider unranks it (the lower half of the unranked row's slot is beyond the divider).
  await settled(page);
  await change(page, () => dragRow(page, first, second, 0.75));
  await expect.poll(() => layout(page, mine)).toEqual(["Unranked", first, second]);

  await change(page, () => rowOperation(page, second, `Rank ${second}`));
  await expect.poll(() => layout(page, mine)).toEqual([second, "Unranked", first]);

  // The ranking changes under the open page (the same list, a new revision): the next change is refused, said in words, and the list reloads.
  const { api } = await apiAsAdmin();
  try {
    await updateRankingViaApi(api, (ranked) => ranked);
  } finally {
    await api.dispose();
  }
  await settled(page);
  const [stale] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === "PUT" && r.url().endsWith("/api/v1/roadmap/ranking")),
    rowOperation(page, first, `Rank ${first}`),
  ]);
  expect(stale.status()).toBe(409);
  await expect(page.getByRole("alert")).toContainText("The roadmap changed in the meantime");
  await settled(page);
  await expect.poll(() => layout(page, mine)).toEqual([second, "Unranked", first]);

  // The same change again, from the reloaded list, goes through.
  await change(page, () => rowOperation(page, first, `Rank ${first}`));
  await expect.poll(() => layout(page, mine)).toEqual([second, first]);

  // Cleanup: the projects leave the ranking with their deletion (afterEach); the admin removes the user.
  await signOut(page);
  await login(page);
  await deleteUserRow(page, account.name);
});

test("a user without the roadmap right reads the ranked rows with no handle and no ranking item in the menu", async ({ page }) => {
  const first = uniqueText("e2e-rm-read-first");
  const second = uniqueText("e2e-rm-read-second");
  const third = uniqueText("e2e-rm-read-third");
  const mine = [first, second, third];

  await login(page);
  const account = await createUserViaUi(page, "E2E Roadmap Reader");
  const { programId, projectIds } = await seedProjects(mine);
  const { api } = await apiAsAdmin();
  try {
    await updateRankingViaApi(api, (ranked) => [...ranked, projectIds[0], projectIds[1]]);
  } finally {
    await api.dispose();
  }
  await signOut(page);

  await login(page, account.email, account.password);
  await openRoadmapOf(page, programId);
  await expect.poll(() => layout(page, mine)).toEqual([first, second, "Unranked", third]);
  await expect(rowOf(page, first).getByRole("img", { name: `${first}, target window 2026-02-02 to 2026-03-31, read-only` })).toHaveCount(1);
  await expect(page.getByText("Everyone can read it")).toBeVisible();

  // Read-only: no drag handle anywhere, no bar that can be picked up, and the row menu offers the project and nothing that changes the ranking.
  await expect(page.locator("[data-row-handle]")).toHaveCount(0);
  await expect(grid(page).getByRole("button", { name: new RegExp(`^${first}, `) })).toHaveCount(0);
  await operations(page, first).click();
  await expect(page.getByRole("menuitem", { name: `Open project ${first}`, exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /Move|Rank/ })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menuitem")).toHaveCount(0);
  await operations(page, third).click();
  await expect(page.getByRole("menuitem", { name: `Open project ${third}`, exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /Move|Rank/ })).toHaveCount(0);

  await signOut(page);
  await login(page);
  await deleteUserRow(page, account.name);
});
