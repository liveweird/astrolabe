// Jira polling (v1.3), against the compose stack's Jira STUB and its scheduler (a tick every 60 s after a 10 s first one on the stack under test): a tested
// connection with a polling interval is polled by the scheduler on its own and reads Current, a manual-only one is not; an administrator sets the interval and
// manual only in the editor; the telemetry panel's Sync section lists the connections with their state.
// Owns: its Jira connections (unique `e2e-poll-*` names, each scoped to the stub's `E2E` project ONLY and bound to a unique throwaway site), created through the
// API in the beforeAll and removed in the afterAll. It binds nothing, creates no plan node and dates nothing (no year), so a run of its connections calls Jira
// for nothing and no other spec's figures meet it. It never flips the stub. Test connection shares a 10-a-minute bucket per IP with the other Jira specs: the
// beforeAll spends ONE call per worker start (the polled connection; the manual-only one is never tested), a 429 waits the minute out once.
import { randomUUID } from "node:crypto";
import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { accountMenu, apiAsAdmin, deleteViaApi, expect, login, test, testJiraConnectionViaApi, uniqueText } from "./helpers";

// The scenarios read one another's connection (the second edits the polled one, the third lists it): one serial group, and a failed test stops the rest.
test.describe.configure({ mode: "serial" });

interface Connection {
  id: number;
  name: string;
}

const CONNECTIONS = "/api/v1/integrations/jira/connections";
/** The scheduler's first run of a tested connection: a tick every 60 s (10 s after start), the connection due at once - two minutes is the ceiling, the rest is slack. */
const POLL_WITHIN_MS = 120_000;

let scheduled: Connection;
let manual: Connection;
const teardown: string[] = [];

/** A unique throwaway Jira site: the stub answers for any tenant, and a site of its own keeps this file's connections apart from every other spec's. */
const uniqueSite = () => `https://e2epoll${randomUUID().replace(/-/g, "").slice(0, 12)}.atlassian.net`;

async function seedConnection(api: APIRequestContext, label: string, pollIntervalMinutes: number | null): Promise<Connection> {
  const name = uniqueText(`e2e-poll-${label}`);
  const body = { name, siteUrl: uniqueSite(), email: "e2e-poll@astrolabe.local", apiToken: "e2e-poll-token", authScheme: "BASIC", projectKeys: ["E2E"], enabled: true, pollIntervalMinutes };
  const response = await api.post(CONNECTIONS, { data: body });
  expect(response.status(), await response.text()).toBe(201);
  const id = ((await response.json()) as { id: number }).id;
  teardown.push(`${CONNECTIONS}/${id}`);
  return { id, name };
}

test.beforeAll(async () => {
  test.setTimeout(180_000);
  const { api } = await apiAsAdmin();
  try {
    scheduled = await seedConnection(api, "scheduled", 5);
    manual = await seedConnection(api, "manual", null);
    await testJiraConnectionViaApi(api, scheduled.id);
  } finally {
    await api.dispose();
  }
});
test.afterAll(async () => {
  await deleteViaApi(teardown.splice(0).reverse());
});

interface RunRow {
  trigger: "MANUAL" | "SCHEDULED";
  outcome: "SUCCEEDED" | "FAILED" | "ABANDONED" | null;
}

async function runsOf(api: APIRequestContext, connection: Connection): Promise<RunRow[]> {
  const response = await api.get(`/api/v1/integrations/sync/runs?kind=JIRA&connectionId=${connection.id}`);
  expect(response.ok(), await response.text()).toBeTruthy();
  return ((await response.json()) as { items: RunRow[] }).items;
}

const scheduledRunCount = async (api: APIRequestContext, connection: Connection): Promise<number> => (await runsOf(api, connection)).filter((run) => run.trigger === "SCHEDULED").length;

