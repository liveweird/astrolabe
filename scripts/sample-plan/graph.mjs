// The server's dependency cycle rule as a pure JS port (`planning/DependencyGraph.kt`, `.claude/docs/planning-model.md` "Dependencies"), used by the
// sample-plan generator to draw only links the server accepts, and by the loader's self-test stub to replay the rule on the committed dataset.
//
// Nodes are the START and END time points of every milestone and project. Edges: START(x) -> END(x) for every entity, the containment
// START(project) -> START(milestone) and END(milestone) -> END(project), and one edge per link (X(pred) -> Y(succ): FS END->START, SS START->START,
// FF END->END, SF START->END). Without link edges that graph is a DAG, so a new edge u -> v closes a cycle exactly when v already reaches u. ANY
// directed cycle is refused, lags ignored. The server also keeps at most ONE active link per UNORDERED pair of endpoints (a reverse pair is a
// cycle for most type combinations, the plain "already linked" 409 for the rest), and a link needs two different endpoints.
//
// A link is `{predecessorKind, predecessorRef, successorKind, successorRef, type}` with kind "MILESTONE" | "PROJECT" (the dataset's refs).

const KIND_LETTER = { MILESTONE: "m", PROJECT: "p" };
const predSide = (type) => (type[0] === "F" ? "E" : "S");
const succSide = (type) => (type[1] === "F" ? "E" : "S");

/** The key of a time point: side ("S" | "E"), entity letter and ref. */
export const pointKey = (side, kind, ref) => `${side}${KIND_LETTER[kind]}${ref}`;
const entityKey = (kind, ref) => `${KIND_LETTER[kind]}${ref}`;

/** The unordered pair of a link's endpoints, as one string (the server's "one link per pair" rule). */
export function pairKey(link) {
  const a = entityKey(link.predecessorKind, link.predecessorRef);
  const b = entityKey(link.successorKind, link.successorRef);
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export class TimePointGraph {
  /** `milestones`: the dataset's milestone records (`ref`, `projectRef`); every one takes part, scheduled or not (as on the server). */
  constructor(milestones) {
    this.next = new Map();
    this.pairs = new Set();
    this.stack = [];
    const projects = new Set();
    for (const m of milestones) {
      this.#edge(pointKey("S", "MILESTONE", m.ref), pointKey("E", "MILESTONE", m.ref));
      this.#edge(pointKey("S", "PROJECT", m.projectRef), pointKey("S", "MILESTONE", m.ref));
      this.#edge(pointKey("E", "MILESTONE", m.ref), pointKey("E", "PROJECT", m.projectRef));
      projects.add(m.projectRef);
    }
    for (const p of projects) this.#edge(pointKey("S", "PROJECT", p), pointKey("E", "PROJECT", p));
  }

  #edge(from, to) {
    if (!this.next.has(from)) this.next.set(from, []);
    this.next.get(from).push(to);
  }

  /** How many links the graph holds. */
  get size() {
    return this.stack.length;
  }

  /** The path of time points `from ... to` when `to` is reachable (a point reaches itself), else null. Iterative DFS with parent links. */
  reaches(from, to) {
    if (from === to) return [from];
    const parent = new Map();
    const seen = new Set([from]);
    const stack = [from];
    while (stack.length > 0) {
      const current = stack.pop();
      for (const candidate of this.next.get(current) ?? []) {
        if (seen.has(candidate)) continue;
        seen.add(candidate);
        parent.set(candidate, current);
        if (candidate === to) {
          const path = [to];
          while (parent.has(path[0])) path.unshift(parent.get(path[0]));
          return path;
        }
        stack.push(candidate);
      }
    }
    return null;
  }

  /** The cycle (as time points) the NEW link would close, or null. */
  cycleClosedBy(link) {
    const from = pointKey(predSide(link.type), link.predecessorKind, link.predecessorRef);
    const to = pointKey(succSide(link.type), link.successorKind, link.successorRef);
    return this.reaches(to, from);
  }

  /** Why the server would refuse the link ("self", "pair" or "cycle"), or null when it would accept it. */
  refusal(link) {
    if (link.predecessorKind === link.successorKind && link.predecessorRef === link.successorRef) return "self";
    if (this.pairs.has(pairKey(link))) return "pair";
    return this.cycleClosedBy(link) ? "cycle" : null;
  }

  /** Adds the link when the server would accept it; true if added. */
  tryAdd(link) {
    if (this.refusal(link) !== null) return false;
    const from = pointKey(predSide(link.type), link.predecessorKind, link.predecessorRef);
    this.#edge(from, pointKey(succSide(link.type), link.successorKind, link.successorRef));
    this.pairs.add(pairKey(link));
    this.stack.push({ from, key: pairKey(link) });
    return true;
  }

  /** Removes the most recently added link (a stack discipline, for a chain that did not complete). */
  popLast() {
    const { from, key } = this.stack.pop();
    this.next.get(from).pop();
    this.pairs.delete(key);
  }
}
