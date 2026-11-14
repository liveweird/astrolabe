import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { Route, Routes, useLocation, useNavigationType } from "react-router-dom";
import i18n from "../i18n";
import { renderWithProviders, screen, waitFor, within } from "../test/render";
import { headingOutline } from "../test/headings";
import { jsonResponse } from "../test/http";
import { milestoneItem, milestonePage } from "../test/milestones";
import Milestones from "./Milestones";

type FetchMock = ReturnType<typeof vi.fn>;

const PLAN = {
  revision: 1,
  workStreams: [{ id: 700, name: "Platform", programs: [{ id: 70, name: "Billing", projects: [{ id: 7, name: "Invoices" }] }] }],
};
const TEAMS = { items: [{ id: 3, name: "Backend" }, { id: 4, name: "Frontend" }], page: 1, pageSize: 100, total: 2 };

const SCHEDULED = milestoneItem({ id: 1, name: "Design" });
const UNSCHEDULED = milestoneItem({ id: 2, name: "Rollout", projectId: 8, projectName: "Payments", teamId: 4, teamName: "Frontend", estimateMd: 2.5, startDate: null, endDate: null });

let answer: (url: string) => Response | Promise<Response>;
let mockFetch: FetchMock;

const listCalls = () => mockFetch.mock.calls.map(([url]) => String(url)).filter((url) => url.startsWith("/api/v1/milestones?"));
const lastQuery = () => new URL(listCalls().at(-1) ?? "", "http://test").searchParams;

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

function renderPage(route = "/milestones") {
  return renderWithProviders(
    <Routes>
      <Route
        path="/milestones"
        element={
          <>
            <Milestones />
            <Where />
          </>
        }
      />
    </Routes>,
    { route },
  );
}

