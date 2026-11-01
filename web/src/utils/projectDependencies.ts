import type { DependencyEndpoint, DependencyType, ProjectDependency } from "../api/dependencies";
import type { ProjectView } from "../api/milestones";
import type { BarId, TimelineArrowData } from "./timelineModel";

/**
 * The project view's dependencies adapted to the Timeline (`.claude/docs/timeline.md` "Arrows"): which external endpoints become
 * ghost rows, whether the project gets its summary row, and the arrows between rows. Pure: it only arranges what the server
 * resolved — the checks (`status`, shortfall, dates) are the server's, never recomputed here.
 */

/** The summary row's id (and its one bar's): the project itself as an endpoint. Strings never collide with the milestones' numeric ids. */
export const projectRowId = (projectId: number): string => `project:${projectId}`;

/** A ghost row's id (and its one bar's): another project's milestone or another project. */
export const ghostRowId = (endpoint: DependencyEndpoint): string => (endpoint.kind === "MILESTONE" ? `ghost:m:${endpoint.id}` : `ghost:p:${endpoint.id}`);

const isOwnProject = (endpoint: DependencyEndpoint, view: ProjectView) => endpoint.kind === "PROJECT" && endpoint.id === view.project.id;
const isOwnMilestone = (endpoint: DependencyEndpoint, view: ProjectView) => endpoint.kind === "MILESTONE" && endpoint.projectId === view.project.id;
const isExternal = (endpoint: DependencyEndpoint, view: ProjectView) => endpoint.projectId !== view.project.id;

const ends = (dependency: ProjectDependency) => [dependency.predecessor, dependency.successor];

const byText = (a: string, b: string) => (a === b ? 0 : a < b ? -1 : 1);

/** The distinct endpoints of other projects that have dates (a project's dates are its derived span), by start, end, name (case-insensitive), kind, id. */
export function ghostEndpoints(view: ProjectView): DependencyEndpoint[] {
  const byRow = new Map<string, DependencyEndpoint>();
  for (const endpoint of view.dependencies.flatMap(ends)) {
    if (isExternal(endpoint, view) && endpoint.startDate !== null && endpoint.endDate !== null) byRow.set(ghostRowId(endpoint), endpoint);
  }
  return [...byRow.values()].sort(
    (a, b) =>
      byText(a.startDate ?? "", b.startDate ?? "") ||
      byText(a.endDate ?? "", b.endDate ?? "") ||
      byText(a.name.toLowerCase(), b.name.toLowerCase()) ||
      byText(a.kind, b.kind) ||
      a.id - b.id,
  );
}

/** The summary row exists only while the project ITSELF is an endpoint of at least one link (v0.6's project rows will make it unconditional). */
export function summaryRowNeeded(view: ProjectView): boolean {
  return view.dependencies.some((dependency) => ends(dependency).some((endpoint) => isOwnProject(endpoint, view)));
}

/** How many links are violated: the "N conflicts" badge. */
export function conflictCount(view: ProjectView): number {
  return view.dependencies.filter((dependency) => dependency.check.status === "VIOLATED").length;
}

/** Violated links per own bar (an own milestone's id, or the summary row's id), counting a link on both of its own ends — the bar's accessible name says so. */
export function conflictsByBar(view: ProjectView): Map<BarId, number> {
  const counts = new Map<BarId, number>();
  for (const dependency of view.dependencies) {
    if (dependency.check.status !== "VIOLATED") continue;
    for (const endpoint of ends(dependency)) {
      const bar = isOwnProject(endpoint, view) ? projectRowId(view.project.id) : isOwnMilestone(endpoint, view) ? endpoint.id : null;
      if (bar !== null) counts.set(bar, (counts.get(bar) ?? 0) + 1);
    }
  }
  return counts;
}

/** How many active links end on a milestone of this project (either end): what its delete takes with it. */
export function linksOfMilestone(view: ProjectView, milestoneId: number): number {
  return view.dependencies.filter((dependency) => ends(dependency).some((endpoint) => isOwnMilestone(endpoint, view) && endpoint.id === milestoneId)).length;
}

/** The row and bar (one and the same id for the synthetic rows) an endpoint is drawn on; a milestone of this project is its own row. */
function barOf(endpoint: DependencyEndpoint, view: ProjectView): BarId {
  if (isOwnProject(endpoint, view)) return projectRowId(view.project.id);
  return isOwnMilestone(endpoint, view) ? endpoint.id : ghostRowId(endpoint);
}

/** Dependency type to the bar edges its arrow joins: the predecessor's, then the successor's. */
const EDGES: Record<DependencyType, readonly ["START" | "END", "START" | "END"]> = {
  FS: ["END", "START"],
  SS: ["START", "START"],
  FF: ["END", "END"],
  SF: ["START", "END"],
};

/**
 * One arrow per link that has dates on both ends (an UNSCHEDULED link has no bar to point at). The Timeline skips an arrow whose row
 * or bar it does not have (a tray milestone's, a project with no span), so a link to one is simply not drawn.
 */
export function arrowSpecs(view: ProjectView): TimelineArrowData[] {
  return view.dependencies
    .filter((dependency) => dependency.check.status !== "UNSCHEDULED")
    .map((dependency) => {
      const [fromKind, toKind] = EDGES[dependency.type];
      const from = barOf(dependency.predecessor, view);
      const to = barOf(dependency.successor, view);
      return {
        id: dependency.id,
        from: { row: from, bar: from, kind: fromKind },
        to: { row: to, bar: to, kind: toKind },
        violated: dependency.check.status === "VIOLATED",
        label: `${dependency.predecessor.name} → ${dependency.successor.name}, ${dependency.type}`,
      };
    });
}
