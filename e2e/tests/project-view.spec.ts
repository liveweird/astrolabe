// The project view (/projects/:id): the project owner creates milestones that wait in the Unscheduled tray and cannot schedule them;
// the milestone's team manager schedules by button, dialog, keyboard, pointer drag and resize, meets the stale notice when someone else
// moved the bar, and unschedules; the owner reads the scheduled timeline with its derived span and drift and gets no handles. Pointer
// drag, the resize handles and the keyboard sensor run ONLY here (happy-dom has no layout). Owns: its throwaway users, people, team and
// plan nodes (unique `e2e-pv-*` names), all seeded through the API and deleted by the afterEach below (the project first - its
// milestones go with it - then program, work stream, team, people, users).
import { randomUUID } from "node:crypto";
import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { apiAsAdmin, deleteViaApi, expect, login, rowOperation, test, uniqueText } from "./helpers";

// Registered in creation order; torn down in reverse (a project before its program before its stream before the team and the people).
const teardown: string[] = [];
test.afterEach(async () => {
  await deleteViaApi(teardown.splice(0).reverse());
});

const TARGET = { targetStart: "2027-01-04", targetEnd: "2027-03-26" };

interface Account {
  email: string;
  password: string;
}

interface World {
  api: APIRequestContext;
  owner: Account;
  manager: Account;
  team: string;
  projectId: number;
  project: string;
}

async function seed(api: APIRequestContext, path: string, data: object, tear: string): Promise<number> {
  const response = await api.post(path, { data });
  expect(response.status(), await response.text()).toBe(201);
  const id = ((await response.json()) as { id: number }).id;
  teardown.push(`${tear}/${id}`);
  return id;
}

async function seedUser(api: APIRequestContext, label: string): Promise<{ id: number; account: Account }> {
  const name = uniqueText(`e2e-pv-${label}`);
  const account = { email: `${name.toLowerCase()}@astrolabe.local`, password: randomUUID().replace(/-/g, "") };
  const id = await seed(api, "/api/v1/users", { name, email: account.email, password: account.password }, "/api/v1/users");
  return { id, account };
}

/**
 * Two throwaway logins (a project OWNER and a team MANAGER, deliberately different people), a team the manager manages, and a plan
 * (work stream and program owned by a third, login-less person) holding one project owned by the owner, with a target window.
 */
async function seedWorld(target: object = TARGET): Promise<World> {
  const { api } = await apiAsAdmin();
  const owner = await seedUser(api, "owner");
  const manager = await seedUser(api, "manager");
  const lead = await seed(api, "/api/v1/people", { name: uniqueText("e2e-pv-lead") }, "/api/v1/people");
  const ownerPerson = await seed(api, "/api/v1/people", { name: uniqueText("e2e-pv-ownerperson"), userId: owner.id }, "/api/v1/people");
  const managerPerson = await seed(api, "/api/v1/people", { name: uniqueText("e2e-pv-managerperson"), userId: manager.id }, "/api/v1/people");
  const team = uniqueText("e2e-pv-team");
  await seed(api, "/api/v1/teams", { name: team, managerPersonId: managerPerson }, "/api/v1/teams");
  const streamId = await seed(api, "/api/v1/work-streams", { name: uniqueText("e2e-pv-stream"), ownerPersonId: lead, startDate: "2026-01-05" }, "/api/v1/work-streams");
  const programId = await seed(api, `/api/v1/work-streams/${streamId}/programs`, { name: uniqueText("e2e-pv-program"), ownerPersonId: lead }, "/api/v1/programs");
  const project = uniqueText("e2e-pv-project");
  const projectId = await seed(api, `/api/v1/programs/${programId}/projects`, { name: project, ownerPersonId: ownerPerson, ...target }, "/api/v1/projects");
  return { api, owner: owner.account, manager: manager.account, team, projectId, project };
}

/** A milestone of the project's team through the API (always unscheduled); answers its id. */
async function seedMilestone(world: World, name: string, estimateMd: number): Promise<number> {
  const teams = await world.api.get(`/api/v1/teams?name=${encodeURIComponent(world.team)}`);
  const teamId = ((await teams.json()) as { items: { id: number }[] }).items[0].id;
  const response = await world.api.post(`/api/v1/projects/${world.projectId}/milestones`, { data: { name, teamId, estimateMd } });
  expect(response.status(), await response.text()).toBe(201);
  return ((await response.json()) as { id: number }).id;
}