describe("Milestones page", () => {
  beforeEach(() => {
    answer = () => jsonResponse(200, milestonePage([SCHEDULED, UNSCHEDULED]));
    mockFetch = vi.fn((url: string) => {
      if (url.startsWith("/api/v1/milestones?")) return Promise.resolve(answer(url));
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
    await i18n.changeLanguage("en");
  });

  test("lists every milestone in a named table under one h2, with the count, and asks for the project-name sort by default", async () => {
    renderPage();
    const table = await screen.findByRole("table", { name: "Milestones" });
    await screen.findByText("Design");
    expect(headingOutline()).toEqual([[2, "Milestones"]]);
    expect(within(table).getByText("Design")).toBeInTheDocument();
    expect(within(table).getByText("Rollout")).toBeInTheDocument();
    expect(screen.getByText("2 milestones")).toBeInTheDocument();
    expect(lastQuery().get("sort")).toBe("projectName");
    expect(lastQuery().get("page")).toBe("1");
    expect(lastQuery().has("scheduled")).toBe(false);
    expect(screen.getByRole("columnheader", { name: "Project" })).toHaveAttribute("aria-sort", "ascending");
  });

  test("the count is the server's total, not the rows on the page", async () => {
    answer = () => jsonResponse(200, milestonePage([SCHEDULED], { total: 41 }));
    renderPage();
    expect(await screen.findByText("41 milestones")).toBeInTheDocument();
  });

  test("the request carries exactly the URL's filters, scheduled=false included", async () => {
    renderPage("/milestones?scheduled=false&teamId=4&projectId=8&name=roll");
    await screen.findByText("Rollout");
    const query = lastQuery();
    expect(query.get("scheduled")).toBe("false");
    expect(query.get("teamId")).toBe("4");
    expect(query.get("projectId")).toBe("8");
    expect(query.get("name")).toBe("roll");
  });

  test("a malformed filter in the URL is dropped", async () => {
    renderPage("/milestones?scheduled=yes&teamId=abc&projectId=-1");
    await screen.findByText("Design");
    const query = lastQuery();
    expect(["scheduled", "teamId", "projectId", "name"].filter((key) => query.has(key))).toEqual([]);
  });

  test("a project's and a team's name are links to their pages, named by the row", async () => {
    renderPage();
    await screen.findByText("Design");
    expect(screen.getAllByRole("link", { name: "Open Invoices" })[0]).toHaveAttribute("href", "/projects/7");
    expect(screen.getByRole("link", { name: "Open team Backend" })).toHaveAttribute("href", "/teams/3");
    expect(screen.getByRole("link", { name: "Open Payments" })).toHaveAttribute("href", "/projects/8");
  });

  test("a scheduled milestone shows its dates and its estimate, an unscheduled one one dimmed 'Not scheduled'", async () => {
    renderPage();
    const table = await screen.findByRole("table", { name: "Milestones" });
    await screen.findByText("Design");
    const designRow = within(table).getByText("Design").closest("tr")!;
    expect(within(designRow).getByText("2026-03-02")).toBeInTheDocument();
    expect(within(designRow).getByText("2026-03-13")).toBeInTheDocument();
    expect(within(designRow).getByText("5")).toBeInTheDocument();
    const rolloutRow = within(table).getByText("Rollout").closest("tr")!;
    expect(within(rolloutRow).getByText("Not scheduled")).toBeInTheDocument();
    expect(within(rolloutRow).getByText("2.5")).toBeInTheDocument();
    expect(rolloutRow.querySelectorAll("td")).toHaveLength(5);
  });

  test("the Schedule select rewrites the URL by replace and re-reads", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("Design");
    await user.click(screen.getByRole("button", { name: "Filters" }));
    await user.click(screen.getByRole("combobox", { name: "Schedule" }));
    await user.click(await screen.findByRole("option", { name: "Not scheduled" }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/milestones?scheduled=false"));
    expect(screen.getByTestId("nav")).toHaveTextContent("REPLACE");
    await waitFor(() => expect(lastQuery().get("scheduled")).toBe("false"));
    await user.click(screen.getByRole("combobox", { name: "Schedule" }));
    await user.click(await screen.findByRole("option", { name: "All" }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(/^\/milestones$/));
    await waitFor(() => expect(lastQuery().has("scheduled")).toBe(false));
  });

  test("the team select rewrites the URL and re-reads", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("Design");
    await user.click(screen.getByRole("button", { name: "Filters" }));
    await user.click(screen.getByRole("combobox", { name: "Team" }));
    await user.click(await screen.findByRole("option", { name: "Frontend" }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/milestones?teamId=4"));
    expect(screen.getByTestId("nav")).toHaveTextContent("REPLACE");
    await waitFor(() => expect(lastQuery().get("teamId")).toBe("4"));
  });

  test("the name search writes the URL at once and asks the server only for the settled text", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("Design");
    const before = listCalls().length;
    await user.click(screen.getByRole("button", { name: "Filters" }));
    await user.type(screen.getByRole("textbox", { name: "Name" }), "roll");
    expect(screen.getByTestId("where")).toHaveTextContent("/milestones?name=roll");
    expect(screen.getByTestId("nav")).toHaveTextContent("REPLACE");
    await waitFor(() => expect(lastQuery().get("name")).toBe("roll"));
    // The keystrokes ("r", "ro", "rol") were never requested: only the settled text was.
    const names = listCalls().slice(before).map((url) => new URL(url, "http://test").searchParams.get("name"));
    expect(names).toEqual(["roll"]);
    await user.click(screen.getByRole("button", { name: "Clear name filter" }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(/^\/milestones$/));
    await waitFor(() => expect(lastQuery().has("name")).toBe(false));
  });

  test("the typed text wins over a late echo of an earlier keystroke, and a trailing space survives", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("Design");
    await user.click(screen.getByRole("button", { name: "Filters" }));
    const input = screen.getByRole("textbox", { name: "Name" });
    await user.type(input, "ro ");
    expect(input).toHaveValue("ro ");
    expect(screen.getByTestId("where")).toHaveTextContent(/^\/milestones\?name=ro$/);
  });

  test("Clear the filters empties the name input too, because the change came from outside the input", async () => {
    const user = userEvent.setup();
    answer = () => jsonResponse(200, milestonePage([]));
    renderPage("/milestones?name=roll");
    expect(await screen.findByText("No milestone matches the filters")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Filters/ }));
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("roll");
    await user.click(screen.getByRole("button", { name: "Clear the filters" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue(""));
    expect(screen.getByTestId("where")).toHaveTextContent(/^\/milestones$/);
  });

  test("while a re-read runs after the filters are cleared, no empty-state claim and no count are made from the previous answer", async () => {
    const user = userEvent.setup();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    answer = (url) => (url.includes("name=zz") ? jsonResponse(200, milestonePage([])) : gate.then(() => jsonResponse(200, milestonePage([SCHEDULED, UNSCHEDULED]))));
    renderPage("/milestones?name=zz");
    expect(await screen.findByText("No milestone matches the filters")).toBeInTheDocument();
    const before = listCalls().length;
    await user.click(screen.getByRole("button", { name: "Clear the filters" }));
    await waitFor(() => expect(listCalls().length).toBeGreaterThan(before));
    // The new request is in flight; the kept answer is the empty one for name=zz.
    expect(screen.queryByText("The plan has no milestones yet")).not.toBeInTheDocument();
    expect(screen.queryByText("No milestone matches the filters")).not.toBeInTheDocument();
    expect(screen.queryByText("0 milestones")).not.toBeInTheDocument();
    release();
    expect(await screen.findByText("Design")).toBeInTheDocument();
    expect(screen.getByText("2 milestones")).toBeInTheDocument();
    expect(screen.queryByText("The plan has no milestones yet")).not.toBeInTheDocument();
  });

  test("a header click sends the sort", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("Design");
    await user.click(within(screen.getByRole("columnheader", { name: "Project" })).getByRole("button"));
    await waitFor(() => expect(lastQuery().get("sort")).toBe("-projectName"));
    await user.click(within(screen.getByRole("columnheader", { name: "Milestone" })).getByRole("button"));
    await waitFor(() => expect(lastQuery().get("sort")).toBe("name"));
    await user.click(within(screen.getByRole("columnheader", { name: "Team" })).getByRole("button"));
    await waitFor(() => expect(lastQuery().get("sort")).toBe("teamName"));
  });

  test("a filter change goes back to page 1", async () => {
    const user = userEvent.setup();
    answer = (url) => jsonResponse(200, milestonePage([SCHEDULED], { total: 45, page: Number(new URL(url, "http://test").searchParams.get("page")) }));
    renderPage();
    await screen.findByText("Design");
    await user.click(screen.getByRole("button", { name: "2" }));
    await waitFor(() => expect(lastQuery().get("page")).toBe("2"));
    await user.click(screen.getByRole("button", { name: "Filters" }));
    await user.click(screen.getByRole("combobox", { name: "Schedule" }));
    await user.click(await screen.findByRole("option", { name: "Scheduled" }));
    await waitFor(() => expect(lastQuery().get("scheduled")).toBe("true"));
    await waitFor(() => expect(lastQuery().get("page")).toBe("1"));
  });

  test("a projectId from a link is a chip named from the plan view; removing it drops the parameter", async () => {
    const user = userEvent.setup();
    renderPage("/milestones?scheduled=false&projectId=7");
    expect(await screen.findByText("Project: Invoices")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove the project filter" }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(/^\/milestones\?scheduled=false$/));
    await waitFor(() => expect(lastQuery().has("projectId")).toBe(false));
    expect(screen.queryByText("Project: Invoices")).not.toBeInTheDocument();
  });

  test("a project the plan view does not know is named by its number", async () => {
    renderPage("/milestones?projectId=99");
    expect(await screen.findByText("Project: Project 99")).toBeInTheDocument();
  });

  test("an empty plan says so, and offers no clear button", async () => {
    answer = () => jsonResponse(200, milestonePage([]));
    renderPage();
    expect(await screen.findByText("The plan has no milestones yet")).toBeInTheDocument();
    expect(screen.getByText("0 milestones")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Clear the filters" })).not.toBeInTheDocument();
  });

  test("nothing matching says so and Clear the filters empties the URL", async () => {
    const user = userEvent.setup();
    answer = () => jsonResponse(200, milestonePage([]));
    renderPage("/milestones?scheduled=true&teamId=4");
    expect(await screen.findByText("No milestone matches the filters")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear the filters" }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(/^\/milestones$/));
  });

  test("a failed read is the inline alert, with no empty-state claim", async () => {
    answer = () => jsonResponse(500, { title: "x", status: 500 });
    renderPage();
    expect(await screen.findByText("Could not load the milestones")).toBeInTheDocument();
    expect(screen.queryByText("The plan has no milestones yet")).not.toBeInTheDocument();
  });

  test("speaks Polish in the bundle's own words", async () => {
    await i18n.changeLanguage("pl");
    answer = () => jsonResponse(200, milestonePage([SCHEDULED, UNSCHEDULED], { total: 2 }));
    renderPage("/milestones?scheduled=false");
    expect(await screen.findByRole("table", { name: "Kamienie milowe" })).toBeInTheDocument();
    expect(await screen.findByText("2 kamienie milowe")).toBeInTheDocument();
    expect(screen.getByText("Design")).toBeInTheDocument();
    expect(screen.getByText("Szacunek (osobodni)")).toBeInTheDocument();
    expect(screen.getByText("Niezaplanowany")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Otwórz zespół Backend" })).toBeInTheDocument();
  });
});
