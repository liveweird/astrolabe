// The Plan page: an admin builds work stream -> program -> project through the modals (assigning owners, a target window, handing
// a project over), then deletes them bottom-up; a PROJECT owner edits their project but is offered no way to set its target
// window and no actions on anything they do not own. Owns: its throwaway people, plan nodes (unique `e2e-plan-*` names) and user,
// deleted by the end of each test and, if a step fails first, by the afterEach below (plan nodes and people only, children first;
// the user is removed through the Users page). The move test also ranks two of its own projects (the global ranking is shared: it
// asserts only their order relative to each other; deleting a project takes it out of the ranking). The order tests write the work streams' shared order
// and one stream's program order: they assert only the order of their own streams and programs relative to each other, never an absolute place.
import type { APIRequestContext, Locator, Page, Response } from "@playwright/test";
import { apiAsAdmin, createUserViaUi, deleteUserRow, deleteViaApi, expect, login, rowOperation, signOut, test, uniqueText, updateRankingViaApi, fillDate } from "./helpers";

// Registered in creation order; torn down in reverse (a project before its program before its stream before the people).
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

async function pickOwner(page: Page, dialog: Locator, name: string): Promise<void> {
  const owner = dialog.getByRole("combobox", { name: "Owner" });
  await owner.click();
  await owner.fill(name);
  await page.getByRole("option", { name }).click();
}

/** Press Create in the open dialog and return the new record's id from the POST response. */
async function createAndGetId(page: Page, dialog: Locator, path: RegExp): Promise<number> {
  const [response] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === "POST" && path.test(r.url()) && r.ok()),
    dialog.getByRole("button", { name: "Create", exact: true }).click(),
  ]);
  return ((await response.json()) as { id: number }).id;
}

/** A row of the Plan table by level and name (the row header holds the name; `data-parent` names the row's parent by kind and id, `ws:<id>` / `pg:<id>`). */
function treeRow(page: Page, kind: "workStream" | "program" | "project", name: string): Locator {
  return page.locator(`tr[data-scope="tree"][data-kind="${kind}"]`).filter({ hasText: name });
}

/** The visible names of the items of a row's menu (it is opened and closed again). */
async function menuItems(page: Page, name: string): Promise<string[]> {
  const trigger = page.getByRole("button", { name: `Operations for ${name}`, exact: true });
  await trigger.click();
  const items = page.getByRole("menuitem");
  await expect(items.first()).toBeVisible();
  const names = (await items.allTextContents()).map((text) => text.trim());
  await page.keyboard.press("Escape");
  await expect(items).toHaveCount(0);
  return names;
}

async function confirmDelete(page: Page, path: RegExp): Promise<void> {
  await Promise.all([
    page.waitForResponse((r) => r.request().method() === "DELETE" && path.test(r.url()) && r.ok()),
    page.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).click(),
  ]);
}

