import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { Route, Routes, useLocation, useNavigationType } from "react-router-dom";
import { renderWithProviders, screen, waitFor, within } from "../test/render";
import { jsonResponse } from "../test/http";
import { milestoneItem, milestonePage } from "../test/milestones";
import Milestones from "./Milestones";

type FetchMock = ReturnType<typeof vi.fn>;

// Platform (700): Billing (70: Invoices 7, Payments 8), Search (71: Indexing 9); Growth (701): Onboarding (72: Signup 10).
const PLAN = {
  revision: 1,
  workStreams: [
    {
      id: 700,
      name: "Platform",
      programs: [
        { id: 70, name: "Billing", projects: [{ id: 7, name: "Invoices" }, { id: 8, name: "Payments" }] },
        { id: 71, name: "Search", projects: [{ id: 9, name: "Indexing" }] },
      ],
    },
    { id: 701, name: "Growth", programs: [{ id: 72, name: "Onboarding", projects: [{ id: 10, name: "Signup" }] }] },
  ],
};
const TEAMS = { items: [{ id: 3, name: "Backend" }, { id: 4, name: "Frontend" }], page: 1, pageSize: 100, total: 2 };

const SCHEDULED = milestoneItem({ id: 1, name: "Design" });
const UNSCHEDULED = milestoneItem({ id: 2, name: "Rollout", projectId: 8, projectName: "Payments", teamId: 4, teamName: "Frontend", rankPosition: null, estimateMd: 2.5, startDate: null, endDate: null });

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

