// The flat-teams registry: an admin creates a team, renames it, assigns its manager (a person of the people directory) and
// deletes it; a regular user sees the read-only list. Owns: its throwaway team(s), person and user (unique names, deleted by
// the end of the test and, if a step fails first, by the afterEach below).
import type { Page } from "@playwright/test";
import { apiAsAdmin, createUserViaUi, deleteUserRow, deleteViaApi, expect, login, openFilters, rowOperation, signOut, test, uniqueText } from "./helpers";

/** A team's name link in the Teams table (since 1.32 the weeks table below names a team with a warning again, so a page-wide match could be two). */
const teamLink = (page: Page, name: string) => page.getByRole("table", { name: "Teams", exact: true }).getByRole("link", { name: `Open team ${name}`, exact: true });

// Rows the first test seeds through the API, deleted in reverse order (the team before the person who manages it).
const teardown: string[] = [];
test.afterEach(async () => {
  await deleteViaApi(teardown.splice(0).reverse());
});

test("admin creates a team, renames it, assigns its manager, and deletes it", async ({ page }) => {
  await login(page);
  // The manager is a PERSON of the directory, seeded through the API (the journey under test is the team's).
  const { api } = await apiAsAdmin();
  const personName = uniqueText("e2e-person");
  const personEmail = `${personName}@example.com`;
  const created = await api.post("/api/v1/people", { data: { name: personName, email: personEmail } });
  expect(created.status(), await created.text()).toBe(201);
  teardown.push(`/api/v1/people/${((await created.json()) as { id: number }).id}`);
  await api.dispose();
  const teamName = uniqueText("e2e-team");

  // Create through the modal — a new team lands on its own page.
  await page.goto("/teams");
  await expect(page.getByRole("heading", { name: "Teams" })).toBeVisible();
  await page.getByRole("button", { name: "New team" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name").fill(teamName);
  await dialog.getByLabel("Description").fill("Playwright's own team");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page).toHaveURL(/\/teams\/\d+$/);
  teardown.push(`/api/v1/teams/${/\/teams\/(\d+)$/.exec(page.url())![1]}`);
  await expect(page.getByRole("heading", { name: teamName })).toBeVisible();
  await expect(page.getByText("No manager")).toBeVisible();

  // Rename from the details page.
  const renamed = `${teamName}-renamed`;
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByRole("dialog").getByLabel("Name").fill(renamed);
  await page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("heading", { name: renamed })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // Assign the seeded person as the team's manager from the editor's searchable picker.
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const editor = page.getByRole("dialog");
  const managerPicker = editor.getByRole("combobox", { name: "Manager" });
  await managerPicker.click();
  await managerPicker.fill(personName);
  await page.getByRole("option", { name: `${personName} (${personEmail})` }).click();
  await Promise.all([
    page.waitForResponse((r) => r.request().method() === "PUT" && /\/api\/v1\/teams\/\d+$/.test(r.url()) && r.ok()),
    editor.getByRole("button", { name: "Save", exact: true }).click(),
  ]);
  await expect(page.getByText(`Manager: ${personName}`)).toBeVisible();

  // The list shows it (filtered by name); delete from the row menu.
  await page.goto("/teams");
  await openFilters(page);
  await page.getByLabel("Name", { exact: true }).fill(renamed);
  await expect(teamLink(page, renamed)).toBeVisible();
  await rowOperation(page, renamed, `Delete ${renamed}`);
  await Promise.all([
    page.waitForResponse((r) => r.request().method() === "DELETE" && /\/api\/v1\/teams\/\d+$/.test(r.url()) && r.ok()),
    page.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).click(),
  ]);
  await expect(teamLink(page, renamed)).toHaveCount(0);
  // The row (and the kebab that had the focus) is gone: the focus moves to the page heading, not to the start of the document.
  await expect(page.getByRole("heading", { level: 2, name: "Teams" })).toBeFocused();
});

