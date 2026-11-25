import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { QueryClient } from "@tanstack/react-query";
import { Route, Routes, useLocation } from "react-router-dom";
import i18n from "../i18n";
import { planViewKey } from "../api/plan";
import { forgetRevalidated } from "../api/revalidate";
import { act, renderWithProviders, screen, waitFor, within } from "../test/render";
import { deferred } from "../test/deferred";
import { jsonResponse } from "../test/http";
import { dependencyListView, dependencyRow } from "../test/dependencyList";
import { milestoneItem, milestonePage } from "../test/milestones";
import { planOf } from "../test/planView";
import Dependencies from "./Dependencies";

// The Dependencies page's "Add dependency" (1.27): the header button by the plan view's `can.createDependency`, the dialog's projects, the write, the refresh and
// the focus. The dialog's own fields are `components/DependencyAddModal.test.tsx`; the row menu's edit and delete are `Dependencies.write.test.tsx`.

// Platform: Billing (Checkout 3 and Audit 6 may be added to; Ledger 8 may not), Search (a second Checkout, 9, may not).
const PLAN = planOf([
  {
    id: 700,
    name: "Platform",
    programs: [
      {
        id: 70,
        name: "Billing",
        projects: [{ id: 3, name: "Checkout" }, { id: 6, name: "Audit" }, { id: 8, name: "Ledger", can: { createDependency: false } }],
      },
      { id: 71, name: "Search", projects: [{ id: 9, name: "Checkout", can: { createDependency: false } }] },
    ],
  },
]);
const NONE_ADDABLE = planOf([
  { id: 700, name: "Platform", programs: [{ id: 70, name: "Billing", projects: [{ id: 3, name: "Checkout", can: { createDependency: false } }] }] },
]);
const TEAMS = { items: [{ id: 4, name: "Backend" }], page: 1, pageSize: 100, total: 1 };
const MILESTONES = milestonePage([
  milestoneItem({ id: 12, name: "Design review", projectId: 3, projectName: "Checkout" }),
  milestoneItem({ id: 20, name: "Scoping", projectId: 6, projectName: "Audit" }),
]);

let plan: () => Response | Promise<Response>;
let post: () => Response | Promise<Response>;
let mockFetch: ReturnType<typeof vi.fn>;

function Where() {
  const location = useLocation();
  return <p data-testid="where">{location.pathname + location.search}</p>;
}

function renderPage(route = "/dependencies", queryClient?: QueryClient) {
  // The shell's focus target (`useFocusMainOnNavigation`, and where `useDialogFocus` sends a focus whose opener has gone).
  return renderWithProviders(
    <main id="main-content" tabIndex={-1}>
      <Routes>
        <Route
          path="/dependencies"
          element={
            <>
              <Dependencies />
              <Where />
            </>
          }
        />
      </Routes>
    </main>,
    { route, queryClient },
  );
}

const readCalls = () => mockFetch.mock.calls.map(([url]) => String(url)).filter((url) => url.startsWith("/api/v1/views/dependencies"));
const planCalls = () => mockFetch.mock.calls.map(([url]) => String(url)).filter((url) => url === "/api/v1/views/plan");
const posts = () =>
  mockFetch.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === "POST")
    .map(([url, init]) => ({ url: String(url), body: JSON.parse(String((init as RequestInit).body)) }));
const addButton = () => screen.findByRole("button", { name: "Add dependency" });

