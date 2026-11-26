import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { QueryClient } from "@tanstack/react-query";
import { forgetRevalidated } from "../api/revalidate";
import i18n from "../i18n";
import { dependencyListView, dependencyRow, milestoneEnd } from "../test/dependencyList";
import { routeFetch } from "../test/http";
import { planOf } from "../test/planView";
import { renderWithProviders, screen, waitFor, within } from "../test/render";
import PlanDependenciesPanel from "./PlanDependenciesPanel";

// 1.29: the panel as the HOST of the list's writes (the edit and delete dialogs are `.dialogs.test.tsx`): the row menu by the row's `can`, the focus after a delete,
// and what a save and a delete refresh.

const TABLE = "Dependencies of the plan";
const NAME = "Design review · Checkout → Build · Billing";
const PLAN = planOf([{ id: 700, name: "Platform", programs: [{ id: 70, name: "Billing", projects: [{ id: 3, name: "Checkout" }] }] }]);
const MAY_BOTH = dependencyRow({ id: 77, can: { edit: true, delete: true } });

let rows = [MAY_BOTH];
let mockFetch: ReturnType<typeof routeFetch>;
let queryClient: QueryClient;

const writes = () =>
  mockFetch.mock.calls
    .filter(([url]) => String(url).startsWith("/api/v1/dependencies/"))
    .map(([url, init]) => ({ method: (init as RequestInit).method, url: String(url), body: (init as RequestInit).body === undefined ? undefined : JSON.parse(String((init as RequestInit).body)) }));
/** The query-key prefixes the writes asked to be refreshed (`refreshQueriesAfterMutation` invalidates each group). */
const invalidated = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map(([filters]) => (filters as { queryKey: readonly unknown[] }).queryKey[0]);

function renderOpen() {
  // The Roadmap's and the Programs page's cached views, as the pages the panel sits under would hold them.
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(["roadmap", "view", { baseline: null, criticalPath: null }], { revision: 1 });
  queryClient.setQueryData(["roadmap", "programs", { baseline: null, criticalPath: null }], { revision: 1 });
  return renderWithProviders(
    <main id="main-content" tabIndex={-1}>
      <PlanDependenciesPanel />
    </main>,
    { route: "/roadmap?dependencies=all", queryClient },
  );
}

describe("PlanDependenciesPanel: changing a dependency from its row", () => {
  beforeEach(() => {
    rows = [MAY_BOTH];
    mockFetch = routeFetch({
      "PUT /api/v1/dependencies/:id": () => new Response(null, { status: 204 }),
      "DELETE /api/v1/dependencies/:id": () => new Response(null, { status: 204 }),
      "GET /api/v1/views/dependencies": () => dependencyListView(rows),
      "GET /api/v1/views/plan": PLAN,
      "GET /api/v1/teams": { items: [{ id: 4, name: "Backend" }], page: 1, pageSize: 100, total: 1 },
    });
    vi.stubGlobal("fetch", mockFetch);
    localStorage.setItem("astrolabe.auth.token", "fake-token");
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    forgetRevalidated();
    await i18n.changeLanguage("en");
  });

  const openMenu = async (user: ReturnType<typeof userEvent.setup>, name = NAME) => user.click(await screen.findByRole("button", { name: `Operations for ${name}` }));

  test("each menu item shows only under the row's own flag, and a row that may do neither has no menu", async () => {
    const user = userEvent.setup();
    const end = (id: number) => ({ id, name: `Step ${id}`, projectId: 3, projectName: "Checkout" });
    const row = (id: number, can: { edit: boolean; delete: boolean }) =>
      dependencyRow({ id, can, predecessor: milestoneEnd(end(id * 10)), successor: milestoneEnd(end(id * 10 + 1)) });
    rows = [row(1, { edit: true, delete: false }), row(2, { edit: false, delete: true }), row(3, { edit: false, delete: false })];
    renderOpen();
    await openMenu(user, "Step 10 · Checkout → Step 11 · Checkout");
    expect(screen.getByRole("menuitem", { name: /^Edit / })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /^Delete / })).toBeNull();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menuitem")).toBeNull());
    await openMenu(user, "Step 20 · Checkout → Step 21 · Checkout");
    expect(screen.queryByRole("menuitem", { name: /^Edit / })).toBeNull();
    expect(screen.getByRole("menuitem", { name: /^Delete / })).toBeInTheDocument();
    const table = screen.getByRole("table", { name: TABLE });
    expect(within(table).getAllByRole("button", { name: /^Operations for / })).toHaveLength(2);
    const [, , neither] = within(table).getAllByRole("row").slice(1);
    expect(within(neither).queryByRole("button")).toBeNull();
  });

  test("a read-only list has no operations column", async () => {
    rows = [dependencyRow({ id: 5 })];
    renderOpen();
    await screen.findByRole("table", { name: TABLE });
    expect(screen.queryByRole("columnheader", { name: "Operations" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Operations for / })).toBeNull();
  });

  test("Edit… saves the type and lag, closes the dialog and refreshes the plan and both roadmap views", async () => {
    const user = userEvent.setup();
    renderOpen();
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    await openMenu(user);
    await user.click(screen.getByRole("menuitem", { name: `Edit ${NAME}` }));
    const dialog = await screen.findByRole("dialog", { name: "Edit dependency" });
    await user.click(within(dialog).getByRole("combobox", { name: "Type" }));
    await user.click(await screen.findByRole("option", { name: "Start → Start (SS)" }));
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit dependency" })).toBeNull());
    expect(writes()).toEqual([{ method: "PUT", url: "/api/v1/dependencies/77", body: { type: "SS", lagDays: 0 } }]);
    await waitFor(() => expect(invalidated(spy)).toEqual(expect.arrayContaining(["plan", "roadmap"])));
    // The Roadmap's view and the Programs page's both sit under "roadmap": the refresh marked them.
    await waitFor(() => {
      expect(queryClient.getQueryState(["roadmap", "view", { baseline: null, criticalPath: null }])?.isInvalidated).toBe(true);
      expect(queryClient.getQueryState(["roadmap", "programs", { baseline: null, criticalPath: null }])?.isInvalidated).toBe(true);
    });
  });

  test("Delete confirms, sends DELETE, refreshes the plan and both roadmap views and puts the focus on the panel's h3", async () => {
    const user = userEvent.setup();
    renderOpen();
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    await openMenu(user);
    await user.click(screen.getByRole("menuitem", { name: `Delete ${NAME}` }));
    const dialog = await screen.findByRole("dialog", { name: "Delete dependency?" });
    rows = [];
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Delete dependency?" })).toBeNull());
    expect(writes()).toEqual([{ method: "DELETE", url: "/api/v1/dependencies/77", body: undefined }]);
    expect(await screen.findByText("The plan has no dependencies yet")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("heading", { level: 3, name: "Dependencies" })).toHaveFocus());
    expect(invalidated(spy)).toEqual(expect.arrayContaining(["plan", "roadmap"]));
    expect(queryClient.getQueryState(["roadmap", "view", { baseline: null, criticalPath: null }])?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(["roadmap", "programs", { baseline: null, criticalPath: null }])?.isInvalidated).toBe(true);
  });
});
