// The view reads revalidate (1.22): the SPA keeps the last answer of a view in memory and sends its ETag back as If-None-Match, so a name changed
// elsewhere (a team rename moves no plan revision) still reaches an open page, and an unchanged page is answered 304. Owns: one throwaway team
// (`e2e-reval-team-*`, no manager, no milestone), seeded and renamed and removed through the API; nothing dated, no plan node, no lock. The tag is
// kept in the page's memory, so every step navigates INSIDE the SPA (the sidebar link, never page.goto: a reload would forget it).
import type { Page, Response } from "@playwright/test";
import { apiAsAdmin, deleteViaApi, expect, login, openFilters, test, uniqueText } from "./helpers";

// A 304 needs a moment in which no other worker wrote the plan (its revision is in the document), so it is waited for, one read at a time.
const MAX_READS_FOR_A_304 = 10;

const teardown: string[] = [];
test.afterEach(async () => {
  await deleteViaApi(teardown.splice(0).reverse());
});

/** What a read of the team page's view answered, and whether the browser sent a tag with it. */
interface ViewRead {
  status: number;
  sentTag: boolean;
}

const isViewRead = (teamId: number) => (response: Response): boolean =>
  response.request().method() === "GET" && new URL(response.url()).pathname === `/api/v1/views/team/${teamId}`;

/**
 * Open the team from the sidebar's Teams entry (filtered by its name) and answer the first read of its view that follows. The wait is registered
 * before the click that opens the page, so the read cannot be missed.
 */
async function openTeamFromTheMenu(page: Page, teamId: number, name: string): Promise<ViewRead> {
  await page.getByRole("link", { name: "Teams", exact: true }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Teams", exact: true })).toBeVisible();
  await openFilters(page);
  await page.getByLabel("Name", { exact: true }).fill(name);
  const link = page.getByRole("link", { name: `Open team ${name}`, exact: true });
  await expect(link).toBeVisible();
  const read = page.waitForResponse(isViewRead(teamId));
  await link.click();
  const response = await read;
  return { status: response.status(), sentTag: (await response.request().headerValue("if-none-match")) !== null };
}

test("a team renamed elsewhere shows on its page at the next read, and an unchanged page is answered 304", async ({ page }) => {
  const { api } = await apiAsAdmin();
  const original = uniqueText("e2e-reval-team");
  const created = await api.post("/api/v1/teams", { data: { name: original } });
  expect(created.status(), await created.text()).toBe(201);
  const teamId = ((await created.json()) as { id: number }).id;
  teardown.push(`/api/v1/teams/${teamId}`);

  await login(page);
  const first = await openTeamFromTheMenu(page, teamId, original);
  expect(first, "the first read of this team's view in this page: no tag kept yet, a full answer").toEqual({ status: 200, sentTag: false });
  await expect(page.getByRole("heading", { level: 2, name: original, exact: true })).toBeVisible();

  // A rename moves no plan revision, yet changes what the view says: the next read must carry the kept tag and still come back whole.
  const renamed = uniqueText("e2e-reval-renamed");
  const put = await api.put(`/api/v1/teams/${teamId}`, { data: { name: renamed } });
  expect(put.status(), await put.text()).toBe(204);
  await api.dispose();
  const second = await openTeamFromTheMenu(page, teamId, renamed);
  expect(second, "the tag of the old document is sent and no longer matches").toEqual({ status: 200, sentTag: true });
  await expect(page.getByRole("heading", { level: 2, name: renamed, exact: true })).toBeVisible();

  // Nothing changes now: the next read is a 304 unless another worker writes the plan in between (the plan's revision is in the document), so
  // ask again, up to ten times, and take the first 304.
  const statuses: number[] = [];
  for (let attempt = 0; attempt < MAX_READS_FOR_A_304 && !statuses.includes(304); attempt++) {
    const read = await openTeamFromTheMenu(page, teamId, renamed);
    expect(read.sentTag).toBe(true);
    statuses.push(read.status);
    await expect(page.getByRole("heading", { level: 2, name: renamed, exact: true })).toBeVisible();
    await expect(page.getByRole("alert").filter({ hasText: "Could not load the team" })).toHaveCount(0);
  }
  expect(statuses, "an unchanged view is answered 304 (reads so far, oldest first)").toContain(304);
});
