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
  assert.equal(ds.dependencies.length, COUNTS.dependencies);
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

test("the dependency graph is acyclic (containment included), links are unique per pair and within the server's rules", () => {
  const byRef = new Map(ds.milestones.map((m) => [m.ref, m]));
  const pairs = new Set();
  let cross = 0;
  for (const d of ds.dependencies) {
    const pred = byRef.get(d.predecessorRef);
    const succ = byRef.get(d.successorRef);
    assert.ok(pred && succ && pred.ref !== succ.ref);
    assert.equal(succ.projectRef, d.successorProjectRef);
    assert.ok(["FS", "SS", "FF"].includes(d.type) && Number.isInteger(d.lagDays) && d.lagDays >= -5 && d.lagDays <= 10);
    const key = [pred.ref, succ.ref].sort((a, b) => a - b).join("-");
    assert.ok(!pairs.has(key), `pair ${key} linked twice`);
    pairs.add(key);
    if (pred.projectRef !== succ.projectRef) cross++;
  }
  const spanOf = (m) => (m.startOffset === null ? null : { start: m.startOffset, end: m.endOffset });
  const violated = ds.dependencies.filter((d) => linkShortfall(d.type, d.lagDays, spanOf(byRef.get(d.predecessorRef)), spanOf(byRef.get(d.successorRef))) > 0).length;
  assert.ok(violated / ds.dependencies.length >= 0.05 && violated / ds.dependencies.length <= 0.25, `violated links ${violated}`);
  // The figures the README points at (summary.json) equal what is counted here, independently of the generator's own helper.
  const stats = ds.summary.dependencyStats;
  assert.deepEqual(stats.byType, { FS: ds.dependencies.filter((d) => d.type === "FS").length, SS: ds.dependencies.filter((d) => d.type === "SS").length, FF: ds.dependencies.filter((d) => d.type === "FF").length });
  assert.equal(stats.violated, violated);
  assert.equal(stats.crossProject, cross);
  assert.equal(stats.withUnscheduledEnd, ds.dependencies.filter((d) => spanOf(byRef.get(d.predecessorRef)) === null || spanOf(byRef.get(d.successorRef)) === null).length);
  assert.ok(cross / ds.dependencies.length >= 0.2 && cross / ds.dependencies.length <= 0.3, `cross-project share ${cross}`);
  // Kahn over START/END points of every milestone and project: START(x)->END(x), START(project)->START(milestone), END(milestone)->END(project).
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
  for (const d of ds.dependencies) {
    edge(`${d.type[0] === "F" ? "E" : "S"} m${d.predecessorRef}`, `${d.type[1] === "S" ? "S" : "E"} m${d.successorRef}`);
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
