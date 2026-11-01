// The Roadmap page (a timeline): an admin grants the ROADMAP_EDITOR right on Users -> Permissions; that editor ranks two projects from the
// row menu, moves one up from the keyboard (the menu button keeps focus, the live region says it), drags rows by their handle (inside the
// ranked rows, and below the "Unranked" divider = Unrank), and meets the stale-roadmap notice when the ranking changed under their page;
// a user without the right reads the same rows with no handle and no ranking item in the menu. The third test is the target window: a
// ROADMAP_EDITOR who owns nothing drags the band (pressing on the span bar over it - the pointer goes through to the window), draws a window across
// a row that has none, sets one from the keyboard through the row menu's dialog and clears it, and the project's own owner (no grant) reads the band
// read-only. The ranking is ONE global, shared list that
// other specs' ranking writes (and deletes of ranked projects) also touch, so every assertion is about the relative order of this spec's OWN
// projects (the program pick - a remembered browser setting - narrows the page to this spec's program), and every ranking write is retried
// on a stale-revision answer. Owns: its throwaway people, team, plan nodes (unique `e2e-rm-*` names), milestones and users, deleted by the end of
// each test and, if a step fails first, by the afterEach below (the plan nodes, team and people, children first - deleting a project also removes
// it from the ranking and takes its milestones along; the users through the Users page or, for the API-seeded ones, the API). The window test
// never writes the ranking.
import { randomUUID } from "node:crypto";
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
 * the stale notice and a reload (the PUT is a 409): wait the reload out and do the change again, from the list the server really has. The bound is
 * generous on purpose: `--repeat-each` runs copies of this very test on parallel workers, and they all write the one global ranking.
 */