/** Waits (bounded) until the scheduler has run the connection to a success: the one thing that proves a tick found it due. */
async function awaitScheduledSuccess(api: APIRequestContext, connection: Connection): Promise<void> {
  await expect
    .poll(async () => (await runsOf(api, connection)).some((run) => run.trigger === "SCHEDULED" && run.outcome === "SUCCEEDED"), {
      message: "a scheduled, succeeded run of the polled connection",
      timeout: POLL_WITHIN_MS,
      intervals: [2_000, 5_000],
    })
    .toBe(true);
}

/** One row of the connection page's facts table, found by its row header. */
const fact = (page: Page, label: string): Locator =>
  page.getByRole("table", { name: "Connection facts" }).getByRole("row").filter({ has: page.getByRole("rowheader", { name: label, exact: true }) });

test("a tested connection with a polling interval is polled by the scheduler within two minutes and reads Current, and an untested manual-only connection has no run", async ({ page }) => {
  test.setTimeout(180_000);
  const { api } = await apiAsAdmin();
  try {
    await awaitScheduledSuccess(api, scheduled);
    expect(await runsOf(api, manual), "the untested manual-only connection has no run").toEqual([]);
  } finally {
    await api.dispose();
  }

  await login(page);
  await page.goto(`/integrations/jira/${scheduled.id}`);
  await expect(page.getByRole("heading", { level: 2, name: scheduled.name })).toBeVisible();
  // The run row: the scheduler's, not a person's.
  const runs = page.getByRole("table", { name: "Recent runs" });
  const run = runs.getByRole("row").filter({ hasText: "Scheduled" });
  await expect(run.first().getByText("Succeeded", { exact: true })).toBeVisible();
  await expect(runs.getByRole("row").filter({ hasText: "Manual" })).toHaveCount(0);
  // The facts: Current, the last success dated, the next poll within the interval (5 minutes), the interval itself.
  await expect(fact(page, "Status").getByText("Current", { exact: true })).toBeVisible();
  await expect(fact(page, "Status")).toContainText(/next poll in [1-5] min/);
  await expect(fact(page, "Last success (UTC)")).not.toContainText("—");
  await expect(fact(page, "Polling")).toContainText("every 5 min");

  // The manual-only connection: nothing ran, it reads Never synced and Manual only (it was never tested, so the line under the badge says so).
  await page.goto(`/integrations/jira/${manual.id}`);
  await expect(page.getByRole("heading", { level: 2, name: manual.name })).toBeVisible();
  await expect(fact(page, "Status").getByText("Never synced", { exact: true })).toBeVisible();
  await expect(fact(page, "Polling")).toContainText("Manual only");
  await expect(fact(page, "Last success (UTC)")).toContainText("—");
  await expect(page.getByRole("table", { name: "Recent runs" })).toContainText("No runs yet");
});

