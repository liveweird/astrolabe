import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { QueryClient } from "@tanstack/react-query";
import i18n from "../i18n";
import { forgetRevalidated } from "../api/revalidate";
import { act, renderWithProviders, screen, waitFor, within } from "../test/render";
import { deferred } from "../test/deferred";
import { jsonResponse } from "../test/http";
import { planOf } from "../test/planView";
import { dependencyListView, dependencyRow } from "../test/dependencyList";
import PlanDependenciesPanel from "./PlanDependenciesPanel";

// The dependency panel's row writes (1.22 on the Dependencies page, the panel's since 1.29): a row's menu, the project page's dialog and confirmation, the
// refresh and the focus. The menu by the row's `can`, and what a save and a delete invalidate, are `PlanDependenciesPanel.write.test.tsx`; the read-only
// list (the cells, the filters, the states) is `PlanDependenciesPanel.list.test.tsx`.

const TABLE = "Dependencies of the plan";
const PLAN = planOf([{ id: 700, name: "Platform", programs: [{ id: 70, name: "Billing", projects: [{ id: 3, name: "Checkout" }] }] }]);
const TEAMS = { items: [{ id: 4, name: "Backend" }, { id: 7, name: "Frontend" }], page: 1, pageSize: 100, total: 2 };

let answer: () => Response;
/** The answer to a write on a dependency (`PUT`/`DELETE /api/v1/dependencies/{id}`): a `204` unless a test says otherwise. */
let write: () => Response;
let mockFetch: ReturnType<typeof vi.fn>;

function renderPage(query = "?dependencies=all", queryClient?: QueryClient) {
  // The shell's focus target (`useFocusMainOnNavigation`, and where `useDialogFocus` sends a focus whose opener has gone).
  return renderWithProviders(
    <main id="main-content" tabIndex={-1}>
      <PlanDependenciesPanel />
    </main>,
    { route: `/roadmap${query}`, queryClient },
  );
}

const readCalls = () => mockFetch.mock.calls.map(([url]) => String(url)).filter((url) => url.startsWith("/api/v1/views/dependencies"));

