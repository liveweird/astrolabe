// The Programs page (the plan as a tree on a timeline): an admin reads work stream -> program -> project, folds the programs open and shut from
// the keyboard (the chevron button, said in the status region), checks that a program's bar is the span its projects cover and that the roll-up
// counts add up the flags of its projects, sees the arrow between two shown project rows, and switches to Year zoom; the program pick set on
// this page narrows the Roadmap (after a reload) and the one set there narrows this page; a user without any right reads the same tree with
// read-only bars and a row menu that only opens the project. The pick (a browser setting, `astrolabe.viewSettings.planning.programPick`)
// narrows every assertion to this spec's own program(s): the compose stack may hold the loaded sample plan, whatever other specs add, and an
// unfolded grid over 80 rows virtualises. Owns: its throwaway person, team, work stream, two programs, three projects with scheduled milestones,
// the link between two of them (unique `e2e-pg-*` names) and users, all seeded through the API and removed by the afterEach through the API,
// children first (the users through the Users page). It never touches the global ranking: its projects stay unranked.
import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { apiAsAdmin, createUserViaUi, deleteUserRow, deleteViaApi, expect, login, openFilters, signOut, test, uniqueText } from "./helpers";

// Registered in creation order; torn down in reverse (projects before programs before the stream, the team and the person).
const teardown: string[] = [];
test.afterEach(async () => {
  await deleteViaApi(teardown.splice(0).reverse());
});

/** The program pick's ONE shared key (a browser setting). */
const PICK_KEY = "astrolabe.viewSettings.planning.programPick";

async function seed(api: APIRequestContext, path: string, data: object, tear: string | null): Promise<number> {
  const response = await api.post(path, { data });
  expect(response.status(), await response.text()).toBe(201);
  const id = ((await response.json()) as { id: number }).id;
  if (tear !== null) teardown.push(`${tear}/${id}`);
  return id;
}

/** A milestone of the project on `teamId`, scheduled for the given days (an admin may schedule anything). */
async function schedule(api: APIRequestContext, projectId: number, teamId: number, name: string, start: string, end: string): Promise<void> {
  const milestoneId = await seed(api, `/api/v1/projects/${projectId}/milestones`, { name, teamId, estimateMd: 1 }, null);
  const view = (await (await api.get(`/api/v1/views/project/${projectId}`)).json()) as { revision: number };
  const response = await api.put(`/api/v1/milestones/${milestoneId}/schedule`, { data: { expectedRevision: view.revision, startDate: start, endDate: end } });
  expect(response.status(), await response.text()).toBe(200);
}

type Plan = { stream: string; a: string; b: string; aId: number; bId: number; late: string; early: string; other: string };

/**
 * One work stream with two programs. Program A: `late` (target 2026-03-02 to 03-31, milestones 03-02 to 03-06 and 04-06 to 04-10: its span
 * ends ten days after the target, one WARNING) and `early` (no window, one milestone 02-02 to 02-06); so A's span is 2026-02-02 to 2026-04-10.
 * Program B: `other` (target and milestone both 05-04 to 05-08: nothing flagged), linked after `late` by a finish-to-start project link.
 */
