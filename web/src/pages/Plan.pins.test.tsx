import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { screen, waitFor, within } from "@testing-library/react";
import Plan from "./Plan";
import { headingOutline } from "../test/headings";
import { routeFetch } from "../test/http";
import { linksView } from "../test/jiraLinks";
import { findPlanTree, planOf, planStatus } from "../test/planView";
import { renderWithProviders } from "../test/render";

const PINS_KEY = "astrolabe.viewSettings.plan.pins";
const PINNED_FOLDS_KEY = "astrolabe.viewSettings.plan.pinnedCollapsed";
const PINNED_OPEN_KEY = "astrolabe.viewSettings.plan.pinnedOpen";
const FOLDS_KEY = "astrolabe.viewSettings.plan.collapsed";

const PLAN = planOf([
  {
    id: 1,
    name: "Platform",
    programs: [
      { id: 10, name: "Billing", projects: [{ id: 100, name: "Invoices" }, { id: 101, name: "Taxes" }] },
      { id: 11, name: "Identity", projects: [{ id: 102, name: "Login" }] },
    ],
  },
  { id: 2, name: "Legacy", endDate: "2025-12-31", programs: [{ id: 12, name: "Archive", projects: [{ id: 103, name: "Old ledger" }] }] },
]);

const read = (key: string) => JSON.parse(localStorage.getItem(key) ?? "null") as unknown;
const pinnedTable = () => screen.getByRole("table", { name: "Pinned rows of the plan" });
const pinnedKeys = () => within(pinnedTable()).getAllByRole("row").slice(1).map((row) => `${row.getAttribute("data-root")}|${row.getAttribute("data-key")}`);
const treeKeys = () =>
  within(screen.getByRole("table", { name: "Work streams, programs and projects" }))
    .getAllByRole("row")
    .slice(1)
    .map((row) => row.getAttribute("data-key"));
const status = planStatus;

function show(route = "/plan", plan = PLAN) {
  vi.stubGlobal("fetch", routeFetch({ "GET /api/v1/views/plan": plan, "GET /api/v1/views/jira-links": linksView(), "GET /api/v1/people": { items: [], page: 1, pageSize: 20, total: 0 } }));
  return renderWithProviders(<Plan />, { route });
}

async function pickFromMenu(user: ReturnType<typeof userEvent.setup>, name: string, item: string) {
  await user.click(await screen.findByRole("button", { name: `Operations for ${name}`, hidden: false }));
  await user.click(await screen.findByRole("menuitem", { name: item }));
}

