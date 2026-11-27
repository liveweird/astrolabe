import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { QueryClient } from "@tanstack/react-query";
import { Route, Routes, useLocation, useNavigationType } from "react-router-dom";
import i18n from "../i18n";
import { renderWithProviders, screen, waitFor, within } from "../test/render";
import { headingOutline } from "../test/headings";
import { requestsAnswered } from "../test/requestsAnswered";
import { jsonResponse, notModified } from "../test/http";
import { DATABASE_TIMEOUT_PROBLEM, shouldRetryQuery } from "../api/http";
import { forgetRevalidated } from "../api/revalidate";
import { TEAM_LOAD_KEY } from "../api/teamLoad";
import { teamLoadRow, teamLoadView, teamLoadWeek } from "../test/teamLoad";
import TeamLoad from "./TeamLoad";

const BOTH = teamLoadRow({ id: 3, name: "Backend", managerName: "Alex Rivera", milestones: 12, unscheduledMilestones: 4, overloadedWeeks: 3, wipExceededWeeks: 1 });
const OVERLOADED = teamLoadRow({ id: 4, name: "Frontend", managerName: null, milestones: 8, unscheduledMilestones: 0, overloadedWeeks: 1 });
const WIP = teamLoadRow({ id: 5, name: "Data", managerName: "Sam Lee", milestones: 5, wipExceededWeeks: 2 });
const QUIET = teamLoadRow({ id: 6, name: "Mobile", managerName: "Kim Park", milestones: 2, unscheduledMilestones: 1, weeksWithoutCapacity: 6 });
const ALL = [BOTH, OVERLOADED, WIP, QUIET];

/** `GET /teams` as the colour read sees it: Backend INDIGO, Frontend TEAL, the rest in palette order. */
function teamsPage(rows: typeof ALL) {
  const colours = ["INDIGO", "TEAL", "LIME", "RASPBERRY"] as const;
  const items = rows.map((row, index) => ({ id: row.id, name: row.name, description: null, managerPersonId: null, managerName: row.managerName, colour: colours[index], createdAt: 1, updatedAt: 2 }));
  return { items, page: 1, pageSize: 100, total: items.length };
}

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

function renderPage(route = "/team-load", queryClient?: QueryClient) {
  return renderWithProviders(
    <Routes>
      <Route
        path="/team-load"
        element={
          <>
            <TeamLoad />
            <Where />
          </>
        }
      />
    </Routes>,
    { route, queryClient },
  );
}

/** The reads of the document itself: the page also reads the teams (their colours, `useTeamColours`), which these counts must not include. */
const loadReads = () => mockFetch.mock.calls.filter(([url]) => url === "/api/v1/views/team-load");

const teamNames = () =>
  within(screen.getByRole("table", { name: "Load of every team" }))
    .getAllByRole("link", { name: /^Open team / })
    .map((link) => link.textContent);

