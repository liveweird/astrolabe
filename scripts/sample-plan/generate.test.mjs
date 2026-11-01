// Self-test of the sample-plan generator: `node --test scripts/sample-plan/generate.test.mjs` (Node >= 24, no install, no network).
// It pins determinism (two runs, identical bytes; the committed files equal a fresh run), the headline counts, the Zipf team sizes, the
// referential integrity, acyclicity of the dependency graph, and that every value respects the server's own limits (V14 estimates, V16
// capacity CHECKs, the working-day rule, name lengths) - the rules the loader would otherwise meet as 400s.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { COUNTS, DEFAULT_SEED, FILES, SAMPLE_EMAIL_DOMAIN, buildDataset, periodsOf, render, zipfSizes } from "./generate.mjs";
import { containsWorkingDay, dayOfWorkIndex, isMonday, isoDateAt, mondayOfWeek, weekday, workIndex, workingDaysBetween } from "./days.mjs";
import { linkShortfall, overallRates, weekCapacity, weeklyRows } from "./stats.mjs";
import { TimePointGraph } from "./graph.mjs";
import { criticalChains } from "./critical.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ds = buildDataset(DEFAULT_SEED);
const projects = ds.plan.workStreams.flatMap((w) => w.programs.flatMap((p) => p.projects));
const programs = ds.plan.workStreams.flatMap((w) => w.programs);
const unique = (list) => new Set(list).size === list.length;
const decimals2 = (x) => Math.round(x * 100) / 100 === x;

test("two runs write identical bytes, a different seed does not", () => {
  assert.deepEqual(render(buildDataset(DEFAULT_SEED)), render(ds));
  assert.notDeepEqual(render(buildDataset(DEFAULT_SEED + 1)), render(ds));
});

test("the committed sample-data/plan equals a fresh run (the generator is platform-independent)", () => {
  for (const [file, text] of Object.entries(render(ds))) {
    assert.equal(readFileSync(path.join(ROOT, "sample-data", "plan", file), "utf8"), text, `${file} drifted: node scripts/sample-plan/generate.mjs`);
  }
});

test("the headline counts", () => {
  assert.equal(ds.people.length, COUNTS.people);
  assert.equal(ds.teams.length, COUNTS.teams);
  assert.equal(ds.plan.workStreams.length, COUNTS.workStreams);
  assert.equal(programs.length, COUNTS.programs);
  assert.equal(projects.length, COUNTS.projects);
  assert.equal(ds.milestones.length, COUNTS.milestones);
  assert.equal(ds.dependencies.length, ds.summary.counts.dependencies);
  assert.ok(ds.dependencies.length >= COUNTS.milestoneDependencies + Object.values(COUNTS.projectDependencies).reduce((a, b) => a + b, 0), "the milestone links plus at least every project-endpoint quota");
  assert.ok(ds.dependencies.slice(0, COUNTS.milestoneDependencies).every((d) => d.predecessorKind === "MILESTONE" && d.successorKind === "MILESTONE"), "the first 300 are the milestone links");
  assert.equal(ds.ranking.projectRefs.length, COUNTS.rankedProjects);
  assert.equal(ds.teamOrders.length, COUNTS.customOrderTeams);
  assert.equal(projects.filter((p) => p.targetStartOffset !== null).length, COUNTS.targetWindows);
  assert.equal(ds.milestones.filter((m) => m.startOffset === null).length, COUNTS.unscheduled);
  assert.deepEqual(ds.summary.counts.workStreams, 5);
  assert.ok(Object.keys(FILES).length === 9);
});