/** A schedule write as the ADMIN, with the view's current revision (a client that has just read the view). */
async function scheduleViaApi(world: World, milestoneId: number, startDate: string | null, endDate: string | null): Promise<void> {
  const view = await world.api.get(`/api/v1/views/project/${world.projectId}`);
  const { revision } = (await view.json()) as { revision: number };
  const response = await world.api.put(`/api/v1/milestones/${milestoneId}/schedule`, { data: { expectedRevision: revision, startDate, endDate } });
  expect(response.status(), await response.text()).toBe(200);
}

/** Type an ISO date and leave the field by clicking the dialog title: Tab would focus the next date input and open its calendar over the footer. */
async function fillDate(dialog: Locator, label: string, value: string): Promise<void> {
  await dialog.getByLabel(label).fill(value);
  await dialog.getByRole("heading").first().click();
}

const addDays = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

// The page's "today" is the viewer's LOCAL calendar day (`localIsoDate` in the SPA), never UTC. The browser's zone is pinned for this file
// (the config sets none, so it would follow the machine): UTC+14 puts the local date a day ahead of UTC for 14 hours of every day, which
// is what makes a UTC "today" here fail instead of passing by luck.
const ZONE = "Pacific/Kiritimati";
test.use({ timezoneId: ZONE });
/** Today's `YYYY-MM-DD` on the wall calendar of the pinned zone (en-CA formats as ISO). */
const localToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: ZONE }).format(new Date());

const bar = (page: Page, name: string) => page.getByRole("button", { name: new RegExp(`^${name}, `) });
const tray = (page: Page) => page.getByRole("table", { name: "Unscheduled milestones" });
/** The bar's dates as its accessible name states them: "{name}, {team}, {start} to {end}, {n} man-days". */
const span = (start: string, end: string) => new RegExp(`${start} to ${end}`);
const settled = (page: Page) => expect(page.locator('[aria-busy="true"]')).toHaveCount(0);

async function openProject(page: Page, world: World): Promise<void> {
  await page.goto(`/projects/${world.projectId}`);
  await expect(page.getByRole("heading", { level: 2, name: world.project })).toBeVisible();
}

/** Create a milestone through the New milestone dialog; answers when the POST has landed. */
async function createMilestone(page: Page, world: World, name: string, estimate: string): Promise<void> {
  await page.getByRole("button", { name: "New milestone" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name").fill(name);
  const team = dialog.getByRole("combobox", { name: "Team" });
  await team.click();
  await team.fill(world.team);
  await page.getByRole("option", { name: world.team }).click();
  await dialog.getByLabel("Estimate").fill(estimate);
  await Promise.all([
    page.waitForResponse((r) => r.request().method() === "POST" && /\/api\/v1\/projects\/\d+\/milestones$/.test(r.url()) && r.ok()),
    dialog.getByRole("button", { name: "Create", exact: true }).click(),
  ]);
  await expect(dialog).toHaveCount(0);
}

/**
 * Do one change and wait for its schedule PUT; answers the status. The page ignores a change while its previous save is still running,
 * and every save (accepted or refused as stale) is followed by a background reload of the view: that reload is registered BEFORE the
 * change and awaited AFTER the PUT, so the next step never starts while the page is still busy and a late reload can never overwrite it.
 */
async function change(page: Page, act: () => Promise<void>): Promise<number> {
  await settled(page);
  const reload = page.waitForResponse((r) => r.request().method() === "GET" && /\/api\/v1\/views\/project\/\d+$/.test(r.url()), { timeout: 15_000 });
  reload.catch(() => undefined); // no unhandled rejection when `act` fails first: the failure is `act`'s
  const [response] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === "PUT" && /\/api\/v1\/milestones\/\d+\/schedule$/.test(r.url())),
    act(),
  ]);
  await reload;
  await settled(page);
  return response.status();
}

/**
 * React Query reloads active views when the tab becomes visible again (`visibilitychange`). Nothing in this spec switches tabs, but a
 * reload racing a keyboard drag would replace the bars mid-gesture, so the event never reaches the app here.
 */
