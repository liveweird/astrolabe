import { type Response } from "@playwright/test";
import { accountMenu, axeViolations, expect, login, test } from "./helpers";

// The app shell chrome that isn't owned by any single page: the icon rail (desktop navbar
// collapse) and the account menu's colour-scheme switch. Both are DEVICE-level state (plain
// localStorage, no server sync — unlike the language switch in i18n.spec.ts), so this spec
// owns no server-side state at all.
test("the icon rail collapses and expands the navbar, remembered across reload", async ({ page }) => {
  await login(page);
  const toggle = page.getByRole("button", { name: "Show or hide the navigation" });
  await expect(toggle).toHaveAttribute("data-expanded", "true");
  await expect(page.getByRole("link", { name: "Teams" })).toBeVisible();

  await toggle.click();
  // Collapsed to icon-only: the leaf keeps its accessible name via aria-label, so the same
  // by-name locator still finds it.
  await expect(toggle).not.toHaveAttribute("data-expanded", "true");
  await expect(page.getByRole("link", { name: "Teams" })).toBeVisible();

  await page.reload();
  await expect(toggle).not.toHaveAttribute("data-expanded", "true");

  await toggle.click();
  await expect(toggle).toHaveAttribute("data-expanded", "true");
});

test("switching the theme in the account menu updates the color scheme and persists across reload", async ({ page }) => {
  await login(page);
  const html = page.locator("html");

  await accountMenu(page).click();
  await page.getByText("Dark", { exact: true }).click();
  await expect(html).toHaveAttribute("data-mantine-color-scheme", "dark");

  await page.keyboard.press("Escape");
  await page.reload();
  await expect(html).toHaveAttribute("data-mantine-color-scheme", "dark");

  await accountMenu(page).click();
  await page.getByText("Light", { exact: true }).click();
  await expect(html).toHaveAttribute("data-mantine-color-scheme", "light");
});

test("Tab in the open account menu closes it and moves the focus on from its trigger", async ({ page }) => {
  await login(page);
  const trigger = accountMenu(page);
  await trigger.focus();
  await page.keyboard.press("Enter");
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  // The menu opens on its first item. Menu items are not Tab stops (arrow keys move between them), so the first Tab leaves.
  const first = menu.getByRole("menuitem", { name: "English" });
  await expect(first).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(menu).toHaveCount(0);
  await expect(trigger).not.toBeFocused();
  await expect(page.locator("body")).not.toBeFocused();

  // The same with a theme other than the default (System): picking Dark leaves the menu open, Escape closes it, and Tab from the reopened menu still leaves.
  await trigger.click();
  await menu.getByRole("menuitem", { name: "Dark" }).click();
  await expect(menu.getByRole("menuitem", { name: "Dark" })).toHaveAttribute("aria-current", "true");
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(first).toBeFocused();
  await expect(menu.getByRole("menuitem", { name: "Dark" })).toHaveAttribute("aria-current", "true");
  await page.keyboard.press("Tab");
  await expect(menu).toHaveCount(0);
  await expect(page.locator("body")).not.toBeFocused();
});

// The route-change behaviour of the shell: the tab title names the page and `#main-content` takes the focus
// (so the next Tab lands inside the page, past the sidebar). Keep the test name stable: the scenario file mirrors it.
test("the document title names the page and the focus moves to the main content on navigation", async ({ page }) => {
  await login(page);
  // Home collapses to the brand alone; every other page reads "<page> · Astrolabe".
  await expect(page).toHaveTitle("Astrolabe");

  await page.getByRole("link", { name: "Teams" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Teams" })).toBeVisible();
  await expect(page).toHaveTitle("Teams · Astrolabe");
  // The click left the focus on the sidebar link; the route change handed it to the main area, so a Tab goes into the page.
  await expect(page.locator("#main-content")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.locator("#main-content :focus")).toHaveCount(1);

  await page.getByRole("link", { name: "Home" }).click();
  await expect(page).toHaveTitle("Astrolabe");
});

// The Home landing: three cards, each with a link named after its purpose (distinct from the sidebar's "Plan" / "Roadmap" / "Deviations"). Read-only.
test("the Home page links to the plan, the roadmap and the deviations", async ({ page }) => {
  await login(page);
  const home = page.getByRole("heading", { level: 2, name: "Astrolabe" });
  await expect(home).toBeVisible();

  for (const [link, heading] of [
    ["Open the plan", "Plan"],
    ["Open the roadmap", "Roadmap"],
    ["Open the deviations", "Deviations"],
  ] as const) {
    await page.getByRole("link", { name: link, exact: true }).click();
    await expect(page.getByRole("heading", { level: 2, name: heading, exact: true })).toBeVisible();
    await page.getByRole("link", { name: "Home", exact: true }).click();
    await expect(home).toBeVisible();
  }
});

// The deploy check (1.17): the shell re-reads `/index.html` (served `no-cache`, its `astrolabe-build` meta holds the build's commit) and compares it with
// the commit baked into its own bundle. A real second build cannot be had inside one stack, so the test answers the shell's read with the real response whose
// meta content is replaced, in its own browser only: the server and every other spec are untouched, so this spec owns nothing. The five-minute interval, the
// kept answer after a failed check and the Polish text are pinned in vitest (useServedBuild.test.tsx, UpdateBanner.test.tsx).
test("a tab left open across a deploy is told to reload when the user comes back to it, and Reload loads the build that is served", async ({ page }) => {
  const isShellRead = (response: Response) => new URL(response.url()).pathname === "/index.html";
  const notice = page.getByRole("status").filter({ hasText: "A new version of Astrolabe is available. Reload the page to use it." });

  const firstRead = page.waitForResponse(isShellRead);
  await login(page);
  const html = await (await firstRead).text();
  expect(html.match(/<meta name="astrolabe-build" content="[^"]+"/g)).toHaveLength(1);
  await expect(accountMenu(page)).toBeVisible();
  await expect(notice).toHaveCount(0);

  // A deploy happened: the shell the server now serves carries another build's commit. The tab only learns of it when the user comes back to it.
  await page.route("**/index.html", async (route) => {
    const response = await route.fetch();
    const body = (await response.text()).replace(/(<meta name="astrolabe-build" content=")[^"]*/, "$1another-build");
    const headers = { ...response.headers() };
    delete headers["content-length"];
    delete headers["content-encoding"];
    await route.fulfill({ response, body, headers });
  });
  await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
  await expect(notice).toBeVisible();
  await expect(notice.getByRole("button", { name: "Reload", exact: true })).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);

  // The notice belongs to the shell, so it stays across a client-side navigation.
  await page.getByRole("link", { name: "Roadmap", exact: true }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Roadmap", exact: true })).toBeVisible();
  await expect(notice).toBeVisible();

  // The server serves the build the tab runs again, and the user reloads: the new page sees equal stamps and says nothing.
  await page.unroute("**/index.html");
  const readAfterReload = page.waitForResponse(isShellRead);
  await notice.getByRole("button", { name: "Reload", exact: true }).click();
  await (await readAfterReload).text();
  await expect(page.getByRole("heading", { level: 2, name: "Roadmap", exact: true })).toBeVisible();
  await expect(notice).toHaveCount(0);
});