test("team sizes are Zipf-distributed and two or more teams exceed the 80-row virtualisation threshold", () => {
  const sizes = ds.teams.map((t) => ds.milestones.filter((m) => m.teamRef === t.ref).length);
  assert.deepEqual(sizes, zipfSizes(COUNTS.teams, COUNTS.milestones, 1));
  assert.equal(sizes.reduce((a, b) => a + b, 0), COUNTS.milestones);
  for (let i = 1; i < sizes.length; i++) assert.ok(sizes[i] <= sizes[i - 1], "sizes never grow with the rank");
  // The rank-size rule: size(k) ~ size(1) / k, within the rounding of whole milestones.
  sizes.forEach((size, i) => assert.ok(Math.abs(size - sizes[0] / (i + 1)) <= 3, `team ${i + 1}: ${size} vs ${sizes[0] / (i + 1)}`));
  assert.ok(sizes.filter((s) => s > 80).length >= 2, "at least two teams take the virtual path");
  assert.ok(sizes.at(-1) >= 18 && sizes.at(-1) <= 24, `smallest team ${sizes.at(-1)}`);
  const scheduled = ds.teams.map((t) => ds.milestones.filter((m) => m.teamRef === t.ref && m.startOffset !== null).length);
  assert.deepEqual(Object.values(ds.summary.scheduledByTeam), scheduled);
  assert.ok(scheduled.some((n) => n >= 60 && n <= 79), "one team of about 65 rows exercises the plain path");
  assert.ok(scheduled.filter((n) => n > 80).length >= 2, "two teams exceed 80 SCHEDULED rows");
});

test("people, owners and managers: unique, sample-domain, all referenced", () => {
  assert.ok(unique(ds.people.map((p) => p.email)) && unique(ds.people.map((p) => p.name)));
  for (const p of ds.people) assert.match(p.email, new RegExp(`^[a-z]+\\.[a-z]+@${SAMPLE_EMAIL_DOMAIN.replaceAll(".", "\\.")}$`));
  const refs = new Set(ds.people.map((p) => p.ref));
  const used = new Set([...ds.teams.map((t) => t.managerRef), ...ds.plan.workStreams.map((w) => w.ownerRef), ...programs.map((p) => p.ownerRef), ...projects.map((p) => p.ownerRef)]);
  for (const r of used) assert.ok(refs.has(r), `person ${r} exists`);
  assert.equal(used.size, ds.people.length, "every person owns or manages something");
  assert.ok(unique(ds.teams.map((t) => t.managerRef)), "one manager per team");
});

test("names are unique where the server requires it and within its length limits", () => {
  const ci = (list) => list.map((s) => s.toLowerCase());
  assert.ok(unique(ci(ds.teams.map((t) => t.name))));
  assert.ok(unique(ci(ds.plan.workStreams.map((w) => w.name))));
  assert.ok(unique(ci(programs.map((p) => p.name))), "program names are unique across work streams");
  assert.ok(unique(ci(projects.map((p) => p.name))));
  for (const p of projects) assert.ok(p.name.length <= 100);
  for (const [, list] of Map.groupBy(ds.milestones, (m) => m.projectRef)) assert.ok(unique(ci(list.map((m) => m.name))), "milestone names are unique per project");
  for (const m of ds.milestones) assert.ok(m.name.length <= 100 && (m.description ?? "").length <= 500);
  for (const text of Object.values(render(ds))) assert.ok(!/[\u0000-\u0008\u000b-\u001f]/.test(text), "no control characters");
});

test("milestones: estimates within V14's rules, spans with a working day, all references resolve", () => {
  const projectRefs = new Set(projects.map((p) => p.ref));
  const teamRefs = new Set(ds.teams.map((t) => t.ref));
  for (const m of ds.milestones) {
    assert.ok(projectRefs.has(m.projectRef) && teamRefs.has(m.teamRef));
    assert.ok(m.estimateMd >= 0.5 && m.estimateMd <= 40 && decimals2(m.estimateMd), `estimate ${m.estimateMd}`);
    assert.equal(m.startOffset === null, m.endOffset === null, "both dates or neither");
    if (m.startOffset !== null) {
      assert.ok(m.endOffset >= m.startOffset && containsWorkingDay(m.startOffset, m.endOffset), `milestone ${m.ref} covers no working day`);
      assert.ok(workingDaysBetween(m.startOffset, m.endOffset) >= 1);
    }
  }
  assert.ok(ds.milestones.some((m) => m.startOffset !== null && (weekday(m.startOffset) > 4 || weekday(m.endOffset) > 4)), "some spans touch a weekend");
  assert.ok([...Map.groupBy(ds.milestones, (m) => m.projectRef).values()].every((l) => l.length >= 6 && l.length <= 14));
});