test("admin builds a work stream, a program and a project, assigns owners, and deletes them bottom-up", async ({ page }) => {
  const { api } = await apiAsAdmin();
  const anna = uniqueText("e2e-plan-anna");
  const ben = uniqueText("e2e-plan-ben");
  await seed(api, "/api/v1/people", { name: anna }, "/api/v1/people");
  await seed(api, "/api/v1/people", { name: ben }, "/api/v1/people");
  await api.dispose();

  await login(page);
  await page.goto("/plan");
  await expect(page.getByRole("heading", { level: 2, name: "Plan" })).toBeVisible();

  // Work stream: name, owner, start date.
  const streamName = uniqueText("e2e-plan-stream");
  await page.getByRole("button", { name: "New work stream" }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name").fill(streamName);
  await pickOwner(page, dialog, anna);
  await fillDate(dialog, "Start date", "2026-01-05");
  const streamId = await createAndGetId(page, dialog, /\/api\/v1\/work-streams$/);
  teardown.push(`/api/v1/work-streams/${streamId}`);
  const streamRow = treeRow(page, "workStream", streamName);
  await expect(streamRow).toBeVisible();
  await expect(streamRow).toContainText(anna);
  await expect(streamRow).toContainText("From 2026-01-05");

  // Program under it, owned by the same person.
  const programName = uniqueText("e2e-plan-program");
  await page.getByRole("button", { name: `New program in ${streamName}` }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name").fill(programName);
  await pickOwner(page, dialog, anna);
  teardown.push(`/api/v1/programs/${await createAndGetId(page, dialog, /\/api\/v1\/work-streams\/\d+\/programs$/)}`);
  await expect(treeRow(page, "program", programName)).toHaveAttribute("data-parent", `ws:${streamId}`);

  // Project under the program, owned by the second person, with a target window.
  const projectName = uniqueText("e2e-plan-project");
  await page.getByRole("button", { name: `New project in ${programName}` }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name").fill(projectName);
  await pickOwner(page, dialog, ben);
  await fillDate(dialog, "Target start", "2026-02-02");
  await fillDate(dialog, "Target end", "2026-03-31");
  teardown.push(`/api/v1/projects/${await createAndGetId(page, dialog, /\/api\/v1\/programs\/\d+\/projects$/)}`);
  await expect(treeRow(page, "project", projectName)).toContainText(ben);
  await expect(treeRow(page, "project", projectName)).toContainText("2026-02-02 – 2026-03-31");

  // The stream folds away what is under it, the fold is remembered across a reload, and opening it brings the rows back.
  const streamToggle = page.getByRole("button", { name: `Work stream ${streamName}`, exact: true });
  await expect(streamToggle).toHaveAttribute("aria-expanded", "true");
  await streamToggle.click();
  await expect(streamToggle).toHaveAttribute("aria-expanded", "false");
  await expect(treeRow(page, "program", programName)).toHaveCount(0);
  await expect(treeRow(page, "project", projectName)).toHaveCount(0);
  await page.reload();
  await expect(streamToggle).toHaveAttribute("aria-expanded", "false");
  await expect(treeRow(page, "program", programName)).toHaveCount(0);
  await streamToggle.click();
  await expect(streamToggle).toHaveAttribute("aria-expanded", "true");
  await expect(treeRow(page, "project", projectName)).toBeVisible();

  // The search lives in the address: it shows the match with its stream and program as context rows, survives a reload, and clearing it brings the plan back.
  const searchBox = page.getByRole("textbox", { name: "Search work streams, programs and projects" });
  await searchBox.fill(projectName);
  await expect(page).toHaveURL(new RegExp(`[?&]q=${projectName}`));
  await expect(page.locator('tr[data-scope="tree"][data-kind="workStream"]')).toHaveCount(1);
  await expect(treeRow(page, "workStream", streamName)).toHaveAttribute("data-context", "true");
  await expect(treeRow(page, "program", programName)).toHaveAttribute("data-context", "true");
  await expect(treeRow(page, "project", projectName)).not.toHaveAttribute("data-context", "true");
  await expect(treeRow(page, "project", projectName).locator("mark")).toHaveText(projectName);
  await page.reload();
  await expect(searchBox).toHaveValue(projectName);
  await expect(page.locator('tr[data-scope="tree"][data-kind="workStream"]')).toHaveCount(1);
  await page.getByRole("button", { name: "Clear the search" }).click();
  await expect(page).not.toHaveURL(/[?&]q=/);
  await expect(treeRow(page, "workStream", streamName)).not.toHaveAttribute("data-context", "true");
  await expect(treeRow(page, "project", projectName)).toBeVisible();

  // Hand the project over, rename it and extend the target window in the same save.
  const renamed = `${projectName}-renamed`;
  await rowOperation(page, projectName, `Edit ${projectName}`);
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name").fill(renamed);
  await dialog.getByLabel("Clear the owner").click();
  await pickOwner(page, dialog, anna);
  await fillDate(dialog, "Target end", "2026-04-15");
  await Promise.all([
    page.waitForResponse((r) => r.request().method() === "PUT" && /\/api\/v1\/projects\/\d+\/details$/.test(r.url()) && r.ok()),
    dialog.getByRole("button", { name: "Save", exact: true }).click(),
  ]);
  const row = treeRow(page, "project", renamed);
  await expect(row).toContainText(anna);
  await expect(row).toContainText("2026-02-02 – 2026-04-15");

  // A parent with children refuses to go (the server's 409, said in words); bottom-up deletion works.
  await rowOperation(page, streamName, `Delete ${streamName}`);
  await page.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByText("This work stream still has programs. Delete them first.")).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();

  await rowOperation(page, renamed, `Delete ${renamed}`);
  await confirmDelete(page, /\/api\/v1\/projects\/\d+$/);
  await expect(page.getByText(renamed)).toHaveCount(0);
  await rowOperation(page, programName, `Delete ${programName}`);
  await confirmDelete(page, /\/api\/v1\/programs\/\d+$/);
  await expect(treeRow(page, "program", programName)).toHaveCount(0);
  await rowOperation(page, streamName, `Delete ${streamName}`);
  await confirmDelete(page, /\/api\/v1\/work-streams\/\d+$/);
  await expect(treeRow(page, "workStream", streamName)).toHaveCount(0);
});

test("a project owner edits their project but is offered no target window and no other actions", async ({ page }) => {
  await login(page);
  const account = await createUserViaUi(page, "E2E Plan Owner");
  const { api } = await apiAsAdmin();
  const lead = uniqueText("e2e-plan-lead");
  const mine = uniqueText("e2e-plan-mine");
  const leadId = await seed(api, "/api/v1/people", { name: lead }, "/api/v1/people");
  const minePersonId = await seed(api, "/api/v1/people", { name: mine, userId: account.id }, "/api/v1/people");
  const streamName = uniqueText("e2e-plan-stream");
  const programName = uniqueText("e2e-plan-program");
  const ownProject = uniqueText("e2e-plan-own");
  const foreignProject = uniqueText("e2e-plan-foreign");
  const streamId = await seed(api, "/api/v1/work-streams", { name: streamName, ownerPersonId: leadId, startDate: "2026-01-05" }, "/api/v1/work-streams");
  const programId = await seed(api, `/api/v1/work-streams/${streamId}/programs`, { name: programName, ownerPersonId: leadId }, "/api/v1/programs");
  const targetWindow = { targetStart: "2026-02-02", targetEnd: "2026-03-31" };
  await seed(api, `/api/v1/programs/${programId}/projects`, { name: ownProject, ownerPersonId: minePersonId, ...targetWindow }, "/api/v1/projects");
  await seed(api, `/api/v1/programs/${programId}/projects`, { name: foreignProject, ownerPersonId: leadId, ...targetWindow }, "/api/v1/projects");
  await api.dispose();
  await signOut(page);

  await login(page, account.email, account.password);
  await page.goto("/plan");
  await expect(treeRow(page, "workStream", streamName)).toBeVisible();
  // Everything is readable, the folds included (a reader's table is the same table), but only their own project offers actions.
  await expect(page.getByRole("button", { name: "New work stream" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: `New program in ${streamName}` })).toHaveCount(0);
  await expect(page.getByRole("button", { name: `New project in ${programName}` })).toHaveCount(0);
  // Everyone may focus and pin, so every row has a menu; the stream, the program and the lead's project offer nothing else.
  expect(await menuItems(page, streamName)).toEqual(["Show only this", "Pin"]);
  expect(await menuItems(page, programName)).toEqual(["Show only this", "Pin"]);
  expect(await menuItems(page, foreignProject)).toEqual(["Pin"]);
  expect(await menuItems(page, ownProject)).toEqual(["Pin", "Edit", "Delete"]);
  await expect(page.getByRole("button", { name: `Work stream ${streamName}`, exact: true })).toHaveAttribute("aria-expanded", "true");

  // Edit: the fields are theirs, the target window is not.
  await rowOperation(page, ownProject, `Edit ${ownProject}`);
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Name")).toBeEnabled();
  await expect(dialog.getByLabel("Target start", { exact: true })).toBeDisabled();
  await expect(dialog.getByLabel("Target end", { exact: true })).toBeDisabled();
  await expect(dialog.getByText("Only an administrator, an owner above the project or a roadmap editor can change the target window.")).toBeVisible();
  const renamed = `${ownProject}-renamed`;
  await dialog.getByLabel("Name").fill(renamed);
  await Promise.all([
    page.waitForResponse((r) => r.request().method() === "PUT" && /\/api\/v1\/projects\/\d+$/.test(r.url()) && r.ok()),
    dialog.getByRole("button", { name: "Save", exact: true }).click(),
  ]);
  const row = page.getByRole("row", { name: new RegExp(renamed) });
  await expect(row).toContainText(mine);
  await expect(row).toContainText("2026-02-02 – 2026-03-31");
  await signOut(page);

  // Cleanup as the admin (the plan nodes and people are removed by the afterEach).
  await login(page);
  await deleteUserRow(page, account.name);
});

/** The ranked project ids that are among `own`, in ranking order (the ranking is shared state: only relative order is asserted). */
async function rankedAmong(api: APIRequestContext, own: number[]): Promise<number[]> {
  const read = await api.get("/api/v1/views/roadmap");
  expect(read.ok(), await read.text()).toBeTruthy();
  const view = (await read.json()) as { ranked: { project: { id: number } }[] };
  return view.ranked.map((entry) => entry.project.id).filter((id) => own.includes(id));
}

test("a work stream owner moves a project to another program and a program to another work stream; rank and milestones travel along", async ({ page }) => {
  await login(page);
  const account = await createUserViaUi(page, "E2E Plan Mover");
  const { api } = await apiAsAdmin();
  const lead = uniqueText("e2e-plan-lead");
  const mine = uniqueText("e2e-plan-mine");
  const leadId = await seed(api, "/api/v1/people", { name: lead }, "/api/v1/people");
  const mineId = await seed(api, "/api/v1/people", { name: mine, userId: account.id }, "/api/v1/people");
  const team = uniqueText("e2e-plan-team");
  const teamId = await seed(api, "/api/v1/teams", { name: team }, "/api/v1/teams");
  // Two work streams the user owns (so a program may move between them), a program each under the first, and two projects led by
  // somebody else - the user reaches them only as the owner of the stream ABOVE.
  const streamA = uniqueText("e2e-plan-stream-a");
  const streamB = uniqueText("e2e-plan-stream-b");
  const programOne = uniqueText("e2e-plan-program-one");
  const programTwo = uniqueText("e2e-plan-program-two");
  const project = uniqueText("e2e-plan-moving");
  const sibling = uniqueText("e2e-plan-sibling");
  const milestone = uniqueText("e2e-plan-milestone");
  const streamAId = await seed(api, "/api/v1/work-streams", { name: streamA, ownerPersonId: mineId, startDate: "2026-01-05" }, "/api/v1/work-streams");
  const streamBId = await seed(api, "/api/v1/work-streams", { name: streamB, ownerPersonId: mineId, startDate: "2026-01-05" }, "/api/v1/work-streams");
  const programOneId = await seed(api, `/api/v1/work-streams/${streamAId}/programs`, { name: programOne, ownerPersonId: leadId }, "/api/v1/programs");
  const programTwoId = await seed(api, `/api/v1/work-streams/${streamAId}/programs`, { name: programTwo, ownerPersonId: leadId }, "/api/v1/programs");
  const projectId = await seed(api, `/api/v1/programs/${programOneId}/projects`, { name: project, ownerPersonId: leadId }, "/api/v1/projects");
  const siblingId = await seed(api, `/api/v1/programs/${programOneId}/projects`, { name: sibling, ownerPersonId: leadId }, "/api/v1/projects");
  const created = await api.post(`/api/v1/projects/${projectId}/milestones`, { data: { name: milestone, teamId, estimateMd: 2 } });
  expect(created.status(), await created.text()).toBe(201);
  await updateRankingViaApi(api, (ranked) => [...ranked, projectId, siblingId]);
  const rankBefore = await rankedAmong(api, [projectId, siblingId]);
  expect(rankBefore).toEqual([projectId, siblingId]);
  await signOut(page);

  await login(page, account.email, account.password);
  await page.goto("/plan");
  await expect(treeRow(page, "workStream", streamA)).toBeVisible();

  // The project moves from program one to program two (same stream): the offered targets leave out its own program.
  await rowOperation(page, project, `Move ${project} to another program`);
  let dialog = page.getByRole("dialog", { name: "Move project" });
  await expect(dialog).toContainText(`Project ${project} is currently in program ${programOne}.`);
  const target = dialog.getByRole("combobox", { name: "New program" });
  await target.click();
  await expect(page.getByRole("option", { name: programOne })).toHaveCount(0);
  await page.getByRole("option", { name: programTwo }).click();
  await Promise.all([
    page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith(`/api/v1/projects/${projectId}/move`) && r.status() === 204),
    dialog.getByRole("button", { name: "Move", exact: true }).click(),
  ]);
  await expect(page.getByText("Project moved")).toBeVisible();
  await expect(dialog).toHaveCount(0);
  await expect(treeRow(page, "project", project)).toHaveAttribute("data-parent", `pg:${programTwoId}`);

  // The project view shows the new program, and the milestone came along.
  await page.getByRole("link", { name: `Open ${project}`, exact: true }).click();
  await expect(page.getByRole("heading", { level: 2, name: project })).toBeVisible();
  await expect(page.getByText(`${programTwo} · ${streamA} · Owner: ${lead}`)).toBeVisible();
  await expect(page.getByRole("table", { name: "Unscheduled milestones" }).getByRole("row", { name: new RegExp(milestone) })).toBeVisible();

  // The program (with the project under it) moves to the other work stream.
  await page.goto("/plan");
  await rowOperation(page, programTwo, `Move ${programTwo} to another work stream`);
  dialog = page.getByRole("dialog", { name: "Move program" });
  await dialog.getByRole("combobox", { name: "New work stream" }).click();
  await expect(page.getByRole("option", { name: streamA })).toHaveCount(0);
  await page.getByRole("option", { name: streamB }).click();
  await Promise.all([
    page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith(`/api/v1/programs/${programTwoId}/move`) && r.status() === 204),
    dialog.getByRole("button", { name: "Move", exact: true }).click(),
  ]);
  await expect(page.getByText("Program moved")).toBeVisible();
  await expect(dialog).toHaveCount(0);
  await expect(treeRow(page, "program", programTwo)).toHaveAttribute("data-parent", `ws:${streamBId}`);
  await page.getByRole("link", { name: `Open ${project}`, exact: true }).click();
  await expect(page.getByText(`${programTwo} · ${streamB} · Owner: ${lead}`)).toBeVisible();

  // Neither move touched the global ranking.
  expect(await rankedAmong(api, [projectId, siblingId])).toEqual(rankBefore);
  await api.dispose();
  await signOut(page);
  await login(page);
  await deleteUserRow(page, account.name);
});

