// The public-holiday dictionary (Administration > Public holidays) and what a holiday does to a project page. An administrator adds a holiday
// in 2040 and finds it under the year picker, meets the duplicate-date message, applies the Polish preset for 2040 (14 more rows; applying it
// again adds none) and deletes a row behind its confirmation; a regular user reads the list with none of the controls. The calendar half is
// API-seeded: a project world in 2040 with a finish-to-start link a1 -> b1 (b1 on the Monday after a1's Friday); a holiday on that Monday moves
// the Dependencies row's "needs" date to the Tuesday and tints and names the header day cell, and deleting the holiday restores both.
// Owns: ALL holidays dated 2040 (the dictionary is global: this spec is the only one that writes holidays, and only in 2040; every other
// spec's working-day figures live in other years - 2027 for dependencies/team-view, 2041 for critical-path - so nothing here can reach
// them), swept by date before the first test and again in the afterAll; one throwaway user (the reader); and the calendar test's throwaway
// people, work stream, program, two projects with a milestone each and their link (unique `e2e-hol-*` names), seeded through the API and
// deleted by the afterEach (the projects first - their milestones and the link go with them - then program, work stream, people).
import { randomUUID } from "node:crypto";
import type { APIRequestContext, Page } from "@playwright/test";
import { apiAsAdmin, axeViolations, deleteViaApi, expect, login, test, uniqueText } from "./helpers";

const YEAR = "2040";

interface Holiday {
  id: number;
  date: string;
  name: string;
}

async function listHolidays(admin: APIRequestContext): Promise<Holiday[]> {
  const response = await admin.get("/api/v1/public-holidays");
  expect(response.ok(), await response.text()).toBeTruthy();
  return ((await response.json()) as { items: Holiday[] }).items;
}

/** Remove every holiday dated in 2040 (this spec's, or an aborted earlier run's): 204 and 404 both pass. */
async function sweepHolidays(): Promise<void> {
  const { api } = await apiAsAdmin();
  try {
    const stranded = (await listHolidays(api)).filter((holiday) => holiday.date.startsWith(`${YEAR}-`));
    await deleteViaApi(stranded.map((holiday) => `/api/v1/public-holidays/${holiday.id}`));
  } finally {
    await api.dispose();
  }
}

// Registered in creation order; torn down in reverse by the afterEach (the projects before their program before its stream before the people).
const teardown: string[] = [];
test.afterEach(async () => {
  await deleteViaApi(teardown.splice(0).reverse());
});

test.beforeAll(sweepHolidays);
test.afterAll(sweepHolidays);

const yearTable = (page: Page) => page.getByRole("table", { name: `Public holidays of ${YEAR}`, exact: true });