const milestoneByRef = new Map(ds.milestones.map((m) => [m.ref, m]));
const spanOf = (m) => (m.startOffset === null ? null : { start: m.startOffset, end: m.endOffset });
const derivedSpan = (projectRef) => {
  const scheduled = ds.milestones.filter((m) => m.projectRef === projectRef && m.startOffset !== null);
  return scheduled.length === 0 ? null : { start: Math.min(...scheduled.map((m) => m.startOffset)), end: Math.max(...scheduled.map((m) => m.endOffset)) };
};
const endpointOf = (kind, ref) => (kind === "PROJECT" ? { project: ref, span: derivedSpan(ref) } : { project: milestoneByRef.get(ref).projectRef, span: spanOf(milestoneByRef.get(ref)) });
const shortfallOf = (d) => linkShortfall(d.type, d.lagDays, endpointOf(d.predecessorKind, d.predecessorRef).span, endpointOf(d.successorKind, d.successorRef).span);

test("links are unique per unordered pair and within the server's rules (milestone and project ends)", () => {
  const pairs = new Set();
  let cross = 0;
  for (const d of ds.dependencies) {
    assert.ok(["MILESTONE", "PROJECT"].includes(d.predecessorKind) && ["MILESTONE", "PROJECT"].includes(d.successorKind));
    const known = (kind, ref) => (kind === "PROJECT" ? projects.some((p) => p.ref === ref) : milestoneByRef.has(ref));
    assert.ok(known(d.predecessorKind, d.predecessorRef) && known(d.successorKind, d.successorRef), `link ${d.ref} has a dangling end`);
    assert.ok(d.predecessorKind !== d.successorKind || d.predecessorRef !== d.successorRef, "no self-link");
    assert.equal(endpointOf(d.successorKind, d.successorRef).project, d.successorProjectRef, "the path project holds the successor");
    assert.ok(["FS", "SS", "FF"].includes(d.type) && Number.isInteger(d.lagDays) && d.lagDays >= -5 && d.lagDays <= 10);
    const ends = [`${d.predecessorKind}${d.predecessorRef}`, `${d.successorKind}${d.successorRef}`].sort().join("|");
    assert.ok(!pairs.has(ends), `pair ${ends} linked twice`);
    pairs.add(ends);
    if (endpointOf(d.predecessorKind, d.predecessorRef).project !== d.successorProjectRef) cross++;
  }
  // The milestone links alone keep the original mix: a quarter across projects.
  const milestoneLinks = ds.dependencies.slice(0, COUNTS.milestoneDependencies);
  const milestoneCross = milestoneLinks.filter((d) => milestoneByRef.get(d.predecessorRef).projectRef !== milestoneByRef.get(d.successorRef).projectRef).length;
  assert.equal(milestoneCross, COUNTS.crossProjectDependencies);
  // Every project-endpoint link runs across projects.
  for (const d of ds.dependencies.filter((x) => x.predecessorKind === "PROJECT" || x.successorKind === "PROJECT")) {
    assert.notEqual(endpointOf(d.predecessorKind, d.predecessorRef).project, d.successorProjectRef, `project-endpoint link ${d.ref} stays inside one project`);
  }
  const violated = ds.dependencies.filter((d) => shortfallOf(d) > 0).length;
  assert.ok(violated / ds.dependencies.length >= 0.05 && violated / ds.dependencies.length <= 0.25, `violated links ${violated}`);
  // The figures the README points at (summary.json) equal what is counted here, independently of the generator's own helper.
  const stats = ds.summary.dependencyStats;
  const count = (pk, sk) => ds.dependencies.filter((d) => d.predecessorKind === pk && d.successorKind === sk).length;
  assert.deepEqual(stats.byType, { FS: ds.dependencies.filter((d) => d.type === "FS").length, SS: ds.dependencies.filter((d) => d.type === "SS").length, FF: ds.dependencies.filter((d) => d.type === "FF").length });
  assert.deepEqual(stats.byKind, { milestoneToMilestone: count("MILESTONE", "MILESTONE"), projectToProject: count("PROJECT", "PROJECT"), milestoneToProject: count("MILESTONE", "PROJECT"), projectToMilestone: count("PROJECT", "MILESTONE") });
  assert.equal(stats.projectEndpoint, ds.dependencies.length - count("MILESTONE", "MILESTONE"));
  assert.ok(stats.byKind.projectToProject >= COUNTS.projectDependencies.projectToProject && stats.byKind.milestoneToProject >= COUNTS.projectDependencies.milestoneToProject && stats.byKind.projectToMilestone >= COUNTS.projectDependencies.projectToMilestone, "every direction meets its quota");
  assert.equal(stats.violated, violated);
  assert.equal(stats.crossProject, cross);
  assert.equal(stats.withUnscheduledEnd, ds.dependencies.filter((d) => endpointOf(d.predecessorKind, d.predecessorRef).span === null || endpointOf(d.successorKind, d.successorRef).span === null).length);
});