// Pins live in the browser (apart from the tree's folds), the focus in the address: a pinned program stays on the page while a search narrows the tree,
// the pins and their folds survive a reload, "Show only this" narrows the table to a node and the breadcrumb leads back.
test("a pinned program stays in reach while a search runs, pins and folds survive a reload, and Show only this leads back by the breadcrumb", async ({ page }) => {
  const { api } = await apiAsAdmin();
  const lead = uniqueText("e2e-plan-lead");
  const leadId = await seed(api, "/api/v1/people", { name: lead }, "/api/v1/people");
  const streamName = uniqueText("e2e-plan-stream");
  const pinned = uniqueText("e2e-plan-pinned");
  const other = uniqueText("e2e-plan-other");
  const pinnedProject = uniqueText("e2e-plan-pinned-project");
  const otherProject = uniqueText("e2e-plan-other-project");
  const streamId = await seed(api, "/api/v1/work-streams", { name: streamName, ownerPersonId: leadId, startDate: "2026-01-05" }, "/api/v1/work-streams");
  const pinnedId = await seed(api, `/api/v1/work-streams/${streamId}/programs`, { name: pinned, ownerPersonId: leadId }, "/api/v1/programs");
  const otherId = await seed(api, `/api/v1/work-streams/${streamId}/programs`, { name: other, ownerPersonId: leadId }, "/api/v1/programs");
  await seed(api, `/api/v1/programs/${pinnedId}/projects`, { name: pinnedProject, ownerPersonId: leadId }, "/api/v1/projects");
  await seed(api, `/api/v1/programs/${otherId}/projects`, { name: otherProject, ownerPersonId: leadId }, "/api/v1/projects");
  await api.dispose();

  await login(page);
  await page.goto("/plan");
  const pinnedRegion = page.getByRole("region", { name: "Pinned rows of the plan" });
  const pinnedRow = (kind: "program" | "project", name: string) => pinnedRegion.locator(`tr[data-kind="${kind}"]`).filter({ hasText: name });

  // Pin the program from its row menu: the pinned section shows it with its project, the tree row carries the marker, and the focus stays on the menu button.
  await rowOperation(page, pinned, `Pin: ${pinned}`);
  await expect(pinnedRow("program", pinned)).toBeVisible();
  await expect(pinnedRow("project", pinnedProject)).toBeVisible();
  await expect(treeRow(page, "program", pinned).getByText("Pinned", { exact: true })).toBeAttached();
  await expect(page.getByRole("button", { name: `Operations for ${pinned}`, exact: true })).toBeFocused();

  // A fold inside the pinned section is its own: the tree keeps the project.
  await page.getByRole("button", { name: `Program ${pinned} (pinned)`, exact: true }).click();
  await expect(pinnedRow("project", pinnedProject)).toHaveCount(0);
  await expect(treeRow(page, "project", pinnedProject)).toBeVisible();

  // A search that matches only the other program narrows the tree; the pin stays, in view, whatever the search.
  const searchBox = page.getByRole("textbox", { name: "Search work streams, programs and projects" });
  await searchBox.fill(otherProject);
  await expect(page).toHaveURL(new RegExp(`[?&]q=${otherProject}`));
  await expect(treeRow(page, "project", otherProject)).toBeVisible();
  await expect(treeRow(page, "program", pinned)).toHaveCount(0);
  await expect(pinnedRow("program", pinned)).toBeInViewport();

  // Pins, the pinned fold and the search survive a reload.
  await page.reload();
  await expect(searchBox).toHaveValue(otherProject);
  await expect(pinnedRow("program", pinned)).toBeVisible();
  await expect(pinnedRow("project", pinnedProject)).toHaveCount(0);
  await page.getByRole("button", { name: "Clear the search" }).click();
  await expect(page).not.toHaveURL(/[?&]q=/);

  // Show only this: the address names the program, the table is that program and its project, the breadcrumb leads back.
  await rowOperation(page, other, `Show only this: ${other}`);
  await expect(page).toHaveURL(new RegExp(`[?&]programId=${otherId}(&|$)`));
  await expect(page.locator('tr[data-scope="tree"]')).toHaveCount(2);
  await expect(treeRow(page, "program", other)).toBeVisible();
  const crumbs = page.getByRole("navigation", { name: "Part of the plan shown" });
  await expect(crumbs.getByRole("link", { name: streamName })).toBeVisible();
  await expect(pinnedRow("program", pinned)).toBeVisible();
  await crumbs.getByRole("link", { name: "All work streams" }).click();
  await expect(page).not.toHaveURL(/programId=/);
  await expect(treeRow(page, "program", pinned)).toBeVisible();

  // Unpin with the section's own button: the section goes, and the focus lands on the node's row menu in the tree.
  await page.getByRole("button", { name: `Unpin: ${pinned} (pinned)`, exact: true }).click();
  await expect(pinnedRegion).toHaveCount(0);
  await expect(page.getByRole("button", { name: `Operations for ${pinned}`, exact: true })).toBeFocused();
});