async function seedPlan(): Promise<Plan> {
  const { api } = await apiAsAdmin();
  try {
    const personId = await seed(api, "/api/v1/people", { name: uniqueText("e2e-pg-owner") }, "/api/v1/people");
    const teamId = await seed(api, "/api/v1/teams", { name: uniqueText("e2e-pg-team") }, "/api/v1/teams");
    const stream = uniqueText("e2e-pg-stream");
    const a = uniqueText("e2e-pg-program-a");
    const b = uniqueText("e2e-pg-program-b");
    const streamId = await seed(api, "/api/v1/work-streams", { name: stream, ownerPersonId: personId, startDate: "2026-01-05" }, "/api/v1/work-streams");
    const aId = await seed(api, `/api/v1/work-streams/${streamId}/programs`, { name: a, ownerPersonId: personId }, "/api/v1/programs");
    const bId = await seed(api, `/api/v1/work-streams/${streamId}/programs`, { name: b, ownerPersonId: personId }, "/api/v1/programs");
    const late = uniqueText("e2e-pg-late");
    const early = uniqueText("e2e-pg-early");
    const other = uniqueText("e2e-pg-other");
    const lateId = await seed(api, `/api/v1/programs/${aId}/projects`, { name: late, ownerPersonId: personId, targetStart: "2026-03-02", targetEnd: "2026-03-31" }, "/api/v1/projects");
    const earlyId = await seed(api, `/api/v1/programs/${aId}/projects`, { name: early, ownerPersonId: personId }, "/api/v1/projects");
    const otherId = await seed(api, `/api/v1/programs/${bId}/projects`, { name: other, ownerPersonId: personId, targetStart: "2026-05-04", targetEnd: "2026-05-08" }, "/api/v1/projects");
    await schedule(api, lateId, teamId, uniqueText("e2e-pg-m1"), "2026-03-02", "2026-03-06");
    await schedule(api, lateId, teamId, uniqueText("e2e-pg-m2"), "2026-04-06", "2026-04-10");
    await schedule(api, earlyId, teamId, uniqueText("e2e-pg-m3"), "2026-02-02", "2026-02-06");
    await schedule(api, otherId, teamId, uniqueText("e2e-pg-m4"), "2026-05-04", "2026-05-08");
    await seed(api, `/api/v1/projects/${otherId}/dependencies`, { predecessor: { kind: "PROJECT", id: lateId }, successor: { kind: "PROJECT", id: otherId }, type: "FS", lagDays: 0 }, null);
    return { stream, a, b, aId, bId, late, early, other };
  } finally {
    await api.dispose();
  }
}

const grid = (page: Page) => page.getByRole("grid", { name: "Programs timeline" });
/** The row of a work stream or program: the one that holds its chevron button. */
const nodeRow = (page: Page, label: string): Locator => grid(page).getByRole("row").filter({ has: page.getByRole("button", { name: label, exact: true }) });
const nodeButton = (page: Page, label: string): Locator => grid(page).getByRole("button", { name: label, exact: true });
/** The row of a project: the one that holds its "Open <name>" link. */
const projectRow = (page: Page, name: string): Locator => grid(page).getByRole("row").filter({ has: page.getByRole("link", { name: `Open ${name}`, exact: true }) });
const status = (page: Page, text: string): Locator => page.getByRole("status").filter({ hasText: text });

