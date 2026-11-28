// Held first responses of the list pages (Users, People, Feature Flags) cannot undo a write made meanwhile, and a held team-page GET cannot be written from:
// a team page left and visited again after a write made on the project page shows no stale copy (1.38). Owns: its throwaway users, people, one team (no
// manager) and a plan with one project (unique `e2e-race-*` names), all seeded through the API and deleted through it, even after a failure. It needs no lock
// (the dates sit in 2027 and it writes no holiday, ranking or connection).
import type { Page, Route } from "@playwright/test";
import { apiAsAdmin, expect, login, openFilters, rowOperation, test, uniqueText } from "./helpers";

type Registry = "users" | "people";

async function verifyPendingListDelete(page: Page, registry: Registry) {
  const { api } = await apiAsAdmin();
  const ownedPaths: string[] = [];
  const name = uniqueText(`e2e-race-${registry}`);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let markHeld!: () => void;
  const held = new Promise<void>((resolve) => { markHeld = resolve; });
  let markSettled!: () => void;
  const settled = new Promise<void>((resolve) => { markSettled = resolve; });
  let intercepted = false;
  const isTarget = (url: string) => {
    const parsed = new URL(url);
    return parsed.pathname === `/api/v1/${registry}` && parsed.searchParams.get("name") === name;
  };
  const handler = async (route: Route) => {
    if (route.request().method() !== "GET" || !isTarget(route.request().url()) || intercepted) {
      await route.continue();
      return;
    }
    intercepted = true;
    try {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      expect((await response.json() as { items: { name: string }[] }).items.some((item) => item.name === name)).toBe(true);
      markHeld();
      await gate;
      await route.fulfill({ response });
    } finally {
      markSettled();
    }
  };
  async function create(resource: Registry, data: object) {
    const response = await api.post(`/api/v1/${resource}`, { data });
    expect(response.status(), await response.text()).toBe(201);
    const { id } = await response.json() as { id: number };
    ownedPaths.unshift(`/api/v1/${resource}/${id}`);
    return id;
  }
  async function seed() {
    if (registry === "users") return create(registry, { name, email: `${name}@astrolabe.local`, password: "e2e-only-password", roles: [] });
    return create(registry, { name });
  }
  try {
    const id = await seed();
    await login(page);
    await page.goto(`/${registry}`);
    const row = page.getByRole("row", { name: new RegExp(name) });
    await openFilters(page);
    const prefix = name.slice(0, -1);
    const initial = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === "GET" && url.pathname === `/api/v1/${registry}` && url.searchParams.get("name") === prefix && response.ok();
    });
    await page.getByLabel("Name", { exact: true }).fill(prefix);
    await (await initial).finished();
    await expect(row).toBeVisible();
    await page.route(`**/api/v1/${registry}?*`, handler);
    await page.getByLabel("Name", { exact: true }).fill(name);
    await held;
    await rowOperation(page, name, `Delete ${name}`);
    const [deleted] = await Promise.all([
      page.waitForResponse((response) => response.request().method() === "DELETE" && new URL(response.url()).pathname === `/api/v1/${registry}/${id}`),
      page.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).click(),
    ]);
    expect(deleted.status()).toBe(204);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect((await api.get(`/api/v1/${registry}/${id}`)).status()).toBe(404);
    release();
    await settled;
    await expect(row).toHaveCount(0);
    await expect(page.getByLabel("Name", { exact: true })).toHaveValue(name);
  } finally {
    try {
      release();
      if (intercepted) await settled;
      if (!page.isClosed()) await page.unroute(`**/api/v1/${registry}?*`, handler);
    } finally {
      try {
        for (const path of ownedPaths) {
          const response = await api.delete(path);
          expect([204, 404], `${path}: ${response.status()}`).toContain(response.status());
        }
      } finally {
        await api.dispose();
      }
    }
  }
}

test("a pending Users filter cannot restore a deleted user", async ({ page }) => { await verifyPendingListDelete(page, "users"); });
test("a pending People filter cannot restore a deleted person", async ({ page }) => { await verifyPendingListDelete(page, "people"); });