test("the time-point graph is acyclic (containment and project ends included) - Kahn, independent of graph.mjs", () => {
  // START(x)->END(x) for every milestone and project, START(project)->START(milestone), END(milestone)->END(project), and one edge per link.
  const edges = new Map();
  const indegree = new Map();
  const node = (k) => {
    if (!edges.has(k)) {
      edges.set(k, []);
      indegree.set(k, 0);
    }
  };
  const edge = (a, b) => {
    node(a);
    node(b);
    edges.get(a).push(b);
    indegree.set(b, indegree.get(b) + 1);
  };
  for (const p of projects) edge(`S p${p.ref}`, `E p${p.ref}`);
  for (const m of ds.milestones) {
    edge(`S m${m.ref}`, `E m${m.ref}`);
    edge(`S p${m.projectRef}`, `S m${m.ref}`);
    edge(`E m${m.ref}`, `E p${m.projectRef}`);
  }
  const letter = (kind) => (kind === "PROJECT" ? "p" : "m");
  for (const d of ds.dependencies) {
    edge(`${d.type[0] === "F" ? "E" : "S"} ${letter(d.predecessorKind)}${d.predecessorRef}`, `${d.type[1] === "S" ? "S" : "E"} ${letter(d.successorKind)}${d.successorRef}`);
  }
  const queue = [...indegree].filter(([, n]) => n === 0).map(([k]) => k);
  let visited = 0;
  while (queue.length > 0) {
    const k = queue.pop();
    visited++;
    for (const next of edges.get(k)) {
      indegree.set(next, indegree.get(next) - 1);
      if (indegree.get(next) === 0) queue.push(next);
    }
  }
  assert.equal(visited, edges.size, "a cycle remains in the time-point graph");
});

test("the server's cycle rule (graph.mjs) accepts the whole dataset link by link, in file order and in reverse", () => {
  for (const order of [ds.dependencies, [...ds.dependencies].reverse()]) {
    const graph = new TimePointGraph(ds.milestones);
    for (const d of order) assert.equal(graph.refusal(d), null, `link ${d.ref} would be refused`);
    for (const d of order) assert.ok(graph.tryAdd(d), `link ${d.ref} was not added`);
  }
});