test("dismissing a delete, edit or new-team dialog with Escape returns the focus to what opened it", async ({ page }) => {
  await login(page);
  const { api } = await apiAsAdmin();
  const teamName = uniqueText("e2e-esc-team");
  const created = await api.post("/api/v1/teams", { data: { name: teamName } });
  expect(created.status(), await created.text()).toBe(201);
  teardown.push(`/api/v1/teams/${((await created.json()) as { id: number }).id}`);
  await api.dispose();

  await page.goto("/teams");
  await openFilters(page);
  // Since 1.32 the Name filter narrows the rows already read (no request to wait for): the list is settled once the one row is there.
  await page.getByLabel("Name", { exact: true }).fill(teamName);
  const kebab = page.getByRole("button", { name: `Operations for ${teamName}` });
  await expect(kebab).toBeVisible();
  // By keyboard end to end: the menu item that opens the dialog is unmounted with its menu, so Mantine's own return-focus has nowhere to go.
  await kebab.focus();
  await page.keyboard.press("Enter");
  const item = page.getByRole("menuitem", { name: `Delete ${teamName}` });
  await item.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(kebab).toBeFocused();

  // The editor, too: it opens after the team's detail has been fetched, and its menu item is just as gone.
  await page.keyboard.press("Enter");
  await page.getByRole("menuitem", { name: `Edit ${teamName}` }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(kebab).toBeFocused();

  // A plain button's dialog, too: it mounts already open, so Mantine records no opener of its own.
  const newTeam = page.getByRole("button", { name: "New team" });
  await newTeam.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(newTeam).toBeFocused();
});

test("Tab in an open row menu closes it and moves on from its kebab; Shift+Tab comes back to the kebab", async ({ page }) => {
  await login(page);
  const { api } = await apiAsAdmin();
  const prefix = uniqueText("e2e-esc-team");
  // Two rows, so there is a Tab stop after the first row's kebab whatever else the page offers below its table.
  for (const suffix of ["a", "b"]) {
    const created = await api.post("/api/v1/teams", { data: { name: `${prefix}-${suffix}` } });
    expect(created.status(), await created.text()).toBe(201);
    teardown.push(`/api/v1/teams/${((await created.json()) as { id: number }).id}`);
  }
  await api.dispose();

  await page.goto("/teams");
  await openFilters(page);
  await page.getByLabel("Name", { exact: true }).fill(prefix);
  const kebab = page.getByRole("button", { name: `Operations for ${prefix}-a` });
  await expect(page.getByRole("button", { name: `Operations for ${prefix}-b` })).toBeVisible();
  await kebab.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menu")).toBeVisible();
  // As a keyboard user: wait for the menu's own focus to land. Mantine places it from a timeout, so a key within about 10 ms of opening is overtaken by it.
  const item = page.getByRole("menuitem", { name: `Edit ${prefix}-a` });
  await expect(item).toBeFocused();

  await page.keyboard.press("Tab");
  await expect(page.getByRole("menu")).toHaveCount(0);
  // The focus moved on past the kebab: not the kebab, not body, not inside a menu.
  await expect(kebab).not.toBeFocused();
  await expect(page.locator("body")).not.toBeFocused();
  await expect(page.locator('[role="menu"]:focus-within')).toHaveCount(0);

  await page.keyboard.press("Shift+Tab");
  await expect(kebab).toBeFocused();

  // And backwards out of a menu: Shift+Tab closes it and the focus goes to the stop before the kebab.
  await page.keyboard.press("Enter");
  await expect(item).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(kebab).not.toBeFocused();
  await expect(page.locator("body")).not.toBeFocused();
});

test("a regular user sees the read-only teams list", async ({ page }) => {
  await login(page);
  const user = await createUserViaUi(page, "E2E Team Reader");
  const teamName = uniqueText("e2e-ro-team");
  await page.goto("/teams");
  await page.getByRole("button", { name: "New team" }).click();
  await page.getByRole("dialog").getByLabel("Name").fill(teamName);
  await page.getByRole("dialog").getByRole("button", { name: "Create", exact: true }).click();
  await expect(page).toHaveURL(/\/teams\/\d+$/);
  await signOut(page);

  await login(page, user.email, user.password);
  await page.goto("/teams");
  await openFilters(page);
  await page.getByLabel("Name", { exact: true }).fill(teamName);
  await expect(teamLink(page, teamName)).toBeVisible();
  await expect(page.getByRole("button", { name: "New team" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: `Operations for ${teamName}` })).toHaveCount(0);
  await teamLink(page, teamName).click();
  await expect(page.getByRole("heading", { name: teamName })).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);
  await signOut(page);

  // Cleanup as the admin.
  await login(page);
  await page.goto("/teams");
  await openFilters(page);
  await page.getByLabel("Name", { exact: true }).fill(teamName);
  await rowOperation(page, teamName, `Delete ${teamName}`);
  await Promise.all([
    page.waitForResponse((r) => r.request().method() === "DELETE" && /\/api\/v1\/teams\/\d+$/.test(r.url()) && r.ok()),
    page.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).click(),
  ]);
  await deleteUserRow(page, user.name);
});

