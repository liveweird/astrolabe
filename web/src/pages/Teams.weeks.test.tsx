import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { QueryClient } from "@tanstack/react-query";
import i18n from "../i18n";
import { screen, waitFor, within } from "../test/render";
import { headingOutline } from "../test/headings";
import { jsonResponse } from "../test/http";
import { forgetRevalidated } from "../api/revalidate";
import { TEAM_LOAD_KEY } from "../api/teamLoad";
import { teamLoadRow, teamLoadView, teamLoadWeek } from "../test/teamLoad";
import { loadReads, renderTeamsPage } from "../test/teamsPage";

// The Teams page's "Weeks with a warning" table (the Team load page folded into it, 1.32): its rows, filters, date and lines.

let answer: () => Response | Promise<Response>;
let mockFetch: ReturnType<typeof vi.fn>;
const reads = () => loadReads(mockFetch);

describe("Teams page: the weeks with a warning (1.21)", () => {
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
    forgetRevalidated();
    await i18n.changeLanguage("en");
  });

  test("one row per team and week in the document's order, each cell the team page's own", async () => {
    renderTeamsPage();
    const table = await weeksTable();
    expect(headingOutline()).toEqual([
      [2, "Teams"],
      [3, "Weeks with a warning"],
    ]);
    const rows = bodyRows(table);
    expect(rows.map((row) => within(row).getAllByRole("cell").map((cell) => cell.textContent))).toEqual([
      ["Backend", "W14 · 2027-04-05", "10.00", "1.00", "1", "Overloaded · +9.00 MD"],
      ["Backend", "W15 · 2027-04-12", "12.50", "10.00", "5", "Overloaded · +2.50 MDOver WIP limit"],
      ["Data", "W05 · 2027-02-01", "6.00", "10.00", "4", "Over WIP limit"],
    ]);
    expect(within(rows[1]!).getByText("Over WIP limit")).toBeInTheDocument();
    expect(reads()).toHaveLength(1);
  });

  test("a team's name links to its page in both tables, one name and one destination", async () => {
    renderTeamsPage();
    const weeks = await weeksTable();
    const teams = screen.getByRole("table", { name: "Teams" });
    for (const table of [teams, weeks]) {
      expect(within(table).getAllByRole("link", { name: "Open team Backend" })[0]).toHaveAttribute("href", "/teams/3");
    }
    expect(within(weeks).getAllByRole("link", { name: "Open team Backend" })).toHaveLength(2);
  });

  test("a week without capacity is not listed and a team without weeks has no row", async () => {
    renderTeamsPage();
    const table = await weeksTable();
    expect(within(table).queryByRole("link", { name: "Open team Mobile" })).toBeNull();
    expect(within(table).queryByText("No capacity")).toBeNull();
  });

  test.each([
    ["overloaded", ["W14 · 2027-04-05", "W15 · 2027-04-12"]],
    ["wip", ["W15 · 2027-04-12", "W05 · 2027-02-01"]],
    ["any", ["W14 · 2027-04-05", "W15 · 2027-04-12", "W05 · 2027-02-01"]],
  ])("?warning=%s lists only the matching weeks of the teams shown, from one read", async (warning, labels) => {
    renderTeamsPage(`/teams?warning=${warning}`);
    const table = await weeksTable();
    expect(bodyRows(table).map((row) => within(row).getAllByRole("cell")[1]!.textContent)).toEqual(labels);
    expect(reads()).toHaveLength(1);
  });

  test("the Name filter narrows the weeks to the teams shown and the line counting earlier weeks follows it, from the same read", async () => {
    const user = userEvent.setup();
    renderTeamsPage();
    const table = await weeksTable();
    expect(bodyRows(table)).toHaveLength(3);
    await user.click(screen.getByRole("button", { name: "Filters" }));
    await user.type(screen.getByLabelText("Name"), "dat");
    expect(bodyRows(await weeksTable()).map((row) => within(row).getAllByRole("cell")[0]!.textContent)).toEqual(["Data"]);
    await user.clear(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "mob");
    await waitFor(() => expect(screen.queryByRole("table", { name: "Weeks with a warning, by team" })).toBeNull());
    expect(reads()).toHaveLength(1);
  });

  test("a filter that leaves teams but none of their listed weeks shows no section and no sentence", async () => {
    answer = () => jsonResponse(200, teamLoadView([teamLoadRow({ id: 3, name: "Backend", overloadedWeeks: 1, warningWeeks: [] })]));
    renderTeamsPage("/teams?warning=overloaded");
    await screen.findByRole("table", { name: "Teams" });
    expect(screen.queryByRole("table", { name: "Weeks with a warning, by team" })).toBeNull();
    expect(screen.queryByText("Weeks with a warning")).toBeNull();
    expect(screen.queryByText(/Not every week is listed/)).toBeNull();
    expect(headingOutline()).toEqual([[2, "Teams"]]);
  });

  test("a document with no listed week shows no section", async () => {
    answer = () => jsonResponse(200, teamLoadView([teamLoadRow({ id: 3, name: "Backend", overloadedWeeks: 2 }), teamLoadRow({ id: 6, name: "Mobile", weeksWithoutCapacity: 6 })]));
    renderTeamsPage();
    await screen.findByRole("table", { name: "Teams" });
    expect(screen.queryByRole("table", { name: "Weeks with a warning, by team" })).toBeNull();
  });

  test("a cut document says how many weeks it lists, also when the section is absent; a complete one says nothing", async () => {
    answer = () => jsonResponse(200, teamLoadView(WITH_WEEKS, { warningWeeksTruncated: true }));
    const { unmount } = renderTeamsPage();
    await weeksTable();
    expect(screen.getByText("Not every week is listed: the list holds 3 weeks, those from this week on first (the nearest first), then earlier ones (the latest first).")).toBeInTheDocument();
    unmount();
    answer = () => jsonResponse(200, teamLoadView([teamLoadRow({ id: 6, name: "Mobile", overloadedWeeks: 4 })], { warningWeeksTruncated: true }));
    renderTeamsPage();
    await screen.findByRole("table", { name: "Teams" });
    expect(screen.queryByRole("table", { name: "Weeks with a warning, by team" })).toBeNull();
    expect(screen.getByText("Not every week is listed: the list holds 0 weeks, those from this week on first (the nearest first), then earlier ones (the latest first).")).toBeInTheDocument();
  });

  test("a cut document that lists one week says 'week', never 'weeks'", async () => {
    answer = () => jsonResponse(200, teamLoadView([WITH_WEEKS[1]!], { warningWeeksTruncated: true }));
    renderTeamsPage();
    await weeksTable();
    expect(screen.getByText(/^Not every week is listed: the list holds 1 week, those from/)).toBeInTheDocument();
  });

  test("a complete document says nothing about a cut", async () => {
    renderTeamsPage();
    await weeksTable();
    expect(screen.queryByText(/Not every week is listed/)).toBeNull();
  });

  test("while the read runs and after a failed first read there is neither section nor line", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    answer = () => gate.then(() => jsonResponse(200, teamLoadView(WITH_WEEKS, { warningWeeksTruncated: true })));
    const { unmount } = renderTeamsPage();
    expect(screen.queryByText("Weeks with a warning")).toBeNull();
    expect(screen.queryByText(/Not every week is listed/)).toBeNull();
    release();
    await weeksTable();
    unmount();
    answer = () => jsonResponse(500, { title: "x", status: 500 });
    renderTeamsPage();
    expect(await screen.findByText("Could not load the teams")).toBeInTheDocument();
    expect(screen.queryByText("Weeks with a warning")).toBeNull();
    expect(screen.queryByText(/Not every week is listed/)).toBeNull();
  });

  test("a failed re-read keeps the weeks under the alert", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderTeamsPage("/teams", queryClient);
    await weeksTable();
    answer = () => jsonResponse(500, { title: "x", status: 500 });
    await queryClient.refetchQueries({ queryKey: TEAM_LOAD_KEY });
    expect(await screen.findByText("Could not load the teams")).toBeInTheDocument();
    expect(bodyRows(screen.getByRole("table", { name: "Weeks with a warning, by team" }))).toHaveLength(3);
  });

  test("speaks Polish in the bundle's own words", async () => {
    await i18n.changeLanguage("pl");
    answer = () => jsonResponse(200, teamLoadView(WITH_WEEKS, { warningWeeksTruncated: true }));
    renderTeamsPage();
    const table = await screen.findByRole("table", { name: "Tygodnie z ostrzeżeniem według zespołów" });
    expect(screen.getByRole("heading", { level: 3, name: "Tygodnie z ostrzeżeniem" })).toBeInTheDocument();
    expect(within(table).getByText("Przeciążenie · +9.00 osobodnia")).toBeInTheDocument();
    expect(screen.getByText("Lista nie zawiera wszystkich tygodni: mieści 3 tygodnie: najpierw tygodnie od bieżącego (od najbliższego), potem wcześniejsze (od najpóźniejszego).")).toBeInTheDocument();
  });
});