test("project-endpoint links in each direction exist, and the zero-slack cross-project chains are 3 or more projects deep", () => {
  const stats = ds.summary.dependencyStats;
  assert.ok(stats.byKind.projectToProject > 0 && stats.byKind.milestoneToProject > 0 && stats.byKind.projectToMilestone > 0);
  const chains = criticalChains(ds.milestones, ds.dependencies);
  assert.equal(stats.zeroSlackChains, chains.sinks.length);
  assert.equal(stats.zeroSlackCrossProjectLinks, chains.zeroSlackLinks);
  assert.equal(stats.deepestZeroSlackChain, chains.deepest);
  assert.ok(stats.zeroSlackChains >= COUNTS.chainLengths.length, `${stats.zeroSlackChains} chains`);
  assert.ok(stats.deepestZeroSlackChain >= Math.max(...COUNTS.chainLengths));
  // Each designed chain shows up: a sink with at least (length - 1) critical projects upstream, per designed length.
  const depths = chains.sinks.map((p) => chains.upstream.get(p).size + 1).sort((a, b) => b - a);
  const wanted = [...COUNTS.chainLengths].sort((a, b) => b - a);
  wanted.forEach((length, i) => assert.ok(depths[i] >= length, `chain ${i + 1}: ${depths[i]} projects deep, wanted ${length}`));
  // The zero-slack links are exact fits on the drawn schedule (not violated, and not a gap), counted here from linkShortfall alone.
  const zero = ds.dependencies.filter((d) => {
    const pred = endpointOf(d.predecessorKind, d.predecessorRef);
    const succ = endpointOf(d.successorKind, d.successorRef);
    return pred.span !== null && succ.span !== null && pred.project !== succ.project && shortfallOf(d) === 0;
  });
  assert.equal(zero.length, stats.zeroSlackCrossProjectLinks);
});

test("graph.mjs follows the server's cycle rule (planning-model.md 'Dependencies')", () => {
  // Two projects of two milestones each: p1 = m1, m2; p2 = m3, m4.
  const ms = [{ ref: 1, projectRef: 1 }, { ref: 2, projectRef: 1 }, { ref: 3, projectRef: 2 }, { ref: 4, projectRef: 2 }];
  const link = (pk, pr, sk, sr, type) => ({ predecessorKind: pk, predecessorRef: pr, successorKind: sk, successorRef: sr, type });
  const fresh = () => new TimePointGraph(ms);
  const g1 = fresh();
  assert.equal(g1.refusal(link("MILESTONE", 1, "PROJECT", 1, "FS")), "cycle", "m FS p for m inside p: END(m) -> START(p), and START(p) reaches END(m)");
  assert.equal(g1.refusal(link("PROJECT", 1, "MILESTONE", 1, "FS")), "cycle", "p FS m for m inside p: END(p) -> START(m), and START(m) reaches END(p)");
  assert.equal(g1.refusal(link("PROJECT", 1, "MILESTONE", 1, "SS")), null, "p SS m is redundant with containment, allowed");
  assert.equal(g1.refusal(link("MILESTONE", 1, "PROJECT", 1, "FF")), null, "m FF p is redundant with containment, allowed");
  assert.equal(g1.refusal(link("MILESTONE", 1, "MILESTONE", 1, "FS")), "self");
  // A link between two PROJECTS also forbids any milestone-level link the other way across them.
  const g2 = fresh();
  assert.ok(g2.tryAdd(link("PROJECT", 1, "PROJECT", 2, "FS")));
  assert.equal(g2.refusal(link("MILESTONE", 3, "MILESTONE", 1, "FS")), "cycle");
  assert.equal(g2.refusal(link("PROJECT", 1, "PROJECT", 2, "SS")), "pair");
  assert.equal(g2.refusal(link("PROJECT", 2, "PROJECT", 1, "FS")), "pair", "the reverse pair is refused whatever the type");
  // A reverse pair that closes no loop is not a cycle, but the one-link-per-unordered-pair rule refuses it.
  const g3 = fresh();
  assert.ok(g3.tryAdd(link("MILESTONE", 1, "MILESTONE", 3, "SS")));
  assert.equal(g3.cycleClosedBy(link("MILESTONE", 3, "MILESTONE", 1, "FF")), null);
  assert.equal(g3.refusal(link("MILESTONE", 3, "MILESTONE", 1, "FF")), "pair");
  // A three-entity loop across projects.
  const g4 = fresh();
  assert.ok(g4.tryAdd(link("MILESTONE", 1, "MILESTONE", 3, "FS")));
  assert.equal(g4.refusal(link("MILESTONE", 3, "PROJECT", 1, "FS")), "cycle", "m1 -> m3 -> p1 -> m1: START(p1) reaches END(m1), which leads to START(m3)");
  // popLast restores the graph exactly.
  const g5 = fresh();
  assert.ok(g5.tryAdd(link("PROJECT", 1, "PROJECT", 2, "FS")));
  g5.popLast();
  assert.equal(g5.size, 0);
  assert.equal(g5.refusal(link("PROJECT", 2, "PROJECT", 1, "FS")), null, "the popped link no longer blocks the reverse");
});