describe("PlanDependenciesPanel: the row dialogs", () => {
  beforeEach(() => {
    write = () => new Response(null, { status: 204 });
    answer = () => jsonResponse(200, dependencyListView([]));
    mockFetch = vi.fn((url: string) => {
      if (url.startsWith("/api/v1/dependencies/")) return Promise.resolve(write());
      if (url === "/api/v1/views/dependencies") return Promise.resolve(answer());
      if (url === "/api/v1/views/plan") return Promise.resolve(jsonResponse(200, PLAN));
      if (url.startsWith("/api/v1/teams?")) return Promise.resolve(jsonResponse(200, TEAMS));
      return Promise.resolve(jsonResponse(404, { title: "x", status: 404 }));
    });
    vi.stubGlobal("fetch", mockFetch);
    localStorage.setItem("astrolabe.auth.token", "fake-token");
  });
  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    localStorage.clear();
    forgetRevalidated();
    await i18n.changeLanguage("en");
  });

  const NAME = "Design review · Checkout → Build · Billing";
  const MAY_BOTH = dependencyRow({ id: 77, can: { edit: true, delete: true } });
  const writes = () =>
    mockFetch.mock.calls
      .filter(([url]) => String(url).startsWith("/api/v1/dependencies/"))
      .map(([url, init]) => ({ method: (init as RequestInit).method, url: String(url), body: (init as RequestInit).body === undefined ? undefined : JSON.parse(String((init as RequestInit).body)) }));
  const kebab = (name = NAME) => screen.getByRole("button", { name: `Operations for ${name}` });

  async function openMenu(user: ReturnType<typeof userEvent.setup>, name = NAME) {
    await user.click(await screen.findByRole("button", { name: `Operations for ${name}` }));
  }

  test("a row that may do both has a menu named by both ends with their projects, holding Edit… and Delete; the column is named", async () => {
    const user = userEvent.setup();
    answer = () => jsonResponse(200, dependencyListView([MAY_BOTH]));
    renderPage();
    await openMenu(user);
    expect(screen.getByRole("menuitem", { name: `Edit ${NAME}` })).toHaveTextContent("Edit…");
    expect(screen.getByRole("menuitem", { name: `Delete ${NAME}` })).toHaveTextContent("Delete");
    expect(within(screen.getByRole("table", { name: TABLE })).getByRole("columnheader", { name: "Operations" })).toBeInTheDocument();
  });

  test("Edit… opens the project page's dialog with both ends and their projects, saves the type and lag, closes, re-reads the list and puts the focus back on the row's menu button", async () => {
    const user = userEvent.setup();
    answer = () => jsonResponse(200, dependencyListView([MAY_BOTH]));
    renderPage();
    await openMenu(user);
    await user.click(screen.getByRole("menuitem", { name: `Edit ${NAME}` }));
    const dialog = await screen.findByRole("dialog", { name: "Edit dependency" });
    expect(within(dialog).getByRole("textbox", { name: "Predecessor" })).toHaveValue("Design review · Checkout");
    expect(within(dialog).getByRole("textbox", { name: "Successor" })).toHaveValue("Build · Billing");
    await user.click(within(dialog).getByRole("combobox", { name: "Type" }));
    await user.click(await screen.findByRole("option", { name: "Start → Start (SS)" }));
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit dependency" })).toBeNull());
    expect(writes()).toEqual([{ method: "PUT", url: "/api/v1/dependencies/77", body: { type: "SS", lagDays: 0 } }]);
    await waitFor(() => expect(readCalls()).toHaveLength(2));
    await waitFor(() => expect(kebab()).toHaveFocus());
  });

  test("a save refreshes the plan and roadmap groups, whatever the filters", async () => {
    const user = userEvent.setup();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(["roadmap", "view"], {});
    queryClient.setQueryData(["plan", "elsewhere"], {});
    answer = () => jsonResponse(200, dependencyListView([MAY_BOTH]));
    renderPage("?dependencies=ok&dependencyProjectId=3", queryClient);
    await openMenu(user);
    await user.click(screen.getByRole("menuitem", { name: `Edit ${NAME}` }));
    await user.click(within(await screen.findByRole("dialog", { name: "Edit dependency" })).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(readCalls()).toHaveLength(2));
    expect(queryClient.getQueryState(["roadmap", "view"])?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(["plan", "elsewhere"])?.isInvalidated).toBe(true);
  });

  test("a cycle 409 shows its path in the dialog and nothing is re-read; a 403 shows the dialog's own sentence", async () => {
    const user = userEvent.setup();
    answer = () => jsonResponse(200, dependencyListView([MAY_BOTH]));
    renderPage();
    await openMenu(user);
    await user.click(screen.getByRole("menuitem", { name: `Edit ${NAME}` }));
    const dialog = await screen.findByRole("dialog", { name: "Edit dependency" });
    write = () =>
      jsonResponse(409, {
        type: "urn:astrolabe:problem:dependency-cycle",
        title: "Conflict",
        status: 409,
        detail: "server words",
        cycle: [
          { kind: "MILESTONE", id: 12, name: "Design review" },
          { kind: "MILESTONE", id: 13, name: "Build" },
          { kind: "MILESTONE", id: 12, name: "Design review" },
        ],
      });
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("With this type the link would close a cycle through:");
    expect(alert).toHaveTextContent("Design review → Build → Design review");
    write = () => jsonResponse(403, { title: "Forbidden", status: 403 });
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(within(dialog).getByRole("alert")).toHaveTextContent("Only the owners of the successor's project"));
    expect(readCalls()).toHaveLength(1);
    expect(dialog).toBeInTheDocument();
  });

  test("Delete confirms in the project page's wording, sends DELETE, re-reads the list and puts the focus on the panel's heading", async () => {
    const user = userEvent.setup();
    answer = () => jsonResponse(200, dependencyListView([MAY_BOTH]));
    renderPage();
    await openMenu(user);
    await user.click(screen.getByRole("menuitem", { name: `Delete ${NAME}` }));
    const dialog = await screen.findByRole("dialog", { name: "Delete dependency?" });
    expect(dialog).toHaveTextContent("The dependency Design review · Checkout → Build · Billing (FS) will be deleted. Nothing moves.");
    answer = () => jsonResponse(200, dependencyListView([]));
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Delete dependency?" })).toBeNull());
    expect(writes()).toEqual([{ method: "DELETE", url: "/api/v1/dependencies/77", body: undefined }]);
    expect(await screen.findByText("The plan has no dependencies yet")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("heading", { level: 3, name: "Dependencies" })).toHaveFocus());
  });

  test("a delete right after an edit of the same row still ends with the focus on the panel's heading (1.23: the editor's watch does not take it back)", async () => {
    // Fake clock (real time still flows for waitFor): Mantine's 10 ms focus return is advanced by hand while the DELETE is held at a gate.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    answer = () => jsonResponse(200, dependencyListView([MAY_BOTH]));
    renderPage();
    await openMenu(user);
    await user.click(screen.getByRole("menuitem", { name: `Edit ${NAME}` }));
    await user.click(within(await screen.findByRole("dialog", { name: "Edit dependency" })).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit dependency" })).toBeNull());
    await waitFor(() => expect(readCalls()).toHaveLength(2));
    await waitFor(() => expect(kebab()).toHaveFocus());
    // A DELETE is held at a gate across Mantine's return-focus timer (`useFocusReturn`, 10 ms after the row menu closes), which may put the
    // focus on the kebab if the body holds it then; a synchronous mock lets the confirm click land inside that window, which no person can.
    const served = mockFetch.getMockImplementation() as (url: string, init?: RequestInit) => Promise<Response>;
    const deleteGate = deferred();
    mockFetch.mockImplementation((url: string, init?: RequestInit) =>
      init?.method === "DELETE" ? deleteGate.promise.then(() => served(url, init)) : served(url, init),
    );
    await openMenu(user);
    await user.click(screen.getByRole("menuitem", { name: `Delete ${NAME}` }));
    const dialog = await screen.findByRole("dialog", { name: "Delete dependency?" });
    answer = () => jsonResponse(200, dependencyListView([]));
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await act(() => vi.advanceTimersByTimeAsync(30));
    deleteGate.resolve();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Delete dependency?" })).toBeNull());
    expect(await screen.findByText("The plan has no dependencies yet")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("heading", { level: 3, name: "Dependencies" })).toHaveFocus());
    await act(() => vi.advanceTimersByTimeAsync(60));
    expect(screen.getByRole("heading", { level: 3, name: "Dependencies" })).toHaveFocus();
  });

  test("a failed delete keeps the dialog with its error and re-reads nothing", async () => {
    const user = userEvent.setup();
    answer = () => jsonResponse(200, dependencyListView([MAY_BOTH]));
    renderPage();
    await openMenu(user);
    await user.click(screen.getByRole("menuitem", { name: `Delete ${NAME}` }));
    const dialog = await screen.findByRole("dialog", { name: "Delete dependency?" });
    write = () => jsonResponse(403, { title: "Forbidden", status: 403 });
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(await within(dialog).findByText("Only the owners of the successor's project, or an administrator, can change its dependencies")).toBeInTheDocument();
    expect(within(dialog).getByText("Could not delete")).toBeInTheDocument();
    expect(readCalls()).toHaveLength(1);
  });

  test("speaks Polish: the row menu's name and items", async () => {
    await i18n.changeLanguage("pl");
    const user = userEvent.setup();
    answer = () => jsonResponse(200, dependencyListView([dependencyRow({ id: 77, can: { edit: true, delete: true } })]));
    renderPage();
    const pl = "Design review · Checkout → Build · Billing";
    await user.click(await screen.findByRole("button", { name: `Operacje dla ${pl}` }));
    expect(screen.getByRole("menuitem", { name: `Edytuj ${pl}` })).toHaveTextContent("Edytuj…");
    expect(screen.getByRole("menuitem", { name: `Usuń ${pl}` })).toHaveTextContent("Usuń");
  });
});
