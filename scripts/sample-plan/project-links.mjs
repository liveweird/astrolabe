// The sample plan's links with a PROJECT endpoint (project -> project, milestone -> project, project -> milestone) and its zero-slack cross-project
// chains, drawn on top of the milestone-to-milestone links of generate.mjs from a SEPARATE seeded stream (so every other file of the dataset is
// untouched by this feature).
//
// Every link is checked against `TimePointGraph` (graph.mjs: the server's cycle rule on the time-point graph with the containment edges, plus the
// one-link-per-unordered-pair rule) BEFORE it is kept, so the loader can never meet a 409.
//
// A zero-slack chain is built BACKWARDS from a tail project: the tail's latest-ending milestone is the landing point; each earlier link ends at the
// current head and starts at the next project, with the lag set to exactly the gap in the drawn schedule (so the link's slack is 0), kept only when it
// fits the dataset's lag range. A middle project is entered at its LATEST-ENDING milestone (its end is the project's end, so the zero path runs on
// through the project) and left from that milestone or from the project's own end; the chain's source is any scheduled milestone or a project. The
// type constraint is the time-point graph's: a link that leaves a milestone's START (SS) needs the chain to enter at that START (FS or SS); one that
// leaves an END (FS, FF) accepts any entering type.
import { prevWorkingOnOrBefore, workIndex } from "./days.mjs";
import { TimePointGraph } from "./graph.mjs";
import { endpointResolver, linkShortfall } from "./stats.mjs";

export const LAG_RANGE = { min: -5, max: 10 };
/** The lags a randomly drawn link takes (the milestone links' own list). */
export const DRAW_LAGS = [0, 0, 0, 0, 1, 2, 3, 5, 10, -1, -2, -5];
export const LINK_TYPES = ["FS", "SS", "FF"];
export const TYPE_WEIGHTS = [70, 15, 15];

/** A link as it is written to dependencies.json (a fixed field order). */
export const toRecord = (link, ref) => ({
  ref,
  predecessorKind: link.predecessorKind,
  predecessorRef: link.predecessorRef,
  successorKind: link.successorKind,
  successorRef: link.successorRef,
  successorProjectRef: link.successorProjectRef,
  type: link.type,
  lagDays: link.lagDays,
});

const milestone = (m) => ({ kind: "MILESTONE", ref: m.ref });
const project = (p) => ({ kind: "PROJECT", ref: p.ref });

/** The scheduled milestone with the latest effective end (the lowest ref on a tie): its end is the project's derived end. */
function latestEnding(list) {
  let best = null;
  for (const m of list) {
    if (m.startOffset === null) continue;
    const end = workIndex(prevWorkingOnOrBefore(m.endOffset));
    if (best === null || end > best.end) best = { m, end };
  }
  return best?.m ?? null;
}

/**
 * The links with a project endpoint. `plan` = `{chainLengths: [projects per chain], extras: {projectToProject, milestoneToProject, projectToMilestone}}`.
 * `milestoneLinks` are the already drawn milestone links (kinds included); returns only the NEW links, chains first.
 */