test("critical.mjs counts the zero-slack chains the way the server's critical path does (hand-counted, 2027-02-01 = offset 0)", () => {
  // Three projects, one milestone each; days are offsets from a Monday. A: Mon 0 - Fri 4, B: Mon 7 - Fri 11, C: Mon 14 - Fri 18.
  const m = (ref, projectRef, startOffset, endOffset) => ({ ref, projectRef, startOffset, endOffset });
  const ms = [m(1, 1, 0, 4), m(2, 2, 7, 11), m(3, 3, 14, 18)];
  const dep = (pk, pr, sk, sr, type, lagDays) => ({ predecessorKind: pk, predecessorRef: pr, successorKind: sk, successorRef: sr, type, lagDays });
  const fs = (a, b) => dep("MILESTONE", a, "MILESTONE", b, "FS", 0);
  // A ends Fri, B starts the next Mon: back-to-back (slack 0), twice.
  const chain = criticalChains(ms, [fs(1, 2), fs(2, 3)]);
  assert.deepEqual([...chain.upstream.get(3)].sort(), [1, 2]);
  assert.deepEqual([...chain.upstream.get(2)], [1]);
  assert.equal(chain.zeroSlackLinks, 2);
  assert.deepEqual(chain.sinks, [3]);
  assert.equal(chain.deepest, 3);
  // A lead of one day on the second link (lag -1) leaves one working day of slack on it: not critical.
  const slack = criticalChains(ms, [fs(1, 2), dep("MILESTONE", 2, "MILESTONE", 3, "FS", -1)]);
  assert.deepEqual([...slack.upstream.get(3)], [], "a link with a working day of slack is not on the chain");
  assert.equal(slack.zeroSlackLinks, 1);
  // A violated link ends the chain: lag 1 asks for one more working day than the schedule gives.
  const violated = criticalChains(ms, [fs(1, 2), dep("MILESTONE", 2, "MILESTONE", 3, "FS", 1)]);
  assert.deepEqual([...violated.upstream.get(3)], []);
  assert.equal(violated.zeroSlackLinks, 1);
  // A project end as the predecessor: END(A) is Fri 4, so A FS m2 is as tight as m1 FS m2, and the project A is named by the link.
  const fromProject = criticalChains(ms, [dep("PROJECT", 1, "MILESTONE", 2, "FS", 0)]);
  assert.deepEqual([...fromProject.upstream.get(2)], [1]);
  // Entering a project's START is critical only when the project's span is tight to its end: C's one milestone is its whole span here.
  const intoProject = criticalChains(ms, [dep("MILESTONE", 2, "PROJECT", 3, "FS", 0)]);
  assert.deepEqual([...intoProject.upstream.get(3)], [2]);
  // ... but not with a second, later milestone in C: START(C) -> START(m3) -> END(m3) -> END(C) has a week of slack against the project's end.
  const wider = criticalChains([...ms, m(4, 3, 21, 25)], [dep("MILESTONE", 2, "PROJECT", 3, "FS", 0)]);
  assert.deepEqual([...wider.upstream.get(3)], []);
  // An unscheduled end is excluded.
  assert.deepEqual([...criticalChains([m(1, 1, 0, 4), m(2, 2, null, null)], [fs(1, 2)]).upstream.get(2)], []);
});