/** Set the program pick (a remembered browser setting) on the loaded page, then open the Programs page from the sidebar. */
async function openProgramsOf(page: Page, ...programIds: number[]): Promise<void> {
  await page.evaluate(([key, value]) => localStorage.setItem(key, value), [PICK_KEY, JSON.stringify(programIds)]);
  await page.getByRole("group", { name: "Planning" }).getByRole("link", { name: "Programs" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Programs" })).toBeVisible();
  await expect(grid(page)).toBeVisible();
}

/** Pick a program in the filter panel's multi-select (searched by its unique name). */
async function pickProgram(page: Page, name: string): Promise<void> {
  await openFilters(page);
  const field = page.getByRole("combobox", { name: "Programs" });
  await field.click();
  await field.fill(name);
  await page.getByRole("option", { name, exact: true }).click();
  await page.keyboard.press("Escape");
}

test("an admin reads the plan as a tree, folds programs from the keyboard, sees spans, roll-up counts and an arrow, and switches to Year zoom", async ({ page }) => {
  const plan = await seedPlan();
  await login(page);
  await openProgramsOf(page, plan.aId, plan.bId);

  // The work stream opens expanded, its programs folded; the facts line counts what the pick leaves.
  await expect(nodeButton(page, `Work stream ${plan.stream}`)).toHaveAttribute("aria-expanded", "true");
  await expect(nodeButton(page, `Program ${plan.a}`)).toHaveAttribute("aria-expanded", "false");
  await expect(nodeButton(page, `Program ${plan.b}`)).toHaveAttribute("aria-expanded", "false");
  await expect(grid(page).getByRole("link", { name: /^Open / })).toHaveCount(0);
  const facts = page.getByRole("group", { name: "Programs facts" });
  await expect(facts).toContainText("1 work stream");
  await expect(facts).toContainText("2 programs");
  await expect(facts).toContainText("3 projects");
  await expect(facts).toContainText("1 warning");

  // A program's bar is the span its projects cover; a work stream's the span of its programs. The late project's warning rolls up to both.
  await expect(nodeRow(page, `Program ${plan.a}`).getByRole("img", { name: `${plan.a}, program span 2026-02-02 to 2026-04-10, read-only` })).toHaveCount(1);
  await expect(nodeRow(page, `Program ${plan.b}`).getByRole("img", { name: `${plan.b}, program span 2026-05-04 to 2026-05-08, read-only` })).toHaveCount(1);
  await expect(nodeRow(page, `Work stream ${plan.stream}`).getByRole("img", { name: `${plan.stream}, work stream span 2026-02-02 to 2026-05-08, read-only` })).toHaveCount(1);
  await expect(nodeRow(page, `Program ${plan.a}`).locator("[data-flags]")).toHaveAttribute("data-flags", "1,0");
  await expect(nodeRow(page, `Work stream ${plan.stream}`).locator("[data-flags]")).toHaveAttribute("data-flags", "1,0");
  await expect(nodeRow(page, `Program ${plan.b}`).locator("[data-flags]")).toHaveCount(0);

  // Opening A with the pointer shows its projects, with the status saying so; each project's own span is what A's bar covers.
  await nodeButton(page, `Program ${plan.a}`).click();
  await expect(nodeButton(page, `Program ${plan.a}`)).toHaveAttribute("aria-expanded", "true");
  await expect(status(page, `${plan.a} expanded, 2 projects`)).toBeAttached();
  await expect(projectRow(page, plan.late).getByRole("img", { name: `${plan.late}, 2026-03-02 to 2026-04-10, read-only` })).toHaveCount(1);
  await expect(projectRow(page, plan.early).getByRole("img", { name: `${plan.early}, 2026-02-02 to 2026-02-06, read-only` })).toHaveCount(1);
  await expect(projectRow(page, plan.late).getByRole("img", { name: `${plan.late}, target window 2026-03-02 to 2026-03-31, read-only` })).toHaveCount(1);
  await expect(projectRow(page, plan.late).locator('[title="10 days past the target end"]')).toHaveCount(1);
  await expect(projectRow(page, plan.late).locator("[data-flags]")).toHaveAttribute("data-flags", "1,0");
  await expect(projectRow(page, plan.early).locator("[data-flags]")).toHaveCount(0);

  // The keyboard path: the chevron button takes Enter, keeps the focus through the change and the status says it.
  await nodeButton(page, `Program ${plan.a}`).focus();
  await page.keyboard.press("Enter");
  await expect(nodeButton(page, `Program ${plan.a}`)).toHaveAttribute("aria-expanded", "false");
  await expect(nodeButton(page, `Program ${plan.a}`)).toBeFocused();
  await expect(status(page, `${plan.a} collapsed`)).toBeAttached();
  await expect(grid(page).getByRole("link", { name: /^Open / })).toHaveCount(0);

  // Both programs open: the project link from the late project to the other one is an arrow between two shown rows (and holds, so not red).
  await expect(page.locator("[data-arrow]")).toHaveCount(0);
  await page.keyboard.press("Enter");
  await nodeButton(page, `Program ${plan.b}`).focus();
  await page.keyboard.press("Enter");
  await expect(projectRow(page, plan.other)).toBeVisible();
  await expect(page.locator("[data-arrow]")).toHaveCount(1);
  await expect(page.locator("[data-arrow]")).toHaveAttribute("data-violated", "false");
  // Folding B leaves the arrow's end without a row: no arrow.
  await page.keyboard.press("Enter");
  await expect(page.locator("[data-arrow]")).toHaveCount(0);

  // Expand all / Collapse all.
  await page.getByRole("button", { name: "Collapse all" }).click();
  await expect(nodeButton(page, `Work stream ${plan.stream}`)).toHaveAttribute("aria-expanded", "false");
  await expect(nodeButton(page, `Program ${plan.a}`)).toHaveCount(0);
  await page.getByRole("button", { name: "Expand all" }).click();
  await expect(projectRow(page, plan.early)).toBeVisible();
  await expect(projectRow(page, plan.other)).toBeVisible();
  await expect(page.locator("[data-arrow]")).toHaveCount(1);

  // Quarter by default (years are not a header at that zoom); Year puts the years in the header.
  await expect(grid(page).getByText("2026", { exact: true })).toHaveCount(0);
  await page.getByText("Year", { exact: true }).click();
  await expect(grid(page).getByText("2026", { exact: true }).first()).toBeVisible();
});

test("the program pick set on the Programs page narrows the Roadmap after a reload, and the pick set on the Roadmap narrows the Programs page", async ({ page }) => {
  const plan = await seedPlan();
  await login(page);
  // No pick yet: the page may hold every program of the stack (the sample plan); pick this spec's program A from the filter panel.
  await page.getByRole("group", { name: "Planning" }).getByRole("link", { name: "Programs" }).click();
  await expect(grid(page)).toBeVisible();
  await pickProgram(page, plan.a);
  await expect(grid(page).getByRole("button", { name: /^Work stream / })).toHaveCount(1);
  await expect(nodeButton(page, `Program ${plan.a}`)).toBeVisible();
  await expect(nodeButton(page, `Program ${plan.b}`)).toHaveCount(0);

  // The Roadmap reads the same remembered pick, also after a reload: only A's two projects (unranked) are on it.
  await page.getByRole("group", { name: "Planning" }).getByRole("link", { name: "Roadmap" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Roadmap" })).toBeVisible();
  await page.reload();
  const roadmap = page.getByRole("grid", { name: "Roadmap timeline" });
  await expect(roadmap).toBeVisible();
  await expect(roadmap.getByRole("link", { name: /^Open / })).toHaveCount(2);
  await expect(roadmap.getByRole("link", { name: `Open ${plan.late}`, exact: true })).toBeVisible();
  await expect(roadmap.getByRole("link", { name: `Open ${plan.early}`, exact: true })).toBeVisible();

  // Change the pick on the Roadmap to program B (clear A first): the Programs page shows B only, also after a reload.
  await openFilters(page);
  // Mantine hides its clear button from the accessibility tree (aria-hidden), so it is found by its label, not its role.
  await page.getByLabel("Clear the program pick").click();
  const field = page.getByRole("combobox", { name: "Programs" });
  await field.click();
  await field.fill(plan.b);
  await page.getByRole("option", { name: plan.b, exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(roadmap.getByRole("link", { name: /^Open / })).toHaveCount(1);
  await expect(roadmap.getByRole("link", { name: `Open ${plan.other}`, exact: true })).toBeVisible();
  await page.getByRole("group", { name: "Planning" }).getByRole("link", { name: "Programs" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Programs" })).toBeVisible();
  await page.reload();
  await expect(grid(page)).toBeVisible();
  await expect(nodeButton(page, `Program ${plan.b}`)).toBeVisible();
  await expect(nodeButton(page, `Program ${plan.a}`)).toHaveCount(0);
});

test("a user without any right reads the tree with read-only bars and a row menu that only opens the project", async ({ page }) => {
  await login(page);
  const account = await createUserViaUi(page, "E2E Programs Reader");
  const plan = await seedPlan();
  await signOut(page);

  await login(page, account.email, account.password);
  await openProgramsOf(page, plan.aId, plan.bId);
  await page.getByRole("button", { name: "Expand all" }).click();
  await expect(projectRow(page, plan.late)).toBeVisible();
  await expect(nodeRow(page, `Program ${plan.a}`).getByRole("img", { name: `${plan.a}, program span 2026-02-02 to 2026-04-10, read-only` })).toHaveCount(1);

  // Read-only: no row handle, no bar that could be picked up (the project's own span and its window are images), one item in the row menu.
  await expect(page.locator("[data-row-handle]")).toHaveCount(0);
  await expect(projectRow(page, plan.late).getByRole("img", { name: `${plan.late}, target window 2026-03-02 to 2026-03-31, read-only` })).toHaveCount(1);
  await expect(grid(page).getByRole("button", { name: new RegExp(`^${plan.late}, `) })).toHaveCount(0);
  await page.getByRole("button", { name: `Operations for ${plan.late}`, exact: true }).click();
  await expect(page.getByRole("menuitem", { name: `Open project ${plan.late}`, exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem")).toHaveCount(1);
  await page.keyboard.press("Escape");

  await signOut(page);
  await login(page);
  await deleteUserRow(page, account.name);
});