describe("Team load page", () => {
  beforeEach(() => {
    answer = () => jsonResponse(200, teamLoadView(ALL));
    mockFetch = vi.fn((url: string) => {
      if (url === "/api/v1/views/team-load") return Promise.resolve(answer());
      if (url.startsWith("/api/v1/teams?")) return Promise.resolve(jsonResponse(200, teamsPage(ALL)));
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

  test("lists every team without a parameter, in one read, under one h2", async () => {
    renderPage();
    const table = await screen.findByRole("table", { name: "Load of every team" });
    expect(headingOutline()).toEqual([[2, "Team load"]]);
    expect(teamNames()).toEqual(["Backend", "Frontend", "Data", "Mobile"]);
    expect(within(table).getByText("Alex Rivera")).toBeInTheDocument();
    // the manager's name leads to the person's page (1.31; the page is folded into Teams next, so this is the one link added here)
    expect(within(table).getByRole("link", { name: "Open person Alex Rivera" })).toHaveAttribute("href", "/people/9");
    expect(loadReads()).toHaveLength(1);
  });

  test("each team's name has its colour swatch before it, read from the teams list, never from the document", async () => {
    renderPage();
    const table = await screen.findByRole("table", { name: "Load of every team" });
    await waitFor(() => expect(table.querySelectorAll("[data-team-colour]")).toHaveLength(4));
    const swatches = [...table.querySelectorAll("[data-team-colour]")];
    expect(swatches.map((swatch) => swatch.getAttribute("data-team-colour"))).toEqual(["INDIGO", "TEAL", "LIME", "RASPBERRY"]);
    const link = within(table).getByRole("link", { name: "Open team Backend" });
    expect(swatches[0].nextElementSibling).toBe(link);
    expect(swatches[0]).toHaveAttribute("aria-hidden", "true");
  });

  test("the facts line shows the totals as they arrive, a zero badge absent", async () => {
    answer = () => jsonResponse(200, teamLoadView(ALL, { totals: { teams: 15, overloadedTeams: 2, wipExceededTeams: 0, unscheduledMilestones: 41 } }));
    renderPage();
    const facts = await screen.findByRole("group", { name: "Team load in figures" });
    expect(within(facts).getByText("15 teams")).toBeInTheDocument();
    expect(within(facts).getByText("41 not scheduled yet"), "the server's plan-wide total, never the rows' sum").toBeInTheDocument();
    expect(within(facts).getByText("2 teams with an overloaded week")).toBeInTheDocument();
    expect(within(facts).queryByText(/over the WIP limit/)).not.toBeInTheDocument();
  });

  test("the facts line keeps the totals when a filter hides the rows", async () => {
    renderPage("/team-load?warning=wip");
    const facts = await screen.findByRole("group", { name: "Team load in figures" });
    expect(within(facts).getByText("4 teams")).toBeInTheDocument();
    expect(within(facts).getByText("2 teams with an overloaded week")).toBeInTheDocument();
    expect(within(facts).getByText("2 teams over the WIP limit")).toBeInTheDocument();
    expect(teamNames()).toEqual(["Backend", "Data"]);
  });

  test.each([
    ["overloaded", ["Backend", "Frontend"]],
    ["wip", ["Backend", "Data"]],
    ["any", ["Backend", "Frontend", "Data"]],
  ])("?warning=%s lists exactly the matching rows", async (warning, names) => {
    renderPage(`/team-load?warning=${warning}`);
    await screen.findByRole("table", { name: "Load of every team" });
    expect(teamNames()).toEqual(names);
  });

  test("an unknown warning lists every team", async () => {
    renderPage("/team-load?warning=bogus");
    await screen.findByRole("table", { name: "Load of every team" });
    expect(teamNames()).toHaveLength(4);
  });

  test("the select rewrites the URL by replace and filters in the browser, with no second read", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("table", { name: "Load of every team" });
    await user.click(screen.getByRole("button", { name: "Filters" }));
    await user.click(screen.getByRole("combobox", { name: "Show" }));
    await user.click(await screen.findByRole("option", { name: "Over the WIP limit" }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/team-load?warning=wip"));
    expect(screen.getByTestId("nav")).toHaveTextContent("REPLACE");
    expect(teamNames()).toEqual(["Backend", "Data"]);
    await user.click(screen.getByRole("combobox", { name: "Show" }));
    await user.click(await screen.findByRole("option", { name: "Every team" }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(/^\/team-load$/));
    expect(teamNames()).toHaveLength(4);
    expect(loadReads()).toHaveLength(1);
  });

  test("a team's name links to its page", async () => {
    renderPage();
    await screen.findByRole("table", { name: "Load of every team" });
    expect(screen.getByRole("link", { name: "Open team Backend" })).toHaveAttribute("href", "/teams/3");
  });

  test("'Not scheduled' links to the team's page (its Unscheduled tray) only when positive, named by its row", async () => {
    renderPage();
    await screen.findByRole("table", { name: "Load of every team" });
    expect(screen.getByRole("link", { name: "4 not scheduled: team Backend" })).toHaveAttribute("href", "/teams/3");
    expect(screen.getByRole("link", { name: "1 not scheduled: team Mobile" })).toHaveAttribute("href", "/teams/6");
    const frontendRow = screen.getByRole("link", { name: "Open team Frontend" }).closest("tr")!;
    expect(within(frontendRow).getByText("0")).toBeInTheDocument();
    expect(within(frontendRow).queryByRole("link", { name: /not scheduled/ })).toBeNull();
  });

  test("the warning badges are worded and only shown when positive; weeks without capacity are a gray fact", async () => {
    renderPage();
    const table = await screen.findByRole("table", { name: "Load of every team" });
    const backend = screen.getByRole("link", { name: "Open team Backend" }).closest("tr")!;
    expect(within(backend).getByText("3 weeks overloaded")).toBeInTheDocument();
    expect(within(backend).getByText("1 week over WIP limit")).toBeInTheDocument();
    expect(within(backend).queryByText(/without capacity/)).toBeNull();
    const frontend = screen.getByRole("link", { name: "Open team Frontend" }).closest("tr")!;
    expect(within(frontend).getByText("1 week overloaded")).toBeInTheDocument();
    expect(within(frontend).queryByText(/WIP/)).toBeNull();
    expect(within(frontend).getByText("No manager")).toBeInTheDocument();
    const mobile = screen.getByRole("link", { name: "Open team Mobile" }).closest("tr")!;
    expect(within(mobile).getByText("6 weeks without capacity")).toBeInTheDocument();
    expect(within(mobile).queryByText(/overloaded|WIP/)).toBeNull();
    // Nothing is ever said to "fit": a quiet row carries no badge of any kind but the neutral fact.
    expect(within(table).queryByText(/fits/i)).toBeNull();
  });

  test("no team at all says so, with no filter claim", async () => {
    answer = () => jsonResponse(200, teamLoadView([]));
    renderPage();
    expect(await screen.findByText("There are no teams yet")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByText("No team has this warning")).toBeNull();
  });

  test("a filter nothing matches says so and 'Show every team' empties the URL", async () => {
    const user = userEvent.setup();
    answer = () => jsonResponse(200, teamLoadView([QUIET]));
    renderPage("/team-load?warning=overloaded");
    expect(await screen.findByText("No team has this warning")).toBeInTheDocument();
    expect(screen.queryByText("There are no teams yet")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Show every team" }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(/^\/team-load$/));
    expect(await screen.findByRole("table", { name: "Load of every team" })).toBeInTheDocument();
  });

  test("while the read runs there is no claim at all", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    answer = () => gate.then(() => jsonResponse(200, teamLoadView(ALL)));
    renderPage("/team-load?warning=wip");
    expect(screen.queryByText("There are no teams yet")).toBeNull();
    expect(screen.queryByText("No team has this warning")).toBeNull();
    expect(screen.queryByRole("group", { name: "Team load in figures" })).toBeNull();
    release();
    expect(await screen.findByRole("table", { name: "Load of every team" })).toBeInTheDocument();
  });

  test("a cut list says so, with the number of rows shown, while the totals stay the server's", async () => {
    answer = () => jsonResponse(200, teamLoadView(ALL, { truncated: true, totals: { teams: 230, overloadedTeams: 9, wipExceededTeams: 3, unscheduledMilestones: 77 } }));
    renderPage();
    expect(await screen.findByText("The list shows its first 4 teams.")).toBeInTheDocument();
    expect(screen.getByText("230 teams")).toBeInTheDocument();
    expect(screen.getByText("77 not scheduled yet")).toBeInTheDocument();
  });

  test("a complete list says nothing about a cut", async () => {
    renderPage();
    await screen.findByRole("table", { name: "Load of every team" });
    expect(screen.queryByText(/first \d+ teams/)).toBeNull();
  });

  test("a failed read is the inline alert, with no empty-state claim", async () => {
    answer = () => jsonResponse(500, { title: "x", status: 500 });
    renderPage();
    expect(await screen.findByText("Could not load the teams' load")).toBeInTheDocument();
    expect(screen.queryByText("There are no teams yet")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
  });

  test("a read the database did not finish makes ONE request and says the request timed out, with the production retry policy", async () => {
    answer = () => jsonResponse(500, { type: DATABASE_TIMEOUT_PROBLEM, title: "Internal Server Error", status: 500, detail: "The database did not answer in time. Try again shortly." });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: shouldRetryQuery, retryDelay: 0 } } });
    renderPage("/team-load", queryClient);
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("The request timed out. Try again.")).toBeInTheDocument();
    expect(within(alert).queryByText(/500/)).toBeNull();
    expect(screen.queryByText("There are no teams yet")).toBeNull();
    // Two more tries would have started by now with retryDelay 0 had the policy retried it.
    await requestsAnswered(queryClient);
    expect(loadReads()).toHaveLength(1);
  });

  test("an untyped 500 is still retried twice under the same policy", async () => {
    answer = () => jsonResponse(500, { title: "x", status: 500 });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: shouldRetryQuery, retryDelay: 0 } } });
    renderPage("/team-load", queryClient);
    expect(await screen.findByText("Load failed (500)")).toBeInTheDocument();
    expect(loadReads()).toHaveLength(3);
  });

  test("a re-read the database did not finish keeps the rows under the sentence", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: shouldRetryQuery, retryDelay: 0 } } });
    renderPage("/team-load", queryClient);
    await screen.findByRole("table", { name: "Load of every team" });
    answer = () => jsonResponse(500, { type: DATABASE_TIMEOUT_PROBLEM, title: "Internal Server Error", status: 500 });
    const before = loadReads().length;
    await queryClient.refetchQueries({ queryKey: TEAM_LOAD_KEY });
    expect(await screen.findByText("The request timed out. Try again.")).toBeInTheDocument();
    expect(loadReads().length - before).toBe(1);
    expect(teamNames()).toEqual(["Backend", "Frontend", "Data", "Mobile"]);
  });

  test("a re-read answered 304 keeps the rows with no alert and no spinner; a 200 after it replaces them", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    answer = () => jsonResponse(200, teamLoadView(ALL), { ETag: 'W/"one"' });
    renderPage("/team-load", queryClient);
    await screen.findByRole("table", { name: "Load of every team" });
    const sent: (string | null)[] = [];
    mockFetch.mockImplementation((_url: string, init?: RequestInit) => {
      sent.push(new Headers(init?.headers).get("If-None-Match"));
      return Promise.resolve(sent.length === 1 ? notModified('W/"one"') : jsonResponse(200, teamLoadView([BOTH]), { ETag: 'W/"two"' }));
    });
    await queryClient.refetchQueries({ queryKey: TEAM_LOAD_KEY });
    expect(sent).toEqual(['W/"one"']);
    expect(teamNames()).toEqual(["Backend", "Frontend", "Data", "Mobile"]);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("status", { name: "Loading…" })).toBeNull();
    await queryClient.refetchQueries({ queryKey: TEAM_LOAD_KEY });
    expect(sent).toEqual(['W/"one"', 'W/"one"']);
    await waitFor(() => expect(teamNames()).toEqual(["Backend"]));
  });

  test("speaks Polish in the bundle's own words", async () => {
    await i18n.changeLanguage("pl");
    renderPage();
    const table = await screen.findByRole("table", { name: "Obciążenie każdego zespołu" });
    expect(headingOutline()).toEqual([[2, "Obciążenie zespołów"]]);
    const backend = within(table).getByRole("link", { name: "Otwórz zespół Backend" }).closest("tr")!;
    expect(within(backend).getByText("3 tygodnie przeciążone")).toBeInTheDocument();
    expect(within(backend).getByText("1 tydzień ponad limitem WIP")).toBeInTheDocument();
    expect(within(table).getByText("6 tygodni bez przepustowości")).toBeInTheDocument();
    expect(within(table).getByText("Przepustowość")).toBeInTheDocument();
    expect(within(table).getByText("Brak kierownika/czki")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Niezaplanowane (4): zespół Backend" })).toBeInTheDocument();
    const facts = screen.getByRole("group", { name: "Obciążenie zespołów w liczbach" });
    expect(within(facts).getByText("4 zespoły")).toBeInTheDocument();
    expect(within(facts).getByText("2 zespoły z przeciążonym tygodniem")).toBeInTheDocument();
    expect(within(facts).getByText("jeszcze niezaplanowanych: 5")).toBeInTheDocument();
  });
});