test("capacity periods respect V16 and show the mix: Monday, mid-week and weekend starts, half with a WIP limit", () => {
  assert.equal(ds.capacity.length, ds.summary.counts.capacityPeriods);
  for (const [team, rows] of Map.groupBy(ds.capacity, (c) => c.teamRef)) {
    assert.ok(rows.length >= 2 && rows.length <= 4, `team ${team} has ${rows.length} periods`);
    assert.ok(unique(rows.map((r) => r.effectiveFromOffset)), "one period per team and start date");
  }
  assert.equal(new Set(ds.capacity.map((c) => c.teamRef)).size, COUNTS.teams, "every team has capacity");
  for (const c of ds.capacity) {
    assert.ok(c.mdPerWeek >= 5 && c.mdPerWeek <= 60 && decimals2(c.mdPerWeek), `mdPerWeek ${c.mdPerWeek}`); // V16: >= 0, < 1,000,000, two decimals
    assert.ok(c.wipLimit === null || (Number.isInteger(c.wipLimit) && c.wipLimit >= 1 && c.wipLimit <= 99), `wipLimit ${c.wipLimit}`);
    assert.ok(Number.isInteger(c.effectiveFromOffset) && Math.abs(c.effectiveFromOffset) < 3650);
  }
  const days = ds.capacity.map((c) => weekday(c.effectiveFromOffset));
  assert.equal(days.filter((d) => d > 4).length, 2, "exactly two periods start on a weekend day");
  assert.ok(days.filter((d) => d >= 1 && d <= 4).length >= Math.floor(ds.capacity.length * 0.1), "some start mid-week");
  assert.ok(days.filter((d) => d === 0).length > ds.capacity.length / 2, "most start on a Monday");
  const limited = ds.capacity.filter((c) => c.wipLimit !== null).length;
  const cs = ds.summary.capacityStats;
  assert.deepEqual([cs.startsOnMonday, cs.startsMidWeek, cs.startsOnWeekend, cs.withWipLimit], [days.filter((d) => d === 0).length, days.filter((d) => d >= 1 && d <= 4).length, days.filter((d) => d > 4).length, limited]);
  assert.deepEqual(cs.mdPerWeek, { min: Math.min(...ds.capacity.map((c) => c.mdPerWeek)), max: Math.max(...ds.capacity.map((c) => c.mdPerWeek)) });
  assert.deepEqual(cs.wipLimit, { min: Math.min(...ds.capacity.filter((c) => c.wipLimit !== null).map((c) => c.wipLimit)), max: Math.max(...ds.capacity.map((c) => c.wipLimit ?? 0)) });
  assert.ok(Math.abs(limited - ds.capacity.length / 2) <= 3, `${limited} of ${ds.capacity.length} periods carry a WIP limit`);
});

test("the schedule overloads about 15% of the loaded weeks and exceeds the WIP limit in about 10% (recomputed from the files)", () => {
  const rows = ds.teams.map((t) =>
    weeklyRows(ds.milestones.filter((m) => m.teamRef === t.ref && m.startOffset !== null).map((m) => ({ start: m.startOffset, end: m.endOffset, estimateMd: m.estimateMd })), periodsOf(ds.capacity, t.ref)),
  );
  const rates = overallRates(rows);
  assert.ok(rates.weeks > 500);
  assert.ok(rates.overloaded / rates.weeks >= 0.08 && rates.overloaded / rates.weeks <= 0.25, `overloaded ${rates.overloaded}/${rates.weeks}`);
  assert.ok(rates.wipExceeded / rates.weeks >= 0.05 && rates.wipExceeded / rates.weeks <= 0.2, `over WIP ${rates.wipExceeded}/${rates.weeks}`);
  assert.equal(ds.summary.loadedWeeks, rates.weeks);
  assert.equal(ds.summary.overloadedWeekShare, Math.round((rates.overloaded / rates.weeks) * 100) / 100);
  assert.equal(ds.summary.wipExceededWeekShare, Math.round((rates.wipExceeded / rates.weeks) * 100) / 100);
});

