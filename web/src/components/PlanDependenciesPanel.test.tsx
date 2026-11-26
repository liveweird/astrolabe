import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { QueryClient } from "@tanstack/react-query";
import { useLocation } from "react-router-dom";
import { forgetRevalidated } from "../api/revalidate";
import i18n from "../i18n";
import { dependencyListView, dependencyRow, violatedRow, unscheduledRow } from "../test/dependencyList";
import { routeFetch } from "../test/http";
import { planOf } from "../test/planView";
import { act, renderWithProviders, screen, waitFor, within } from "../test/render";
import PlanDependenciesPanel from "./PlanDependenciesPanel";

// 1.29: the plan-wide dependency list under the Roadmap's and the Programs page's timeline - hidden until asked for, remembered, opened by the address,
// read only while open. The list's own behaviour (rows, cells, writes) is `.list`, `.add`, `.dialogs` and `.write` beside it; this file is the panel's shell.

const KEY = "astrolabe.viewSettings.roadmap.dependenciesOpen";
const TABLE = "Dependencies of the plan";
const PLAN = planOf([{ id: 700, name: "Platform", programs: [{ id: 70, name: "Billing", projects: [{ id: 3, name: "Checkout" }] }] }]);
const TEAMS = { items: [{ id: 4, name: "Backend" }], page: 1, pageSize: 100, total: 1 };
const ROWS = [violatedRow({ id: 1 }, 3), dependencyRow({ id: 2 }), unscheduledRow({ id: 3 })];

let mockFetch: ReturnType<typeof routeFetch>;
const reads = () => mockFetch.mock.calls.map(([url]) => String(url)).filter((url) => url.startsWith("/api/v1/views/dependencies"));

function Where() {
  const location = useLocation();
  return <p data-testid="search">{location.search}</p>;
}

function render(route = "/roadmap", queryClient?: QueryClient) {
  return renderWithProviders(
    <main id="main-content" tabIndex={-1}>
      <PlanDependenciesPanel />
      <Where />
    </main>,
    { route, queryClient },
  );
}

const toggle = () => screen.getByRole("button", { name: /dependency list$/ });
const body = () => within(screen.getByRole("table", { name: TABLE })).getAllByRole("row").slice(1);