describe("Team load page: the weeks with a warning (1.21)", () => {
  const OVER = teamLoadWeek({ weekStart: "2027-04-05", load: 10, capacity: 1, overloadMd: 9, maxWip: 1 });
  const BOTH_FLAGS = teamLoadWeek({ weekStart: "2027-04-12", load: 12.5, capacity: 10, overloadMd: 2.5, maxWip: 5, wipExceeded: true });
  const WIP_ONLY = teamLoadWeek({ weekStart: "2027-02-01", load: 6, capacity: 10, overloaded: false, overloadMd: null, maxWip: 4, wipExceeded: true });
  const WITH_WEEKS = [
    teamLoadRow({ id: 3, name: "Backend", overloadedWeeks: 2, wipExceededWeeks: 1, warningWeeks: [OVER, BOTH_FLAGS] }),
    teamLoadRow({ id: 5, name: "Data", wipExceededWeeks: 1, warningWeeks: [WIP_ONLY] }),
    teamLoadRow({ id: 6, name: "Mobile", weeksWithoutCapacity: 6 }),
  ];
  const weeksTable = () => screen.findByRole("table", { name: "Weeks with a warning, by team" });
  const bodyRows = (table: HTMLElement) => within(table).getAllByRole("row").slice(1);

  beforeEach(() => {
    mockFetch = vi.fn(() => Promise.resolve(answer()));
    vi.stubGlobal("fetch", mockFetch);
    localStorage.setItem("astrolabe.auth.token", "fake-token");
    answer = () => jsonResponse(200, teamLoadView(WITH_WEEKS));
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    localStorage.clear();
    await i18n.changeLanguage("en");
  });

  test("one row per team and week in the document's order, each cell the team page's own", async () => {
    renderPage();
    const table = await weeksTable();
    expect(headingOutline()).toEqual([
      [2, "Team load"],
      [3, "Weeks with a warning"],
    ]);
    const rows = bodyRows(table);
    expect(rows.map((row) => within(row).getAllByRole("cell").map((cell) => cell.textContent))).toEqual([
      ["Backend", "W14 · 2027-04-05", "10.00", "1.00", "1", "Overloaded · +9.00 MD"],
      ["Backend", "W15 · 2027-04-12", "12.50", "10.00", "5", "Overloaded · +2.50 MDOver WIP limit"],
      ["Data", "W05 · 2027-02-01", "6.00", "10.00", "4", "Over WIP limit"],
    ]);
    expect(within(rows[1]!).getByText("Over WIP limit")).toBeInTheDocument();
    expect(loadReads()).toHaveLength(1);
  });

  test("a team's name links to its page in both tables, one name and one destination", async () => {
    renderPage();
    const weeks = await weeksTable();
    const teams = screen.getByRole("table", { name: "Load of every team" });
    for (const table of [teams, weeks]) {
      expect(within(table).getAllByRole("link", { name: "Open team Backend" })[0]).toHaveAttribute("href", "/teams/3");
    }
    expect(within(weeks).getAllByRole("link", { name: "Open team Backend" })).toHaveLength(2);
  });

  test("a week without capacity is not listed and a team without weeks has no row", async () => {
    renderPage();
    const table = await weeksTable();
    expect(within(table).queryByRole("link", { name: "Open team Mobile" })).toBeNull();
    expect(within(table).queryByText("No capacity")).toBeNull();
  });

  test.each([
    ["overloaded", ["W14 · 2027-04-05", "W15 · 2027-04-12"]],
    ["wip", ["W15 · 2027-04-12", "W05 · 2027-02-01"]],
    ["any", ["W14 · 2027-04-05", "W15 · 2027-04-12", "W05 · 2027-02-01"]],
  ])("?warning=%s lists only the matching weeks of the teams shown, from one read", async (warning, labels) => {
    renderPage(`/team-load?warning=${warning}`);
    const table = await weeksTable();
    expect(bodyRows(table).map((row) => within(row).getAllByRole("cell")[1]!.textContent)).toEqual(labels);
    expect(loadReads()).toHaveLength(1);
  });

  test("a filter that leaves teams but none of their listed weeks shows no section and no sentence", async () => {
    answer = () => jsonResponse(200, teamLoadView([teamLoadRow({ id: 3, name: "Backend", overloadedWeeks: 1, warningWeeks: [] })]));
    renderPage("/team-load?warning=overloaded");
    await screen.findByRole("table", { name: "Load of every team" });
    expect(screen.queryByRole("table", { name: "Weeks with a warning, by team" })).toBeNull();
    expect(screen.queryByText("Weeks with a warning")).toBeNull();
    expect(screen.queryByText(/Not every week is listed/)).toBeNull();
    expect(headingOutline()).toEqual([[2, "Team load"]]);
  });

  test("a document with no listed week shows no section", async () => {
    answer = () => jsonResponse(200, teamLoadView(ALL));
    renderPage();
    await screen.findByRole("table", { name: "Load of every team" });
    expect(screen.queryByRole("table", { name: "Weeks with a warning, by team" })).toBeNull();
  });

  test("a cut document says how many weeks it lists, also when the section is absent; a complete one says nothing", async () => {
    answer = () => jsonResponse(200, teamLoadView(WITH_WEEKS, { warningWeeksTruncated: true }));
    const { unmount } = renderPage();
    await weeksTable();
    expect(screen.getByText("Not every week is listed: the list holds 3 weeks, those from this week on first (the nearest first), then earlier ones (the latest first).")).toBeInTheDocument();
    unmount();
    answer = () => jsonResponse(200, teamLoadView([teamLoadRow({ id: 6, name: "Mobile", overloadedWeeks: 4 })], { warningWeeksTruncated: true }));
    renderPage();
    await screen.findByRole("table", { name: "Load of every team" });
    expect(screen.queryByRole("table", { name: "Weeks with a warning, by team" })).toBeNull();
    expect(screen.getByText("Not every week is listed: the list holds 0 weeks, those from this week on first (the nearest first), then earlier ones (the latest first).")).toBeInTheDocument();
  });

  test("a cut document that lists one week says 'week', never 'weeks'", async () => {
    answer = () => jsonResponse(200, teamLoadView([WITH_WEEKS[1]!], { warningWeeksTruncated: true }));
    renderPage();
    await weeksTable();
    expect(screen.getByText(/^Not every week is listed: the list holds 1 week, those from/)).toBeInTheDocument();
  });

  test("a complete document says nothing about a cut", async () => {
    renderPage();
    await weeksTable();
    expect(screen.queryByText(/Not every week is listed/)).toBeNull();
  });

  test("while the read runs and after a failed first read there is neither section nor line", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    answer = () => gate.then(() => jsonResponse(200, teamLoadView(WITH_WEEKS, { warningWeeksTruncated: true })));
    const { unmount } = renderPage();
    expect(screen.queryByText("Weeks with a warning")).toBeNull();
    expect(screen.queryByText(/Not every week is listed/)).toBeNull();
    release();
    await weeksTable();
    unmount();
    answer = () => jsonResponse(500, { title: "x", status: 500 });
    renderPage();
    expect(await screen.findByText("Could not load the teams' load")).toBeInTheDocument();
    expect(screen.queryByText("Weeks with a warning")).toBeNull();
    expect(screen.queryByText(/Not every week is listed/)).toBeNull();
  });

  test("a failed re-read keeps the weeks under the alert", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderPage("/team-load", queryClient);
    await weeksTable();
    answer = () => jsonResponse(500, { title: "x", status: 500 });
    await queryClient.refetchQueries({ queryKey: TEAM_LOAD_KEY });
    expect(await screen.findByText("Could not load the teams' load")).toBeInTheDocument();
    expect(bodyRows(screen.getByRole("table", { name: "Weeks with a warning, by team" }))).toHaveLength(3);
  });

  test("speaks Polish in the bundle's own words", async () => {
    await i18n.changeLanguage("pl");
    answer = () => jsonResponse(200, teamLoadView(WITH_WEEKS, { warningWeeksTruncated: true }));
    renderPage();
    const table = await screen.findByRole("table", { name: "Tygodnie z ostrzeżeniem według zespołów" });
    expect(screen.getByRole("heading", { level: 3, name: "Tygodnie z ostrzeżeniem" })).toBeInTheDocument();
    expect(within(table).getByText("Przeciążenie · +9.00 osobodnia")).toBeInTheDocument();
    expect(screen.getByText("Lista nie zawiera wszystkich tygodni: mieści 3 tygodnie: najpierw tygodnie od bieżącego (od najbliższego), potem wcześniejsze (od najpóźniejszego).")).toBeInTheDocument();
  });
});