test("ranking, target windows and team orders", () => {
  const projectRefs = new Set(projects.map((p) => p.ref));
  assert.ok(unique(ds.ranking.projectRefs) && ds.ranking.projectRefs.every((r) => projectRefs.has(r)));
  for (const p of projects.filter((p) => p.targetStartOffset !== null)) {
    assert.ok(p.targetEndOffset >= p.targetStartOffset);
    assert.equal(weekday(p.targetStartOffset), 0, "windows start on a Monday");
  }
  assert.ok(projects.every((p) => (p.targetStartOffset === null) === (p.targetEndOffset === null)), "both target dates or neither");
  for (const w of ds.plan.workStreams) assert.equal(weekday(w.startOffset), 0);
  const byRef = new Map(ds.milestones.map((m) => [m.ref, m]));
  for (const o of ds.teamOrders) {
    assert.ok(o.milestoneRefs.length >= 5 && unique(o.milestoneRefs));
    assert.ok(o.milestoneRefs.every((r) => byRef.get(r)?.teamRef === o.teamRef), "only the team's own milestones");
  }
  assert.ok(unique(ds.teamOrders.map((o) => o.teamRef)));
});

test("day arithmetic mirrors the server's working-day index", () => {
  assert.deepEqual([0, 1, 4, 5, 6, 7, -1, -2, -3].map(weekday), [0, 1, 4, 5, 6, 0, 6, 5, 4]);
  assert.equal(workIndex(4) + 1, workIndex(7), "Friday -> Monday is +1");
  assert.equal(workIndex(5), workIndex(4));
  assert.equal(workIndex(6), workIndex(4));
  for (let w = -12; w < 30; w++) assert.equal(workIndex(dayOfWorkIndex(w)), w);
  assert.equal(workingDaysBetween(0, 6), 5);
  assert.equal(workingDaysBetween(5, 6), 0);
  assert.equal(workingDaysBetween(4, 7), 2);
  assert.equal(workingDaysBetween(2, 8), 5);
  assert.equal(isoDateAt("2027-02-01", 0), "2027-02-01");
  assert.equal(isoDateAt("2027-02-01", 7 * 52 - 1), "2028-01-30");
  assert.ok(isMonday("2027-02-01") && !isMonday("2027-02-02"));
  assert.equal(mondayOfWeek(new Date("2027-02-04T10:00:00Z")), "2027-02-01");
  assert.equal(mondayOfWeek(new Date("2027-02-07T23:59:00Z")), "2027-02-01");
  assert.equal(mondayOfWeek(new Date("2027-02-08T00:00:00Z")), "2027-02-08");
  assert.throws(() => isoDateAt("2027-02-30", 0));
});

test("the tuning port reproduces the plan's worked capacity rows (week of 2027-02-01 = offset 0)", () => {
  const cap = (periods, monday = 0) => weekCapacity(monday, periods.map(([from, mdPerWeek]) => ({ from, mdPerWeek, wipLimit: null })));
  assert.equal(cap([[0, 10], [3, 20]]), 14);
  assert.equal(cap([[0, 10], [7, 20]]), 10);
  assert.equal(cap([[0, 10], [5, 20]]), 10);
  assert.equal(cap([[0, 10], [1, 20], [3, 5]]), 12);
  assert.equal(cap([[2, 10]]), 6);
  assert.equal(cap([[2, 10]], -7), null);
  assert.equal(cap([[5, 20]]), null);
  assert.equal(cap([[5, 20]], 7), 20);
  assert.equal(cap([[0, 1.33], [3, 0]]), 0.8);
});