describe("Dependencies page: adding a dependency", () => {
  beforeEach(() => {
    plan = () => jsonResponse(200, PLAN);
    post = () => jsonResponse(201, { id: 90 });
    mockFetch = vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === "POST") return Promise.resolve(post());
      if (url === "/api/v1/views/dependencies") return Promise.resolve(jsonResponse(200, dependencyListView([dependencyRow({ id: 1 })])));
      if (url === "/api/v1/views/plan") return Promise.resolve(plan());
      if (url.startsWith("/api/v1/teams?")) return Promise.resolve(jsonResponse(200, TEAMS));
      if (url.startsWith("/api/v1/milestones?")) return Promise.resolve(jsonResponse(200, MILESTONES));
      return Promise.resolve(jsonResponse(404, { title: "x", status: 404 }));
    });
    vi.stubGlobal("fetch", mockFetch);
    localStorage.setItem("astrolabe.auth.token", "fake-token");
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    localStorage.clear();
    forgetRevalidated();
    await i18n.changeLanguage("en");
  });

  test("the header offers 'Add dependency' when the plan lets the caller add to at least one project, and not before", async () => {
    const gate = deferred<Response>();
    plan = () => gate.promise;
    renderPage();
    await screen.findByRole("table", { name: "Dependencies of the plan" });
    // The plan view is not answered: no claim about the caller's rights, so no button (never a disabled one).
    expect(screen.queryByRole("button", { name: "Add dependency" })).toBeNull();
    gate.resolve(jsonResponse(200, PLAN));
    const button = await addButton();
    expect(button).toBeEnabled();
  });

  test("no button when nothing in the plan may be added to, and none when the plan view failed", async () => {
    const planState = (queryClient: QueryClient) => queryClient.getQueryState(planViewKey)?.status;
    plan = () => jsonResponse(200, NONE_ADDABLE);
    const answered = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const first = renderPage("/dependencies", answered);
    await screen.findByRole("table", { name: "Dependencies of the plan" });
    await waitFor(() => expect(planState(answered)).toBe("success"));
    expect(screen.queryByRole("button", { name: "Add dependency" })).toBeNull();
    first.unmount();

    forgetRevalidated();
    plan = () => jsonResponse(500, { title: "Server error", status: 500 });
    const failed = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderPage("/dependencies", failed);
    await screen.findByRole("table", { name: "Dependencies of the plan" });
    await waitFor(() => expect(planState(failed)).toBe("error"));
    expect(screen.queryByRole("button", { name: "Add dependency" })).toBeNull();
  });

  test("a failed refresh of the plan view takes the button away: the old document is no claim about the caller's rights", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderPage("/dependencies", queryClient);
    await addButton();
    plan = () => jsonResponse(500, { title: "Server error", status: 500 });
    await act(() => queryClient.invalidateQueries({ queryKey: planViewKey }));
    await waitFor(() => expect(queryClient.getQueryState(planViewKey)?.status).toBe("error"));
    expect(queryClient.getQueryData(planViewKey)).toBeDefined();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Add dependency" })).toBeNull());
  });

  test("the dialog offers only the projects the plan says the caller may add to, a shared name told apart by its program", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await addButton());
    const dialog = await screen.findByRole("dialog", { name: "Add dependency" });
    await user.click(within(dialog).getByRole("combobox", { name: "Successor's project" }));
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["Audit", "Checkout (Billing)"]);
  });

  test("a save POSTs to the successor's project, closes, refreshes the dependency list, the plan and the roadmap groups, keeps the filters and puts the focus back on the button", async () => {
    const user = userEvent.setup();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(["roadmap", "view"], {});
    renderPage("/dependencies?status=ok&teamId=4", queryClient);
    const button = await addButton();
    await user.click(button);
    const dialog = await screen.findByRole("dialog", { name: "Add dependency" });
    await user.click(within(dialog).getByRole("combobox", { name: "Successor's project" }));
    await user.click(await screen.findByRole("option", { name: "Audit" }));
    await user.click(within(dialog).getByRole("combobox", { name: "Successor" }));
    await user.click(await screen.findByRole("option", { name: "Scoping · Audit" }));
    await user.click(within(dialog).getByRole("combobox", { name: "Predecessor" }));
    await user.click(await screen.findByRole("option", { name: "Design review · Checkout" }));
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add dependency" })).toBeNull());
    expect(posts()).toEqual([
      {
        url: "/api/v1/projects/6/dependencies",
        body: { predecessor: { kind: "MILESTONE", id: 12 }, successor: { kind: "MILESTONE", id: 20 }, type: "FS", lagDays: 0 },
      },
    ]);
    await waitFor(() => expect(readCalls()).toHaveLength(2));
    await waitFor(() => expect(planCalls().length).toBeGreaterThan(1));
    expect(queryClient.getQueryState(["roadmap", "view"])?.isInvalidated).toBe(true);
    expect(screen.getByTestId("where")).toHaveTextContent("/dependencies?status=ok&teamId=4");
    await waitFor(() => expect(button).toHaveFocus());
  });

  test("the project filter in the URL is the dialog's start when the caller may add to it, and only then", async () => {
    const user = userEvent.setup();
    const first = renderPage("/dependencies?projectId=3");
    await user.click(await addButton());
    expect(await screen.findByRole("combobox", { name: "Successor's project" })).toHaveValue("Checkout (Billing)");
    first.unmount();

    renderPage("/dependencies?projectId=8");
    await user.click(await addButton());
    expect(await screen.findByRole("combobox", { name: "Successor's project" })).toHaveValue("");
  });

  test("Cancel closes the dialog without a write, re-reads nothing and puts the focus back on the button", async () => {
    const user = userEvent.setup();
    renderPage();
    const button = await addButton();
    await user.click(button);
    await user.click(within(await screen.findByRole("dialog", { name: "Add dependency" })).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add dependency" })).toBeNull());
    expect(posts()).toEqual([]);
    expect(readCalls()).toHaveLength(1);
    await waitFor(() => expect(button).toHaveFocus());
  });

  test("a refusal stays in the dialog: its own sentence, the dialog open, nothing re-read", async () => {
    post = () => jsonResponse(403, { title: "Forbidden", status: 403 });
    const user = userEvent.setup();
    renderPage("/dependencies?projectId=6");
    await user.click(await addButton());
    const dialog = await screen.findByRole("dialog", { name: "Add dependency" });
    await user.click(within(dialog).getByRole("combobox", { name: "Successor" }));
    await user.click(await screen.findByRole("option", { name: "Scoping · Audit" }));
    await user.click(within(dialog).getByRole("combobox", { name: "Predecessor" }));
    await user.click(await screen.findByRole("option", { name: "Design review · Checkout" }));
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Only the owners of the successor's project");
    expect(posts()).toHaveLength(1);
    expect(readCalls()).toHaveLength(1);
    expect(screen.getByRole("dialog", { name: "Add dependency" })).toBeInTheDocument();
  });

  test("speaks Polish: the button and the dialog's title", async () => {
    await i18n.changeLanguage("pl");
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Dodaj zależność" }));
    expect(await screen.findByRole("dialog", { name: "Dodaj zależność" })).toBeInTheDocument();
  });
});
