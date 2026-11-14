import { describe, expect, test } from "vitest";
import { screen, within } from "@testing-library/react";
import RoadmapCriticalChain from "./RoadmapCriticalChain";
import type { RoadmapCriticalPath, RoadmapProject, RoadmapView } from "../api/roadmap";
import { renderWithProviders } from "../test/render";
import { allProjects } from "../utils/roadmapRows";

const project = (id: number, name: string, over: Partial<RoadmapProject> = {}): RoadmapProject =>
  ({ id, name, programName: `Prog ${id}`, span: { start: "2027-02-01", end: "2027-02-26" }, ...over }) as unknown as RoadmapProject;

const viewOf = (criticalPath: RoadmapCriticalPath | undefined, targetOver: Partial<RoadmapProject> = {}) =>
  ({
    ranked: [{ position: 1, project: project(1, "Alpha", targetOver) }],
    unranked: [project(2, "Beta"), project(3, "Gamma", { span: { start: "2027-01-04", end: "2027-01-29" } })],
    ...(criticalPath === undefined ? {} : { criticalPath }),
  }) as unknown as RoadmapView;

/** The panel as the roadmap mounts it. */
const panel = (view: RoadmapView, shown: ReadonlySet<number>) => (
  <RoadmapCriticalChain projects={allProjects(view)} criticalPath={view.criticalPath} shown={shown} intro="roadmap.critical.intro" notShown="roadmap.critical.notShown" />
);

const chain = (projects: RoadmapCriticalPath["projects"], projectId = 1): RoadmapCriticalPath => ({ projectId, projects, pairs: [] });
const ALL = new Set([1, 2, 3]);
const cells = (table: HTMLElement) => within(table).getAllByRole("row").slice(1).map((row) => within(row).getAllByRole("cell").map((cell) => cell.textContent));

describe("RoadmapCriticalChain", () => {
  test("no block: nothing at all", () => {
    renderWithProviders(panel(viewOf(undefined), ALL));
    expect(screen.queryByRole("heading")).toBeNull();
  });

  test("the target's facts, then the upstream projects in the server's order with hops, program, dates, slack and the chain badge", () => {
    renderWithProviders(
      panel(
        viewOf(
          chain([
            { projectId: 3, slackDays: 0, critical: true, hops: 1 },
            { projectId: 2, slackDays: 6, critical: false, hops: 2 },
          ]),
        ),
        ALL,
      ),
    );
    expect(screen.getByRole("heading", { level: 3, name: "Critical path to Alpha" })).toBeInTheDocument();
    expect(screen.getByText("Target: Alpha, 2027-02-01 to 2027-02-26.")).toBeInTheDocument();
    expect(screen.getByText("Projects upstream: 2, on the chain: 1.")).toBeInTheDocument();
    expect(cells(screen.getByRole("table", { name: "Projects upstream of Alpha" }))).toEqual([
      ["1", "Gamma", "Prog 3", "2027-01-04 – 2027-01-29", "0 working days", "On the chain"],
      ["2", "Beta", "Prog 2", "2027-02-01 – 2027-02-26", "6 working days", ""],
    ]);
    const link = screen.getByRole("link", { name: "Open Gamma" });
    expect(link).toHaveAttribute("href", "/projects/3");
  });

  test("an upstream project the filters hide is still listed, with a dimmed (not shown) mark", () => {
    renderWithProviders(panel(viewOf(chain([{ projectId: 3, slackDays: 0, critical: true, hops: 1 }])), new Set([1, 2])));
    const row = screen.getByRole("link", { name: "Open Gamma" }).closest("tr")!;
    expect(row).toHaveTextContent("Gamma (not shown)");
  });

  test("nothing scheduled in the target: that sentence, no table", () => {
    renderWithProviders(panel(viewOf(chain([]), { span: null }), ALL));
    expect(screen.getByText("Nothing is scheduled in Alpha, so no chain drives its end.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByText(/No other project is upstream/)).toBeNull();
  });

  test("a scheduled target with nothing upstream: that sentence, no table", () => {
    renderWithProviders(panel(viewOf(chain([])), ALL));
    expect(screen.getByText("No other project is upstream of Alpha.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });

  test("a target the view does not hold renders nothing", () => {
    renderWithProviders(panel(viewOf(chain([], 99)), ALL));
    expect(screen.queryByRole("heading")).toBeNull();
  });

  test("the programs page mounts it with its own intro and mark: the same panel, the folded-or-not-picked wording", () => {
    const view = viewOf(chain([{ projectId: 3, slackDays: 0, critical: true, hops: 1 }]));
    renderWithProviders(<RoadmapCriticalChain projects={allProjects(view)} criticalPath={view.criticalPath} shown={new Set([1, 2])} intro="programs.critical.intro" notShown="programs.critical.notShown" />);
    expect(screen.getByText(/Projects in a folded row or outside the program pick are listed too\./)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open Gamma" }).closest("tr")).toHaveTextContent("Gamma (folded or not picked)");
  });
});
