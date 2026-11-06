import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import TeamDetails from "./TeamDetails";
import type { TeamMilestone, TeamView } from "../api/teams";
import { endLater, item, view as deviationsView } from "../test/deviations";
import { headingOutline } from "../test/headings";
import { jsonResponse } from "../test/http";
import { renderWithProviders } from "../test/render";

const milestone = (id: number, name: string, over: Partial<TeamMilestone> = {}): TeamMilestone => ({
  id,
  projectId: 7,
  name,
  description: null,
  teamId: 1,
  teamName: "Payments",
  estimateMd: 10,
  startDate: "2027-02-01",
  endDate: "2027-02-05",
  createdAt: 1,
  updatedAt: 2,
  projectName: "Invoices",
  programName: "Billing",
  workStreamName: "Platform",
  rankPosition: 1,
  ...over,
});

const TEAM_VIEW: TeamView = {
  revision: 10,
  team: { id: 1, name: "Payments", description: null, managerPersonId: 12, managerName: "Cara New", createdAt: 1, updatedAt: 2, can: { schedule: false, editCapacity: false, editOrder: false } },
  order: { custom: false, revision: 4, milestoneIds: [] },
  capacity: { periods: [] },
  weeks: [],
  weeksTruncated: false,
  scheduled: [milestone(1, "tv-a"), milestone(2, "tv-b", { startDate: "2027-02-08", endDate: "2027-02-10" })],
  unscheduled: [],
  dependencies: [],
  idleGaps: [],
};

const linked = (id: number, key: string, deviations = [endLater(3)]) =>
  item({ bindingId: id, node: { ...item().node, id, name: `tv-${id}`, teamId: 1, teamName: "Payments" }, jira: { ...item().jira, key }, deviations });

type FetchMock = ReturnType<typeof vi.fn>;
let deviations: { status: number; body: unknown };
let teamView: TeamView;
let hold: Promise<void> | null;

function serve(mockFetch: FetchMock) {
  mockFetch.mockImplementation((url: string) => {
    if (url === "/api/v1/views/team/1") return Promise.resolve(jsonResponse(200, teamView));
    if (url === "/api/v1/public-holidays") return Promise.resolve(jsonResponse(200, { items: [] }));
    if (url === "/api/v1/views/deviations?teamId=1") {
      const answer = () => jsonResponse(deviations.status, deviations.body);
      return hold === null ? Promise.resolve(answer()) : hold.then(answer);
    }
    return Promise.resolve(jsonResponse(404, { title: "Not Found", status: 404 }));
  });
}