describe("Team load page: the weeks from this week on (1.22)", () => {
  const EARLY = teamLoadWeek({ weekStart: "2027-02-01", load: 6, capacity: 10, overloaded: false, overloadMd: null, maxWip: 4, wipExceeded: true });
  const EARLY_OVER = teamLoadWeek({ weekStart: "2027-03-29", load: 14, capacity: 10, overloadMd: 4, maxWip: 2 });
  const ON_WEEK = teamLoadWeek({ weekStart: "2027-04-05", load: 10, capacity: 1, overloadMd: 9, maxWip: 1 });
  const LATER = teamLoadWeek({ weekStart: "2027-04-12", load: 12.5, capacity: 10, overloadMd: 2.5, maxWip: 5, wipExceeded: true });
  const ROWS = [
    teamLoadRow({ id: 3, name: "Backend", overloadedWeeks: 3, wipExceededWeeks: 2, warningWeeks: [EARLY_OVER, ON_WEEK, LATER] }),
    teamLoadRow({ id: 5, name: "Data", wipExceededWeeks: 1, warningWeeks: [EARLY] }),
    teamLoadRow({ id: 6, name: "Mobile", overloadedWeeks: 2 }),
  ];
  // The document's own week, never the browser's clock: this Monday is neither today nor near it.
  const CURRENT = "2027-04-05";
  const weeksTable = () => screen.findByRole("table", { name: "Weeks with a warning, by team" });
  const weekLabels = (table: HTMLElement) => within(table).getAllByRole("row").slice(1).map((row) => within(row).getAllByRole("cell")[1]!.textContent);

  beforeEach(() => {
    answer = () => jsonResponse(200, teamLoadView(ROWS, { currentWeekStart: CURRENT }));
    mockFetch = vi.fn(() => Promise.resolve(answer()));
    vi.stubGlobal("fetch", mockFetch);
    localStorage.setItem("astrolabe.auth.token", "fake-token");
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    localStorage.clear();
    forgetRevalidated();
    await i18n.changeLanguage("en");
  });

  test("by default a week before the current week is not a row and the week ON it is; the sentence names the week", async () => {
    renderPage();
    const table = await weeksTable();
    expect(weekLabels(table)).toEqual(["W14 · 2027-04-05", "W15 · 2027-04-12"]);
    expect(screen.getByText(/^The weeks behind the two warning figures from the week W14 · 2027-04-05 on, team by team, oldest first/)).toBeInTheDocument();
    expect(screen.queryByText(/^The weeks behind the two warning figures, team by team/)).toBeNull();
  });

  test("the line counts the earlier weeks the date hides among the rows and the warning shown", async () => {
    renderPage();
    await weeksTable();
    expect(screen.getByText('2 earlier weeks are left out here. Turn on "Include past weeks" to list them.')).toBeInTheDocument();
  });

  test("the line follows the Show filter: it counts only what the warning would list", async () => {
    renderPage("/team-load?warning=wip");
    await weeksTable();
    // Backend's 03-29 week is overloaded only, so under "wip" just Data's 02-01 week is hidden.
    expect(screen.getByText('1 earlier week is left out here. Turn on "Include past weeks" to list it.')).toBeInTheDocument();
  });

  test("the line shows when no week is left to list, so the teams table's counts are never a riddle", async () => {
    answer = () => jsonResponse(200, teamLoadView([ROWS[1]!], { currentWeekStart: CURRENT }));
    renderPage();
    await screen.findByRole("table", { name: "Load of every team" });
    expect(screen.queryByRole("table", { name: "Weeks with a warning, by team" })).toBeNull();
    expect(screen.getByText('1 earlier week is left out here. Turn on "Include past weeks" to list it.')).toBeInTheDocument();
    expect(screen.getByText("1 week over WIP limit")).toBeInTheDocument();
  });

  test("the line is absent when nothing is hidden, while the read runs and after a failed first read", async () => {
    answer = () => jsonResponse(200, teamLoadView([ROWS[0]!], { currentWeekStart: "2027-03-29" }));
    const { unmount } = renderPage();
    await weeksTable();
    expect(screen.queryByText(/earlier weeks? (is|are) left out/)).toBeNull();
    unmount();
    answer = () => jsonResponse(500, { title: "x", status: 500 });
    renderPage();
    expect(await screen.findByText("Could not load the teams' load")).toBeInTheDocument();
    expect(screen.queryByText(/earlier weeks? (is|are) left out/)).toBeNull();
  });

  test("the switch writes ?past=true by replace, lists every listed week from the same read, restores the old sentence and drops the line", async () => {
    const user = userEvent.setup();
    renderPage();
    await weeksTable();
    await user.click(screen.getByRole("button", { name: "Filters" }));
    await user.click(screen.getByRole("switch", { name: "Include past weeks" }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/team-load?past=true"));
    expect(screen.getByTestId("nav")).toHaveTextContent("REPLACE");
    expect(weekLabels(await weeksTable())).toEqual(["W13 · 2027-03-29", "W14 · 2027-04-05", "W15 · 2027-04-12", "W05 · 2027-02-01"]);
    expect(screen.getByText(/^The weeks behind the two warning figures, team by team, oldest first/)).toBeInTheDocument();
    expect(screen.queryByText(/earlier weeks? (is|are) left out/)).toBeNull();
    await user.click(screen.getByRole("switch", { name: "Include past weeks" }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(/^\/team-load$/));
    expect(weekLabels(await weeksTable())).toEqual(["W14 · 2027-04-05", "W15 · 2027-04-12"]);
    expect(loadReads()).toHaveLength(1);
  });

  test("the Show select keeps past=true and the switch keeps the warning", async () => {
    const user = userEvent.setup();
    renderPage("/team-load?past=true");
    await weeksTable();
    await user.click(screen.getByRole("button", { name: /Filters/ }));
    await user.click(screen.getByRole("combobox", { name: "Show" }));
    await user.click(await screen.findByRole("option", { name: "Over the WIP limit" }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/team-load?warning=wip&past=true"));
    await user.click(screen.getByRole("switch", { name: "Include past weeks" }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/team-load?warning=wip"));
    expect(screen.getByTestId("where")).not.toHaveTextContent("past");
  });

  test("?warning=wip&past=true combines: the matching weeks of every date", async () => {
    renderPage("/team-load?warning=wip&past=true");
    const table = await weeksTable();
    expect(weekLabels(table)).toEqual(["W15 · 2027-04-12", "W05 · 2027-02-01"]);
  });

  test("the filter badge counts the switch", async () => {
    const { unmount } = renderPage("/team-load?past=true");
    await weeksTable();
    expect(screen.getByRole("button", { name: /Filters/ })).toHaveTextContent("1");
    unmount();
    renderPage("/team-load?warning=wip&past=true");
    await weeksTable();
    expect(screen.getByRole("button", { name: /Filters/ })).toHaveTextContent("2");
  });

  test("past=1 and past=false read as off", async () => {
    for (const query of ["past=1", "past=false"]) {
      const { unmount } = renderPage(`/team-load?${query}`);
      expect(weekLabels(await weeksTable())).toEqual(["W14 · 2027-04-05", "W15 · 2027-04-12"]);
      unmount();
    }
  });

  test("the teams table counts every week whatever the date hides", async () => {
    renderPage();
    await weeksTable();
    const backend = within(screen.getByRole("table", { name: "Load of every team" })).getByRole("link", { name: "Open team Backend" }).closest("tr")!;
    expect(within(backend).getByText("3 weeks overloaded")).toBeInTheDocument();
    expect(within(backend).getByText("2 weeks over WIP limit")).toBeInTheDocument();
  });

  test("a cut document reads the new order in its line", async () => {
    answer = () => jsonResponse(200, teamLoadView(ROWS, { currentWeekStart: CURRENT, warningWeeksTruncated: true }));
    renderPage();
    await weeksTable();
    expect(screen.getByText("Not every week is listed: the list holds 4 weeks, those from this week on first (the nearest first), then earlier ones (the latest first).")).toBeInTheDocument();
  });

  test("the browser's clock never decides: with the clock far later the same weeks show", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    try {
      renderPage();
      const table = await weeksTable();
      expect(weekLabels(table)).toEqual(["W14 · 2027-04-05", "W15 · 2027-04-12"]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("speaks Polish in the bundle's own words", async () => {
    await i18n.changeLanguage("pl");
    const { unmount } = renderPage();
    await screen.findByRole("table", { name: "Tygodnie z ostrzeżeniem według zespołów" });
    expect(screen.getByText("Nie pokazujemy tu 2 wcześniejszych tygodni. Włącz „Pokaż też minione tygodnie”, aby je zobaczyć.")).toBeInTheDocument();
    expect(screen.getByText(/od tygodnia W14 · 2027-04-05, zespół po zespole, od najstarszego/)).toBeInTheDocument();
    unmount();
    answer = () => jsonResponse(200, teamLoadView([ROWS[1]!], { currentWeekStart: CURRENT }));
    renderPage();
    expect(await screen.findByText("Nie pokazujemy tu 1 wcześniejszego tygodnia. Włącz „Pokaż też minione tygodnie”, aby go zobaczyć.")).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Filtry" }));
    expect(screen.getByRole("switch", { name: "Pokaż też minione tygodnie" })).toBeInTheDocument();
  });
});
