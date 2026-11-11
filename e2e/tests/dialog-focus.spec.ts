// The focus round trip of a dialog, once per page that owns a `useDialogFocus` call: the keyboard focus moves into the dialog when it opens and,
// after Escape, is back on what opened it. The hook's own unit tests and `teams.spec.ts` (Teams) pin the mechanism; this sweep pins that each OTHER
// owner (Plan, ProjectView, TeamDetails, TeamCapacity, People, PersonDetails, Baselines, Users) still calls it: a dialog mounted already open
// (`{editor && <XModal opened />}`) records no opener for Mantine's own focus return, so without the owner's hook the focus ends on `body`.
// Owns: one API-seeded fixture, shared by the tests and removed in the afterAll: a person, a user, a team, a work stream, a program and a project
// (unique `e2e-dlg-*` names, nothing dated). The tests only open a dialog and dismiss it with Escape: they write nothing.
import { randomUUID } from "node:crypto";
import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { apiAsAdmin, deleteViaApi, expect, login, openFilters, test, uniqueText } from "./helpers";

// Registered in creation order; torn down in reverse (the project before its program before its stream before the team, the user and the person).
const teardown: string[] = [];

interface World {
  personId: number;
  teamId: number;
  projectId: number;
  userName: string;
}

let world: World;

async function seed(api: APIRequestContext, path: string, data: object, tear: string): Promise<number> {
  const response = await api.post(path, { data });
  expect(response.status(), await response.text()).toBe(201);
  const id = ((await response.json()) as { id: number }).id;
  teardown.push(`${tear}/${id}`);
  return id;
}

test.beforeAll(async () => {
  const { api } = await apiAsAdmin();
  try {
    const personId = await seed(api, "/api/v1/people", { name: uniqueText("e2e-dlg-person") }, "/api/v1/people");
    const userName = uniqueText("e2e-dlg-user");
    await seed(api, "/api/v1/users", { name: userName, email: `${userName.toLowerCase()}@astrolabe.local`, password: randomUUID().replace(/-/g, "") }, "/api/v1/users");
    const teamId = await seed(api, "/api/v1/teams", { name: uniqueText("e2e-dlg-team") }, "/api/v1/teams");
    const streamId = await seed(api, "/api/v1/work-streams", { name: uniqueText("e2e-dlg-stream"), ownerPersonId: personId, startDate: "2026-01-05" }, "/api/v1/work-streams");
    const programId = await seed(api, `/api/v1/work-streams/${streamId}/programs`, { name: uniqueText("e2e-dlg-program"), ownerPersonId: personId }, "/api/v1/programs");
    const projectId = await seed(api, `/api/v1/programs/${programId}/projects`, { name: uniqueText("e2e-dlg-project"), ownerPersonId: personId }, "/api/v1/projects");
    world = { personId, teamId, projectId, userName };
  } finally {
    await api.dispose();
  }
});

test.afterAll(async () => {
  await deleteViaApi(teardown.splice(0).reverse());
});

/** True once the keyboard focus sits inside an open dialog. Polled: Mantine's focus trap places it from a timeout after the dialog mounts. */
async function expectFocusInDialog(page: Page): Promise<void> {
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect.poll(() => page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]')))).toBe(true);
}

/** Dismiss the open dialog with Escape and wait until it has left the DOM. */
async function dismissWithEscape(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
}

/**
 * The round trip for a PLAIN button (the hook takes the element holding the focus as the opener): focus it by keyboard, Enter opens the dialog, the focus
 * must be inside the dialog (this also proves it LEFT the button, so the last line is not true by default), Escape closes it, and the focus must be back.
 */
async function expectFocusRoundTrip(page: Page, opener: Locator): Promise<void> {
  await expect(opener).toBeVisible();
  await opener.focus();
  await expect(opener).toBeFocused();
  await page.keyboard.press("Enter");
  await expectFocusInDialog(page);
  await dismissWithEscape(page);
  await expect(opener).toBeFocused();
}

test("Plan: the New work stream dialog takes the focus in and gives it back to its button", async ({ page }) => {
  await login(page);
  await page.goto("/plan");
  await expectFocusRoundTrip(page, page.getByRole("button", { name: "New work stream" }));
});

test("ProjectView: the New milestone dialog takes the focus in and gives it back to its button", async ({ page }) => {
  await login(page);
  await page.goto(`/projects/${world.projectId}`);
  await expectFocusRoundTrip(page, page.getByRole("button", { name: "New milestone", exact: true }));
});

test("TeamDetails: the team editor takes the focus in and gives it back to the Edit button", async ({ page }) => {
  await login(page);
  await page.goto(`/teams/${world.teamId}`);
  await expectFocusRoundTrip(page, page.getByRole("button", { name: "Edit", exact: true }));
});

test("TeamCapacity: the Add period dialog takes the focus in and gives it back to its button", async ({ page }) => {
  await login(page);
  await page.goto(`/teams/${world.teamId}`);
  await expectFocusRoundTrip(page, page.getByRole("button", { name: "Add period", exact: true }));
});

test("People: the New person dialog takes the focus in and gives it back to its button", async ({ page }) => {
  await login(page);
  await page.goto("/people");
  await expectFocusRoundTrip(page, page.getByRole("button", { name: "New person", exact: true }));
});

test("PersonDetails: the person editor takes the focus in and gives it back to the Edit button", async ({ page }) => {
  await login(page);
  await page.goto(`/people/${world.personId}`);
  await expectFocusRoundTrip(page, page.getByRole("button", { name: "Edit", exact: true }));
});

test("Baselines: the Take baseline dialog takes the focus in and gives it back to its button", async ({ page }) => {
  await login(page);
  await page.goto("/baselines");
  await expectFocusRoundTrip(page, page.getByRole("button", { name: "Take baseline", exact: true }));
});

test("Users: the reset-password confirmation takes the focus in and gives it back to the row's kebab", async ({ page }) => {
  await login(page);
  await page.goto("/users");
  await openFilters(page);
  // Wait for the debounced filter's own answer, as teams.spec does: a list refetch landing while the dialog closes is a known flake (BACKLOG), and this test is about Escape.
  const filtered = page.waitForResponse((r) => /\/api\/v1\/users\?/.test(r.url()) && new URL(r.url()).searchParams.get("name") === world.userName && r.ok());
  await page.getByLabel("Name", { exact: true }).fill(world.userName);
  await filtered;
  const kebab = page.getByRole("button", { name: `Operations for ${world.userName}` });
  // By keyboard end to end: the menu item that opens the dialog is unmounted with its menu, so the opener the hook returns the focus to is the kebab.
  await kebab.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("menuitem", { name: `Reset password for ${world.userName}` }).focus();
  await page.keyboard.press("Enter");
  await expectFocusInDialog(page);
  await dismissWithEscape(page);
  await expect(kebab).toBeFocused();
});
