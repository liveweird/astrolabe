import type { DependencyListView } from "../api/dependencyList";
import type { components } from "../api/schema";
import { MalformedAnswerError } from "../api/http";

type Schemas = components["schemas"];

/**
 * One end of a dependency as the table reads it: the name, the project and (a milestone only) the team, joined from the document's three
 * lists. A whole-project end is its own project (`projectId` = `id`) and has no team.
 */
export type DependencyListEnd = {
  kind: Schemas["EndpointKind"];
  id: number;
  name: string;
  projectId: number;
  projectName: string;
  teamId: number | null;
  teamName: string | null;
};

/** One dependency with both ends resolved: the wire row (kind and id per end) with the ends joined back to their names. */
export type DependencyListRow = Omit<Schemas["DependencyListRow"], "predecessor" | "successor"> & {
  predecessor: DependencyListEnd;
  successor: DependencyListEnd;
};

/** The document with its rows resolved; the three name lists have done their work and are gone. */
export type ResolvedDependencyList = Omit<DependencyListView, "projects" | "teams" | "milestones" | "dependencies"> & {
  dependencies: DependencyListRow[];
};

function lookup<T extends { id: number }>(items: readonly T[], what: string): (id: number) => T {
  const byId = new Map(items.map((item) => [item.id, item]));
  return (id) => {
    const found = byId.get(id);
    // A reference the document does not resolve is a broken answer, never a blank cell: TanStack Query turns the throw (this runs in the
    // page's query function) into the query's error, which the page shows as its failed read.
    if (found === undefined) throw new MalformedAnswerError(`The dependency list names a ${what} (${id}) it does not hold`);
    return found;
  };
}

/**
 * Joins the dependencies document's names back onto its rows, once, in the page's query function: a milestone end takes its name from
 * `milestones`, its project's from `projects` and its team's from `teams`; a project end its own name from `projects`. Figures and flags
 * (`revision`, `totals`, `truncated`) pass through as the server sent them. Throws when a reference is not in the lists.
 */
export function resolveDependencyList(view: DependencyListView): ResolvedDependencyList {
  const milestone = lookup(view.milestones, "milestone");
  const project = lookup(view.projects, "project");
  const team = lookup(view.teams, "team");
  const end = (ref: Schemas["EndpointRef"]): DependencyListEnd => {
    if (ref.kind === "PROJECT") {
      const own = project(ref.id);
      return { kind: "PROJECT", id: own.id, name: own.name, projectId: own.id, projectName: own.name, teamId: null, teamName: null };
    }
    const own = milestone(ref.id);
    return {
      kind: "MILESTONE",
      id: own.id,
      name: own.name,
      projectId: own.projectId,
      projectName: project(own.projectId).name,
      teamId: own.teamId,
      teamName: team(own.teamId).name,
    };
  };
  const { revision, totals, truncated } = view;
  return {
    revision,
    totals,
    truncated,
    dependencies: view.dependencies.map((row) => ({ ...row, predecessor: end(row.predecessor), successor: end(row.successor) })),
  };
}