async function quietVisibility(page: Page): Promise<void> {
  await page.addInitScript(() => window.addEventListener("visibilitychange", (event) => event.stopImmediatePropagation(), true));
}

/**
 * dnd-kit's keyboard sensor on a focused bar or handle: Space picks up, → moves one day, Space drops. The pick-up and the step are ONE retried
 * unit that always starts from a known state (Escape cancels anything half picked up, then focus, Space, wait for "Picked up", → once, wait
 * for the step announcement): a retry can therefore never press the arrow twice (two days, never the one expected).
 */
async function keyboardMoveByOneDay(page: Page, target: Locator, name: string, start: string, end: string): Promise<void> {
  await expect(async () => {
    await page.keyboard.press("Escape");
    await target.focus();
    await expect(target).toBeFocused();
    await page.keyboard.press("Space");
    await expect(page.getByText(`Picked up ${name}`)).toBeAttached({ timeout: 3_000 });
    await page.keyboard.press("ArrowRight");
    await expect(page.getByText(`${name}: ${start} to ${end}`)).toBeAttached({ timeout: 3_000 });
  }).toPass({ timeout: 20_000 });
  await page.keyboard.press("Space");
}

/**
 * Focusing a bar scrolls it clear of the sticky columns and header (the grid reveals a keyboard-focused item itself: the browser does not
 * count them as covering the scroller) - so its centre is really the topmost element there, which a pointer press needs.
 */
async function focusRevealed(target: Locator): Promise<void> {
  // The grid reveals only keyboard-style focus (`:focus-visible`); after mouse work a script `focus()` is not, so a key press comes first.
  await target.page().keyboard.press("Shift");
  await target.focus();
  await expect
    .poll(() =>
      target.evaluate((el) => {
        const box = el.getBoundingClientRect();
        return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) === el;
      }),
    )
    .toBe(true);
}

/** Press on `from`'s centre and drag the pointer `dx` pixels along the row, in steps (dnd-kit's 5 px activation first). */
async function dragBy(page: Page, from: Locator, dx: number): Promise<void> {
  await focusRevealed(from);
  const box = await from.boundingBox();
  if (!box) throw new Error("the drag source is not laid out");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + Math.sign(dx) * 8, y, { steps: 4 });
  await page.mouse.move(x + dx, y, { steps: 15 });
  await page.mouse.up();
}

test("a project owner creates milestones in the Unscheduled tray and cannot schedule them", async ({ page }) => {
  const world = await seedWorld();
  await world.api.dispose();
  const first = uniqueText("e2e-pv-first");
  const second = uniqueText("e2e-pv-second");

  // The owner reaches the project through its name on the Plan page.
  await login(page, world.owner.email, world.owner.password);
  await page.goto("/plan");
  await page.getByRole("link", { name: `Open ${world.project}` }).click();
  await expect(page.getByRole("heading", { level: 2, name: world.project })).toBeVisible();
  const facts = page.getByRole("group", { name: "Project facts" });
  await expect(facts).toContainText("Target window: 2027-01-04 – 2027-03-26");
  await expect(facts).toContainText("Nothing scheduled");
  await expect(page.getByText("No milestones yet")).toBeVisible();

  await createMilestone(page, world, first, "2.5");
  await createMilestone(page, world, second, "0.25");

  // Both wait in the tray with their team and estimate; the owner has no way to give them dates.
  await expect(page.getByRole("heading", { level: 3, name: "Unscheduled" })).toBeVisible();
  await expect(tray(page).getByRole("row", { name: new RegExp(first) })).toContainText(world.team);
  await expect(tray(page).getByRole("row", { name: new RegExp(first) })).toContainText("2.5 man-days");
  await expect(tray(page).getByRole("row", { name: new RegExp(second) })).toContainText("0.25 man-days");
  await expect(page.getByRole("button", { name: /^Schedule / })).toHaveCount(0);
  await expect(page.locator('[class*="timelineTrayHandle"]')).toHaveCount(0);
  await expect(page.getByText("manager or an administrator schedules them")).toBeVisible();
  await expect(facts).toContainText("Nothing scheduled");
  // They do edit the plan fields: the row menu offers Edit and Delete, and no schedule items.
  await expect(page.getByRole("button", { name: `Operations for ${first}` })).toBeVisible();
  await page.getByRole("button", { name: `Operations for ${first}` }).click();
  await expect(page.getByRole("menuitem", { name: `Edit ${first}` })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /schedule/i })).toHaveCount(0);
});

