import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { QueryClient } from "@tanstack/react-query";
import i18n from "../i18n";
import { screen, waitFor, within } from "../test/render";
import { headingOutline } from "../test/headings";
import { requestsAnswered } from "../test/requestsAnswered";
import { jsonResponse, notModified } from "../test/http";
import { DATABASE_TIMEOUT_PROBLEM, shouldRetryQuery } from "../api/http";
import { forgetRevalidated } from "../api/revalidate";
import { TEAM_LOAD_KEY } from "../api/teamLoad";
import { teamLoadRow, teamLoadView } from "../test/teamLoad";
import { loadReads, renderTeamsPage } from "../test/teamsPage";

// The Teams page's load figures (the Team load page folded into it, 1.32): the table, the facts line, the filters, the states.

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

const reads = () => loadReads(mockFetch);
const table = () => screen.findByRole("table", { name: "Teams" });
const teamNames = () =>
  within(screen.getByRole("table", { name: "Teams" }))
    .getAllByRole("link", { name: /^Open team / })
    .map((link) => link.textContent);
const openFilters = async (user: ReturnType<typeof userEvent.setup>) => user.click(screen.getByRole("button", { name: /Filters/ }));

describe("Teams page: the load figures", () => {
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
    renderTeamsPage();
    const teams = await table();
    expect(headingOutline()).toEqual([[2, "Teams"]]);
    expect(teamNames()).toEqual(["Backend", "Frontend", "Data", "Mobile"]);
    expect(within(teams).getByText("Alex Rivera")).toBeInTheDocument();
    expect(within(teams).getByRole("link", { name: "Open person Alex Rivera" })).toHaveAttribute("href", "/people/9");
    expect(reads()).toHaveLength(1);
    // The paged list is no longer read at all: the one document is the whole page (the colours come from the unpaged options read).
    expect(mockFetch.mock.calls.some(([url]) => typeof url === "string" && url.startsWith("/api/v1/teams?") && !url.includes("pageSize=100"))).toBe(false);
  });

  test("each team's name has its colour swatch before it, read from the teams list, never from the document", async () => {
    renderTeamsPage();
    const teams = await table();
    await waitFor(() => expect(teams.querySelectorAll("[data-team-colour]")).toHaveLength(4));
    const swatches = [...teams.querySelectorAll("[data-team-colour]")];
    expect(swatches.map((swatch) => swatch.getAttribute("data-team-colour"))).toEqual(["INDIGO", "TEAL", "LIME", "RASPBERRY"]);
    const link = within(teams).getByRole("link", { name: "Open team Backend" });
    expect(swatches[0]!.nextElementSibling).toBe(link);
    expect(swatches[0]).toHaveAttribute("aria-hidden", "true");
  });

  test("the facts line shows the totals as they arrive, a zero badge absent", async () => {
    answer = () => jsonResponse(200, teamLoadView(ALL, { totals: { teams: 15, overloadedTeams: 2, wipExceededTeams: 0, unscheduledMilestones: 41 } }));
    renderTeamsPage();
    const facts = await screen.findByRole("group", { name: "The teams in figures" });
    expect(within(facts).getByText("15 teams")).toBeInTheDocument();
    expect(within(facts).getByText("41 not scheduled yet"), "the server's plan-wide total, never the rows' sum").toBeInTheDocument();
    expect(within(facts).getByText("2 teams with an overloaded week")).toBeInTheDocument();
    expect(within(facts).queryByText(/over the WIP limit/)).not.toBeInTheDocument();
  });

  test("the facts line keeps the totals when a filter hides the rows", async () => {
    renderTeamsPage("/teams?warning=wip");
    const facts = await screen.findByRole("group", { name: "The teams in figures" });
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
    renderTeamsPage(`/teams?warning=${warning}`);
    await table();
    expect(teamNames()).toEqual(names);
  });

  test("an unknown warning lists every team", async () => {
    renderTeamsPage("/teams?warning=bogus");
    await table();
    expect(teamNames()).toHaveLength(4);
  });

  test("the select rewrites the URL by replace and filters in the browser, with no second read", async () => {
    const user = userEvent.setup();
    renderTeamsPage();
    await table();
    await openFilters(user);
    await user.click(screen.getByRole("combobox", { name: "Show" }));
    await user.click(await screen.findByRole("option", { name: "Over the WIP limit" }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/teams?warning=wip"));
    expect(screen.getByTestId("nav")).toHaveTextContent("REPLACE");
    expect(teamNames()).toEqual(["Backend", "Data"]);
    await user.click(screen.getByRole("combobox", { name: "Show" }));
    await user.click(await screen.findByRole("option", { name: "Every team" }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(/^\/teams$/));
    expect(teamNames()).toHaveLength(4);
    expect(reads()).toHaveLength(1);
  });

  test("the Name filter narrows the rows as you type, folded, with no second read and no URL change", async () => {
    answer = () => jsonResponse(200, teamLoadView([...ALL, teamLoadRow({ id: 7, name: "Łódź Ops", managerName: null })]));
    const user = userEvent.setup();
    renderTeamsPage();
    await table();
    await openFilters(user);
    await user.type(screen.getByLabelText("Name"), "DA");
    expect(teamNames()).toEqual(["Data"]);
    await user.clear(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "lodz");
    expect(teamNames()).toEqual(["Łódź Ops"]);
    expect(screen.getByTestId("where")).toHaveTextContent(/^\/teams$/);
    expect(reads()).toHaveLength(1);
  });

  test("the Name filter is not remembered: a new visit lists every team", async () => {
    const user = userEvent.setup();
    const { unmount } = renderTeamsPage();
    await table();
    await openFilters(user);
    await user.type(screen.getByLabelText("Name"), "data");
    expect(teamNames()).toEqual(["Data"]);
    unmount();
    renderTeamsPage();
    await table();
    expect(teamNames()).toHaveLength(4);
    expect(Object.keys(localStorage).filter((key) => key.includes("filter.name"))).toEqual([]);
  });

  test("Name and Show combine, the facts keep the totals, and one line counts what is shown once typing pauses", async () => {
    const user = userEvent.setup();
    renderTeamsPage("/teams?warning=overloaded");
    await table();
    expect(await screen.findByText("Showing 2 of 4 teams")).toBeInTheDocument();
    await openFilters(user);
    await user.type(screen.getByLabelText("Name"), "end");
    expect(teamNames()).toEqual(["Backend", "Frontend"]);
    await user.clear(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "front");
    expect(teamNames()).toEqual(["Frontend"]);
    expect(await screen.findByText("Showing 1 of 4 teams")).toBeInTheDocument();
    expect(within(screen.getByRole("group", { name: "The teams in figures" })).getByText("4 teams")).toBeInTheDocument();
  });

  test("with no filter set no count line is spoken", async () => {
    renderTeamsPage();
    await table();
    expect(screen.queryByText(/^Showing \d+ of \d+ teams?$/)).toBeNull();
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });

  test("the filter badge counts the name and the warning; a retired ?past=true counts for nothing and has no switch", async () => {
    const user = userEvent.setup();
    renderTeamsPage("/teams?warning=wip&past=true");
    await table();
    expect(screen.getByRole("button", { name: /Filters/ })).toHaveTextContent("1");
    await openFilters(user);
    expect(screen.queryByRole("switch")).toBeNull();
    await user.type(screen.getByLabelText("Name"), "d");
    expect(screen.getByRole("button", { name: /Filters/ })).toHaveTextContent("2");
  });

  test("a team's name links to its page", async () => {
    renderTeamsPage();
    await table();
    expect(screen.getByRole("link", { name: "Open team Backend" })).toHaveAttribute("href", "/teams/3");
  });

  test("'Not scheduled' links to the team's page (its Unscheduled tray) only when positive, named by its row", async () => {
    renderTeamsPage();
    await table();
    expect(screen.getByRole("link", { name: "4 not scheduled: team Backend" })).toHaveAttribute("href", "/teams/3");
    expect(screen.getByRole("link", { name: "1 not scheduled: team Mobile" })).toHaveAttribute("href", "/teams/6");
    const frontendRow = screen.getByRole("link", { name: "Open team Frontend" }).closest("tr")!;
    expect(within(frontendRow).getByText("0")).toBeInTheDocument();
    expect(within(frontendRow).queryByRole("link", { name: /not scheduled/ })).toBeNull();
  });

  test("the warning badges are worded and only shown when positive; weeks without capacity are a gray fact", async () => {
    renderTeamsPage();
    const teams = await table();
    const backend = screen.getByRole("link", { name: "Open team Backend" }).closest("tr")!;
    expect(within(backend).getByText("3 weeks overloaded")).toBeInTheDocument();
    expect(within(backend).getByText("1 week over WIP limit")).toBeInTheDocument();
    expect(within(backend).queryByText(/without capacity/)).toBeNull();
    // The layout pin (jsdom lays nothing out): a badge in a cell is at least as wide as its text (its label hides overflow, so the column could shrink it into an ellipsis), and its cell keeps one line.
    for (const text of ["3 weeks overloaded", "1 week over WIP limit"]) {
      const badge = within(backend).getByText(text).closest<HTMLElement>(".mantine-Badge-root")!;
      expect(badge).toHaveStyle({ minWidth: "max-content" });
      expect(badge.closest("td")).toHaveStyle({ whiteSpace: "nowrap" });
    }
    const frontend = screen.getByRole("link", { name: "Open team Frontend" }).closest("tr")!;
    expect(within(frontend).getByText("1 week overloaded")).toBeInTheDocument();
    expect(within(frontend).queryByText(/WIP/)).toBeNull();
    expect(within(frontend).getByText("No manager")).toBeInTheDocument();
    const mobile = screen.getByRole("link", { name: "Open team Mobile" }).closest("tr")!;
    expect(within(mobile).getByText("6 weeks without capacity")).toBeInTheDocument();
    expect(within(mobile).queryByText(/overloaded|WIP/)).toBeNull();
    // Nothing is ever said to "fit": a quiet row carries no badge of any kind but the neutral fact.
    expect(within(teams).queryByText(/fits/i)).toBeNull();
  });

  test("each positive week count is a link to the team's weekly load table, with its own kind in the address, named by its figure and where it goes (1.36)", async () => {
    renderTeamsPage();
    await table();
    const backend = screen.getByRole("link", { name: "Open team Backend" }).closest("tr")!;
    const overloaded = within(backend).getByRole("link", { name: "3 weeks overloaded: open the weekly load of team Backend" });
    expect(overloaded).toHaveAttribute("href", "/teams/3?load=overloaded");
    expect(overloaded).toHaveTextContent("3 weeks overloaded");
    expect(within(backend).getByRole("link", { name: "1 week over WIP limit: open the weekly load of team Backend" })).toHaveAttribute("href", "/teams/3?load=wip");
    const mobile = screen.getByRole("link", { name: "Open team Mobile" }).closest("tr")!;
    const gray = within(mobile).getByRole("link", { name: "6 weeks without capacity: open the weekly load of team Mobile" });
    expect(gray).toHaveAttribute("href", "/teams/6?load=nocapacity");
    // A zero figure is no badge and so no link; the facts line's team totals are plain badges (not per team).
    expect(within(mobile).queryAllByRole("link", { name: /weekly load/ })).toHaveLength(1);
    const group = screen.getByRole("group", { name: "The teams in figures" });
    expect(within(group).queryByRole("link")).toBeNull();
  });

  test("the links' names are Polish in Polish, the figure worded with its plural", async () => {
    await i18n.changeLanguage("pl");
    renderTeamsPage();
    await screen.findByRole("table", { name: "Zespoły" });
    expect(screen.getByRole("link", { name: "3 tygodnie przeciążone: otwórz tygodniowe obciążenie zespołu Backend" })).toHaveAttribute("href", "/teams/3?load=overloaded");
    expect(screen.getByRole("link", { name: "2 tygodnie ponad limitem WIP: otwórz tygodniowe obciążenie zespołu Data" })).toHaveAttribute("href", "/teams/5?load=wip");
  });

  test("no team at all says so, with no filter claim", async () => {
    answer = () => jsonResponse(200, teamLoadView([]));
    renderTeamsPage();
    expect(await screen.findByText("No teams yet")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByText("No team matches the filters")).toBeNull();
  });

  test("a filter nothing matches says so and 'Show every team' clears Name and Show", async () => {
    const user = userEvent.setup();
    answer = () => jsonResponse(200, teamLoadView([QUIET]));
    renderTeamsPage("/teams?warning=overloaded");
    expect(await screen.findByText("No team matches the filters")).toBeInTheDocument();
    expect(screen.queryByText("No teams yet")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Show every team" }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(/^\/teams$/));
    expect(await table()).toBeInTheDocument();
    // A name that matches nothing is cleared by the same button.
    await openFilters(user);
    await user.type(screen.getByLabelText("Name"), "zzz");
    expect(await screen.findByText("No team matches the filters")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show every team" }));
    expect(await table()).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveValue("");
  });

  test("while the read runs there is no claim at all", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    answer = () => gate.then(() => jsonResponse(200, teamLoadView(ALL)));
    renderTeamsPage("/teams?warning=wip");
    expect(screen.queryByText("No teams yet")).toBeNull();
    expect(screen.queryByText("No team matches the filters")).toBeNull();
    expect(screen.queryByRole("group", { name: "The teams in figures" })).toBeNull();
    release();
    expect(await table()).toBeInTheDocument();
  });

  test("a cut list says so, with the number of rows shown, while the totals stay the server's", async () => {
    answer = () => jsonResponse(200, teamLoadView(ALL, { truncated: true, totals: { teams: 230, overloadedTeams: 9, wipExceededTeams: 3, unscheduledMilestones: 77 } }));
    renderTeamsPage();
    expect(await screen.findByText("The list shows its first 4 teams.")).toBeInTheDocument();
    expect(screen.getByText("230 teams")).toBeInTheDocument();
    expect(screen.getByText("77 not scheduled yet")).toBeInTheDocument();
  });

  test("a complete list says nothing about a cut", async () => {
    renderTeamsPage();
    await table();
    expect(screen.queryByText(/first \d+ teams/)).toBeNull();
  });

  test("a failed first read is the one inline alert, with no empty-state claim and no facts", async () => {
    answer = () => jsonResponse(500, { title: "x", status: 500 });
    renderTeamsPage();
    expect(await screen.findByText("Could not load the teams")).toBeInTheDocument();
    expect(screen.queryByText("No teams yet")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByRole("group", { name: "The teams in figures" })).toBeNull();
  });

  test("a read the database did not finish makes ONE request and says the request timed out, with the production retry policy", async () => {
    answer = () => jsonResponse(500, { type: DATABASE_TIMEOUT_PROBLEM, title: "Internal Server Error", status: 500, detail: "The database did not answer in time. Try again shortly." });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: shouldRetryQuery, retryDelay: 0 } } });
    renderTeamsPage("/teams", queryClient);
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("The request timed out. Try again.")).toBeInTheDocument();
    expect(within(alert).queryByText(/500/)).toBeNull();
    expect(screen.queryByText("No teams yet")).toBeNull();
    // Two more tries would have started by now with retryDelay 0 had the policy retried it.
    await requestsAnswered(queryClient);
    expect(reads()).toHaveLength(1);
  });

  test("an untyped 500 is still retried twice under the same policy", async () => {
    answer = () => jsonResponse(500, { title: "x", status: 500 });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: shouldRetryQuery, retryDelay: 0 } } });
    renderTeamsPage("/teams", queryClient);
    expect(await screen.findByText("Load failed (500)")).toBeInTheDocument();
    expect(reads()).toHaveLength(3);
  });

  test("a re-read the database did not finish keeps the rows under the sentence", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: shouldRetryQuery, retryDelay: 0 } } });
    renderTeamsPage("/teams", queryClient);
    await table();
    answer = () => jsonResponse(500, { type: DATABASE_TIMEOUT_PROBLEM, title: "Internal Server Error", status: 500 });
    const before = reads().length;
    await queryClient.refetchQueries({ queryKey: TEAM_LOAD_KEY });
    expect(await screen.findByText("The request timed out. Try again.")).toBeInTheDocument();
    expect(reads().length - before).toBe(1);
    expect(teamNames()).toEqual(["Backend", "Frontend", "Data", "Mobile"]);
  });

  test("a failed re-read keeps the rows and makes no empty claim, even when the filters match none of them", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderTeamsPage("/teams?warning=overloaded", queryClient);
    await table();
    answer = () => jsonResponse(500, { title: "x", status: 500 });
    await queryClient.refetchQueries({ queryKey: TEAM_LOAD_KEY });
    expect(await screen.findByText("Could not load the teams")).toBeInTheDocument();
    expect(teamNames()).toEqual(["Backend", "Frontend"]);
  });

  test("a re-read answered 304 keeps the rows with no alert and no spinner; a 200 after it replaces them", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    answer = () => jsonResponse(200, teamLoadView(ALL), { ETag: 'W/"one"' });
    renderTeamsPage("/teams", queryClient);
    await table();
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
    renderTeamsPage();
    const teams = await screen.findByRole("table", { name: "Zespoły" });
    expect(headingOutline()).toEqual([[2, "Zespoły"]]);
    const backend = within(teams).getByRole("link", { name: "Otwórz zespół Backend" }).closest("tr")!;
    expect(within(backend).getByText("3 tygodnie przeciążone")).toBeInTheDocument();
    expect(within(backend).getByText("1 tydzień ponad limitem WIP")).toBeInTheDocument();
    expect(within(teams).getByText("6 tygodni bez przepustowości")).toBeInTheDocument();
    expect(within(teams).getByText("Przepustowość")).toBeInTheDocument();
    expect(within(teams).getByText("Brak kierownika/czki")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Niezaplanowane (4): zespół Backend" })).toBeInTheDocument();
    const facts = screen.getByRole("group", { name: "Zespoły w liczbach" });
    expect(within(facts).getByText("4 zespoły")).toBeInTheDocument();
    expect(within(facts).getByText("2 zespoły z przeciążonym tygodniem")).toBeInTheDocument();
    expect(within(facts).getByText("jeszcze niezaplanowanych: 5")).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Filtry" }));
    await user.type(screen.getByLabelText("Nazwa"), "mob");
    expect(await screen.findByText("Widoczne: 1 z 4 zespołów")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Nazwa"), "xyz");
    expect(await screen.findByText("Żaden zespół nie pasuje do filtrów")).toBeInTheDocument();
  });
});