/** A work stream's program rows in the tree, as `pg:<id>` keys in table order. */
const programKeys = (page: Page, streamId: number): Promise<string[]> =>
  page.locator(`tr[data-scope="tree"][data-kind="program"][data-parent="ws:${streamId}"]`).evaluateAll((rows) => rows.map((row) => row.getAttribute("data-key") ?? ""));

/** Every work stream row in the tree, as `ws:<id>` keys in table order. */
const streamKeys = (page: Page): Promise<string[]> =>
  page.locator('tr[data-scope="tree"][data-kind="workStream"]').evaluateAll((rows) => rows.map((row) => row.getAttribute("data-key") ?? ""));

/** The page's own write is over (the table says it is busy while an order write runs; a change is refused until then). */
async function settled(page: Page): Promise<void> {
  await expect(page.getByRole("table", { name: "Work streams, programs and projects" })).toHaveAttribute("aria-busy", "false");
}

/**
 * Press a row's grip, drag it to `fraction` of the target row's height and release. dnd-kit activates after 5 px, so the first step is a short move; the
 * pointer then travels in steps so the slot follows it. The upper half of a row is the slot before its block, the lower half the slot after it.
 */
async function dragRow(page: Page, from: string, onto: string, fraction: number): Promise<void> {
  const row = page.locator(`tr[data-scope="tree"][data-key="${from}"]`);
  // Centre the middle of the travel (not the held row), so neither end comes near the auto-scroll bands at the window's edges: a pointer held there scrolls
  // the rows under it and the drop would land elsewhere.
  await row.evaluate((element, key) => {
    const onto = element.ownerDocument.querySelector(`tr[data-scope="tree"][data-key="${key}"]`);
    const a = element.getBoundingClientRect();
    const b = (onto ?? element).getBoundingClientRect();
    window.scrollBy(0, (Math.min(a.top, b.top) + Math.max(a.bottom, b.bottom)) / 2 - window.innerHeight / 2);
  }, onto);
  const handle = await row.locator("[data-plan-handle]").boundingBox();
  const target = await page.locator(`tr[data-scope="tree"][data-key="${onto}"]`).boundingBox();
  if (!handle || !target) throw new Error("the row's grip or the target row is not laid out");
  const x = handle.x + handle.width / 2;
  await page.mouse.move(x, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(x, handle.y + handle.height / 2 + (target.y > handle.y ? 8 : -8), { steps: 4 });
  await page.mouse.move(x, target.y + target.height * fraction, { steps: 15 });
  await page.mouse.up();
}

const orderPut = (path: RegExp) => (r: Response) => r.request().method() === "PUT" && path.test(r.url());

// Re-arranging: a work stream's owner puts its programs in another order by a real drag and from the row menu (the focus stays on the menu button), the
// Programs page and a second sign-in read the same order, and a reader has no grip at all.
test("a work stream owner re-orders its programs by a drag and from the row menu; the Programs page and an admin read the same order; a reader has no grip", async ({ page }) => {
  await login(page);
  const account = await createUserViaUi(page, "E2E Plan Orderer");
  const reader = await createUserViaUi(page, "E2E Plan Reader");
  const { api } = await apiAsAdmin();
  const lead = uniqueText("e2e-plan-lead");
  const mine = uniqueText("e2e-plan-mine");
  const leadId = await seed(api, "/api/v1/people", { name: lead }, "/api/v1/people");
  const mineId = await seed(api, "/api/v1/people", { name: mine, userId: account.id }, "/api/v1/people");
  const stream = uniqueText("e2e-plan-order-stream");
  const [one, two, three] = [uniqueText("e2e-plan-order-a"), uniqueText("e2e-plan-order-b"), uniqueText("e2e-plan-order-c")];
  const streamId = await seed(api, "/api/v1/work-streams", { name: stream, ownerPersonId: mineId, startDate: "2026-01-05" }, "/api/v1/work-streams");
  const oneId = await seed(api, `/api/v1/work-streams/${streamId}/programs`, { name: one, ownerPersonId: leadId }, "/api/v1/programs");
  const twoId = await seed(api, `/api/v1/work-streams/${streamId}/programs`, { name: two, ownerPersonId: leadId }, "/api/v1/programs");
  const threeId = await seed(api, `/api/v1/work-streams/${streamId}/programs`, { name: three, ownerPersonId: leadId }, "/api/v1/programs");
  // A project under each program: the Programs page draws a program's fold button only when it has projects, and that button is how its row is read there.
  const projectOf: Record<number, number> = {};
  for (const id of [oneId, twoId, threeId]) projectOf[id] = await seed(api, `/api/v1/programs/${id}/projects`, { name: uniqueText("e2e-plan-order-project"), ownerPersonId: leadId }, "/api/v1/projects");
  await api.dispose();
  const keys = (...ids: number[]) => ids.map((id) => `pg:${id}`);
  const programPath = new RegExp(`/api/v1/work-streams/${streamId}/program-order$`);
  const row = (key: string) => page.locator(`tr[data-scope="tree"][data-key="${key}"]`);
  await signOut(page);

  // Untouched, the programs follow their names. A reader (no person, no right) has no grip on any of them.
  await login(page, reader.email, reader.password);
  await page.goto("/plan");
  await expect(row(`ws:${streamId}`)).toBeVisible();
  expect(await programKeys(page, streamId)).toEqual(keys(oneId, twoId, threeId));
  await expect(page.locator(`tr[data-scope="tree"][data-parent="ws:${streamId}"] [data-plan-handle]`)).toHaveCount(0);
  await expect(page.locator("[data-plan-handle]")).toHaveCount(0);
  await signOut(page);

  // The owner has a grip on each program, none on the work stream (an administrator's right) and none on the project (never re-arranged).
  await login(page, account.email, account.password);
  await page.goto("/plan");
  await expect(row(`ws:${streamId}`)).toBeVisible();
  for (const id of [oneId, twoId, threeId]) await expect(row(`pg:${id}`).locator("[data-plan-handle]")).toHaveCount(1);
  await expect(row(`ws:${streamId}`).locator("[data-plan-handle]")).toHaveCount(0);
  await expect(page.locator(`tr[data-scope="tree"][data-kind="project"][data-parent="pg:${oneId}"] [data-plan-handle]`)).toHaveCount(0);

  // A real drag: the first program (with its project) onto the lower half of the last one's BLOCK: its project row, the block's last row (the lower half of
  // the program's own row is still above the block's midpoint).
  await settled(page);
  await Promise.all([page.waitForResponse((r) => orderPut(programPath)(r) && r.status() === 200), dragRow(page, `pg:${oneId}`, `pj:${projectOf[threeId]}`, 0.75)]);
  await expect.poll(() => programKeys(page, streamId)).toEqual(keys(twoId, threeId, oneId));
  await settled(page);

  // The row menu, with the keyboard: the menu opens on its first item, the arrows reach Move up (the last row's Move down is disabled), Enter takes it.
  const menuButton = page.getByRole("button", { name: `Operations for ${one}`, exact: true });
  await expect(page.getByRole("menu")).toHaveCount(0);
  // dnd-kit swallows clicks for 50 ms after a drop, and the click Enter produces is one of them when it comes that soon: open the menu until it is open.
  const firstItem = page.getByRole("menuitem", { name: `Show only this: ${one}`, exact: true });
  await expect(async () => {
    if ((await page.getByRole("menu").count()) === 0) {
      await menuButton.focus();
      await page.keyboard.press("Enter");
    }
    await expect(firstItem).toBeFocused({ timeout: 1000 });
  }).toPass({ timeout: 10_000 });
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitem", { name: `Pin: ${one}`, exact: true })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  const moveUp = page.getByRole("menuitem", { name: `Move up: ${one}`, exact: true });
  await expect(moveUp).toBeFocused();
  await Promise.all([page.waitForResponse((r) => orderPut(programPath)(r) && r.status() === 200), page.keyboard.press("Enter")]);
  await expect.poll(() => programKeys(page, streamId)).toEqual(keys(twoId, oneId, threeId));
  // The focus is back on the row's menu button once the menu has finished closing, and the status region says where the row went.
  await expect(menuButton).toBeFocused();
  await expect(page.getByRole("status").filter({ hasText: `${one} moved to position 2 of 3` })).toBeAttached();
  await settled(page);

  // The Programs page (narrowed to this work stream's programs) reads the same order.
  await page.evaluate(([key, value]) => localStorage.setItem(key, value), ["astrolabe.viewSettings.planning.programPick", JSON.stringify([oneId, twoId, threeId])]);
  await page.goto("/programs");
  const grid = page.getByRole("grid", { name: "Programs timeline" });
  await expect(grid.getByRole("button", { name: `Program ${one}`, exact: true })).toBeVisible();
  const onPage = () => grid.getByRole("button", { name: /^Program e2e-plan-order-/ }).evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label")));
  expect(await onPage()).toEqual([`Program ${two}`, `Program ${one}`, `Program ${three}`]);
  await signOut(page);

  // A second sign-in (the administrator) sees the same order.
  await login(page);
  await page.goto("/plan");
  await expect(row(`ws:${streamId}`)).toBeVisible();
  expect(await programKeys(page, streamId)).toEqual(keys(twoId, oneId, threeId));
  await deleteUserRow(page, account.name);
  await deleteUserRow(page, reader.name);
});

// The work streams' order is ONE list the whole instance shares (four workers write plans at once): the test asserts only its own streams' order relative to
// each other, and meets a stale notice (or the 400 of a stream another worker deleted) without failing on it.
test("an admin moves one of its own work streams above the other from the row menu; a closed work stream stays last", async ({ page }) => {
  const { api } = await apiAsAdmin();
  const lead = uniqueText("e2e-plan-lead");
  const leadId = await seed(api, "/api/v1/people", { name: lead }, "/api/v1/people");
  const [first, second, closed] = [uniqueText("e2e-plan-order-first"), uniqueText("e2e-plan-order-second"), uniqueText("e2e-plan-order-closed")];
  const firstId = await seed(api, "/api/v1/work-streams", { name: first, ownerPersonId: leadId, startDate: "2026-01-05" }, "/api/v1/work-streams");
  const secondId = await seed(api, "/api/v1/work-streams", { name: second, ownerPersonId: leadId, startDate: "2026-01-05" }, "/api/v1/work-streams");
  const closedId = await seed(api, "/api/v1/work-streams", { name: closed, ownerPersonId: leadId, startDate: "2025-01-06", endDate: "2025-06-30" }, "/api/v1/work-streams");
  await api.dispose();
  const [a, b, c] = [`ws:${firstId}`, `ws:${secondId}`, `ws:${closedId}`];
  const closedLast = async () => {
    const keys = await streamKeys(page);
    expect(keys.indexOf(c)).toBeGreaterThan(keys.indexOf(a));
    expect(keys.indexOf(c)).toBeGreaterThan(keys.indexOf(b));
  };

  await login(page);
  await page.goto("/plan");
  await expect(page.locator(`tr[data-scope="tree"][data-key="${b}"]`)).toBeVisible();
  // The two open streams are re-arrangeable (a grip each); by name the first comes before the second, and the closed one after both.
  for (const key of [a, b]) await expect(page.locator(`tr[data-scope="tree"][data-key="${key}"] [data-plan-handle]`)).toHaveCount(1);
  expect((await streamKeys(page)).indexOf(a)).toBeLessThan((await streamKeys(page)).indexOf(b));
  await closedLast();

  // Move the second above the first, one place at a time: the streams between them (other specs' own) are moved past on the way, and a write that meets
  // another worker's change is answered 409, says so and reloads - the next step simply goes again.
  for (let attempt = 0; attempt < 60; attempt++) {
    const keys = await streamKeys(page);
    if (keys.indexOf(b) < keys.indexOf(a)) break;
    await settled(page);
    await expect(page.getByRole("menu")).toHaveCount(0);
    const [response] = await Promise.all([page.waitForResponse(orderPut(/\/api\/v1\/work-stream-order$/)), rowOperation(page, second, `Move up: ${second}`)]);
    // 400: another worker deleted its stream meanwhile, so the full list names a stream that is gone (a delete bumps no order revision, so it is not a 409).
    expect([200, 400, 409]).toContain(response.status());
    await settled(page);
  }
  const keys = await streamKeys(page);
  expect(keys.indexOf(b)).toBeLessThan(keys.indexOf(a));
  await closedLast();

  // The order is the server's: a reload shows the same, the closed stream still after both.
  await page.reload();
  await expect(page.locator(`tr[data-scope="tree"][data-key="${b}"]`)).toBeVisible();
  const reloaded = await streamKeys(page);
  expect(reloaded.indexOf(b)).toBeLessThan(reloaded.indexOf(a));
  await closedLast();
});