async function change(page: Page, act: () => Promise<void>): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt++) {
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

  // The editor opens the Roadmap from the Planning section: both projects wait under the "Unranked" divider, with their target window as a band
  // (the editor may change it, so it is a draggable band, not a read-only image; the target window's gestures are the third test).
  await login(page, account.email, account.password);
  await openRoadmapOf(page, programId);
  await expect(page.getByRole("heading", { level: 3, name: "Timeline" })).toBeVisible();
  await expect.poll(() => layout(page, mine)).toEqual(["Unranked", first, second]);
  await expect(rowOf(page, first).getByRole("button", { name: `${first}, target window 2026-02-02 to 2026-03-31` })).toHaveCount(1);

  // Rank appends at the END: first, then second. The divider goes once nothing is unranked.
  await change(page, () => rowOperation(page, first, `Rank ${first}`));
  await expect.poll(() => layout(page, mine)).toEqual([first, "Unranked", second]);
  await change(page, () => rowOperation(page, second, `Rank ${second}`));
  await expect.poll(() => layout(page, mine)).toEqual([first, second]);

  // Move up, with the keyboard: the menu button takes Enter, the item takes Enter; focus is back on the menu button after the move and the
  // screen-reader status says where the row went.
  await change(page, async () => {
    // The previous change's menu is still fading out for ~150 ms; two dropdowns would have two focus sentinels.
    await expect(page.getByRole("menu")).toHaveCount(0);
    await operations(page, second).focus();
    await page.keyboard.press("Enter");
    await expect(operations(page, second)).toHaveAttribute("aria-expanded", "true");
    const item = page.getByRole("menuitem", { name: `Move up ${second}`, exact: true });
    // As a keyboard user: opened with Enter the menu's focus trap takes the focus into the dropdown (its sentinel), ArrowDown reaches the first item,
    // Enter takes it. Each step waits for the one before (a programmatic `focus()` straight away races the trap, which can pull the focus back into
    // the dropdown and swallow the Enter).
    await expect(page.locator("[data-autofocus]")).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(item).toBeFocused();
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

// ---- the target window: the band's drag, the draw, the dialog and Clear ---------------------------------------------------------------------

interface Account {
  email: string;
  password: string;
}

interface WindowWorld {
  programId: number;
  /** Has a target window 2026-02-02 to 2026-03-31 and a milestone 2026-02-09 to 2026-03-27 (its span lies inside the window). */
  moved: { id: number; name: string };
  /** Has no window and a milestone 2026-04-06 to 2026-04-24. */
  bare: { id: number; name: string };
  /** A ROADMAP_EDITOR who owns nothing (no person at all). */
  editor: Account;
  /** The two projects' own owner, with no grant: the plan structure lets them read the band, not move it. */
  owner: Account;
}

/** A user through the API (the spec is about the page, not about creating logins); answers its id and credentials. */
async function seedUser(api: APIRequestContext, label: string): Promise<{ id: number; account: Account }> {
  const name = uniqueText(`e2e-rm-${label}`);
  const account = { email: `${name.toLowerCase()}@astrolabe.local`, password: randomUUID().replace(/-/g, "") };
  const id = await seed(api, "/api/v1/users", { name, email: account.email, password: account.password }, "/api/v1/users");
  return { id, account };
}

/** A milestone on `teamId`, scheduled (an admin may schedule anything); it leaves with its project. */
async function scheduled(api: APIRequestContext, projectId: number, teamId: number, start: string, end: string): Promise<void> {
  const response = await api.post(`/api/v1/projects/${projectId}/milestones`, { data: { name: uniqueText("e2e-rm-m"), teamId, estimateMd: 1 } });
  expect(response.status(), await response.text()).toBe(201);
  const id = ((await response.json()) as { id: number }).id;
  const view = (await (await api.get(`/api/v1/views/project/${projectId}`)).json()) as { revision: number };
  const put = await api.put(`/api/v1/milestones/${id}/schedule`, { data: { expectedRevision: view.revision, startDate: start, endDate: end } });
  expect(put.status(), await put.text()).toBe(200);
}

async function seedWindowWorld(): Promise<WindowWorld> {
  const { api } = await apiAsAdmin();
  try {
    const editor = await seedUser(api, "editor");
    const owner = await seedUser(api, "owner");
    expect((await api.put(`/api/v1/users/${editor.id}/permissions`, { data: { permissions: ["ROADMAP_EDITOR"] } })).status()).toBe(204);
    const lead = await seed(api, "/api/v1/people", { name: uniqueText("e2e-rm-lead") }, "/api/v1/people");
    const ownerPerson = await seed(api, "/api/v1/people", { name: uniqueText("e2e-rm-ownerperson"), userId: owner.id }, "/api/v1/people");
    const teamId = await seed(api, "/api/v1/teams", { name: uniqueText("e2e-rm-team") }, "/api/v1/teams");
    const streamId = await seed(api, "/api/v1/work-streams", { name: uniqueText("e2e-rm-stream"), ownerPersonId: lead, startDate: "2026-01-05" }, "/api/v1/work-streams");
    const programId = await seed(api, `/api/v1/work-streams/${streamId}/programs`, { name: uniqueText("e2e-rm-program"), ownerPersonId: lead }, "/api/v1/programs");
    const movedName = uniqueText("e2e-rm-moved");
    const bareName = uniqueText("e2e-rm-bare");
    const movedId = await seed(api, `/api/v1/programs/${programId}/projects`, { name: movedName, ownerPersonId: ownerPerson, targetStart: "2026-02-02", targetEnd: "2026-03-31" }, "/api/v1/projects");
    const bareId = await seed(api, `/api/v1/programs/${programId}/projects`, { name: bareName, ownerPersonId: ownerPerson }, "/api/v1/projects");
    await scheduled(api, movedId, teamId, "2026-02-09", "2026-03-27");
    await scheduled(api, bareId, teamId, "2026-04-06", "2026-04-24");
    return { programId, moved: { id: movedId, name: movedName }, bare: { id: bareId, name: bareName }, editor: editor.account, owner: owner.account };
  } finally {
    await api.dispose();
  }
}

const addDays = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** Type an ISO date and leave the field by clicking the dialog title: Tab would focus the next date input and open its calendar over the footer. */
async function fillDate(dialog: Locator, label: string, value: string): Promise<void> {
  await dialog.getByLabel(label).fill(value);
  await dialog.getByRole("heading").first().click();
}

/** The next PUT of a project's target window. */
const windowPut = (page: Page, projectId: number) => page.waitForResponse((r) => r.request().method() === "PUT" && r.url().endsWith(`/api/v1/projects/${projectId}/target-window`));

/**
 * Press the middle of `target`, move `dx` pixels along the row and release. The target is a (read-only) span bar: its frame lets the pointer
 * through, so the press lands on the target window under it or on the row's draw surface. dnd-kit activates after 5 px, hence the short first step.
 */
async function dragAcross(page: Page, target: Locator, dx: number): Promise<void> {
  await target.evaluate((element) => element.scrollIntoView({ block: "center", inline: "center" }));
  const box = await target.boundingBox();
  if (!box) throw new Error("the bar is not laid out");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + Math.sign(dx) * 8, y, { steps: 3 });
  await page.mouse.move(x + dx, y, { steps: 10 });
  await page.mouse.up();
}

/** Open a row's menu as a keyboard user and take the item named `item`: Enter, ArrowDown until the item has the focus, Enter. */
async function menuItemByKeyboard(page: Page, name: string, item: string): Promise<void> {
  await expect(page.getByRole("menu")).toHaveCount(0); // a previous menu may still be fading out (two dropdowns, two focus sentinels)
  await operations(page, name).focus();
  await expect(operations(page, name)).toBeFocused();
  // dnd-kit swallows the click that follows a drag for 50 ms (its click blocker is removed on a timer), and an Enter on a button IS a click: right
  // after a pointer gesture the first Enter can be lost, so press it again until the menu is open (bounded; the same idiom as `rowOperation`).
  await expect(async () => {
    if ((await operations(page, name).getAttribute("aria-expanded")) !== "true") await page.keyboard.press("Enter");
    expect(await operations(page, name).getAttribute("aria-expanded")).toBe("true");
  }).toPass({ timeout: 10_000 });
  // Opened with Enter, the menu's focus trap takes the focus into the dropdown first; each ArrowDown then moves to the next item.
  await expect(page.locator("[data-autofocus]")).toBeFocused();
  const target = page.getByRole("menuitem", { name: item, exact: true });
  for (let step = 0; step < 8 && !(await target.evaluate((element) => element === document.activeElement)); step++) await page.keyboard.press("ArrowDown");
  await expect(target).toBeFocused();
  await page.keyboard.press("Enter");
}

test("a roadmap editor who owns nothing drags the band, draws a window, sets one from the keyboard dialog and clears it; the project's own owner reads the band read-only", async ({ page }) => {
  const { programId, moved, bare, editor, owner } = await seedWindowWorld();
  const band = (name: string, start: string, end: string) => rowOf(page, name).getByRole("button", { name: `${name}, target window ${start} to ${end}` });
  const anyBand = (name: string) => rowOf(page, name).getByRole("button", { name: new RegExp(`^${name}, target window `) });
  const span = (name: string, start: string, end: string) => rowOf(page, name).getByRole("img", { name: `${name}, ${start} to ${end}, read-only` });
  const drawSurface = (name: string) => rowOf(page, name).locator("[data-draw-surface]");

  await login(page, editor.email, editor.password);
  await openRoadmapOf(page, programId);

  // The editor's own rights make the window a draggable band; the project with none offers the draw across its row.
  await expect(band(moved.name, "2026-02-02", "2026-03-31")).toHaveCount(1);
  await expect(drawSurface(moved.name)).toHaveCount(0);
  await expect(drawSurface(bare.name)).toHaveCount(1);

  // Drag the band two weeks earlier, by pressing in the middle of the span bar that lies over it (the pointer goes through the span to the window).
  // The window now ends before the span: the server's drift flag appears on the row and in the panel after the refetch.
  const [movedPut] = await Promise.all([windowPut(page, moved.id), dragAcross(page, span(moved.name, "2026-02-09", "2026-03-27"), -42)]);
  expect(movedPut.status()).toBe(204);
  expect(movedPut.request().postDataJSON()).toEqual({ targetStart: "2026-01-19", targetEnd: "2026-03-17" });
  await expect(band(moved.name, "2026-01-19", "2026-03-17")).toHaveCount(1);
  await settled(page);
  await expect(rowOf(page, moved.name).locator("[data-flags]")).toHaveAttribute("data-flags", "1,1");
  await page.getByRole("button", { name: /^Show the \d+ flags?$/ }).click();
  await expect(page.getByRole("table", { name: "Flags of the projects shown" })).toContainText("Ends 10 days after the target");

  // Draw a window across the project that has none, pressing on its span bar: ten days from the day the pointer went down.
  const [drawPut] = await Promise.all([windowPut(page, bare.id), dragAcross(page, span(bare.name, "2026-04-06", "2026-04-24"), 30)]);
  expect(drawPut.status()).toBe(204);
  const drawn = drawPut.request().postDataJSON() as { targetStart: string; targetEnd: string };
  expect(drawn.targetEnd).toBe(addDays(drawn.targetStart, 10));
  expect(drawn.targetStart >= "2026-04-06" && drawn.targetStart <= "2026-04-24").toBe(true);
  await expect(band(bare.name, drawn.targetStart, drawn.targetEnd)).toHaveCount(1);
  await settled(page);
  await expect(drawSurface(bare.name)).toHaveCount(0);

  // Set a window from the keyboard: the row menu's Edit target window… item opens the dialog, the dates are typed, Save closes it and the focus is back on the menu button.
  await menuItemByKeyboard(page, moved.name, `Edit target window of ${moved.name}`);
  const dialog = page.getByRole("dialog", { name: `Target window of ${moved.name}` });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Target start")).toHaveValue("2026-01-19");
  await fillDate(dialog, "Target start", "2026-02-02");
  await fillDate(dialog, "Target end", "2026-03-31");
  const [dialogPut] = await Promise.all([windowPut(page, moved.id), dialog.getByRole("button", { name: "Save" }).click()]);
  expect(dialogPut.request().postDataJSON()).toEqual({ targetStart: "2026-02-02", targetEnd: "2026-03-31" });
  await expect(dialog).toBeHidden();
  await expect(band(moved.name, "2026-02-02", "2026-03-31")).toHaveCount(1);
  await expect(operations(page, moved.name)).toBeFocused();
  await expect(page.getByRole("status").filter({ hasText: `${moved.name}: target window 2026-02-02 to 2026-03-31` })).toBeAttached();
  await settled(page);

  // Clear it from the keyboard (the menu's Clear target window item): the band is gone, the row can be drawn on again and the focus stays on the menu button.
  const [cleared] = await Promise.all([windowPut(page, moved.id), menuItemByKeyboard(page, moved.name, `Clear target window of ${moved.name}`)]);
  expect(cleared.request().postDataJSON()).toEqual({ targetStart: null, targetEnd: null });
  await expect(anyBand(moved.name)).toHaveCount(0);
  await expect(drawSurface(moved.name)).toHaveCount(1);
  await expect(operations(page, moved.name)).toBeFocused();
  await settled(page);

  // The project's own owner (no grant, nothing above the project): the drawn band is a read-only image, there is nothing to draw on and the menu
  // only opens the project.
  await signOut(page);
  await login(page, owner.email, owner.password);
  await openRoadmapOf(page, programId);
  await expect(rowOf(page, bare.name).getByRole("img", { name: `${bare.name}, target window ${drawn.targetStart} to ${drawn.targetEnd}, read-only` })).toHaveCount(1);
  await expect(anyBand(bare.name)).toHaveCount(0);
  await expect(page.locator("[data-draw-surface]")).toHaveCount(0);
  await operations(page, bare.name).click();
  await expect(page.getByRole("menuitem", { name: `Open project ${bare.name}`, exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /target window/ })).toHaveCount(0);
});
