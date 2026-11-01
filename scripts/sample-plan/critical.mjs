// A JS port of the v0.7 critical path (`planning/CriticalPathKernels.kt`, `.claude/docs/planning-model.md` "The critical path") over day OFFSETS, with
// the holiday-free Monday-Friday calendar of days.mjs. The generator uses it to MEASURE the zero-slack cross-project chains it draws (`summary.json`),
// and the self-test recomputes the same figures from the written files. The server's kernel stays the truth.
//
// Values: a scheduled milestone has S = workIndex(first working day on or after its start) and E = workIndex(last working day on or before its end) + 1;
// a project (derived span) has min S and max E over its scheduled milestones. An edge from -> to with an offset has slack value(to) - value(from) - offset:
// a milestone's S -> E (offset = its length: slack 0), the containment S(project) -> S(milestone) and E(milestone) -> E(project) (offset 0) and a link
// X(pred) -> Y(succ) with its lag for all four types. A PROJECT has no start-to-end edge. Excluded: a link with an unscheduled end and a VIOLATED link
// (negative slack). For a viewed project p, the upstream set U is every point that reaches E(p) over the included edges; float(E(p)) = 0 and
// float(u) = min(slack(u -> v) + float(v)) over the edges into U; CRITICAL = float 0.
import { nextWorkingOnOrAfter, prevWorkingOnOrBefore, workIndex } from "./days.mjs";
import { endpointResolver } from "./stats.mjs";
import { pointKey } from "./graph.mjs";

const predSide = (type) => (type[0] === "F" ? "E" : "S");
const succSide = (type) => (type[1] === "F" ? "E" : "S");

/** The half-open working-day values of a span: {S, E}. */
const valuesOf = (span) => ({ S: workIndex(nextWorkingOnOrAfter(span.start)), E: workIndex(prevWorkingOnOrBefore(span.end)) + 1 });

/**
 * For every project, the OTHER projects that hold a critical entity in its upstream set, as the server's `report` figures it (the minimum float over the
 * entity's points that are in the set): a milestone of another project whose START is in the set, or a project named by an included link (one arriving
 * in the set); a project that merely contains upstream milestones is not counted. Also the number of cross-project links that are zero-slack INSIDE some
 * project's upstream set (the server's critical links). Returns `{upstream: Map(projectRef -> Set(projectRef)), zeroSlackLinks, sinks, deepest}`:
 * a SINK is a project with at least two such projects whose own chain is not part of another project's critical upstream (so one chain is one sink);
 * `deepest` is the largest number of projects on one chain (the project itself included).
 */
export function criticalChains(milestones, dependencies) {
  const resolver = endpointResolver(milestones);
  const value = new Map(); // point key -> working-day value
  const out = new Map(); // point key -> [{to, slack}]
  const inn = new Map(); // point key -> [from]
  const links = []; // the included links: {from, to, slack, cross}
  const edge = (from, to, slack) => {
    if (!out.has(from)) out.set(from, []);
    if (!inn.has(to)) inn.set(to, []);
    out.get(from).push({ to, slack });
    inn.get(to).push(from);
  };

  for (const m of milestones) {
    if (m.startOffset === null) continue;
    const v = valuesOf({ start: m.startOffset, end: m.endOffset });
    value.set(pointKey("S", "MILESTONE", m.ref), v.S);
    value.set(pointKey("E", "MILESTONE", m.ref), v.E);
  }
  const projectRefs = [...new Set(milestones.map((m) => m.projectRef))];
  for (const p of projectRefs) {
    const span = resolver.span("PROJECT", p);
    if (!span) continue;
    const v = valuesOf(span);
    value.set(pointKey("S", "PROJECT", p), v.S);
    value.set(pointKey("E", "PROJECT", p), v.E);
  }
  for (const m of milestones) {
    if (m.startOffset === null) continue;
    const s = pointKey("S", "MILESTONE", m.ref);
    const e = pointKey("E", "MILESTONE", m.ref);
    edge(s, e, 0);
    edge(pointKey("S", "PROJECT", m.projectRef), s, value.get(s) - value.get(pointKey("S", "PROJECT", m.projectRef)));
    edge(e, pointKey("E", "PROJECT", m.projectRef), value.get(pointKey("E", "PROJECT", m.projectRef)) - value.get(e));
  }
  for (const d of dependencies) {
    const from = pointKey(predSide(d.type), d.predecessorKind, d.predecessorRef);
    const to = pointKey(succSide(d.type), d.successorKind, d.successorRef);
    if (!value.has(from) || !value.has(to)) continue;
    const slack = value.get(to) - value.get(from) - d.lagDays;
    if (slack < 0) continue;
    edge(from, to, slack);
    links.push({ from, to, slack, cross: resolver.projectOf(d.predecessorKind, d.predecessorRef) !== resolver.projectOf(d.successorKind, d.successorRef) });
  }

  const upstream = new Map();
  const criticalLinks = new Set(); // cross-project links that are zero-slack inside some project's upstream set (the server's `criticalDependencies`)
  for (const p of projectRefs) {
    const end = pointKey("E", "PROJECT", p);
    const critical = new Set();
    if (value.has(end)) {
      const reach = new Set([end]);
      const todo = [end];
      while (todo.length > 0) {
        for (const from of inn.get(todo.pop()) ?? []) if (!reach.has(from)) (reach.add(from), todo.push(from));
      }
      const float = new Map([[end, 0]]);
      const solve = (u) => {
        if (float.has(u)) return float.get(u);
        let best = Number.POSITIVE_INFINITY;
        for (const { to, slack } of out.get(u) ?? []) if (reach.has(to)) best = Math.min(best, slack + solve(to));
        float.set(u, best);
        return best;
      };
      for (const u of reach) solve(u);
      // The server's `report`: an entity's figure is the minimum over those of its points in the upstream set; another project's milestone is listed
      // when its START is in it, a project only when an included link (one whose arrival point is in it) names it.
      const figure = (kind, ref) => {
        const points = [pointKey("S", kind, ref), pointKey("E", kind, ref)].filter((k) => float.has(k));
        return points.length === 0 ? null : Math.min(...points.map((k) => float.get(k)));
      };
      const linked = new Set();
      links.forEach((l, i) => {
        if (!reach.has(l.to)) return;
        linked.add(l.from.slice(1));
        linked.add(l.to.slice(1));
        if (l.slack === 0 && float.get(l.to) === 0 && l.cross) criticalLinks.add(i);
      });
      for (const u of reach) {
        if (u[0] !== "S" || u[1] !== "m") continue;
        const ref = Number(u.slice(2));
        const owner = resolver.projectOf("MILESTONE", ref);
        if (owner !== p && figure("MILESTONE", ref) === 0) critical.add(owner);
      }
      for (const entity of linked) {
        if (entity[0] !== "p" || Number(entity.slice(1)) === p) continue;
        if (figure("PROJECT", Number(entity.slice(1))) === 0) critical.add(Number(entity.slice(1)));
      }
    }
    upstream.set(p, critical);
  }

  const deep = [...upstream].filter(([, set]) => set.size >= 2).map(([p]) => p);
  const inside = new Set(deep.flatMap((p) => [...upstream.get(p)]));
  const sinks = deep.filter((p) => !inside.has(p));
  const deepest = Math.max(0, ...[...upstream.values()].map((s) => s.size + 1));
  return { upstream, zeroSlackLinks: criticalLinks.size, sinks, deepest: deepest === 1 ? 0 : deepest };
}