describe("Milestones page, rank and plan scope", () => {
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
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  test("the request carries the work stream and the program of the URL", async () => {
    renderPage("/milestones?workStreamId=700&programId=70");
    await screen.findByText("Design");
    expect(lastQuery().get("workStreamId")).toBe("700");
    expect(lastQuery().get("programId")).toBe("70");
    expect(lastQuery().has("projectId")).toBe(false);
  });

  test("the Rank column is the first one and shows the project's position, or a dash that assistive technology reads as 'Unranked'", async () => {
    renderPage();
    const table = await screen.findByRole("table", { name: "Milestones" });
    await screen.findByText("Design");
    expect(within(table).getAllByRole("columnheader")[0]).toHaveTextContent("Rank");
    const rankedRow = within(table).getByText("Design").closest("tr")!;
    expect(rankedRow.querySelector("td")).toHaveTextContent("2");
    const unrankedRow = within(table).getByText("Rollout").closest("tr")!;
    const cell = unrankedRow.querySelector("td")!;
    expect(cell).toHaveTextContent("–");
    expect(within(cell).getByText("–")).toHaveAttribute("aria-hidden", "true");
    expect(within(cell).getByText("Unranked")).toBeInTheDocument();
    expect(within(rankedRow).queryByText("Unranked")).not.toBeInTheDocument();
  });

  test("the Rank header asks for the rank, then project name, start and name; descending flips only the first key; the page still opens by project", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("Design");
    expect(lastQuery().get("sort")).toBe("projectName");
    expect(screen.getByRole("columnheader", { name: "Rank" })).toHaveAttribute("aria-sort", "none");
    await user.click(within(screen.getByRole("columnheader", { name: "Rank" })).getByRole("button"));
    await waitFor(() => expect(lastQuery().get("sort")).toBe("rankPosition,projectName,startDate,name"));
    expect(screen.getByRole("columnheader", { name: "Rank" })).toHaveAttribute("aria-sort", "ascending");
    expect(screen.getByRole("columnheader", { name: "Project" })).toHaveAttribute("aria-sort", "none");
    await user.click(within(screen.getByRole("columnheader", { name: "Rank" })).getByRole("button"));
    await waitFor(() => expect(lastQuery().get("sort")).toBe("-rankPosition,projectName,startDate,name"));
    expect(screen.getByRole("columnheader", { name: "Rank" })).toHaveAttribute("aria-sort", "descending");
    await user.click(within(screen.getByRole("columnheader", { name: "Project" })).getByRole("button"));
    await waitFor(() => expect(lastQuery().get("sort")).toBe("projectName"));
  });

  test("the Rank sort is remembered per browser like the others", async () => {
    localStorage.setItem("astrolabe.viewSettings.milestones.paging", JSON.stringify({ sortField: "rankPosition", sortDir: "desc", pageSize: 20 }));
    renderPage();
    await screen.findByText("Design");
    expect(lastQuery().get("sort")).toBe("-rankPosition,projectName,startDate,name");
  });

  const openFilters = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(await screen.findByRole("button", { name: /^Filters/ }));
  };
  const optionsOf = async (user: ReturnType<typeof userEvent.setup>, name: string) => {
    await user.click(screen.getByRole("combobox", { name }));
    await waitFor(() => expect(screen.queryAllByRole("option").length).toBeGreaterThan(0));
    return screen.getAllByRole("option").map((option) => option.textContent);
  };

  test("the Work stream select lists the plan's work streams and writes workStreamId by replace; the request carries it, page 1", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("Design");
    await openFilters(user);
    expect(await optionsOf(user, "Work stream")).toEqual(["Growth", "Platform"]);
    await user.click(screen.getByRole("option", { name: "Platform" }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/milestones?workStreamId=700"));
    expect(screen.getByTestId("nav")).toHaveTextContent("REPLACE");
    await waitFor(() => expect(lastQuery().get("workStreamId")).toBe("700"));
    expect(lastQuery().get("page")).toBe("1");
  });

  test("the Program and Project selects offer only what is under the work stream and program picked above them", async () => {
    const user = userEvent.setup();
    renderPage("/milestones?workStreamId=700");
    await openFilters(user);
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Work stream" })).toHaveValue("Platform"));
    expect(await optionsOf(user, "Program")).toEqual(["Billing", "Search"]);
    await user.click(screen.getByRole("option", { name: "Search" }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/milestones?workStreamId=700&programId=71"));
    await waitFor(() => expect(lastQuery().get("programId")).toBe("71"));
    expect(await optionsOf(user, "Project")).toEqual(["Indexing"]);
  });

  test("without a work stream or program every project is offered", async () => {
    const user = userEvent.setup();
    renderPage();
    await openFilters(user);
    expect(await optionsOf(user, "Project")).toEqual(["Indexing", "Invoices", "Payments", "Signup"]);
  });

  test("picking a work stream drops a program and a project outside it, from the URL and the request", async () => {
    const user = userEvent.setup();
    renderPage("/milestones?teamId=3&programId=70&projectId=7");
    await openFilters(user);
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Project" })).toHaveValue("Invoices"));
    await optionsOf(user, "Work stream");
    await user.click(screen.getByRole("option", { name: "Growth" }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(/^\/milestones\?teamId=3&workStreamId=701$/));
    await waitFor(() => expect(lastQuery().has("programId")).toBe(false));
    expect(lastQuery().has("projectId")).toBe(false);
    expect(lastQuery().get("teamId")).toBe("3");
    expect(lastQuery().get("workStreamId")).toBe("701");
    expect(screen.getByRole("combobox", { name: "Program" })).toHaveValue("");
    expect(screen.getByRole("combobox", { name: "Project" })).toHaveValue("");
    expect(screen.queryByText("Project: Invoices")).not.toBeInTheDocument();
  });

  test("picking a work stream that holds the program and project keeps both", async () => {
    const user = userEvent.setup();
    renderPage("/milestones?programId=70&projectId=7");
    await openFilters(user);
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Program" })).toHaveValue("Billing"));
    await optionsOf(user, "Work stream");
    await user.click(screen.getByRole("option", { name: "Platform" }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/milestones?workStreamId=700&programId=70&projectId=7"));
  });

  test("picking a program drops a project outside it and keeps the work stream", async () => {
    const user = userEvent.setup();
    renderPage("/milestones?workStreamId=700&projectId=7");
    await openFilters(user);
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Project" })).toHaveValue("Invoices"));
    await optionsOf(user, "Program");
    await user.click(screen.getByRole("option", { name: "Search" }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(/^\/milestones\?workStreamId=700&programId=71$/));
    expect(screen.getByRole("combobox", { name: "Project" })).toHaveValue("");
  });

  test("the clear buttons of the Work stream and Program selects drop their parameter and leave the others", async () => {
    const user = userEvent.setup();
    renderPage("/milestones?workStreamId=700&programId=70&projectId=7");
    await openFilters(user);
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Program" })).toHaveValue("Billing"));
    await user.click(screen.getByLabelText("Clear the program filter"));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(/^\/milestones\?workStreamId=700&projectId=7$/));
    await user.click(screen.getByLabelText("Clear the work stream filter"));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(/^\/milestones\?projectId=7$/));
    await waitFor(() => expect(lastQuery().has("workStreamId")).toBe(false));
  });

  test("the badge on the toggle counts a work stream and a program; only the project has a chip", async () => {
    renderPage("/milestones?workStreamId=700&programId=70&projectId=7");
    expect(await screen.findByText("Project: Invoices")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Filters/ })).toHaveTextContent("3");
    expect(screen.queryByText(/^Work stream: /)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Program: /)).not.toBeInTheDocument();
  });

  test("a work stream or program from a link that the plan does not hold is named by its number", async () => {
    const user = userEvent.setup();
    renderPage("/milestones?workStreamId=99&programId=98");
    await openFilters(user);
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Work stream" })).toHaveValue("Work stream 99"));
    expect(screen.getByRole("combobox", { name: "Program" })).toHaveValue("Program 98");
  });

  test("Clear the filters drops the work stream and program too", async () => {
    const user = userEvent.setup();
    answer = () => jsonResponse(200, milestonePage([]));
    renderPage("/milestones?workStreamId=700&programId=70");
    expect(await screen.findByText("No milestone matches the filters")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear the filters" }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(/^\/milestones$/));
  });
});
