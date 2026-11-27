import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useLocation, useNavigationType } from "react-router-dom";
import ProjectMilestonesTable from "./ProjectMilestonesTable";
import type { ProjectMilestone, ProjectView } from "../api/milestones";
import { headingOutline } from "../test/headings";
import { routeFetch } from "../test/http";
import { renderWithProviders } from "../test/render";

// The Milestones table of the project page (1.29): the view's own milestones, filtered by Schedule (in the address), team and name (page state),
// sorted by milestone, team or start, shown or hidden per browser. Every fixture name carries "pm-" so a query never matches the controls' words.

const OPEN_KEY = "astrolabe.viewSettings.project.milestonesOpen";

const milestone = (id: number, name: string, over: Partial<ProjectMilestone> = {}): ProjectMilestone => ({
  jira: null,
  flags: [],
  id,
  projectId: 7,
  name,
  description: null,
  teamId: 3,
  teamName: "Backend",
  estimateMd: 5,
  startDate: null,
  endDate: null,
  createdAt: 1,
  updatedAt: 2,
  slackDays: null,
  critical: false,
  pinned: false,
  can: { edit: true, delete: true, schedule: true },
  ...over,
});

const DISCOVERY = milestone(1, "pm-discovery", { estimateMd: 12.25, startDate: "2027-01-11", endDate: "2027-01-15" });
const BUILD = milestone(2, "pm-build", { teamId: 4, teamName: "Design", startDate: "2027-01-04", endDate: "2027-01-08" });
const ROLLOUT = milestone(3, "pm-rollout", { estimateMd: 2.5 });
const AUDIT = milestone(4, "pm-żółć audit", { teamId: 4, teamName: "Design" });

const viewOf = (scheduled: ProjectMilestone[], unscheduled: ProjectMilestone[]) => ({ scheduled, unscheduled }) as ProjectView;
const VIEW = viewOf([DISCOVERY, BUILD], [ROLLOUT, AUDIT]);

const TEAMS = {
  items: [
    { id: 3, name: "Backend", description: null, managerPersonId: null, managerName: null, colour: "INDIGO", createdAt: 1, updatedAt: 2 },
    { id: 4, name: "Design", description: null, managerPersonId: null, managerName: null, colour: "TEAL", createdAt: 1, updatedAt: 2 },
  ],
  page: 1,
  pageSize: 100,
  total: 2,
};

function Probe() {
  const { pathname, search } = useLocation();
  return (
    <>
      <output data-testid="where">{pathname + search}</output>
      <output data-testid="nav">{useNavigationType()}</output>
    </>
  );
}

const page = (view: ProjectView) => (
  <>
    <ProjectMilestonesTable view={view} />
    <Probe />
  </>
);
const renderTable = (route = "/projects/7", view: ProjectView = VIEW) => renderWithProviders(page(view), { route });

const table = () => screen.getByRole("table", { name: "Milestones of this project" });
const bodyRows = () => within(table()).getAllByRole("row").slice(1);
const milestoneNames = () => bodyRows().map((row) => within(row).getAllByRole("cell")[0].textContent);
const toggle = () => screen.getByRole("button", { name: /milestones table$/ });
const where = () => screen.getByTestId("where").textContent;