describe("PlanDependenciesPanel", () => {
  beforeEach(() => {
    mockFetch = routeFetch({
      "GET /api/v1/views/dependencies": () => dependencyListView(ROWS),
      "GET /api/v1/views/plan": PLAN,
      "GET /api/v1/teams": TEAMS,
    });
    vi.stubGlobal("fetch", mockFetch);
    localStorage.setItem("astrolabe.auth.token", "fake-token");
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    forgetRevalidated();
    await i18n.changeLanguage("en");
  });

  test("hidden by default: an h3, a collapsed toggle, no table, no Add button - and nothing is read", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render("/roadmap", queryClient);
    expect(screen.getByRole("heading", { level: 3, name: "Dependencies" })).toBeInTheDocument();
    // Nothing of it prints while hidden, the lone heading included.
    expect(screen.getByRole("heading", { level: 3, name: "Dependencies" })).toHaveAttribute("data-print", "hide");
    expect(toggle()).toHaveAccessibleName("Show the dependency list");
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("table", { name: TABLE })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add dependency" })).toBeNull();
    // A disabled query is idle (no fetch in flight and none made), which settling the mount's effects makes visible.
    await act(async () => {});
    expect(queryClient.isFetching()).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("showing it reads the list once, shows the rows violated first with the facts, remembers the choice and keeps the focus on the toggle", async () => {
    const user = userEvent.setup();
    render();
    await user.click(toggle());
    await screen.findByRole("table", { name: TABLE });
    expect(body().map((row) => within(row).getAllByRole("cell")[0].textContent)).toEqual(["Violated · 3 working days short", "OK", "Not scheduled yet"]);
    expect(screen.getByRole("group", { name: "Dependencies in figures" })).toHaveTextContent("3 dependencies");
    // The panel is a region named by its heading, so its "Filters" toggle is told apart from the page's own.
    expect(screen.getByRole("heading", { level: 3, name: "Dependencies" })).not.toHaveAttribute("data-print");
    const region = screen.getByRole("region", { name: "Dependencies" });
    expect(within(region).getByRole("button", { name: "Filters" })).toBeInTheDocument();
    expect(within(region).getByRole("table", { name: TABLE })).toBeInTheDocument();
    expect(reads()).toEqual(["/api/v1/views/dependencies"]);
    expect(toggle()).toHaveAccessibleName("Hide the dependency list");
    expect(toggle()).toHaveFocus();
    expect(localStorage.getItem(KEY)).toBe("true");
    // The click wrote nothing to the address.
    expect(screen.getByTestId("search")).toBeEmptyDOMElement();
    await user.click(toggle());
    expect(screen.queryByRole("table", { name: TABLE })).toBeNull();
    expect(localStorage.getItem(KEY)).toBe("false");
  });

  test("a panel remembered as shown opens on a bare address", async () => {
    localStorage.setItem(KEY, "true");
    render();
    expect(await screen.findByRole("table", { name: TABLE })).toBeInTheDocument();
    expect(screen.getByTestId("search")).toBeEmptyDOMElement();
  });

  test("the address opens a hidden panel with its filters, moves the focus to the heading, never writes the memory or the address", async () => {
    render("/roadmap?programId=4&dependencies=violated&dependencyProjectId=3");
    await screen.findByRole("table", { name: TABLE });
    expect(body()).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 3, name: "Dependencies" })).toHaveFocus();
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(screen.getByTestId("search")).toHaveTextContent("?programId=4&dependencies=violated&dependencyProjectId=3");
  });

  test("the Roadmap's own teamId and status are not the panel's filters", async () => {
    render("/roadmap?teamId=4&status=violated&dependencies=all");
    await screen.findByRole("table", { name: TABLE });
    expect(body()).toHaveLength(3);
  });

  test("a filter change writes the panel's names by replace and keeps the foreign parameters; Clear takes the filters away", async () => {
    const user = userEvent.setup();
    render("/roadmap?programId=4&dependencies=all");
    await screen.findByRole("table", { name: TABLE });
    await user.click(screen.getByRole("button", { name: "Filters" }));
    await user.click(screen.getByRole("combobox", { name: "Status" }));
    await user.click(await screen.findByRole("option", { name: "Violated" }));
    expect(screen.getByTestId("search")).toHaveTextContent("?programId=4&dependencies=violated");
    expect(body()).toHaveLength(1);
    await user.click(screen.getByRole("combobox", { name: "Team" }));
    await user.click(await screen.findByRole("option", { name: "Backend" }));
    expect(screen.getByTestId("search")).toHaveTextContent("?programId=4&dependencies=violated&dependencyTeamId=4");
    await user.click(screen.getByRole("combobox", { name: "Status" }));
    await user.click(await screen.findByRole("option", { name: "All" }));
    expect(screen.getByTestId("search")).toHaveTextContent("?programId=4&dependencies=all&dependencyTeamId=4");
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  test("hiding a panel the address opened takes the word away (the filters stay) and the panel stays closed after a re-render", async () => {
    const user = userEvent.setup();
    render("/roadmap?programId=4&dependencies=violated&dependencyTeamId=4");
    await screen.findByRole("table", { name: TABLE });
    await user.click(toggle());
    expect(screen.queryByRole("table", { name: TABLE })).toBeNull();
    expect(screen.getByTestId("search")).toHaveTextContent("?programId=4&dependencyTeamId=4");
    expect(toggle()).toHaveAccessibleName("Show the dependency list");
  });

  test("Add dependency is the header's button while the panel is shown and the plan lets the caller add, and it opens the dialog", async () => {
    const user = userEvent.setup();
    const addable = planOf([{ id: 700, name: "Platform", programs: [{ id: 70, name: "Billing", projects: [{ id: 3, name: "Checkout", can: { createDependency: true } }] }] }]);
    mockFetch = routeFetch({
      "GET /api/v1/views/dependencies": () => dependencyListView(ROWS),
      "GET /api/v1/views/plan": addable,
      "GET /api/v1/teams": TEAMS,
      "GET /api/v1/milestones": { items: [], page: 1, pageSize: 20, total: 0 },
      "GET /api/v1/projects": { items: [], page: 1, pageSize: 20, total: 0 },
    });
    vi.stubGlobal("fetch", mockFetch);
    render();
    expect(screen.queryByRole("button", { name: "Add dependency" })).toBeNull();
    await user.click(toggle());
    await user.click(await screen.findByRole("button", { name: "Add dependency" }));
    expect(await screen.findByRole("dialog", { name: "Add dependency" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Successor's project" })).toBeInTheDocument());
  });

  test("a failed read says so inside the panel and a hidden panel never shows it", async () => {
    mockFetch = routeFetch({
      "GET /api/v1/views/dependencies": () => new Response(JSON.stringify({ title: "x", status: 500 }), { status: 500, headers: { "Content-Type": "application/problem+json" } }),
      "GET /api/v1/views/plan": PLAN,
      "GET /api/v1/teams": TEAMS,
    });
    vi.stubGlobal("fetch", mockFetch);
    render("/roadmap?dependencies=all");
    expect(await screen.findByText("Could not read the dependencies")).toBeInTheDocument();
    expect(screen.queryByText("The plan has no dependencies yet")).toBeNull();
  });
});