test("an administrator adds a holiday in 2040, meets the duplicate message, applies the Polish preset twice and deletes a row", async ({ page }) => {
  const date = "2040-03-14";
  const name = uniqueText("e2e-hol-day");

  await login(page);
  await page.goto("/public-holidays");
  await expect(page.getByRole("heading", { level: 2, name: "Public holidays", exact: true })).toBeVisible();

  // Add one: the table follows the new row to its year (2040 is not offered until a row exists in it).
  await page.getByRole("textbox", { name: "Date", exact: true }).fill(date);
  await page.getByRole("textbox", { name: "Name", exact: true }).fill(name);
  await Promise.all([
    page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith("/api/v1/public-holidays") && r.status() === 201),
    page.getByRole("button", { name: "Add holiday", exact: true }).click(),
  ]);
  await expect(page.getByText("Public holiday added", { exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Year", exact: true })).toHaveValue(YEAR);
  await expect(yearTable(page).getByRole("row", { name: new RegExp(`^${date} .* ${name}`) })).toBeVisible();
  await expect(yearTable(page).getByRole("row")).toHaveCount(2); // the header and the one row

  // The same date again is refused inline (409): the message, no toast, no second row.
  await page.getByRole("textbox", { name: "Date", exact: true }).fill(date);
  await page.getByRole("textbox", { name: "Name", exact: true }).fill(`${name} again`);
  await page.getByRole("button", { name: "Add holiday", exact: true }).click();
  await expect(page.getByText("A holiday already exists on this date.")).toBeVisible();
  await expect(yearTable(page).getByRole("row")).toHaveCount(2);

  // The Polish preset for the year being viewed: the 14 statutory days of 2040 are added (this spec's own row is not one of them).
  await page.getByRole("button", { name: `Add Polish public holidays for ${YEAR}` }).click();
  const confirm = page.getByRole("dialog", { name: "Add the Polish public holidays?" });
  await Promise.all([
    page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith("/api/v1/public-holidays/apply-preset") && r.status() === 200),
    confirm.getByRole("button", { name: "Add holidays", exact: true }).click(),
  ]);
  await expect(confirm).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: `Polish holidays of ${YEAR}` })).toHaveText(`Polish holidays of ${YEAR}: 14 added, 0 already present.`);
  await expect(yearTable(page).getByRole("row")).toHaveCount(1 + 14 + 1); // the header, the 14 statutory days and this spec's row
  await expect(yearTable(page).getByRole("row", { name: /^2040-01-01 .* Nowy Rok/ })).toBeVisible();
  await expect(yearTable(page).getByRole("row", { name: /^2040-12-25 .* Boże Narodzenie \(pierwszy dzień\)/ })).toBeVisible();

  // Applying it again adds nothing and leaves every row as it was.
  await page.getByRole("button", { name: `Add Polish public holidays for ${YEAR}` }).click();
  await Promise.all([
    page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith("/api/v1/public-holidays/apply-preset") && r.status() === 200),
    confirm.getByRole("button", { name: "Add holidays", exact: true }).click(),
  ]);
  await expect(page.getByRole("status").filter({ hasText: `Polish holidays of ${YEAR}` })).toHaveText(`Polish holidays of ${YEAR}: 0 added, 14 already present.`);
  await expect(yearTable(page).getByRole("row")).toHaveCount(16);
  await expect(confirm).toHaveCount(0);

  // Delete this spec's row behind the confirmation; the statutory days stay.
  await page.getByRole("button", { name: `Delete the holiday ${name}`, exact: true }).click();
  const deleteDialog = page.getByRole("dialog", { name: "Delete this holiday?" });
  await Promise.all([
    page.waitForResponse((r) => r.request().method() === "DELETE" && r.url().includes("/api/v1/public-holidays/") && r.status() === 204),
    deleteDialog.getByRole("button", { name: "Delete", exact: true }).click(),
  ]);
  await expect(page.getByText("Public holiday deleted", { exact: true })).toBeVisible();
  await expect(yearTable(page).getByText(name, { exact: true })).toHaveCount(0);
  await expect(yearTable(page).getByRole("row")).toHaveCount(15);
  // The administrator's page with a full table, the add strip and the preset button, scanned once the toasts (whose close buttons carry no
  // name) and the dialogs' fade-out are gone.
  await expect(page.locator(".mantine-Notification-root")).toHaveCount(0);
  expect(await axeViolations(page)).toEqual([]);
});