describe("Plan page: pins", () => {
  beforeEach(() => {
    localStorage.setItem("astrolabe.auth.token", "fake-token");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  test("with no pin there is no Pinned section", async () => {
    show();
    await findPlanTree();
    expect(screen.queryByRole("button", { name: /^Pinned/ })).not.toBeInTheDocument();
    expect(screen.getAllByRole("table")).toHaveLength(1);
  });

  test("Pin in a row's menu adds the node to the Pinned section, marks the row, says so, remembers it, and the focus stays on the menu button", async () => {
    const user = userEvent.setup();
    show();
    await findPlanTree();
    await pickFromMenu(user, "Billing", "Pin: Billing");
    expect(read(PINS_KEY)).toEqual(["pg:10"]);
    expect(status()).toHaveTextContent("Billing pinned");
    expect(pinnedKeys()).toEqual(["pg:10|pg:10", "pg:10|pj:100", "pg:10|pj:101"]);
    expect(screen.getByRole("button", { name: /^Pinned/ })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: /^Pinned/ })).toHaveTextContent("1 pin");
    // The tree row carries the marker; the tree is untouched.
    const treeRow = document.querySelector('tr[data-scope="tree"][data-key="pg:10"]') as HTMLElement;
    expect(within(treeRow).getByText("Pinned")).toBeInTheDocument();
    expect(treeKeys()).toHaveLength(9);
    await waitFor(() => expect(screen.getByRole("button", { name: "Operations for Billing" })).toHaveFocus());
    // The menu now offers Unpin, in the same place.
    await user.click(screen.getByRole("button", { name: "Operations for Billing" }));
    expect(await screen.findByRole("menuitem", { name: "Unpin: Billing" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Pin: Billing" })).not.toBeInTheDocument();
  });

  test("every accessible name in the pinned copy is wrapped, so a row's controls are never two of the same name", async () => {
    localStorage.setItem(PINS_KEY, JSON.stringify(["pg:10"]));
    show();
    await findPlanTree();
    const section = pinnedTable();
    expect(within(section).getByRole("button", { name: "Program Billing (pinned)" })).toBeInTheDocument();
    expect(within(section).getByRole("button", { name: "Operations for Billing (pinned)" })).toBeInTheDocument();
    expect(within(section).getByRole("button", { name: "Unpin: Billing (pinned)" })).toBeInTheDocument();
    expect(within(section).getByRole("button", { name: "New project in Billing (pinned)" })).toBeInTheDocument();
    expect(within(section).getByRole("link", { name: "Open project Invoices (pinned)" })).toBeInTheDocument();
    // The exact names are the tree's alone.
    expect(screen.getAllByRole("button", { name: "Program Billing" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Operations for Billing" })).toHaveLength(1);
    expect(screen.getAllByRole("link", { name: "Open project Invoices" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "New project in Billing" })).toHaveLength(1);
  });

  test("the pinned copy has no Pin item, no Move items, and a root alone has the Unpin button", async () => {
    localStorage.setItem(PINS_KEY, JSON.stringify(["pg:10"]));
    const user = userEvent.setup();
    show();
    await findPlanTree();
    const section = pinnedTable();
    expect(within(section).getAllByRole("button", { name: /^Unpin/ })).toHaveLength(1);
    await user.click(within(section).getByRole("button", { name: "Operations for Billing (pinned)" }));
    const items = (await screen.findAllByRole("menuitem")).map((el) => el.getAttribute("aria-label"));
    expect(items).toEqual(["Show only this: Billing (pinned)", "Edit Billing (pinned)", "Move Billing to another work stream (pinned)", "Delete Billing (pinned)"]);
  });

  test("a pin ignores the filters, the focus and Hide closed", async () => {
    localStorage.setItem(PINS_KEY, JSON.stringify(["pj:103", "pg:11"]));
    show("/plan?q=nothing&hideClosed=true&workStreamId=1");
    expect(await screen.findByText("No row matches")).toBeInTheDocument();
    expect(pinnedKeys()).toEqual(["pj:103|pj:103", "pg:11|pg:11", "pg:11|pj:102"]);
  });

  test("a pin of a deleted node draws nothing and stays in storage until the user's next pin change prunes it", async () => {
    localStorage.setItem(PINS_KEY, JSON.stringify(["pg:999", "pg:10"]));
    const user = userEvent.setup();
    show();
    await findPlanTree();
    expect(pinnedKeys()[0]).toBe("pg:10|pg:10");
    expect(screen.getByRole("button", { name: /^Pinned/ })).toHaveTextContent("1 pin");
    expect(read(PINS_KEY)).toEqual(["pg:999", "pg:10"]);
    await pickFromMenu(user, "Identity", "Pin: Identity");
    expect(read(PINS_KEY)).toEqual(["pg:10", "pg:11"]);
  });

  test("a pin made before a reload is still there, in pin order", async () => {
    const user = userEvent.setup();
    const first = show();
    await findPlanTree();
    await pickFromMenu(user, "Identity", "Pin: Identity");
    await pickFromMenu(user, "Platform", "Pin: Platform");
    first.unmount();
    show();
    await findPlanTree();
    expect(pinnedKeys().filter((entry) => entry.split("|")[0] === entry.split("|")[1])).toEqual(["pg:11|pg:11", "ws:1|ws:1"]);
  });

  test("Unpin in the row menu removes the pin and the focus stays on the menu button", async () => {
    localStorage.setItem(PINS_KEY, JSON.stringify(["pg:10"]));
    const user = userEvent.setup();
    show();
    await findPlanTree();
    await pickFromMenu(user, "Billing", "Unpin: Billing");
    expect(read(PINS_KEY)).toEqual([]);
    expect(status()).toHaveTextContent("Billing unpinned");
    expect(screen.queryByRole("button", { name: /^Pinned/ })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Operations for Billing" })).toHaveFocus());
  });

  test("Unpin in the pinned section moves the focus to the next pinned root's Unpin, else the previous, else the node's menu in the tree", async () => {
    localStorage.setItem(PINS_KEY, JSON.stringify(["pg:10", "pg:11", "pg:12"]));
    const user = userEvent.setup();
    show();
    await findPlanTree();
    await user.click(within(pinnedTable()).getByRole("button", { name: "Unpin: Identity (pinned)" }));
    expect(read(PINS_KEY)).toEqual(["pg:10", "pg:12"]);
    await waitFor(() => expect(within(pinnedTable()).getByRole("button", { name: "Unpin: Archive (pinned)" })).toHaveFocus());
    // The last root has no next: the previous one.
    await user.click(within(pinnedTable()).getByRole("button", { name: "Unpin: Archive (pinned)" }));
    await waitFor(() => expect(within(pinnedTable()).getByRole("button", { name: "Unpin: Billing (pinned)" })).toHaveFocus());
    // The only one left: its row menu in the tree.
    await user.click(within(pinnedTable()).getByRole("button", { name: "Unpin: Billing (pinned)" }));
    expect(screen.queryByRole("button", { name: /^Pinned/ })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Operations for Billing" })).toHaveFocus());
    expect(status()).toHaveTextContent("Billing unpinned");
  });

  test("when the unpinned node's tree row is not on the page, the focus goes to the page title", async () => {
    localStorage.setItem(PINS_KEY, JSON.stringify(["pg:10"]));
    const user = userEvent.setup();
    show("/plan?q=archive");
    await findPlanTree();
    await user.click(within(pinnedTable()).getByRole("button", { name: "Unpin: Billing (pinned)" }));
    await waitFor(() => expect(screen.getByRole("heading", { level: 2, name: "Plan" })).toHaveFocus());
  });

  test("folds inside the pinned section are its own: they never touch the tree's, and the tree's never touch them", async () => {
    localStorage.setItem(PINS_KEY, JSON.stringify(["ws:1"]));
    const user = userEvent.setup();
    show();
    await findPlanTree();
    await user.click(within(pinnedTable()).getByRole("button", { name: "Program Billing (pinned)" }));
    expect(pinnedKeys()).toEqual(["ws:1|ws:1", "ws:1|pg:10", "ws:1|pg:11", "ws:1|pj:102"]);
    expect(read(PINNED_FOLDS_KEY)).toEqual(["ws:1>pg:10"]);
    expect(read(FOLDS_KEY)).toBeNull();
    expect(treeKeys()).toContain("pj:100");
    expect(status()).toHaveTextContent("Billing collapsed");
    await user.click(screen.getByRole("button", { name: "Work stream Platform" }));
    expect(read(FOLDS_KEY)).toEqual(["ws:1"]);
    expect(pinnedKeys()).toHaveLength(4);
    expect(within(pinnedTable()).getByRole("button", { name: "Work stream Platform (pinned)" })).toHaveAttribute("aria-expanded", "true");
  });

  test("the section folds as a whole, remembered, and its heading says how many pins it holds", async () => {
    localStorage.setItem(PINS_KEY, JSON.stringify(["pg:10", "pj:103"]));
    const user = userEvent.setup();
    show();
    await findPlanTree();
    expect(headingOutline()).toEqual([[2, "Plan"], [3, "Pinned 2 pins"]]);
    await user.click(screen.getByRole("button", { name: /^Pinned/ }));
    expect(screen.getByRole("button", { name: /^Pinned/ })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("table", { name: "Pinned rows of the plan" })).not.toBeInTheDocument();
    expect(read(PINNED_OPEN_KEY)).toBe(false);
    expect(screen.getByRole("button", { name: /^Pinned/ })).toHaveFocus();
  });

  test("unpinning drops the folds the section kept for that root, and pinning while the section is folded opens it", async () => {
    localStorage.setItem(PINS_KEY, JSON.stringify(["ws:1", "pg:12"]));
    localStorage.setItem(PINNED_FOLDS_KEY, JSON.stringify(["ws:1>pg:10", "pg:12>pg:12"]));
    localStorage.setItem(PINNED_OPEN_KEY, JSON.stringify(false));
    const user = userEvent.setup();
    show();
    await findPlanTree();
    await pickFromMenu(user, "Billing", "Pin: Billing");
    expect(read(PINNED_OPEN_KEY)).toBe(true);
    expect(screen.getByRole("button", { name: /^Pinned/ })).toHaveAttribute("aria-expanded", "true");
    await user.click(within(pinnedTable()).getByRole("button", { name: "Unpin: Archive (pinned)" }));
    expect(read(PINNED_FOLDS_KEY)).toEqual(["ws:1>pg:10"]);
  });

  test("the pinned table is a labelled, focusable scroll region with its own height limit", async () => {
    localStorage.setItem(PINS_KEY, JSON.stringify(["ws:1"]));
    show();
    await findPlanTree();
    const region = screen.getByRole("region", { name: "Pinned rows of the plan" });
    expect(region).toHaveAttribute("tabindex", "0");
    expect(region.getAttribute("style") ?? "").toContain("min(40vh, 20rem)");
  });

  test("Show only this from the pinned copy narrows the tree, keeps the section and leaves the focus on the pinned copy's own menu button", async () => {
    localStorage.setItem(PINS_KEY, JSON.stringify(["pg:10"]));
    const user = userEvent.setup();
    show();
    await findPlanTree();
    const trigger = within(pinnedTable()).getByRole("button", { name: "Operations for Billing (pinned)" });
    await user.click(trigger);
    await user.click(await screen.findByRole("menuitem", { name: "Show only this: Billing (pinned)" }));
    await waitFor(() => expect(treeKeys()).toEqual(["pg:10", "pj:100", "pj:101"]));
    expect(pinnedKeys()).toEqual(["pg:10|pg:10", "pg:10|pj:100", "pg:10|pj:101"]);
    expect(status()).toHaveTextContent("Showing only Billing");
    await waitFor(() => expect(within(pinnedTable()).getByRole("button", { name: "Operations for Billing (pinned)" })).toHaveFocus());
  });

  test("an editor opened from the pinned copy gives the focus back to the pinned copy's menu button", async () => {
    localStorage.setItem(PINS_KEY, JSON.stringify(["pg:10"]));
    const user = userEvent.setup();
    show();
    await findPlanTree();
    await user.click(within(pinnedTable()).getByRole("button", { name: "Operations for Billing (pinned)" }));
    await user.click(await screen.findByRole("menuitem", { name: "Edit Billing (pinned)" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /^cancel$/i }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(within(pinnedTable()).getByRole("button", { name: "Operations for Billing (pinned)" })).toHaveFocus());
  });

  test("a pinned project is one row, and a read-only reader pins too", async () => {
    const user = userEvent.setup();
    show("/plan", planOf([{ id: 1, name: "Platform", can: { edit: false, delete: false, createProgram: false, orderPrograms: false }, programs: [{ id: 10, name: "Billing", can: { edit: false, delete: false, createProject: false, move: false }, projects: [{ id: 100, name: "Invoices", can: { edit: false, delete: false, editTargetWindow: false, move: false, createMilestone: false, createDependency: false } }] }] }], { can: { createWorkStream: false, orderWorkStreams: false } }));
    await findPlanTree();
    await pickFromMenu(user, "Invoices", "Pin: Invoices");
    expect(pinnedKeys()).toEqual(["pj:100|pj:100"]);
    // The pinned copy of a project the reader may do nothing to has no menu (the Pin item is the tree's), only its Unpin button.
    expect(within(pinnedTable()).queryByRole("button", { name: "Operations for Invoices (pinned)" })).not.toBeInTheDocument();
    expect(within(pinnedTable()).getByRole("button", { name: "Unpin: Invoices (pinned)" })).toBeInTheDocument();
  });
});
