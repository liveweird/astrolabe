import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { QueryClient } from "@tanstack/react-query";
import { useLocation, useNavigationType } from "react-router-dom";
import { forgetRevalidated } from "../api/revalidate";
import i18n from "../i18n";
import { renderWithProviders, screen, waitFor, within } from "../test/render";
import { headingOutline } from "../test/headings";
import { jsonResponse } from "../test/http";
import { planOf } from "../test/planView";
import { dependencyListView, dependencyRow, milestoneEnd, projectEnd, unscheduledRow, violatedRow } from "../test/dependencyList";
import PlanDependenciesPanel from "./PlanDependenciesPanel";

// The plan-wide dependency list as the Roadmap's and the Programs page's panel hosts it (1.29; these were the Dependencies page's tests): the cells, the ends, the facts,
// the filters in the address under the panel's names, the empty, cut and failed states. The panel's shell (hidden, remembered, opened by the address) is
// `PlanDependenciesPanel.test.tsx`; the dialogs and the row menu are `.add` and `.write` here.

const PLAN = planOf([{ id: 700, name: "Platform", programs: [{ id: 70, name: "Billing", projects: [{ id: 3, name: "Checkout" }, { id: 6, name: "Billing" }] }] }]);
const TEAMS = { items: [{ id: 4, name: "Backend" }, { id: 7, name: "Frontend" }], page: 1, pageSize: 100, total: 2 };

// Three milestone links of different status and one whole-project successor, in the server's order (violated first).
const VIOLATED = violatedRow({ id: 1 }, 3);
const HELD = dependencyRow({ id: 2, lagDays: -1 });
const OPEN = unscheduledRow({
  id: 3,
  predecessor: milestoneEnd({ id: 20, name: "Scoping", projectId: 8, projectName: "Search", teamId: 9, teamName: "Data" }),
  successor: projectEnd({ id: 8, name: "Search", projectId: 8, projectName: "Search" }),
  type: "SS",
  lagDays: 2,
});
const ALL = [VIOLATED, HELD, OPEN];

let answer: () => Response | Promise<Response>;
let mockFetch: ReturnType<typeof vi.fn>;

function Where() {
  const location = useLocation();
  const type = useNavigationType();
  return (
    <>
      <p data-testid="where">{location.pathname + location.search}</p>
      <p data-testid="nav">{type}</p>
    </>
  );
}

/** The panel on the Roadmap's address; `query` is the panel's own (`?dependencies=…`), open by default. */
function renderPage(query = "?dependencies=all", queryClient?: QueryClient) {
  return renderWithProviders(
    <main id="main-content" tabIndex={-1}>
      <PlanDependenciesPanel />
      <Where />
    </main>,
    { route: `/roadmap${query}`, queryClient },
  );
}

const TABLE = "Dependencies of the plan";
const readCalls = () => mockFetch.mock.calls.map(([url]) => String(url)).filter((url) => url.startsWith("/api/v1/views/dependencies"));
/** The rows' predecessor/successor cells, as "pred → succ" by the first line of each end cell. */
const rowIds = () =>
  within(screen.getByRole("table", { name: TABLE }))
    .getAllByRole("row")
    .slice(1)
    .map((row) => within(row).getAllByRole("cell")[0].textContent ?? "");