test("a pending Feature Flags filter cannot undo a successful toggle", async ({ page }) => {
  const { api } = await apiAsAdmin();
  const name = uniqueText("e2e-race-flags");
  let userId: number | undefined;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let markHeld!: () => void;
  const held = new Promise<void>((resolve) => { markHeld = resolve; });
  let markSettled!: () => void;
  const settled = new Promise<void>((resolve) => { markSettled = resolve; });
  let intercepted = false;
  const handler = async (route: Route) => {
    if (route.request().method() !== "GET" || new URL(route.request().url()).searchParams.get("name") !== name || intercepted) {
      await route.continue();
      return;
    }
    intercepted = true;
    try {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      expect((await response.json() as { items: { id: number }[] }).items.some((item) => item.id === userId)).toBe(true);
      markHeld();
      await gate;
      await route.fulfill({ response });
    } finally {
      markSettled();
    }
  };
  try {
    const created = await api.post("/api/v1/users", { data: { name, email: `${name}@astrolabe.local`, password: "e2e-only-password", roles: [] } });
    expect(created.status()).toBe(201);
    userId = (await created.json() as { id: number }).id;
    expect((await api.put(`/api/v1/users/${userId}/features`, { data: { disabledFeatures: ["MFA"] } })).status()).toBe(204);
    await login(page);
    await page.goto("/feature-flags");
    await openFilters(page);
    const prefix = name.slice(0, -1);
    const initial = page.waitForResponse((response) => response.request().method() === "GET" && new URL(response.url()).pathname === "/api/v1/users" && new URL(response.url()).searchParams.get("name") === prefix && response.ok());
    await page.getByLabel("Name", { exact: true }).fill(prefix);
    await (await initial).finished();
    const toggle = page.getByRole("switch", { name: `Toggle Email MFA for ${name}`, exact: true });
    await expect(toggle).not.toBeChecked();
    await expect(toggle).toBeVisible();
    await page.route("**/api/v1/users?*", handler);
    await page.getByLabel("Name", { exact: true }).fill(name);
    await held;
    const [updated] = await Promise.all([
      page.waitForResponse((response) => response.request().method() === "PUT" && new URL(response.url()).pathname === `/api/v1/users/${userId}/features`),
      toggle.click({ force: true }),
    ]);
    expect(updated.status()).toBe(204);
    expect((await (await api.get(`/api/v1/users/${userId}`)).json() as { disabledFeatures: string[] }).disabledFeatures).not.toContain("MFA");
    release();
    await settled;
    await expect(toggle).toBeChecked();
    await expect(toggle).toBeEnabled();
    await expect(page.getByLabel("Name", { exact: true })).toHaveValue(name);
  } finally {
    try {
      release();
      if (intercepted) await settled;
      if (!page.isClosed()) await page.unroute("**/api/v1/users?*", handler);
    } finally {
      try {
        if (userId !== undefined) expect([204, 404]).toContain((await api.delete(`/api/v1/users/${userId}`)).status());
      } finally {
        await api.dispose();
      }
    }
  }
});

