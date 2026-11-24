import { describe, expect, test } from "vitest";
import { screen, within } from "@testing-library/react";
import ProjectDependencies from "./ProjectDependencies";
import type { DependencyEndpoint, ProjectDependency } from "../api/dependencies";
import type { ProjectView } from "../api/milestones";
import { renderWithProviders } from "../test/render";

const endpoint = (id: number, name: string): DependencyEndpoint => ({
  kind: "MILESTONE",
  id,
  name,
  projectId: 7,
  projectName: "Invoices",
  teamId: 3,
  teamName: "Backend",
  startDate: "2027-02-01",
  endDate: "2027-02-05",
});

const link = (id: number, over: Partial<ProjectDependency> = {}): ProjectDependency => ({
  id,
  predecessor: endpoint(id * 10, `p${id}`),
  successor: endpoint(id * 10 + 1, `s${id}`),
  type: "FS",
  lagDays: 0,
  check: { status: "OK", shortfallDays: null, slackDays: 5, requiredDate: "2027-02-08", actualDate: "2027-02-15" },
  critical: false,
  can: { edit: false, delete: false },
  ...over,
});

const OK_CRITICAL = link(1, { critical: true, check: { status: "OK", shortfallDays: null, slackDays: 0, requiredDate: "2027-02-08", actualDate: "2027-02-08" } });
const OK_SLACK = link(2);
const VIOLATED = link(3, { check: { status: "VIOLATED", shortfallDays: 2, slackDays: -2, requiredDate: "2027-02-08", actualDate: "2027-02-04" } });
const NOT_YET = link(4, { check: { status: "UNSCHEDULED", shortfallDays: null, slackDays: null, requiredDate: null, actualDate: null } });

const view = { project: { id: 7, can: { createDependency: false } }, dependencies: [OK_CRITICAL, OK_SLACK, VIOLATED, NOT_YET] } as unknown as ProjectView;

const table = () => screen.getByRole("table", { name: "Dependencies of the project" });
const rows = () => within(table()).getAllByRole("row").slice(1);

function renderSection(showCritical?: boolean) {
  return renderWithProviders(<ProjectDependencies view={view} onAdd={() => undefined} onEdit={() => undefined} showCritical={showCritical} />);
}

describe("ProjectDependencies: the Slack column (1.7)", () => {
  test("off: no Slack header and no Slack cell - the table is the one it was", () => {
    renderSection();
    expect(within(table()).getAllByRole("columnheader").map((header) => header.textContent)).toEqual(["Status", "Predecessor", "Type", "Lag", "Successor", "Dates", ""]);
    expect(within(rows()[0]).getAllByRole("cell")).toHaveLength(7);
  });

  test("on: a Slack header after Dates; each link reads its own slack, a critical one carries the hidden words, an unscheduled one a dash", () => {
    renderSection(true);
    expect(within(table()).getAllByRole("columnheader").map((header) => header.textContent)).toEqual(["Status", "Predecessor", "Type", "Lag", "Successor", "Dates", "Slack", ""]);
    const slack = rows().map((row) => within(row).getAllByRole("cell")[6].textContent);
    expect(slack).toEqual(["0 critical path", "5 working days", "-2 working days", "—"]);
  });

  test("on: the critical link keeps its Critical path badge beside the slack", () => {
    renderSection(true);
    expect(within(rows()[0]).getByText("Critical path")).toBeInTheDocument();
    expect(within(rows()[1]).queryByText("Critical path")).toBeNull();
  });
});

describe("ProjectDependencies: the baseline marker (1.26)", () => {
  const withMarks = (marks: (boolean | undefined)[]) =>
    ({ project: { id: 7, can: { createDependency: false } }, dependencies: marks.map((mark, index) => link(index + 1, mark === undefined ? {} : { newSinceBaseline: mark })) }) as unknown as ProjectView;
  const renderMarks = (marks: (boolean | undefined)[]) => renderWithProviders(<ProjectDependencies view={withMarks(marks)} onAdd={() => undefined} onEdit={() => undefined} />);

  test("only a link marked newSinceBaseline carries the badge, and it is gray: false and absent (no baseline, or links not captured) say nothing", () => {
    renderMarks([true, false, undefined]);
    expect(within(rows()[0]).getByText("New since the baseline").closest(".mantine-Badge-root")!.getAttribute("style") ?? "").toContain("gray");
    expect(within(rows()[1]).queryByText("New since the baseline")).toBeNull();
    expect(within(rows()[2]).queryByText("New since the baseline")).toBeNull();
    expect(screen.getAllByText("New since the baseline")).toHaveLength(1);
  });

  test("the marker sits beside the status badge and never replaces it, a violated link stays red", () => {
    const violated = link(1, { newSinceBaseline: true, check: { status: "VIOLATED", shortfallDays: 2, slackDays: -2, requiredDate: "2027-02-08", actualDate: "2027-02-04" } });
    renderWithProviders(<ProjectDependencies view={{ project: { id: 7, can: { createDependency: false } }, dependencies: [violated] } as unknown as ProjectView} onAdd={() => undefined} onEdit={() => undefined} />);
    const cell = within(rows()[0]).getAllByRole("cell")[0];
    expect(within(cell).getByText(/Violated/).closest(".mantine-Badge-root")!.getAttribute("style") ?? "").toContain("red");
    expect(within(cell).getByText("New since the baseline")).toBeInTheDocument();
  });
});
