import type { DeviationItem } from "../api/deviations";
import type { ProjectView } from "../api/milestones";
import type { JiraLink, JiraSite, PlanFlag } from "../api/roadmap";
import type { TeamView } from "../api/teams";
import { siteUrls } from "./jiraBars";

// What the project and team pages show of the plan nodes linked to Jira (the chips, the milestone menu's link/unlink item): built from the VIEW's own
// `jira` blocks and `jiraSites` (1.3), so it is exactly as current as the view and costs no request of its own.

/** What a page shows of one linked plan node: its Jira key (with the connection's site for the link), the binding (to unlink it) and its OPEN flags by severity. */
export type JiraMark = {
  bindingId: number;
  key: string;
  siteUrl: string | null;
  warnings: number;
  infos: number;
};

/** `PROJECT:7` / `MILESTONE:12`: a node's key in a {@link JiraMarks} map. */
export const markKey = (level: DeviationItem["level"], nodeId: number) => `${level}:${nodeId}`;

export type JiraMarks = {
  byNode: ReadonlyMap<string, JiraMark>;
  /** The open Jira flags of every marked node, by severity (a chip's count). */
  warnings: number;
  infos: number;
};

/** A plan node of a view, as far as the marks need it. */
type MarkedNode = { level: DeviationItem["level"]; id: number; jira: JiraLink | null; flags: readonly Pick<PlanFlag, "kind" | "severity">[] };

/**
 * One mark per node that carries a Jira link. Only `JIRA_DEVIATION` flags are counted: the project's `JIRA_MILESTONES` roll-up repeats what its
 * milestone rows already carry, and counting it would count a deviation twice. The view lists no flag of an acknowledged item or a disabled
 * connection, so these are the OPEN ones.
 */
function marksOf(sites: readonly JiraSite[], nodes: readonly MarkedNode[]): JiraMarks {
  const urls = siteUrls(sites);
  const byNode = new Map<string, JiraMark>();
  let warnings = 0;
  let infos = 0;
  for (const { level, id, jira, flags } of nodes) {
    if (jira === null) continue;
    const own = flags.filter((flag) => flag.kind === "JIRA_DEVIATION");
    const nodeWarnings = own.filter((flag) => flag.severity === "WARNING").length;
    byNode.set(markKey(level, id), { bindingId: jira.bindingId, key: jira.issueKey, siteUrl: urls.get(jira.connectionId) ?? null, warnings: nodeWarnings, infos: own.length - nodeWarnings });
    warnings += nodeWarnings;
    infos += own.length - nodeWarnings;
  }
  return { byNode, warnings, infos };
}

const milestoneNode = (milestone: { id: number; jira: JiraLink | null; flags: readonly PlanFlag[] }): MarkedNode => ({ level: "MILESTONE", ...milestone });

/** The project page's marks: the project's own link and each milestone's (scheduled and in the tray). */
export function projectMarks(view: Pick<ProjectView, "jiraSites" | "project" | "scheduled" | "unscheduled">): JiraMarks {
  const { project } = view;
  return marksOf(view.jiraSites, [{ level: "PROJECT", id: project.id, jira: project.jira, flags: project.flags }, ...[...view.scheduled, ...view.unscheduled].map(milestoneNode)]);
}

/** The team page's marks: each of the team's milestones (scheduled and in the tray) that is linked. */
export function teamMarks(view: Pick<TeamView, "jiraSites" | "scheduled" | "unscheduled">): JiraMarks {
  return marksOf(view.jiraSites, [...view.scheduled, ...view.unscheduled].map(milestoneNode));
}