test("a team page left, then reopened after a write on the project page, shows no stale list while its refetch is held", async ({ page }) => {
  const { api } = await apiAsAdmin();
  const ownedPaths: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let markHeld!: () => void;
  const held = new Promise<void>((resolve) => { markHeld = resolve; });
  let holding = false;
  let intercepted = false;
  const create = async (path: string, data: object, tear: string) => {
    const response = await api.post(path, { data });
    expect(response.status(), await response.text()).toBe(201);
    const { id } = await response.json() as { id: number };
    ownedPaths.unshift(`${tear}/${id}`);
    return id;
  };
  const prefix = uniqueText("e2e-race-ms");
  const [first, second, tray] = [`${prefix}-a`, `${prefix}-b`, `${prefix}-c`];
  let teamId = 0;
  const teamGet = (url: string) => new URL(url).pathname === `/api/v1/views/team/${teamId}`;
  // Every held GET (the page may ask more than once): the finally waits for all of them to be answered before the route goes away.
  const inflight: Promise<void>[] = [];
  const handler = async (route: Route) => {
    if (!holding || route.request().method() !== "GET" || !teamGet(route.request().url())) {
      await route.continue();
      return;
    }
    const work = (async () => {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      intercepted = true;
      markHeld();
      await gate;
      await route.fulfill({ response });
    })();
    inflight.push(work);
    await work;
  };
  try {
    const owner = await create("/api/v1/people", { name: uniqueText("e2e-race-person") }, "/api/v1/people");
    teamId = await create("/api/v1/teams", { name: uniqueText("e2e-race-team") }, "/api/v1/teams");
    const stream = await create("/api/v1/work-streams", { name: uniqueText("e2e-race-stream"), ownerPersonId: owner, startDate: "2026-01-05" }, "/api/v1/work-streams");
    const program = await create(`/api/v1/work-streams/${stream}/programs`, { name: uniqueText("e2e-race-program"), ownerPersonId: owner }, "/api/v1/programs");
    const projectName = uniqueText("e2e-race-project");
    const project = await create(`/api/v1/programs/${program}/projects`, { name: projectName, ownerPersonId: owner }, "/api/v1/projects");
    const milestone = (name: string) => create(`/api/v1/projects/${project}/milestones`, { name, teamId, estimateMd: 2 }, "/api/v1/milestones");
    const trayId = await milestone(tray);
    for (const [name, start, end] of [[first, "2027-02-01", "2027-02-05"], [second, "2027-02-08", "2027-02-12"]]) {
      const id = await milestone(name);
      const { revision } = await (await api.get(`/api/v1/views/team/${teamId}`)).json() as { revision: number };
      const scheduled = await api.put(`/api/v1/milestones/${id}/schedule`, { data: { expectedRevision: revision, startDate: start, endDate: end } });
      expect(scheduled.status(), await scheduled.text()).toBe(200);
    }

    // 1. The team page, read once: two scheduled rows, one in the tray; this is the copy the cache keeps.
    await login(page);
    await page.goto(`/teams/${teamId}`);
    const timeline = page.getByRole("grid", { name: "Team milestone timeline", exact: true });
    const rows = timeline.getByRole("row").filter({ hasText: prefix });
    await expect(rows).toHaveCount(2);
    // 2. Leave it for the project page by the milestone's link (in the single-page app: the cache stays).
    await timeline.getByRole("link", { name: `Open milestone ${first}`, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${project}$`));
    await expect(page.getByRole("heading", { level: 2, name: projectName, exact: true })).toBeVisible();
    // 3. Schedule the tray milestone there.
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
    // The project view's reload is registered BEFORE the click and awaited after the PUT: the page starts it in the write's success handler, which is also
    // where the cached team page is dropped, so going Back before it would race that handler.
    const reload = page.waitForResponse((r) => r.request().method() === "GET" && new URL(r.url()).pathname === `/api/v1/views/project/${project}`, { timeout: 15_000 });
    reload.catch(() => undefined); // no unhandled rejection when the click fails first: the failure is the click's
    const [scheduled] = await Promise.all([
      page.waitForResponse((r) => r.request().method() === "PUT" && new RegExp(`/api/v1/milestones/${trayId}/schedule$`).test(r.url())),
      page.getByRole("button", { name: `Schedule ${tray}`, exact: true }).click(),
    ]);
    expect(scheduled.status()).toBe(200);
    await reload;
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
    // 4. Back to the team page while its GET is held: the copy from step 1 is gone, so no row of the old list is shown to write from.
    await page.route("**/api/v1/views/team/*", handler);
    holding = true;
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`/teams/${teamId}$`));
    await held;
    await expect(rows).toHaveCount(0);
    // 5. The refetch lands: all three rows, and the first move sends a list that has the newly scheduled milestone in it.
    holding = false;
    release();
    await expect(rows).toHaveCount(3);
    const [put] = await Promise.all([
      page.waitForRequest((r) => r.method() === "PUT" && new RegExp(`/api/v1/teams/${teamId}/milestone-order$`).test(r.url())),
      rowOperation(page, second, `Move to top: ${second}`),
    ]);
    const { milestoneIds } = put.postDataJSON() as { milestoneIds: number[] };
    expect(milestoneIds).toHaveLength(3);
    expect(milestoneIds).toContain(trayId);
  } finally {
    try {
      holding = false;
      release();
      await Promise.allSettled(inflight);
      if (!page.isClosed()) await page.unroute("**/api/v1/views/team/*", handler);
    } finally {
      try {
        for (const path of ownedPaths) {
          const response = await api.delete(path);
          expect([204, 404], `${path}: ${response.status()}`).toContain(response.status());
        }
      } finally {
        await api.dispose();
      }
    }
  }
  expect(intercepted).toBe(true);
});