describe("PlanDependenciesPanel: the list", () => {
  beforeEach(() => {
    answer = () => jsonResponse(200, dependencyListView(ALL));
    mockFetch = vi.fn((url: string) => {
      if (url === "/api/v1/views/dependencies") return Promise.resolve(answer());
      if (url === "/api/v1/views/plan") return Promise.resolve(jsonResponse(200, PLAN));
      if (url.startsWith("/api/v1/teams?")) return Promise.resolve(jsonResponse(200, TEAMS));
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

  test("lists every dependency in a named table under the panel's one h3, in the server's order, with one read and no parameter", async () => {
    renderPage();
    const table = await screen.findByRole("table", { name: TABLE });
    expect(headingOutline()).toEqual([[3, "Dependencies"]]);
    expect(rowIds()).toEqual(["Violated · 3 working days short", "OK", "Not scheduled yet"]);
    expect(within(table).getAllByRole("columnheader").map((header) => header.textContent)).toEqual(["Status", "Predecessor", "Type", "Lag", "Successor", "Dates"]);
    expect(readCalls()).toEqual(["/api/v1/views/dependencies"]);
    expect(screen.getByRole("region", { name: TABLE })).toBeInTheDocument();
  });

  test("each cell: the worded status, the type, the lag (a lead worded), the dates and the ends", async () => {
    renderPage();
    const table = await screen.findByRole("table", { name: TABLE });
    const [violated, held, open] = within(table).getAllByRole("row").slice(1);
    expect(within(violated).getByText("Finish → Start (FS)")).toBeInTheDocument();
    expect(within(violated).getByText("0 working days")).toBeInTheDocument();
    expect(within(violated).getByText("needs 2027-06-14 · is 2027-06-09")).toBeInTheDocument();
    expect(within(violated).getByText("Design review")).toBeInTheDocument();
    expect(within(violated).getByText("Build")).toBeInTheDocument();
    expect(within(held).getByText("-1 working day (lead)")).toBeInTheDocument();
    expect(within(open).getByText("Start → Start (SS)")).toBeInTheDocument();
    expect(within(open).getByText("2 working days")).toBeInTheDocument();
    expect(within(open).getByText("–")).toBeInTheDocument();
    // A whole-project end is worded "Project X"; a milestone end is its own name.
    expect(within(open).getByText("Project Search")).toBeInTheDocument();
    expect(within(open).getByText("Scoping")).toBeInTheDocument();
  });

  test("an end names its project and, for a milestone, its team, as links named by their destination", async () => {
    renderPage();
    const table = await screen.findByRole("table", { name: TABLE });
    const [violated, , open] = within(table).getAllByRole("row").slice(1);
    expect(within(violated).getAllByRole("link", { name: "Open project Checkout" })[0]).toHaveAttribute("href", "/projects/3");
    expect(within(violated).getByRole("link", { name: "Open project Billing" })).toHaveAttribute("href", "/projects/6");
    expect(within(violated).getByRole("link", { name: "Open team Backend" })).toHaveAttribute("href", "/teams/4");
    expect(within(violated).getByRole("link", { name: "Open team Frontend" })).toHaveAttribute("href", "/teams/7");
    // The predecessor milestone links itself (its project's page with the row marked), its project and its team; the whole-project successor has a project link and no team link.
    expect(within(open).getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual(["/projects/8?milestone=20", "/projects/8", "/teams/9", "/projects/8"]);
    expect(within(open).getByRole("link", { name: "Open milestone Scoping" })).toHaveAttribute("href", "/projects/8?milestone=20");
    // A link's accessible name contains its visible text.
    for (const link of within(table).getAllByRole("link")) {
      expect(link.getAttribute("aria-label") ?? "").toContain(link.textContent ?? "");
    }
  });

  test("the list offers nothing that changes a link when no row may be changed", async () => {
    renderPage();
    const table = await screen.findByRole("table", { name: TABLE });
    expect(within(table).queryByRole("button")).toBeNull();
    expect(screen.queryByRole("columnheader", { name: /operations/i })).toBeNull();
  });

  test("the facts line shows the server's totals, a zero badge absent", async () => {
    answer = () => jsonResponse(200, dependencyListView(ALL, { totals: { links: 349, violated: 9, unscheduled: 0 } }));
    renderPage();
    const facts = await screen.findByRole("group", { name: "Dependencies in figures" });
    expect(within(facts).getByText("349 dependencies")).toBeInTheDocument();
    expect(within(facts).getByText("9 violated dependencies")).toBeInTheDocument();
    expect(within(facts).queryByText(/not scheduled yet/)).toBeNull();
  });

  test("the unscheduled badge is shown when positive, in words", async () => {
    renderPage();
    const facts = await screen.findByRole("group", { name: "Dependencies in figures" });
    expect(within(facts).getByText("3 dependencies")).toBeInTheDocument();
    expect(within(facts).getByText("1 violated dependency")).toBeInTheDocument();
    expect(within(facts).getByText("1 not scheduled yet")).toBeInTheDocument();
  });

  test("the facts line keeps the totals when a filter hides every row", async () => {
    renderPage("?dependencies=violated&dependencyTeamId=9");
    const facts = await screen.findByRole("group", { name: "Dependencies in figures" });
    expect(within(facts).getByText("3 dependencies")).toBeInTheDocument();
    expect(await screen.findByText("No dependency matches the filters")).toBeInTheDocument();
  });

  test.each([
    ["?dependencies=violated", [1]],
    ["?dependencies=ok", [2]],
    ["?dependencies=unscheduled", [3]],
    ["?dependencies=all&dependencyTeamId=4", [1, 2]],
    ["?dependencies=all&dependencyTeamId=9", [3]],
    ["?dependencies=all&dependencyProjectId=8", [3]],
    ["?dependencies=all&dependencyProjectId=3", [1, 2]],
    ["?dependencies=violated&dependencyTeamId=4&dependencyProjectId=3", [1]],
    ["?dependencies=ok&dependencyTeamId=9", []],
    ["?dependencies=all&dependencyTeamId=abc", [1, 2, 3]],
  ])("%s lists exactly the matching rows", async (query, ids) => {
    renderPage(query);
    await screen.findByRole("group", { name: "Dependencies in figures" });
    if (ids.length === 0) {
      expect(await screen.findByText("No dependency matches the filters")).toBeInTheDocument();
      expect(screen.queryByRole("table", { name: TABLE })).toBeNull();
      return;
    }
    const wanted = ids.map((id) => ALL.findIndex((row) => row.id === id));
    const expected = wanted.map((index) => (index === 0 ? "Violated · 3 working days short" : index === 1 ? "OK" : "Not scheduled yet"));
    await waitFor(() => expect(rowIds()).toEqual(expected));
    expect(readCalls()).toHaveLength(1);
  });

  test("each select rewrites the URL by replace and filters in the browser, with no second read", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("table", { name: TABLE });
    await user.click(screen.getByRole("button", { name: "Filters" }));
    await user.click(screen.getByRole("combobox", { name: "Status" }));
    await user.click(await screen.findByRole("option", { name: "Violated" }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/roadmap?dependencies=violated"));
    expect(screen.getByTestId("nav")).toHaveTextContent("REPLACE");
    expect(rowIds()).toEqual(["Violated · 3 working days short"]);
    await user.click(screen.getByRole("combobox", { name: "Team" }));
    await user.click(await screen.findByRole("option", { name: "Backend" }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/roadmap?dependencies=violated&dependencyTeamId=4"));
    await user.click(screen.getByRole("combobox", { name: "Status" }));
    await user.click(await screen.findByRole("option", { name: "All" }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(/^\/roadmap\?dependencies=all&dependencyTeamId=4$/));
    expect(rowIds()).toHaveLength(2);
    expect(readCalls()).toHaveLength(1);
  });

  test("a projectId from a link is a chip named from the plan view; removing it drops the parameter", async () => {
    const user = userEvent.setup();
    renderPage("?dependencies=violated&dependencyProjectId=3");
    expect(await screen.findByText("Project: Checkout")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove the project filter" }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(/^\/roadmap\?dependencies=violated$/));
    expect(screen.queryByText("Project: Checkout")).not.toBeInTheDocument();
  });

  test("the Project select narrows the rows in the browser, writes the address and reads nothing more", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("table", { name: TABLE });
    await user.click(screen.getByRole("button", { name: "Filters" }));
    await user.click(screen.getByRole("combobox", { name: "Project" }));
    await user.click(await screen.findByRole("option", { name: "Checkout" }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/roadmap?dependencies=all&dependencyProjectId=3"));
    expect(screen.getByTestId("nav")).toHaveTextContent("REPLACE");
    expect(rowIds()).toEqual(["Violated · 3 working days short", "OK"]);
    expect(await screen.findByText("Project: Checkout")).toBeInTheDocument();
    expect(readCalls()).toHaveLength(1);
  });

  test("a teamId no team holds is shown as Team N once the list has answered", async () => {
    const user = userEvent.setup();
    renderPage("?dependencies=all&dependencyTeamId=99");
    await user.click(await screen.findByRole("button", { name: /^Filters/ }));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Team" })).toHaveValue("Team 99"));
  });

  test("a project the plan view does not know is named by its number", async () => {
    renderPage("?dependencies=all&dependencyProjectId=99");
    expect(await screen.findByText("Project: Project 99")).toBeInTheDocument();
  });

  test("a plan without dependencies says so, with no filter claim and no facts line", async () => {
    answer = () => jsonResponse(200, dependencyListView([]));
    renderPage();
    expect(await screen.findByText("The plan has no dependencies yet")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByText("No dependency matches the filters")).toBeNull();
    expect(screen.queryByRole("group", { name: "Dependencies in figures" })).toBeNull();
  });

  test("a filter nothing matches says so and Clear the filters empties the URL", async () => {
    const user = userEvent.setup();
    renderPage("?dependencies=ok&dependencyTeamId=9");
    expect(await screen.findByText("No dependency matches the filters")).toBeInTheDocument();
    expect(screen.queryByText("The plan has no dependencies yet")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Clear the filters" }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(/^\/roadmap\?dependencies=all$/));
    expect(await screen.findByRole("table", { name: TABLE })).toBeInTheDocument();
  });

  test("while the read runs there is no claim at all", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    answer = () => gate.then(() => jsonResponse(200, dependencyListView(ALL)));
    renderPage("?dependencies=violated");
    expect(screen.queryByText("The plan has no dependencies yet")).toBeNull();
    expect(screen.queryByText("No dependency matches the filters")).toBeNull();
    expect(screen.queryByRole("group", { name: "Dependencies in figures" })).toBeNull();
    release();
    expect(await screen.findByRole("table", { name: TABLE })).toBeInTheDocument();
  });

  test("a cut list says so with the rows shown and keeps the server's totals", async () => {
    answer = () => jsonResponse(200, dependencyListView(ALL, { truncated: true, totals: { links: 1400, violated: 40, unscheduled: 5 } }));
    renderPage();
    expect(await screen.findByText("The list shows its first 3 dependencies.")).toBeInTheDocument();
    expect(rowIds()).toHaveLength(3);
    expect(screen.getByText("1400 dependencies")).toBeInTheDocument();
  });

  test("a cut list whose shown rows all miss the filters speaks of the rows read only, and keeps the way out", async () => {
    answer = () => jsonResponse(200, dependencyListView(ALL, { truncated: true, totals: { links: 1400, violated: 40, unscheduled: 5 } }));
    renderPage("?dependencies=ok&dependencyTeamId=9");
    expect(await screen.findByText("None of the first 3 dependencies matches the filters")).toBeInTheDocument();
    expect(screen.queryByText("No dependency matches the filters")).toBeNull();
    expect(screen.queryByText("The plan has no dependencies yet")).toBeNull();
    expect(screen.getByRole("button", { name: "Clear the filters" })).toBeInTheDocument();
  });

  test("a complete list says nothing about a cut", async () => {
    renderPage();
    await screen.findByRole("table", { name: TABLE });
    expect(screen.queryByText(/The list shows its first/)).toBeNull();
  });

  test("a failed first read is the inline alert, with no empty-state claim", async () => {
    answer = () => jsonResponse(500, { title: "x", status: 500 });
    renderPage();
    expect(await screen.findByText("Could not read the dependencies")).toBeInTheDocument();
    expect(screen.queryByText("The plan has no dependencies yet")).toBeNull();
    expect(screen.queryByText("No dependency matches the filters")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
  });

  test("a failed re-read withdraws the \"nothing matches\" claim", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderPage("?dependencies=ok&dependencyTeamId=9", queryClient);
    expect(await screen.findByText("No dependency matches the filters")).toBeInTheDocument();
    answer = () => jsonResponse(500, { title: "x", status: 500 });
    await queryClient.invalidateQueries({ queryKey: ["plan", "dependencies"] });
    expect(await screen.findByText("Could not read the dependencies")).toBeInTheDocument();
    expect(screen.queryByText("No dependency matches the filters")).toBeNull();
    expect(screen.queryByText("The plan has no dependencies yet")).toBeNull();
  });

  test("the rows of a kept document stay on screen over a failed re-read", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderPage("?dependencies=all", queryClient);
    await screen.findByRole("table", { name: TABLE });
    answer = () => jsonResponse(500, { title: "x", status: 500 });
    await queryClient.invalidateQueries({ queryKey: ["plan", "dependencies"] });
    expect(await screen.findByText("Could not read the dependencies")).toBeInTheDocument();
    expect(rowIds()).toHaveLength(3);
  });

  test("a document naming an end its lists do not hold is a failed read: the alert, no row, no empty claim", async () => {
    answer = () => jsonResponse(200, { ...dependencyListView(ALL), milestones: [] });
    renderPage();
    expect(await screen.findByText("Could not read the dependencies")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByText("The plan has no dependencies yet")).toBeNull();
    expect(screen.queryByText("No dependency matches the filters")).toBeNull();
  });

  test("an unresolvable re-read keeps the rows of the earlier answer under the alert", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderPage("?dependencies=all", queryClient);
    await screen.findByRole("table", { name: TABLE });
    answer = () => jsonResponse(200, { ...dependencyListView(ALL), teams: [] });
    await queryClient.invalidateQueries({ queryKey: ["plan", "dependencies"] });
    expect(await screen.findByText("Could not read the dependencies")).toBeInTheDocument();
    expect(screen.getByText("The server's answer could not be read. Reload the page, or try again later.")).toBeInTheDocument();
    expect(rowIds()).toHaveLength(3);
  });

  test("speaks Polish in the bundle's own words", async () => {
    await i18n.changeLanguage("pl");
    renderPage();
    const table = await screen.findByRole("table", { name: "Zależności planu" });
    expect(headingOutline()).toEqual([[3, "Zależności"]]);
    expect(within(table).getAllByRole("columnheader").map((header) => header.textContent)).toEqual(["Stan", "Poprzednik", "Typ", "Opóźnienie", "Następnik", "Terminy"]);
    expect(within(table).getByText("Niedotrzymane · brakuje 3 dni roboczych")).toBeInTheDocument();
    expect(within(table).getByText("Jeszcze niezaplanowane")).toBeInTheDocument();
    expect(within(table).getByText("Projekt Search")).toBeInTheDocument();
    const facts = screen.getByRole("group", { name: "Zależności w liczbach" });
    expect(within(facts).getByText("3 zależności")).toBeInTheDocument();
    expect(within(facts).getByText("1 naruszona zależność")).toBeInTheDocument();
    expect(within(facts).getByText("jeszcze niezaplanowanych: 1")).toBeInTheDocument();
  });
});