test("an administrator sets the polling interval and manual only in the editor", async ({ page }) => {
  test.setTimeout(240_000);
  await login(page);
  await page.goto(`/integrations/jira/${scheduled.id}`);
  await expect(page.getByRole("heading", { level: 2, name: scheduled.name })).toBeVisible();
  await expect(fact(page, "Polling")).toContainText("every 5 min");

  const edit = async (): Promise<Locator> => {
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Edit Jira connection" });
    await expect(dialog).toBeVisible();
    return dialog;
  };
  const interval = (dialog: Locator) => dialog.getByRole("textbox", { name: "Polling interval (minutes)" });
  const manualOnly = (dialog: Locator) => dialog.getByRole("checkbox", { name: "Manual only (no polling)" });
  const save = async (dialog: Locator): Promise<void> => {
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
  };

  // The field opens on the saved interval; a value the rule refuses stays in the open dialog with the rule's sentence and saves nothing.
  let dialog = await edit();
  await expect(interval(dialog)).toHaveValue("5");
  await expect(manualOnly(dialog)).not.toBeChecked();
  await interval(dialog).fill("3");
  await save(dialog);
  await expect(dialog.getByText(/from 5 to 1440/)).toBeVisible();
  await expect(dialog).toBeVisible();

  // A valid number round-trips: saved, and the page and the next editor read it back.
  await interval(dialog).fill("20");
  await save(dialog);
  await expect(dialog).toHaveCount(0);
  await expect(fact(page, "Polling")).toContainText("every 20 min");
  dialog = await edit();
  await expect(interval(dialog)).toHaveValue("20");

  // Manual only disables the number and saves as no polling at all.
  await manualOnly(dialog).check();
  await expect(interval(dialog)).toBeDisabled();
  await save(dialog);
  await expect(dialog).toHaveCount(0);
  await expect(fact(page, "Polling")).toContainText("Manual only");
  await expect(fact(page, "Status")).toContainText("manual only");
  await expect(fact(page, "Next poll (UTC)")).toContainText("manual only");

  // The registry's Status column says the same, without opening the page.
  await page.goto("/integrations/jira");
  const row = page.getByRole("table", { name: "Jira connections" }).getByRole("row").filter({ hasText: scheduled.name });
  await expect(row).toContainText("manual only");

  // And back: the checkbox reads checked and the number disabled, unchecking enables it, and the interval saved is the one typed.
  // Manual only has stopped the scheduler for this connection: the scheduled runs counted here are all there will be until it is polled again.
  const { api } = await apiAsAdmin();
  let before: number;
  try {
    before = await scheduledRunCount(api, scheduled);
  } finally {
    await api.dispose();
  }
  await page.goto(`/integrations/jira/${scheduled.id}`);
  dialog = await edit();
  await expect(manualOnly(dialog)).toBeChecked();
  await expect(interval(dialog)).toBeDisabled();
  await manualOnly(dialog).uncheck();
  await expect(interval(dialog)).toBeEnabled();
  await interval(dialog).fill("5");
  await save(dialog);
  await expect(dialog).toHaveCount(0);
  await expect(fact(page, "Polling")).toContainText("every 5 min");

  // The edit made the connection due at once, and it is polled again: a NEW scheduled run, beyond the ones counted before the restore.
  const poller = await apiAsAdmin();
  try {
    await expect
      .poll(() => scheduledRunCount(poller.api, scheduled), { message: "a new scheduled run after the interval was restored", timeout: POLL_WITHIN_MS, intervals: [2_000, 5_000] })
      .toBeGreaterThan(before);
  } finally {
    await poller.api.dispose();
  }
});

test("the telemetry panel's Sync section lists the connection with its state", async ({ page }) => {
  test.setTimeout(180_000);
  const { api } = await apiAsAdmin();
  try {
    // The state is derived from the newest runs: wait (bounded) for a success, which the first scenario normally left behind already.
    await awaitScheduledSuccess(api, scheduled);
  } finally {
    await api.dispose();
  }

  await login(page);
  await accountMenu(page).click();
  await page.getByRole("menuitem", { name: "Telemetry panel" }).click();
  const panel = page.getByRole("complementary", { name: "Telemetry" });
  await expect(panel).toBeVisible();
  const section = panel.getByRole("button", { name: "Sync", exact: true });
  if ((await section.getAttribute("aria-expanded")) !== "true") await section.click();
  await expect(section).toHaveAttribute("aria-expanded", "true");
  await expect(panel.getByText(/^The scheduler looks for connections that are due every \d+ s\.$/)).toBeVisible();

  const table = panel.getByRole("table", { name: "Sync status per connection" });
  const polled = table.getByRole("row").filter({ hasText: scheduled.name });
  await expect(polled).toHaveCount(1);
  await expect(polled).toContainText("Jira");
  await expect(polled.getByText("Current", { exact: true })).toBeVisible();
  await expect(polled).toContainText("every 5 min");
  await expect(polled.getByRole("cell").nth(2)).not.toContainText("Never"); // the Last success cell: an age, not "Never"
  // The manual-only one: nothing has run, it is not polled, and it says why.
  const idle = table.getByRole("row").filter({ hasText: manual.name });
  await expect(idle).toHaveCount(1);
  await expect(idle.getByText("Never synced", { exact: true })).toBeVisible();
  await expect(idle.getByRole("cell").nth(2)).toHaveText("Never"); // the Last success cell
  await expect(idle).toContainText("Manual only");
});