describe("Teams page: the weeks from this week on (1.22)", () => {
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
    renderTeamsPage();
    const table = await weeksTable();
    expect(weekLabels(table)).toEqual(["W14 · 2027-04-05", "W15 · 2027-04-12"]);
    expect(screen.getByText(/^The weeks behind the two warning figures from the week W14 · 2027-04-05 on, team by team, oldest first/)).toBeInTheDocument();
    expect(screen.queryByText(/^The weeks behind the two warning figures, team by team/)).toBeNull();
  });

  test("the line counts the earlier weeks the date hides among the rows and the warning shown", async () => {
    renderTeamsPage();
    await weeksTable();
    expect(screen.getByText('2 earlier weeks are left out here. Turn on "Include past weeks" to list them.')).toBeInTheDocument();
  });

  test("the line follows the Show filter: it counts only what the warning would list", async () => {
    renderTeamsPage("/teams?warning=wip");
    await weeksTable();
    // Backend's 03-29 week is overloaded only, so under "wip" just Data's 02-01 week is hidden.
    expect(screen.getByText('1 earlier week is left out here. Turn on "Include past weeks" to list it.')).toBeInTheDocument();
  });

  test("the line follows the Name filter: it counts only the earlier weeks of the teams shown", async () => {
    const user = userEvent.setup();
    renderTeamsPage();
    await weeksTable();
    expect(screen.getByText('2 earlier weeks are left out here. Turn on "Include past weeks" to list them.')).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Filters" }));
    await user.type(screen.getByLabelText("Name"), "dat");
    expect(screen.getByText('1 earlier week is left out here. Turn on "Include past weeks" to list it.')).toBeInTheDocument();
  });

  test("the line shows when no week is left to list, so the teams table's counts are never a riddle", async () => {
    answer = () => jsonResponse(200, teamLoadView([ROWS[1]!], { currentWeekStart: CURRENT }));
    renderTeamsPage();
    await screen.findByRole("table", { name: "Teams" });
    expect(screen.queryByRole("table", { name: "Weeks with a warning, by team" })).toBeNull();
    expect(screen.getByText('1 earlier week is left out here. Turn on "Include past weeks" to list it.')).toBeInTheDocument();
    expect(screen.getByText("1 week over WIP limit")).toBeInTheDocument();
  });

  test("the line is absent when nothing is hidden, while the read runs and after a failed first read", async () => {
    answer = () => jsonResponse(200, teamLoadView([ROWS[0]!], { currentWeekStart: "2027-03-29" }));
    const { unmount } = renderTeamsPage();
    await weeksTable();
    expect(screen.queryByText(/earlier weeks? (is|are) left out/)).toBeNull();
    unmount();
    answer = () => jsonResponse(500, { title: "x", status: 500 });
    renderTeamsPage();
    expect(await screen.findByText("Could not load the teams")).toBeInTheDocument();
    expect(screen.queryByText(/earlier weeks? (is|are) left out/)).toBeNull();
  });

  test("the switch writes ?past=true by replace, lists every listed week from the same read, restores the old sentence and drops the line", async () => {
    const user = userEvent.setup();
    renderTeamsPage();
    await weeksTable();
    await user.click(screen.getByRole("button", { name: "Filters" }));
    await user.click(screen.getByRole("switch", { name: "Include past weeks" }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/teams?past=true"));
    expect(screen.getByTestId("nav")).toHaveTextContent("REPLACE");
    expect(weekLabels(await weeksTable())).toEqual(["W13 · 2027-03-29", "W14 · 2027-04-05", "W15 · 2027-04-12", "W05 · 2027-02-01"]);
    expect(screen.getByText(/^The weeks behind the two warning figures, team by team, oldest first/)).toBeInTheDocument();
    expect(screen.queryByText(/earlier weeks? (is|are) left out/)).toBeNull();
    await user.click(screen.getByRole("switch", { name: "Include past weeks" }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(/^\/teams$/));
    expect(weekLabels(await weeksTable())).toEqual(["W14 · 2027-04-05", "W15 · 2027-04-12"]);
    expect(reads()).toHaveLength(1);
  });

  test("the Show select keeps past=true and the switch keeps the warning", async () => {
    const user = userEvent.setup();
    renderTeamsPage("/teams?past=true");
    await weeksTable();
    await user.click(screen.getByRole("button", { name: /Filters/ }));
    await user.click(screen.getByRole("combobox", { name: "Show" }));
    await user.click(await screen.findByRole("option", { name: "Over the WIP limit" }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/teams?warning=wip&past=true"));
    await user.click(screen.getByRole("switch", { name: "Include past weeks" }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/teams?warning=wip"));
    expect(screen.getByTestId("where")).not.toHaveTextContent("past");
  });

  test("?warning=wip&past=true combines: the matching weeks of every date", async () => {
    renderTeamsPage("/teams?warning=wip&past=true");
    const table = await weeksTable();
    expect(weekLabels(table)).toEqual(["W15 · 2027-04-12", "W05 · 2027-02-01"]);
  });

  test("the filter badge counts the switch", async () => {
    const { unmount } = renderTeamsPage("/teams?past=true");
    await weeksTable();
    expect(screen.getByRole("button", { name: /Filters/ })).toHaveTextContent("1");
    unmount();
    renderTeamsPage("/teams?warning=wip&past=true");
    await weeksTable();
    expect(screen.getByRole("button", { name: /Filters/ })).toHaveTextContent("2");
  });

  test("past=1 and past=false read as off", async () => {
    for (const query of ["past=1", "past=false"]) {
      const { unmount } = renderTeamsPage(`/teams?${query}`);
      expect(weekLabels(await weeksTable())).toEqual(["W14 · 2027-04-05", "W15 · 2027-04-12"]);
      unmount();
    }
  });

  test("the teams table counts every week whatever the date hides", async () => {
    renderTeamsPage();
    await weeksTable();
    const backend = within(screen.getByRole("table", { name: "Teams" })).getByRole("link", { name: "Open team Backend" }).closest("tr")!;
    expect(within(backend).getByText("3 weeks overloaded")).toBeInTheDocument();
    expect(within(backend).getByText("2 weeks over WIP limit")).toBeInTheDocument();
  });

  test("a cut document reads the new order in its line", async () => {
    answer = () => jsonResponse(200, teamLoadView(ROWS, { currentWeekStart: CURRENT, warningWeeksTruncated: true }));
    renderTeamsPage();
    await weeksTable();
    expect(screen.getByText("Not every week is listed: the list holds 4 weeks, those from this week on first (the nearest first), then earlier ones (the latest first).")).toBeInTheDocument();
  });

  test("the browser's clock never decides: with the clock far later the same weeks show", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    try {
      renderTeamsPage();
      const table = await weeksTable();
      expect(weekLabels(table)).toEqual(["W14 · 2027-04-05", "W15 · 2027-04-12"]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("speaks Polish in the bundle's own words", async () => {
    await i18n.changeLanguage("pl");
    const { unmount } = renderTeamsPage();
    await screen.findByRole("table", { name: "Tygodnie z ostrzeżeniem według zespołów" });
    expect(screen.getByText("Nie pokazujemy tu 2 wcześniejszych tygodni. Włącz „Pokaż też minione tygodnie”, aby je zobaczyć.")).toBeInTheDocument();
    expect(screen.getByText(/od tygodnia W14 · 2027-04-05, zespół po zespole, od najstarszego/)).toBeInTheDocument();
    unmount();
    answer = () => jsonResponse(200, teamLoadView([ROWS[1]!], { currentWeekStart: CURRENT }));
    renderTeamsPage();
    expect(await screen.findByText("Nie pokazujemy tu 1 wcześniejszego tygodnia. Włącz „Pokaż też minione tygodnie”, aby go zobaczyć.")).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Filtry" }));
    expect(screen.getByRole("switch", { name: "Pokaż też minione tygodnie" })).toBeInTheDocument();
  });
});