test("an admin gives a team a colour and its milestone bar on the project page carries it", async ({ page }) => {
  await login(page);
  const { api } = await apiAsAdmin();
  // The plan is seeded through the API (the journey under test is the colour's): a person, a team that starts INDIGO, a work stream, a program,
  // a project and one milestone of the team, scheduled. Registered in creation order, torn down in reverse (the milestone before the project).
  const seed = async (path: string, data: object, tear: string): Promise<number> => {
    const created = await api.post(path, { data });
    expect(created.status(), await created.text()).toBe(201);
    const id = ((await created.json()) as { id: number }).id;
    teardown.push(`${tear}/${id}`);
    return id;
  };
  const person = await seed("/api/v1/people", { name: uniqueText("e2e-tc-person") }, "/api/v1/people");
  const teamName = uniqueText("e2e-tc-team");
  const teamId = await seed("/api/v1/teams", { name: teamName, colour: "INDIGO" }, "/api/v1/teams");
  const stream = await seed("/api/v1/work-streams", { name: uniqueText("e2e-tc-stream"), ownerPersonId: person, startDate: "2026-01-05" }, "/api/v1/work-streams");
  const program = await seed(`/api/v1/work-streams/${stream}/programs`, { name: uniqueText("e2e-tc-program"), ownerPersonId: person }, "/api/v1/programs");
  const projectId = await seed(`/api/v1/programs/${program}/projects`, { name: uniqueText("e2e-tc-project"), ownerPersonId: person }, "/api/v1/projects");
  const milestoneName = uniqueText("e2e-tc-milestone");
  const milestoneId = await seed(`/api/v1/projects/${projectId}/milestones`, { name: milestoneName, teamId, estimateMd: 5 }, "/api/v1/milestones");
  const { revision } = (await (await api.get(`/api/v1/views/project/${projectId}`)).json()) as { revision: number };
  const scheduled = await api.put(`/api/v1/milestones/${milestoneId}/schedule`, { data: { expectedRevision: revision, startDate: "2027-01-11", endDate: "2027-01-15" } });
  expect(scheduled.status(), await scheduled.text()).toBe(200);
  await api.dispose();

  // The bar and the Team cell's swatch read the team's colour; a test reads the attributes, never the colour itself.
  // The timeline's own row carries the bar's tint and the Team cell's swatch.
  const timelineRow = () => page.getByRole("grid", { name: "Milestone timeline" }).getByRole("row").filter({ hasText: milestoneName });
  const bar = () => timelineRow().locator("[data-tint]");
  const swatch = () => timelineRow().locator("[data-team-colour]");
  await page.goto(`/projects/${projectId}`);
  await expect(bar()).toHaveAttribute("data-tint", "var(--astrolabe-team-indigo)");
  await expect(swatch()).toHaveAttribute("data-team-colour", "INDIGO");

  // The admin picks another colour in the team's editor.
  await page.goto(`/teams/${teamId}`);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const editor = page.getByRole("dialog");
  await editor.getByText("Raspberry", { exact: true }).click();
  await Promise.all([
    page.waitForResponse((r) => r.request().method() === "PUT" && /\/api\/v1\/teams\/\d+$/.test(r.url()) && r.ok()),
    editor.getByRole("button", { name: "Save", exact: true }).click(),
  ]);
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // The project page now draws the milestone's bar, and the Team cell's swatch, in the new colour.
  await page.goto(`/projects/${projectId}`);
  await expect(bar()).toHaveAttribute("data-tint", "var(--astrolabe-team-raspberry)");
  await expect(swatch()).toHaveAttribute("data-team-colour", "RASPBERRY");

  // Under forced colours (1.30) the browser would paint a filled bar's background Canvas, so the body opts out of the forcing and takes a 1 px border.
  // Structure only, never a colour: the system palette is the user's, and the tint (the team's colour) is the information the bar keeps.
  await page.emulateMedia({ forcedColors: "active" });
  const body = bar().locator(":scope > div").first();
  await expect(body).toHaveCSS("forced-color-adjust", "none");
  await expect(body).toHaveCSS("border-top-width", "1px");
  await expect(body).toHaveCSS("border-top-style", "solid");
  await page.emulateMedia({ forcedColors: "none" });
  await expect(body).toHaveCSS("border-top-width", "0px");
});