test("the team's manager schedules a milestone by button, by keyboard, by pointer drag and by resize, and meets the stale notice", async ({ page }) => {
  // The target start is a month in the PAST, so "the later of today and the target start" is today whatever day the suite runs: the
  // Schedule button's start is then the viewer's local date, and a UTC "today" would be a day off for 14 hours of every day.
  const world = await seedWorld({ targetStart: addDays(localToday(), -30), targetEnd: "2027-03-26" });
  const name = uniqueText("e2e-pv-ms");
  const milestoneId = await seedMilestone(world, name, 3);
  // A second, already scheduled milestone is the ruler of the pointer drop at the end: its bar says where a known day is on screen.
  const ruler = uniqueText("e2e-pv-ruler");
  await scheduleViaApi(world, await seedMilestone(world, ruler, 1), "2027-02-15", "2027-02-19");

  await quietVisibility(page);
  await login(page, world.manager.email, world.manager.password);
  await openProject(page, world);
  await expect(tray(page).getByRole("row", { name: new RegExp(name) })).toBeVisible();

  // The Schedule button: one calendar week from today (the target start is already past).
  const start = localToday();
  expect(await change(page, () => page.getByRole("button", { name: `Schedule ${name}`, exact: true }).click())).toBe(200);
  await expect(bar(page, name)).toHaveAccessibleName(span(start, addDays(start, 6)));
  await expect(tray(page)).toHaveCount(0); // nothing left unscheduled: the tray says so instead of a table
  await expect(page.getByText("Every milestone is scheduled.")).toBeVisible();
  await expect(page.getByRole("rowheader", { name: new RegExp(name) })).toBeVisible();

  // Edit schedule…: typed dates through the dialog.
  await rowOperation(page, name, `Edit schedule of ${name}`);
  const dialog = page.getByRole("dialog");
  await fillDate(dialog, "Start date", "2027-02-01");
  await fillDate(dialog, "End date", "2027-02-05");
  expect(await change(page, () => dialog.getByRole("button", { name: "Save", exact: true }).click())).toBe(200);
  await expect(dialog).toHaveCount(0);
  await expect(bar(page, name)).toHaveAccessibleName(span("2027-02-01", "2027-02-05"));

  // The keyboard: Space, ArrowRight, Space moves the bar one day; the live region says so.
  expect(await change(page, () => keyboardMoveByOneDay(page, bar(page, name), name, "2027-02-02", "2027-02-06"))).toBe(200);
  await expect(bar(page, name)).toHaveAccessibleName(span("2027-02-02", "2027-02-06"));
  await expect(page.getByText(`Dropped ${name}: 2027-02-02 to 2027-02-06.`)).toBeAttached();

  // A real pointer drag by two day cells (28 px each at week zoom; measured from the five-day bar).
  const dayPx = ((await bar(page, name).boundingBox())?.width ?? 0) / 5;
  expect(dayPx).toBeGreaterThan(10);
  expect(await change(page, () => dragBy(page, bar(page, name), 2 * dayPx))).toBe(200);
  await expect(bar(page, name)).toHaveAccessibleName(span("2027-02-04", "2027-02-08"));

  // Resize by the end handle: one more day on the right.
  expect(await change(page, () => dragBy(page, page.getByRole("button", { name: `Resize end of ${name}` }), dayPx))).toBe(200);
  await expect(bar(page, name)).toHaveAccessibleName(span("2027-02-04", "2027-02-09"));

  // Someone else (the admin, with a fresh view) moves the same bar; the manager's next change is refused, said in words, and the bar
  // shows the server's dates after the reload.
  await scheduleViaApi(world, milestoneId, "2027-03-01", "2027-03-05");
  expect(await change(page, () => keyboardMoveByOneDay(page, bar(page, name), name, "2027-02-05", "2027-02-10"))).toBe(409);
  await expect(page.getByRole("alert")).toContainText("moved by someone else in the meantime");
  await settled(page);
  await expect(bar(page, name)).toHaveAccessibleName(span("2027-03-01", "2027-03-05"));

  // Unschedule from the row menu: the bar returns to the tray.
  expect(await change(page, () => rowOperation(page, name, `Unschedule ${name}`))).toBe(200);
  await expect(bar(page, name)).toHaveCount(0);
  await expect(tray(page).getByRole("row", { name: new RegExp(name) })).toBeVisible();

  // Drag the tray row onto the timeline with the pointer. The page is scrolled (the ruler is months right of the range start), so the day
  // under the pointer is only right if the drop zone is measured in the scrolled frame: three and a half day cells right of the ruler's
  // last day (2027-02-19) is the 23rd, and the milestone gets one calendar week from there.
  await focusRevealed(bar(page, ruler));
  const rulerBox = await bar(page, ruler).boundingBox();
  const handle = await tray(page).getByRole("row", { name: new RegExp(name) }).locator('[class*="timelineTrayHandle"]').boundingBox();
  if (!rulerBox || !handle) throw new Error("the ruler bar or the tray handle is not laid out");
  // both ends of the gesture must be on screen: the mouse cannot press or drop outside the viewport
  const viewport = page.viewportSize();
  if (!viewport) throw new Error("the page has no viewport");
  const inViewport = (box: { x: number; y: number; width: number; height: number }) =>
    box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width && box.y + box.height <= viewport.height;
  expect(inViewport(handle), "the tray handle is inside the viewport").toBe(true);
  expect(inViewport(rulerBox), "the ruler bar is inside the viewport").toBe(true);
  const dropX = rulerBox.x + rulerBox.width + 3.5 * (rulerBox.width / 5);
  const dropY = rulerBox.y + rulerBox.height / 2;
  // the drop point must be on the visible track (right of the sticky columns, inside the scroller), or the drop is rightly ignored
  const scroller = await page.getByRole("region", { name: "Milestone timeline" }).boundingBox();
  const lastColumn = await page.getByRole("grid", { name: "Milestone timeline" }).getByRole("columnheader", { name: "Operations" }).boundingBox();
  if (!scroller || !lastColumn) throw new Error("the timeline is not laid out");
  expect(dropX).toBeGreaterThan(lastColumn.x + lastColumn.width);
  expect(dropX).toBeLessThan(scroller.x + scroller.width - 20);
  expect(
    await change(page, async () => {
      await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
      await page.mouse.down();
      await page.mouse.move(handle.x + handle.width / 2 + 8, handle.y + handle.height / 2 - 8, { steps: 4 });
      await page.mouse.move(dropX, dropY, { steps: 20 });
      await page.mouse.up();
    }),
  ).toBe(200);
  await expect(bar(page, name)).toHaveAccessibleName(span("2027-02-23", "2027-03-01"));
  await expect(page.getByText("Every milestone is scheduled.")).toBeVisible();
  await world.api.dispose();
});

