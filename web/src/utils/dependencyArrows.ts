import type { DependencyEndpoint, DependencyType, ProjectDependency } from "../api/dependencies";
import type { BarId, TimelineArrowData } from "./timelineModel";

/**
 * The view-independent part of turning a view's `dependencies[]` into Timeline arrows and conflict counts (the project view's and the
 * team view's share it). Pure: the checks (`status`, shortfall, dates) are the SERVER's and are only read here. A page decides which
 * row/bar an endpoint is drawn on (`rowOf`/`barOf`); an endpoint it answers `null` for has no bar on that timeline.
 */

/** Dependency type to the bar edges its arrow joins: the predecessor's, then the successor's. */
export const EDGES: Record<DependencyType, readonly ["START" | "END", "START" | "END"]> = {
  FS: ["END", "START"],
  SS: ["START", "START"],
  FF: ["END", "END"],
  SF: ["START", "END"],
};

/** How many links are violated: the "N conflicts" badge. */
export function conflictCountOf(dependencies: readonly ProjectDependency[]): number {
  return dependencies.filter((dependency) => dependency.check.status === "VIOLATED").length;
}

/** Violated links per bar, counting a link on both of its ends when both are bars of this timeline — the bar's accessible name says so. */
export function conflictsByBarFor(dependencies: readonly ProjectDependency[], barOf: (endpoint: DependencyEndpoint) => BarId | null): Map<BarId, number> {
  const counts = new Map<BarId, number>();
  for (const dependency of dependencies) {
    if (dependency.check.status !== "VIOLATED") continue;
    for (const endpoint of [dependency.predecessor, dependency.successor]) {
      const bar = barOf(endpoint);
      if (bar !== null) counts.set(bar, (counts.get(bar) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * One arrow per link that has dates on both ends (an UNSCHEDULED link has no bar to point at) and a row on this timeline for both
 * ends (`rowOf`: a row's id, which is also its one bar's id; `null` = not on this timeline, so the arrow is left out). The
 * Timeline itself still skips an arrow whose row it does not mount, so a link to a tray milestone is simply not drawn.
 */
export function arrowSpecsFor(dependencies: readonly ProjectDependency[], rowOf: (endpoint: DependencyEndpoint) => BarId | null): TimelineArrowData[] {
  const specs: TimelineArrowData[] = [];
  for (const dependency of dependencies) {
    if (dependency.check.status === "UNSCHEDULED") continue;
    const from = rowOf(dependency.predecessor);
    const to = rowOf(dependency.successor);
    if (from === null || to === null) continue;
    const [fromKind, toKind] = EDGES[dependency.type];
    specs.push({
      id: dependency.id,
      from: { row: from, bar: from, kind: fromKind },
      to: { row: to, bar: to, kind: toKind },
      violated: dependency.check.status === "VIOLATED",
      label: `${dependency.predecessor.name} → ${dependency.successor.name}, ${dependency.type}`,
    });
  }
  return specs;
}