export function makeProjectLinks(rng, { milestones, projects, milestoneLinks, plan }) {
  const resolver = endpointResolver(milestones);
  const byProject = new Map(projects.map((p) => [p.ref, []]));
  for (const m of milestones) byProject.get(m.projectRef).push(m);
  const graph = new TimePointGraph(milestones);
  for (const link of milestoneLinks) if (!graph.tryAdd(link)) throw new Error(`milestone link ${link.ref} is refused by the cycle rule`);

  const spanOf = (end) => resolver.span(end.kind, end.ref);
  const candidate = (pred, succ, type, lagDays) => ({
    predecessorKind: pred.kind,
    predecessorRef: pred.ref,
    successorKind: succ.kind,
    successorRef: succ.ref,
    successorProjectRef: resolver.projectOf(succ.kind, succ.ref),
    type,
    lagDays,
  });
  /** The lag that makes the link's slack exactly 0 on the drawn schedule. */
  const exactLag = (type, pred, succ) => 0 - linkShortfall(type, 0, spanOf(pred), spanOf(succ));
  /** The types in the order to try: one weighted draw first, the rest after it. */
  const typeOrder = (allowed) => {
    const first = rng.weighted(allowed, allowed.map((t) => TYPE_WEIGHTS[LINK_TYPES.indexOf(t)]));
    return [first, ...allowed.filter((t) => t !== first)];
  };

  const used = new Set(); // projects that are members of a chain
  const links = [];

  // One step back from `head` (a milestone the chain lands on): the first project that offers a link of exactly zero slack within the lag range.
  function extend(head, departs, isSource, members) {
    const allowed = departs === "S" ? ["FS", "SS"] : LINK_TYPES;
    for (const y of rng.shuffle(projects.filter((p) => !used.has(p.ref) && !members.has(p.ref)))) {
      const latest = latestEnding(byProject.get(y.ref));
      if (latest === null) continue;
      for (const type of typeOrder(allowed)) {
        let options;
        if (isSource) {
          const scheduled = byProject.get(y.ref).filter((m) => m.startOffset !== null);
          options = rng.shuffle([project(y), milestone(latest), milestone(rng.pick(scheduled))]);
        } else {
          // Leaving the middle project's END reaches the chain's next point from the milestone or from the project; its START cannot.
          options = type === "SS" ? [milestone(latest)] : rng.chance(0.4) ? [project(y), milestone(latest)] : [milestone(latest), project(y)];
        }
        for (const pred of options) {
          const lagDays = exactLag(type, pred, head);
          if (lagDays < LAG_RANGE.min || lagDays > LAG_RANGE.max) continue;
          const link = candidate(pred, head, type, lagDays);
          if (graph.tryAdd(link)) return { link, project: y, node: milestone(latest), departs: type[0] === "F" ? "E" : "S" };
        }
      }
    }
    return null;
  }

  for (const length of [...plan.chainLengths].sort((a, b) => b - a)) {
    let built = null;
    for (const tail of rng.shuffle(projects.filter((p) => !used.has(p.ref)))) {
      const landing = latestEnding(byProject.get(tail.ref));
      if (landing === null) continue;
      const chain = [];
      const members = new Set([tail.ref]);
      let head = milestone(landing);
      let departs = null;
      for (let step = 1; step < length; step++) {
        const next = extend(head, departs, step === length - 1, members);
        if (next === null) break;
        chain.push(next.link);
        members.add(next.project.ref);
        head = next.node;
        departs = next.departs;
      }
      if (chain.length === length - 1) {
        built = { chain, members };
        break;
      }
      for (let i = 0; i < chain.length; i++) graph.popLast();
    }
    if (built === null) throw new Error(`no zero-slack chain of ${length} projects fits the drawn schedule`);
    for (const ref of built.members) used.add(ref);
    links.push(...built.chain.toReversed()); // source first
  }

  // The remaining project-endpoint links: random pairs of different projects, drawn like the milestone links (a candidate the schedule already
  // violates is kept 1 time in 5), until each direction has its quota.
  const extraKinds = [["projectToProject", false, false], ["milestoneToProject", true, false], ["projectToMilestone", false, true]];
  for (const [name, predIsMilestone, succIsMilestone] of extraKinds) {
    for (let made = 0, attempts = 0; made < plan.extras[name]; attempts++) {
      if (attempts > 20_000) throw new Error(`could not draw ${plan.extras[name]} ${name} links`);
      const [a, b] = rng.shuffle(projects).slice(0, 2);
      const pred = predIsMilestone ? milestone(rng.pick(byProject.get(a.ref))) : project(a);
      const succ = succIsMilestone ? milestone(rng.pick(byProject.get(b.ref))) : project(b);
      const type = rng.weighted(LINK_TYPES, TYPE_WEIGHTS);
      const lagDays = rng.pick(DRAW_LAGS);
      if (linkShortfall(type, lagDays, spanOf(pred), spanOf(succ)) > 0 && !rng.chance(0.2)) continue;
      if (graph.tryAdd(candidate(pred, succ, type, lagDays))) {
        links.push(candidate(pred, succ, type, lagDays));
        made++;
      }
    }
  }
  return links;
}