test("the project owner reads the scheduled timeline, the derived span and the drift, with no handles", async ({ page }) => {
  const world = await seedWorld({ targetStart: "2027-01-04", targetEnd: "2027-01-29" });
  const name = uniqueText("e2e-pv-late");
  await scheduleViaApi(world, await seedMilestone(world, name, 4), "2027-01-11", "2027-02-05");
  await world.api.dispose();

  await login(page, world.owner.email, world.owner.password);
  await openProject(page, world);
  const facts = page.getByRole("group", { name: "Project facts" });
  await expect(facts).toContainText("Target window: 2027-01-04 – 2027-01-29");
  await expect(facts).toContainText("Scheduled span: 2027-01-11 – 2027-02-05");
  await expect(facts).toContainText("Ends 7 days after the target");
  await expect(facts).toContainText("Starts 7 days after the target");

  // The bar is a read-only image: no handles, nothing to pick up, and the row menu has no schedule items.
  await expect(page.getByRole("img", { name: new RegExp(`^${name}, .*2027-01-11 to 2027-02-05.*, read-only$`) })).toBeVisible();
  await expect(bar(page, name)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Resize / })).toHaveCount(0);
  await page.getByRole("button", { name: `Operations for ${name}` }).click();
  await expect(page.getByRole("menuitem", { name: `Edit ${name}` })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /schedule/i })).toHaveCount(0);
});
