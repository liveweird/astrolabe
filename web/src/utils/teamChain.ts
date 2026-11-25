import type { DependencyType, ProjectDependency } from "../api/dependencies";
import type { TeamChainMember, TeamCriticalChain, TeamView } from "../api/teams";
import { EDGES, ghostRowId } from "./dependencyArrows";
import type { DependencyListEnd } from "./dependencyListRows";
import type { BarId, TimelineArrowData } from "./timelineModel";

/**
 * The team page's critical chain (1.27, `GET /views/team/{id}?criticalChain=true`) adapted to the Timeline and to the page's text: the other teams'
 * milestones (and whole projects) on the chain through this team's work become read-only ghost rows after the team's own, the chain's links
 * become critical arrows between them and one table lists every critical arrow of the page. Pure: the block, its order, its caps and the figures
 * are the SERVER's (`.claude/docs/planning-model.md` "The team view"); nothing is recomputed here.
 */

const byText = (a: string, b: string) => (a === b ? 0 : a < b ? -1 : 1);

/** The members in chain order - start, end, name (case-insensitive), kind, id - the order of the appended rows (the server's own order is nearest first, which the cap needs). */
export function orderedMembers(chain: TeamCriticalChain): TeamChainMember[] {
  return [...chain.members].sort(
    (a, b) => byText(a.startDate, b.startDate) || byText(a.endDate, b.endDate) || byText(a.name.toLowerCase(), b.name.toLowerCase()) || byText(a.kind, b.kind) || a.id - b.id,
  );
}

/** A member as the table's end: its name, its project and, for a milestone, its team. A whole project is its own project and has no team. */
const endOf = (member: TeamChainMember): DependencyListEnd => ({
  kind: member.kind,
  id: member.id,
  name: member.name,
  projectId: member.projectId,
  projectName: member.projectName,
  teamId: member.teamId,
  teamName: member.teamName,
});

/** Every day the chain's rows show, for the page's grow-only range. */
export const chainDays = (chain: TeamCriticalChain | undefined): string[] => (chain === undefined ? [] : chain.members.flatMap((member) => [member.startDate, member.endDate]));

/** The team's own projects by id, for the ghost bars' "on the critical chain of": every project the view holds a milestone of (scheduled or in the tray). */
export function chainProjectNames(view: Pick<TeamView, "scheduled" | "unscheduled">): ReadonlyMap<number, string> {
  return new Map([...view.scheduled, ...view.unscheduled].map((milestone) => [milestone.projectId, milestone.projectName]));
}

/**
 * One arrow per link of the block, `critical` (the server only lists critical links) and never violated (a violation ends a chain). `rowOf` answers the
 * row of an end, `null` for one that has none: that link is left out (the server lists a link only between two members, so none is).
 */
export function chainArrowSpecs(chain: TeamCriticalChain, rowOf: (end: { kind: string; id: number }) => BarId | null): TimelineArrowData[] {
  const names = new Map(chain.members.map((member) => [ghostRowId(member), member.name]));
  const specs: TimelineArrowData[] = [];
  for (const link of chain.links) {
    const from = rowOf(link.predecessor);
    const to = rowOf(link.successor);
    if (from === null || to === null) continue;
    const [fromKind, toKind] = EDGES[link.type];
    const label = `${names.get(ghostRowId(link.predecessor)) ?? ""} → ${names.get(ghostRowId(link.successor)) ?? ""}, ${link.type}`;
    specs.push({ id: link.id, from: { row: from, bar: from, kind: fromKind }, to: { row: to, bar: to, kind: toKind }, violated: false, critical: true, label });
  }
  return specs;
}

/** One critical arrow of the page as the table reads it: both ends resolved to their names, projects and teams. */
export type CriticalArrowRow = { id: number; predecessor: DependencyListEnd; successor: DependencyListEnd; type: DependencyType; lagDays: number; sortKey: string };

const ownEnd = (end: ProjectDependency["predecessor"]): DependencyListEnd => ({
  kind: end.kind,
  id: end.id,
  name: end.name,
  projectId: end.projectId,
  projectName: end.projectName,
  teamId: end.teamId,
  teamName: end.teamName,
});

/**
 * Every critical arrow the page can draw: the team's own critical links (`dependencies[]`, with `critical: true`) and the block's links, in chain order
 * (the predecessor's start, then the successor's, then id) - the text equivalent of the arrows, which have none on their own (the svg is `aria-hidden`).
 * Without the block (the toggle is on but the chain has not arrived) the own links are still listed.
 */
export function criticalArrowRows(view: Pick<TeamView, "dependencies">, chain: TeamCriticalChain | undefined): CriticalArrowRow[] {
  const own: CriticalArrowRow[] = view.dependencies
    .filter((dependency) => dependency.critical)
    .map((dependency) => ({
      id: dependency.id,
      predecessor: ownEnd(dependency.predecessor),
      successor: ownEnd(dependency.successor),
      type: dependency.type,
      lagDays: dependency.lagDays,
      sortKey: `${dependency.predecessor.startDate ?? ""} ${dependency.successor.startDate ?? ""}`,
    }));
  const ends = new Map((chain?.members ?? []).map((member) => [ghostRowId(member), member]));
  const linked: CriticalArrowRow[] = (chain?.links ?? []).flatMap((link) => {
    const predecessor = ends.get(ghostRowId(link.predecessor));
    const successor = ends.get(ghostRowId(link.successor));
    if (predecessor === undefined || successor === undefined) return [];
    return [{ id: link.id, predecessor: endOf(predecessor), successor: endOf(successor), type: link.type, lagDays: link.lagDays, sortKey: `${predecessor.startDate} ${successor.startDate}` }];
  });
  return [...own, ...linked].sort((a, b) => byText(a.sortKey, b.sortKey) || a.id - b.id);
}