beforeEach(() => {
  vi.stubGlobal("fetch", routeFetch({ "GET /api/v1/teams": TEAMS }));
  localStorage.setItem("astrolabe.auth.token", "fake-token");
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("ProjectMilestonesTable", () => {
  test("is shown by default under an h3, as a named table in a named scroll region, earliest start first and the unscheduled last", async () => {
    renderTable();
    expect(headingOutline()).toEqual([[3, "Milestones"]]);
    expect(screen.getByRole("region", { name: "Milestones of this project" })).toHaveAttribute("tabindex", "0");
    expect(within(table()).getAllByRole("columnheader").map((header) => header.textContent)).toEqual(["Milestone", "Team", "Estimate (man-days)", "Start", "End"]);
    expect(milestoneNames()).toEqual(["pm-build", "pm-discovery", "pm-rollout", "pm-żółć audit"]);
    expect(screen.getByRole("columnheader", { name: "Start" })).toHaveAttribute("aria-sort", "ascending");
    expect(screen.getByText("4 milestones")).toBeInTheDocument();
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
    expect(toggle()).toHaveTextContent("Hide the milestones table");
  });

  test("a row says its estimate and dates; a milestone without dates has ONE dimmed cell across the two date columns", async () => {
    renderTable();
    const discovery = bodyRows()[1];
    expect(within(discovery).getAllByRole("cell").map((cell) => cell.textContent)).toEqual(["pm-discovery", "Backend", "12.25", "2027-01-11", "2027-01-15"]);
    const rollout = bodyRows()[2];
    expect(within(rollout).getAllByRole("cell")).toHaveLength(4);
    expect(within(rollout).getByText("Not scheduled").closest("td")).toHaveAttribute("colspan", "2");
  });

  test("the Team cell is a link to the team's page named by its name, with the team's swatch once the teams read answers", async () => {
    renderTable();
    const link = within(bodyRows()[0]).getByRole("link", { name: "Open team Design" });
    expect(link).toHaveAttribute("href", "/teams/4");
    // The swatch sits beside the link, in the same cell (decoration, never part of the link's name).
    await waitFor(() => expect(link.closest("td")?.querySelector("[data-team-colour]")).toHaveAttribute("data-team-colour", "TEAL"));
    expect(within(bodyRows()[1]).getByRole("link", { name: "Open team Backend" }).closest("td")?.querySelector("[data-team-colour]")).toHaveAttribute("data-team-colour", "INDIGO");
  });

  test("the Schedule control rewrites the address by replace, keeping what else the address holds, and narrows the rows", async () => {
    const user = userEvent.setup();
    renderTable("/projects/7?baseline=3");
    await user.click(screen.getByRole("combobox", { name: "Schedule" }));
    await user.click(await screen.findByRole("option", { name: "Not scheduled" }));
    expect(where()).toBe("/projects/7?baseline=3&milestones=unscheduled");
    expect(screen.getByTestId("nav")).toHaveTextContent("REPLACE");
    expect(milestoneNames()).toEqual(["pm-rollout", "pm-żółć audit"]);
    expect(screen.getByText("Showing 2 of 4 milestones")).toBeInTheDocument();
    await user.click(screen.getByRole("combobox", { name: "Schedule" }));
    await user.click(await screen.findByRole("option", { name: "Scheduled" }));
    expect(milestoneNames()).toEqual(["pm-build", "pm-discovery"]);
    expect(where()).toBe("/projects/7?baseline=3&milestones=scheduled");
  });

  test("?milestones= opens a table the browser remembered as hidden, with that choice, and writes no memory; a stale value is no choice", async () => {
    localStorage.setItem(OPEN_KEY, "false");
    renderTable("/projects/7?milestones=unscheduled");
    expect(milestoneNames()).toEqual(["pm-rollout", "pm-żółć audit"]);
    expect(screen.getByRole("combobox", { name: "Schedule" })).toHaveValue("Not scheduled");
    expect(localStorage.getItem(OPEN_KEY)).toBe("false");
  });

  test("an unknown ?milestones= value changes nothing: the remembered choice rules (hidden stays hidden)", () => {
    localStorage.setItem(OPEN_KEY, "false");
    renderTable("/projects/7?milestones=bogus");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
  });

  test("hiding removes the table (it is not rendered, so it does not print) and is remembered; showing brings it back", async () => {
    const user = userEvent.setup();
    const first = renderTable();
    await user.click(toggle());
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Schedule" })).not.toBeInTheDocument();
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    expect(toggle()).toHaveTextContent("Show the milestones table");
    expect(headingOutline()).toEqual([[3, "Milestones"]]);
    expect(localStorage.getItem(OPEN_KEY)).toBe("false");
    // Another visit (a fresh mount) finds it hidden.
    first.unmount();
    renderTable();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    await user.click(toggle());
    expect(table()).toBeInTheDocument();
    expect(localStorage.getItem(OPEN_KEY)).toBe("true");
    expect(toggle()).toHaveFocus();
  });

  test("hiding a table the address opened takes the parameter away, so it really closes (and a reload keeps it closed)", async () => {
    const user = userEvent.setup();
    localStorage.setItem(OPEN_KEY, "false");
    renderTable("/projects/7?milestones=scheduled&baseline=3");
    await user.click(toggle());
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(where()).toBe("/projects/7?baseline=3");
  });

  test("the team select offers only the project's teams and narrows to one; the name filter folds case and accents", async () => {
    const user = userEvent.setup();
    renderTable();
    await user.click(screen.getByRole("combobox", { name: "Team" }));
    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual(["Backend", "Design"]);
    await user.click(screen.getByRole("option", { name: "Design" }));
    expect(milestoneNames()).toEqual(["pm-build", "pm-żółć audit"]);
    await user.type(screen.getByRole("textbox", { name: "Name" }), "ZOLC");
    expect(milestoneNames()).toEqual(["pm-żółć audit"]);
    expect(await screen.findByText("Showing 1 of 4 milestones")).toBeInTheDocument();
    // Team and name are page state, never the address.
    expect(where()).toBe("/projects/7");
  });

  test("nothing matching says so inside the table; Clear the filters brings every milestone and the All choice back", async () => {
    const user = userEvent.setup();
    renderTable("/projects/7?milestones=scheduled");
    await user.type(screen.getByRole("textbox", { name: "Name" }), "rollout");
    expect(within(table()).getByText("No milestone matches the filters")).toBeInTheDocument();
    expect(bodyRows()).toHaveLength(1);
    expect(await screen.findByText("Showing 0 of 4 milestones")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear the filters" }));
    expect(milestoneNames()).toEqual(["pm-build", "pm-discovery", "pm-rollout", "pm-żółć audit"]);
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("");
    expect(screen.queryByRole("button", { name: "Clear the filters" })).not.toBeInTheDocument();
    expect(where()).toBe("/projects/7?milestones=all");
  });

  test("Clear the filters leaves an address without ?milestones= alone", async () => {
    const user = userEvent.setup();
    renderTable("/projects/7?baseline=3");
    await user.type(screen.getByRole("textbox", { name: "Name" }), "rollout");
    await user.click(screen.getByRole("button", { name: "Clear the filters" }));
    expect(milestoneNames()).toHaveLength(4);
    expect(where()).toBe("/projects/7?baseline=3");
  });

  test("the rows follow every change of the name at once; the announced count waits for typing to pause, and an emptied name is announced at once", async () => {
    const user = userEvent.setup();
    renderTable();
    const input = screen.getByRole("textbox", { name: "Name" });
    // The count line is the one status region whose text mentions milestones.
    const announced = () => screen.getAllByRole("status").find((region) => /milestone/.test(region.textContent ?? ""));
    fireEvent.change(input, { target: { value: "rollout" } });
    expect(milestoneNames()).toEqual(["pm-rollout"]);
    expect(announced()).toHaveTextContent("4 milestones");
    expect(await screen.findByText("Showing 1 of 4 milestones")).toBeInTheDocument();
    fireEvent.change(input, { target: { value: "" } });
    expect(milestoneNames()).toHaveLength(4);
    expect(announced()).toHaveTextContent("4 milestones");
    await user.click(screen.getByRole("combobox", { name: "Schedule" }));
    await user.click(await screen.findByRole("option", { name: "Scheduled" }));
    // The Schedule choice is not typing: announced at once.
    expect(announced()).toHaveTextContent("Showing 2 of 4 milestones");
  });

  test("the headers sort by milestone, team and start; the state is aria-sort and a repeat flips it", async () => {
    const user = userEvent.setup();
    renderTable();
    await user.click(within(table()).getByRole("button", { name: "Milestone" }));
    expect(milestoneNames()).toEqual(["pm-build", "pm-discovery", "pm-rollout", "pm-żółć audit"]);
    expect(screen.getByRole("columnheader", { name: "Milestone" })).toHaveAttribute("aria-sort", "ascending");
    await user.click(within(table()).getByRole("button", { name: "Milestone" }));
    expect(milestoneNames()).toEqual(["pm-żółć audit", "pm-rollout", "pm-discovery", "pm-build"]);
    expect(screen.getByRole("columnheader", { name: "Milestone" })).toHaveAttribute("aria-sort", "descending");
    await user.click(within(table()).getByRole("button", { name: "Team" }));
    expect(milestoneNames()).toEqual(["pm-discovery", "pm-rollout", "pm-build", "pm-żółć audit"]);
    await user.click(within(table()).getByRole("button", { name: "Start" }));
    expect(milestoneNames()).toEqual(["pm-build", "pm-discovery", "pm-rollout", "pm-żółć audit"]);
    expect(screen.getByRole("columnheader", { name: "Team" })).toHaveAttribute("aria-sort", "none");
  });

  test("a team filter whose milestones left the project is dropped, not left as an empty table behind a blank select", async () => {
    const user = userEvent.setup();
    const { rerender } = renderTable();
    await user.click(screen.getByRole("combobox", { name: "Team" }));
    await user.click(await screen.findByRole("option", { name: "Design" }));
    expect(milestoneNames()).toEqual(["pm-build", "pm-żółć audit"]);
    rerender(page(viewOf([DISCOVERY], [ROLLOUT])));
    expect(milestoneNames()).toEqual(["pm-discovery", "pm-rollout"]);
    expect(screen.getByText("2 milestones")).toBeInTheDocument();
  });

  test("the filters and the toggle are hidden from print; the table is not (it prints as shown)", () => {
    renderTable();
    expect(toggle()).toHaveAttribute("data-print", "hide");
    expect(screen.getByRole("combobox", { name: "Schedule" }).closest("[data-print]")).toHaveAttribute("data-print", "hide");
    expect(table().closest("[data-print]")).toBeNull();
  });
});