test("a regular user reads the 2040 holidays but cannot change them", async ({ page }) => {
  const { api } = await apiAsAdmin();
  let name: string;
  const userName = uniqueText("e2e-hol-reader");
  const account = { email: `${userName.toLowerCase()}@astrolabe.local`, password: randomUUID().replace(/-/g, "") };
  try {
    const created = await api.post("/api/v1/users", { data: { name: userName, email: account.email, password: account.password } });
    expect(created.status(), await created.text()).toBe(201);
    teardown.push(`/api/v1/users/${((await created.json()) as { id: number }).id}`);
    const holiday = await api.post("/api/v1/public-holidays", { data: { date: "2040-05-02", name: uniqueText("e2e-hol-read") } });
    expect(holiday.status(), await holiday.text()).toBe(201);
    name = ((await holiday.json()) as Holiday).name;
  } finally {
    await api.dispose();
  }

  await login(page, account.email, account.password);
  // Any signed-in user finds the page in the Administration section.
  await page.getByRole("group", { name: "Administration" }).getByRole("link", { name: "Public holidays", exact: true }).click();
  await expect(page).toHaveURL(/\/public-holidays$/);
  await expect(page.getByRole("heading", { level: 2, name: "Public holidays", exact: true })).toBeVisible();
  await expect(page.getByText(/The list is maintained by administrators\./)).toBeVisible();
  await page.getByRole("combobox", { name: "Year", exact: true }).click();
  await page.getByRole("option", { name: YEAR, exact: true }).click();
  await expect(yearTable(page).getByRole("row", { name: new RegExp(`^2040-05-02 .* ${name}`) })).toBeVisible();

  // Read-only: no add strip, no preset, no delete.
  await expect(page.getByRole("button", { name: "Add holiday", exact: true })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Date", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Add Polish public holidays/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Delete the holiday / })).toHaveCount(0);
  expect(await axeViolations(page)).toEqual([]);
});

async function seed(api: APIRequestContext, path: string, data: object, tear: string): Promise<number> {
  const response = await api.post(path, { data });
  expect(response.status(), await response.text()).toBe(201);
  const id = ((await response.json()) as { id: number }).id;
  teardown.push(`${tear}/${id}`);
  return id;
}

test("a holiday on the Monday after a finish moves the dependency's needed date and tints the header day; deleting it restores both", async ({ page }) => {
  // a1 ends on Friday 2040-02-03 and b1 starts on Monday 2040-02-06: the finish-to-start link holds with no spare day.
  const monday = "2040-02-06";
  const { api } = await apiAsAdmin();
  try {
    const lead = await seed(api, "/api/v1/people", { name: uniqueText("e2e-hol-lead") }, "/api/v1/people");
    const teamId = await seed(api, "/api/v1/teams", { name: uniqueText("e2e-hol-team") }, "/api/v1/teams");
    const streamId = await seed(api, "/api/v1/work-streams", { name: uniqueText("e2e-hol-stream"), ownerPersonId: lead, startDate: "2040-01-01" }, "/api/v1/work-streams");
    const programId = await seed(api, `/api/v1/work-streams/${streamId}/programs`, { name: uniqueText("e2e-hol-program"), ownerPersonId: lead }, "/api/v1/programs");

    async function project(label: string, startDate: string, endDate: string) {
      const name = uniqueText(`e2e-hol-proj-${label}`);
      const id = await seed(api, `/api/v1/programs/${programId}/projects`, { name, ownerPersonId: lead }, "/api/v1/projects");
      const milestone = uniqueText(`e2e-hol-${label}1`);
      const created = await api.post(`/api/v1/projects/${id}/milestones`, { data: { name: milestone, teamId, estimateMd: 3 } });
      expect(created.status(), await created.text()).toBe(201);
      const milestoneId = ((await created.json()) as { id: number }).id;
      const view = (await (await api.get(`/api/v1/views/project/${id}`)).json()) as { revision: number };
      const scheduled = await api.put(`/api/v1/milestones/${milestoneId}/schedule`, { data: { expectedRevision: view.revision, startDate, endDate } });
      expect(scheduled.status(), await scheduled.text()).toBe(200);
      return { id, name, milestone, milestoneId };
    }
    const a = await project("a", "2040-01-30", "2040-02-03");
    const b = await project("b", monday, "2040-02-10");
    const link = await api.post(`/api/v1/projects/${b.id}/dependencies`, {
      data: { predecessor: { kind: "MILESTONE", id: a.milestoneId }, successor: { kind: "MILESTONE", id: b.milestoneId }, type: "FS", lagDays: 0 },
    });
    expect(link.status(), await link.text()).toBe(201);

    const holidayName = uniqueText("e2e-hol-monday");
    await login(page);
    await page.goto(`/projects/${b.id}`);
    await expect(page.getByRole("heading", { level: 2, name: b.name })).toBeVisible();
    const row = page.getByRole("table", { name: "Dependencies of the project" }).getByRole("row").filter({ hasText: a.milestone });
    const header = page.locator(`[data-holiday="true"][title="Public holiday: ${holidayName}"]`);
    await expect(row).toContainText("OK");
    await expect(row).toContainText(`needs ${monday} · is ${monday}`);
    await expect(header).toHaveCount(0);

    // The holiday is added through the API (the page is the subject, not the dictionary's form) and the open page is reloaded.
    const added = await api.post("/api/v1/public-holidays", { data: { date: monday, name: holidayName } });
    expect(added.status(), await added.text()).toBe(201);
    const holidayId = ((await added.json()) as Holiday).id;
    try {
      await page.reload();
      await expect(page.getByRole("heading", { level: 2, name: b.name })).toBeVisible();
      // The Monday is a day off: the link now needs the Tuesday, b1's first working day, and still holds. The header cell of the day is
      // named, and the hidden paragraph (the header and tracks are aria-hidden) is the accessible surface of the dictionary in view.
      await expect(row).toContainText("OK");
      await expect(row).toContainText("needs 2040-02-07");
      await expect(header).toHaveCount(1);
      // (Which holidays the paragraph names depends on how many the stack holds - it lists only the next few past a handful - so only its presence is pinned.)
      await expect(page.getByText(/[Pp]ublic holidays? shown/)).toBeAttached();
    } finally {
      await api.delete(`/api/v1/public-holidays/${holidayId}`);
    }

    await page.reload();
    await expect(page.getByRole("heading", { level: 2, name: b.name })).toBeVisible();
    await expect(row).toContainText(`needs ${monday} · is ${monday}`);
    await expect(header).toHaveCount(0);
  } finally {
    await api.dispose();
  }
});
