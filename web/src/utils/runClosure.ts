/**
 * The dependency closure of a project, for the run's team picker (1.39): the teams of EVERY project the start project waits on, directly or through a chain, nearest first.
 * Pure: `links` are the Roadmap document's project pairs (predecessor, successor; a link inside one project is never listed there) and `projects` its projects with their
 * distinct `teamIds`; `startIds` are the project(s) the walk starts from (their own teams are not upstream of themselves and are never returned).
 *
 * - Breadth-first, so the nearest projects come first; the projects of one distance are taken by id, so the answer is the same whatever order the document listed them in.
 * - Cycle-safe: a project is walked once, and a start project reached again is not walked again.
 * - A project with no teams adds nothing and the walk goes on through it; a project the document lacks is walked as one with no teams.
 * - The bound: `max` is the size of the WHOLE set the run asks over, `have` being the teams already in it (they count, and are never returned again). A project is taken whole or not at all: the
 *   walk STOPS before the project whose new teams would pass `max` (`cut`), it never skips on to a smaller one further out, so what is returned is always a nearest-first prefix of the chain.
 *   `cut` is true only when something would have been added.
 */
export function upstreamTeamIds(
  links: readonly { predecessorProjectId: number; successorProjectId: number }[],
  projects: readonly { id: number; teamIds: readonly number[] }[],
  startIds: readonly number[],
  max: number,
  have: readonly number[] = [],
): { ids: number[]; cut: boolean } {
  const teamsOf = new Map(projects.map((project) => [project.id, project.teamIds]));
  const before = new Map<number, number[]>();
  for (const link of links) before.set(link.successorProjectId, [...(before.get(link.successorProjectId) ?? []), link.predecessorProjectId]);
  const seen = new Set(startIds);
  const taken = new Set(have);
  const ids: number[] = [];
  let level = [...new Set(startIds)];
  while (level.length > 0) {
    const next = [...new Set(level.flatMap((id) => before.get(id) ?? []))].filter((id) => !seen.has(id)).sort((a, b) => a - b);
    for (const id of next) {
      seen.add(id);
      const fresh = [...new Set(teamsOf.get(id) ?? [])].filter((team) => !taken.has(team));
      if (fresh.length > 0 && taken.size + fresh.length > max) return { ids, cut: true };
      for (const team of fresh) {
        taken.add(team);
        ids.push(team);
      }
    }
    level = next;
  }
  return { ids, cut: false };
}