describe("the team page's Jira chip", () => {
  let mockFetch: FetchMock;
  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    localStorage.setItem("astrolabe.auth.token", "fake-token");
    localStorage.setItem("astrolabe.auth.roles", JSON.stringify(["USER"]));
    deviations = { status: 200, body: deviationsView({ items: [linked(1, "E2E-3"), linked(2, "E2E-4", [])] }) };
    teamView = TEAM_VIEW;
    hold = null;
    serve(mockFetch);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });
  const renderPage = () => renderWithProviders(<Routes><Route path="/teams/:id" element={<TeamDetails />} /></Routes>, { route: "/teams/1" });

  test("shows how many milestones are linked, a deviation count that opens the page filtered to the team, and a Jira column with each row's key", async () => {
    renderPage();
    const group = await screen.findByRole("group", { name: "Links to Jira" });
    expect(within(group).getByText("2 milestones linked to Jira")).toBeInTheDocument();
    expect(within(group).getByRole("link", { name: "1 Jira deviation" })).toHaveAttribute("href", "/deviations?teamId=1");
    const grid = screen.getByRole("grid", { name: "Team milestone timeline" });
    expect(within(grid).getByRole("columnheader", { name: "Jira" })).toBeInTheDocument();
    const rowA = within(grid).getByRole("row", { name: /tv-a/ });
    expect(within(rowA).getByRole("link", { name: /E2E-3/ })).toHaveAttribute("href", "https://acme.atlassian.net/browse/E2E-3");
    expect(within(rowA).getByText("1 deviation")).toBeInTheDocument();
    expect(within(grid).getByRole("row", { name: /tv-b/ })).toHaveTextContent("E2E-4");
    // The outline is the page's own: the chip adds no heading.
    expect(headingOutline().filter(([level]) => level === 2)).toEqual([[2, "Payments"]]);
  });

  test("a failed or empty deviations answer shows no chip and no column, and the timeline is untouched", async () => {
    deviations = { status: 500, body: { title: "Internal Server Error", status: 500 } };
    renderPage();
    const grid = await screen.findByRole("grid", { name: "Team milestone timeline" });
    await waitFor(() => expect(mockFetch.mock.calls.some(([url]) => url === "/api/v1/views/deviations?teamId=1")).toBe(true));
    expect(screen.queryByRole("group", { name: "Links to Jira" })).not.toBeInTheDocument();
    expect(within(grid).queryByRole("columnheader", { name: "Jira" })).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  test("with nothing linked there is no chip and no column", async () => {
    deviations = { status: 200, body: deviationsView({ items: [] }) };
    renderPage();
    const grid = await screen.findByRole("grid", { name: "Team milestone timeline" });
    await waitFor(() => expect(mockFetch.mock.calls.some(([url]) => url === "/api/v1/views/deviations?teamId=1")).toBe(true));
    expect(screen.queryByRole("group", { name: "Links to Jira" })).not.toBeInTheDocument();
    expect(within(grid).queryByRole("columnheader", { name: "Jira" })).not.toBeInTheDocument();
  });

  test("an unscheduled (tray) milestone carries its key too, so what the chip counts is what is visible", async () => {
    teamView = { ...TEAM_VIEW, unscheduled: [milestone(3, "tv-tray", { startDate: null, endDate: null })] };
    deviations = { status: 200, body: deviationsView({ items: [linked(1, "E2E-3"), linked(3, "E2E-9", [])] }) };
    renderPage();
    expect(await screen.findByText("2 milestones linked to Jira")).toBeInTheDocument();
    const tray = screen.getByRole("table", { name: "Unscheduled milestones of the team" });
    expect(within(tray).getByRole("columnheader", { name: "Jira" })).toBeInTheDocument();
    expect(within(tray).getByRole("link", { name: /E2E-9/ })).toBeInTheDocument();
  });

  test("a FIRST visit lays the table out without the column and adds it when the query answers; the answer is remembered", async () => {
    let release: () => void = () => undefined;
    hold = new Promise<void>((resolve) => (release = resolve));
    renderPage();
    const grid = await screen.findByRole("grid", { name: "Team milestone timeline" });
    expect(within(grid).queryByRole("columnheader", { name: "Jira" })).not.toBeInTheDocument();
    release();
    expect(await within(grid).findByRole("columnheader", { name: "Jira" })).toBeInTheDocument();
    await waitFor(() => expect(localStorage.getItem("astrolabe.viewSettings.teams.jiraColumn.1")).toBe("true"));
  });

  test("a REPEAT visit has the column from the first render (no shift), and drops it when the answer says nothing is linked any more", async () => {
    localStorage.setItem("astrolabe.viewSettings.teams.jiraColumn.1", "true");
    let release: () => void = () => undefined;
    hold = new Promise<void>((resolve) => (release = resolve));
    deviations = { status: 200, body: deviationsView({ items: [] }) };
    renderPage();
    const grid = await screen.findByRole("grid", { name: "Team milestone timeline" });
    expect(within(grid).getByRole("columnheader", { name: "Jira" })).toBeInTheDocument();
    release();
    await waitFor(() => expect(within(grid).queryByRole("columnheader", { name: "Jira" })).not.toBeInTheDocument());
    await waitFor(() => expect(localStorage.getItem("astrolabe.viewSettings.teams.jiraColumn.1")).toBe("false"));
  });

  test("a failed answer keeps what the last visit showed and never stores anything", async () => {
    localStorage.setItem("astrolabe.viewSettings.teams.jiraColumn.1", "true");
    deviations = { status: 500, body: { title: "x", status: 500 } };
    renderPage();
    const grid = await screen.findByRole("grid", { name: "Team milestone timeline" });
    await waitFor(() => expect(mockFetch.mock.calls.some(([url]) => url === "/api/v1/views/deviations?teamId=1")).toBe(true));
    expect(within(grid).getByRole("columnheader", { name: "Jira" })).toBeInTheDocument();
    expect(localStorage.getItem("astrolabe.viewSettings.teams.jiraColumn.1")).toBe("true");
  });
});
