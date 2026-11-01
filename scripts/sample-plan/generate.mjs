#!/usr/bin/env node
// Deterministic synthetic planning dataset at the intended scale (15 teams, 5 work streams, 20 programs, 100 projects, 1,000 milestones),
// the "sample plan" of v0.5.0. Zero dependencies (Node built-ins only). Every random draw comes from a seeded mulberry32 stream and there
// is no clock, so two runs write byte-identical files — scripts/sample-plan/generate.test.mjs pins that and that the committed files equal
// a fresh run. The pattern is Flow's sample-data/jira/generate.mjs (mulberry32, a frozen clock).
//
// Usage: node scripts/sample-plan/generate.mjs [--seed 42] [--out sample-data/plan]
//
// Writes people.json, teams.json, plan.json, milestones.json, dependencies.json, capacity.json, ranking.json, team-orders.json and
// summary.json. Records refer to each other by `ref` (a 1-based integer per file); every date is a DAY OFFSET from an anchor Monday that
// the loader (load.mjs --anchor) resolves, so the dataset is never tied to a calendar. sample-data/plan/README.md documents the files.
//
// Transcendental maths (exp/log) is deliberately avoided: the only Math.pow is the Zipf weight, whose rounded result the self-test
// re-checks against the committed files on every platform.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dayOfWorkIndex, mondayOf, weekday } from "./days.mjs";
import { dailyWip, linkShortfall, overallRates, quantile, weeklyLoads, weeklyRows } from "./stats.mjs";

export const DEFAULT_SEED = 42;
export const COUNTS = { people: 30, teams: 15, workStreams: 5, programs: 20, projects: 100, milestones: 1000, dependencies: 300, rankedProjects: 80, targetWindows: 60, unscheduled: 100, crossProjectDependencies: 75, customOrderTeams: 3 };
/**
 * The Zipf exponent of the team sizes: the classic rank-size rule (size of rank k = size of rank 1 / k). With 1,000 milestones over 15
 * teams that is 301, 151, 100, 75, 60, ... 20: three teams above the Timeline's 80-row virtualisation threshold, a fourth (about 68
 * scheduled rows) just below it for the plain path, and the smallest at 20. (Exactly TWO above 80 with a ~20 smallest is not a power law:
 * it needs a 400-row head, which the measurement does not want.)
 */
export const ZIPF_S = 1;

// ---------------------------------------------------------------------------------------------------------------------------------
// Seeded PRNG (mulberry32) - deterministic across runs, platforms and Node versions (integer maths and one division).
// ---------------------------------------------------------------------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeRng(seed) {
  const next = mulberry32(seed);
  const rng = {
    float: next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)), // inclusive both ends
    chance: (p) => next() < p,
    pick: (list) => list[Math.floor(next() * list.length)],
    shuffle(list) {
      const a = [...list];
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    },
    weighted(values, weights) {
      let x = next() * weights.reduce((s, w) => s + w, 0);
      for (let i = 0; i < values.length; i++) {
        x -= weights[i];
        if (x < 0) return values[i];
      }
      return values[values.length - 1];
    },
  };
  return rng;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Vocabulary. Every name is unique where the server requires it (people emails, team / work stream / program names, project names within
// a program, milestone names within a project) and short enough for the 100-character name limit.
// ---------------------------------------------------------------------------------------------------------------------------------
const FIRST_NAMES = [["Anna", "anna"], ["Piotr", "piotr"], ["Maria", "maria"], ["Jan", "jan"], ["Katarzyna", "katarzyna"], ["Tomasz", "tomasz"], ["Agnieszka", "agnieszka"], ["Michał", "michal"], ["Ewa", "ewa"], ["Paweł", "pawel"], ["Magdalena", "magdalena"], ["Krzysztof", "krzysztof"], ["Joanna", "joanna"], ["Marcin", "marcin"], ["Zofia", "zofia"], ["Łukasz", "lukasz"], ["Natalia", "natalia"], ["Jakub", "jakub"], ["Alicja", "alicja"], ["Bartosz", "bartosz"], ["Karolina", "karolina"], ["Wojciech", "wojciech"], ["Dorota", "dorota"], ["Rafał", "rafal"], ["Weronika", "weronika"], ["Adam", "adam"], ["Helena", "helena"], ["Szymon", "szymon"], ["Irena", "irena"], ["Filip", "filip"]];
// Surnames that do not change with gender, so any first name pairs with any of them.
const LAST_NAMES = [["Nowak", "nowak"], ["Mazur", "mazur"], ["Dudek", "dudek"], ["Zając", "zajac"], ["Król", "krol"], ["Wieczorek", "wieczorek"], ["Kowalczyk", "kowalczyk"], ["Krawczyk", "krawczyk"], ["Adamczyk", "adamczyk"], ["Wójcik", "wojcik"], ["Woźniak", "wozniak"], ["Kaczmarek", "kaczmarek"], ["Sikora", "sikora"], ["Baran", "baran"], ["Michalak", "michalak"], ["Szewczyk", "szewczyk"], ["Pietrzak", "pietrzak"], ["Marciniak", "marciniak"], ["Duda", "duda"], ["Sowa", "sowa"], ["Wilk", "wilk"], ["Lis", "lis"], ["Cieślak", "cieslak"], ["Walczak", "walczak"], ["Stępień", "stepien"], ["Gajda", "gajda"], ["Bielak", "bielak"], ["Borek", "borek"], ["Kubiak", "kubiak"], ["Pawlak", "pawlak"]];
export const SAMPLE_EMAIL_DOMAIN = "sample.astrolabe.local";

// Listed from the largest team down (Zipf rank 1 first), so "Platform" is the virtualised-path team of the measurements.
const TEAM_NAMES = ["Platform", "Payments", "Mobile", "Web Frontend", "Data Engineering", "Search", "Identity", "Infrastructure", "QA Automation", "Design Systems", "Analytics", "Integrations", "Security", "Billing", "Support Tooling"];

const STREAMS = [
  { name: "Customer Experience", programs: ["Digital Storefront", "Self-Service Portal", "Mobile Experience", "Customer Loyalty"] },
  { name: "Platform Foundations", programs: ["Cloud Migration", "Developer Productivity", "Observability", "Core Services"] },
  { name: "Commerce & Growth", programs: ["Checkout Optimisation", "Marketplace Expansion", "Pricing & Promotions", "Partner Channels"] },
  { name: "Data & Intelligence", programs: ["Data Platform", "Reporting & Analytics", "Personalisation", "Experimentation"] },
  { name: "Operations Excellence", programs: ["Fulfilment & Logistics", "Support Operations", "Security & Compliance", "Finance Systems"] },
];

const PROJECT_NOUNS = ["Checkout", "Onboarding", "Search", "Notifications", "Billing", "Reporting", "Login", "Catalog", "Inventory", "Loyalty", "Messaging", "Dashboards", "Payments", "Fulfilment", "Pricing", "Recommendations", "Subscriptions", "Returns", "Support portal", "Mobile app"];
const PROJECT_INITIATIVES = ["redesign", "migration", "consolidation", "rollout", "revamp", "automation", "hardening", "modernisation", "expansion", "pilot"];

// The milestone vocabulary in delivery order: a project takes an ordered subset, so a name is unique within its project.
const STAGES = ["Discovery", "Design", "Prototype", "Build", "Integrate", "Test", "Hardening", "Pilot", "Migration", "Rollout", "Launch", "Handover", "Documentation", "Retrospective"];
const MILESTONE_NOTES = ["Scope agreed with the stakeholders.", "Blocked on an external vendor.", "Needs a security review.", "Reuses the shared component library.", "Cut-over happens out of hours.", "Rehearsed in the staging environment first."];

// Estimates (man-days) from a skewed table: many small items, a long tail up to 40.
const ESTIMATES = [0.5, 1, 1.5, 2, 3, 4, 5, 6, 8, 10, 13, 15, 20, 25, 30, 40];
const ESTIMATE_WEIGHTS = [3, 5, 5, 8, 10, 9, 10, 8, 10, 8, 6, 5, 5, 3, 2, 1];
const QUARTER_NUDGES = [0, 0, 0, 0, 0.25, 0.5, -0.25];

const round2 = (x) => Math.round(x * 100) / 100;

// ---------------------------------------------------------------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------------------------------------------------------------

/** `count` team sizes summing to `total`, Zipf-distributed (size of rank k proportional to k^-s), by the largest-remainder rule. */
export function zipfSizes(count, total, s) {
  const weights = Array.from({ length: count }, (_, k) => 1 / Math.pow(k + 1, s));
  const sum = weights.reduce((a, b) => a + b, 0);
  const raw = weights.map((w) => (total * w) / sum);
  const sizes = raw.map(Math.floor);
  const byRemainder = raw.map((x, i) => [x - Math.floor(x), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  let rest = total - sizes.reduce((a, b) => a + b, 0);
  for (const [, i] of byRemainder) {
    if (rest-- <= 0) break;
    sizes[i]++;
  }
  return sizes;
}

/** `n` integers in [min, max] summing to `total`: start flat, then move single units between random pairs. */
function boundedSplit(rng, n, total, min, max) {
  const parts = Array.from({ length: n }, () => Math.floor(total / n));
  let rest = total - parts.reduce((a, b) => a + b, 0);
  for (let i = 0; rest > 0; i++, rest--) parts[i % n]++;
  for (let step = 0; step < n * 20; step++) {
    const a = rng.int(0, n - 1);
    const b = rng.int(0, n - 1);
    if (a !== b && parts[a] < max && parts[b] > min) {
      parts[a]++;
      parts[b]--;
    }
  }
  return parts;
}

function makePeople(rng) {
  const lastNames = rng.shuffle(LAST_NAMES);
  return FIRST_NAMES.map(([first, firstSlug], i) => ({
    ref: i + 1,
    name: `${first} ${lastNames[i][0]}`,
    email: `${firstSlug}.${lastNames[i][1]}@${SAMPLE_EMAIL_DOMAIN}`,
  }));
}

function makeStructure(rng, people) {
  const managerCount = COUNTS.teams;
  const owners = people.slice(managerCount); // persons 16..30; the managers are persons 1..15
  const ownerRef = (i, share) => (rng.chance(share) ? people[rng.int(0, managerCount - 1)].ref : owners[i % owners.length].ref);
  const perProgram = boundedSplit(rng, COUNTS.programs, COUNTS.projects, 3, 7);
  const names = rng.shuffle(PROJECT_NOUNS.flatMap((n) => PROJECT_INITIATIVES.map((i) => `${n} ${i}`)));
  let programIndex = 0;
  let projectIndex = 0;
  let ref = 0;
  const workStreams = STREAMS.map((stream, si) => ({
    ref: si + 1,
    name: stream.name,
    description: "Sample work stream (generated; never production).",
    ownerRef: owners[si].ref,
    startOffset: -7 * rng.int(26, 52),
    programs: stream.programs.map((programName) => {
      const program = {
        ref: ++programIndex,
        name: programName,
        description: null,
        ownerRef: ownerRef(programIndex - 1, 0),
        projects: [],
      };
      for (let k = 0; k < perProgram[programIndex - 1]; k++, projectIndex++) {
        program.projects.push({ ref: ++ref, name: names[projectIndex], description: null, ownerRef: ownerRef(projectIndex, 0.15), targetStartOffset: null, targetEndOffset: null });
      }
      return program;
    }),
  }));
  return workStreams;
}

/** Everything the milestone drawing needs to know about a project, in the structure order. */
function flattenProjects(workStreams) {
  return workStreams.flatMap((ws) => ws.programs.flatMap((pr) => pr.projects));
}

function drawEstimate(rng) {
  const base = rng.weighted(ESTIMATES, ESTIMATE_WEIGHTS);
  return round2(Math.min(40, Math.max(0.5, base + rng.pick(QUARTER_NUDGES))));
}

function makeMilestones(rng, projects, teamSizes) {
  const perProject = boundedSplit(rng, projects.length, COUNTS.milestones, 6, 14);
  // Exact team sizes: a pool with each team repeated size times, shuffled, dealt out in creation order.
  const teamPool = rng.shuffle(teamSizes.flatMap((size, t) => Array.from({ length: size }, () => t + 1)));
  const milestones = [];
  projects.forEach((project, pi) => {
    const stageIndexes = rng.shuffle(STAGES.map((_, i) => i)).slice(0, perProject[pi]).sort((a, b) => a - b);
    let cursor = (mondayOf(project.startOffset) / 7) * 5; // a working-day index
    for (const stage of stageIndexes) {
      const estimateMd = drawEstimate(rng);
      const durationDays = Math.min(60, Math.max(1, Math.ceil(estimateMd / rng.pick([0.8, 1, 1.25, 1.5, 2]))));
      let start = dayOfWorkIndex(cursor);
      let end = dayOfWorkIndex(cursor + durationDays - 1);
      // Some spans start on a weekend or end on one (the server counts only the Monday-Friday days inside).
      if (rng.chance(0.08)) {
        if (weekday(start) === 0) start -= rng.pick([1, 2]);
        else if (weekday(end) === 4) end += rng.pick([1, 2]);
      }
      cursor += Math.max(1, Math.floor(durationDays * rng.pick([0.4, 0.6, 0.8, 1, 1]))) + rng.pick([0, 0, 0, 1, 2]);
      milestones.push({
        ref: milestones.length + 1,
        projectRef: project.ref,
        teamRef: teamPool[milestones.length],
        name: STAGES[stage],
        description: rng.chance(0.2) ? rng.pick(MILESTONE_NOTES) : null,
        estimateMd,
        startOffset: start,
        endOffset: end,
      });
    }
  });
  for (const index of rng.shuffle(milestones.map((_, i) => i)).slice(0, COUNTS.unscheduled)) {
    milestones[index].startOffset = null;
    milestones[index].endOffset = null;
  }
  return milestones;
}

function makeDependencies(rng, milestones, projects, rankIndexOf) {
  const byProject = new Map(projects.map((p) => [p.ref, []]));
  for (const m of milestones) byProject.get(m.projectRef).push(m);
  const spanOf = (m) => (m.startOffset === null ? null : { start: m.startOffset, end: m.endOffset });
  // A link is drawn with its type and lag first; a candidate the schedule already violates is kept only 1 time in 5, so most links are
  // satisfied and a visible minority is violated (the warnings the project and team views show first).
  const draw = (predecessor, successor) => {
    const type = rng.weighted(["FS", "SS", "FF"], [70, 15, 15]);
    const lagDays = rng.pick([0, 0, 0, 0, 1, 2, 3, 5, 10, -1, -2, -5]);
    return { predecessor, successor, type, lagDays, accepted: linkShortfall(type, lagDays, spanOf(predecessor), spanOf(successor)) <= 0 || rng.chance(0.2) };
  };
  const links = [];
  const intraPairs = [];
  for (const list of byProject.values()) for (let i = 0; i + 1 < list.length; i++) intraPairs.push([list[i], list[i + 1]]);
  for (const [predecessor, successor] of rng.shuffle(intraPairs)) {
    if (links.length === COUNTS.dependencies - COUNTS.crossProjectDependencies) break;
    const link = draw(predecessor, successor);
    if (link.accepted) links.push(link);
  }
  // Cross-project links always run from a better-ranked project to a worse-ranked one: with the within-project stage order this is a
  // total order on the milestones, and every link goes from an earlier to a later milestone, so the time-point graph is acyclic.
  const projectsByRank = [...projects].sort((a, b) => rankIndexOf.get(a.ref) - rankIndexOf.get(b.ref));
  const seen = new Set(links.map((l) => `${l.predecessor.ref}-${l.successor.ref}`));
  while (links.length < COUNTS.dependencies) {
    const rank = rng.int(1, projectsByRank.length - 1);
    const successor = rng.pick(byProject.get(projectsByRank[rank].ref));
    const predecessor = rng.pick(byProject.get(projectsByRank[rank - rng.int(1, Math.min(rank, 10))].ref));
    const key = `${predecessor.ref}-${successor.ref}`;
    if (seen.has(key)) continue;
    const link = draw(predecessor, successor);
    if (!link.accepted) continue;
    seen.add(key);
    links.push(link);
  }
  return links.map((l, i) => ({
    ref: i + 1,
    predecessorRef: l.predecessor.ref,
    successorRef: l.successor.ref,
    successorProjectRef: l.successor.projectRef,
    type: l.type,
    lagDays: l.lagDays,
  }));
}

/** 2-4 capacity periods per team, tuned against the team's own schedule so that some weeks are overloaded and some exceed the WIP limit. */
function makeCapacity(rng, teamSizes, milestones) {
  const spans = (team) => milestones.filter((m) => m.teamRef === team && m.startOffset !== null).map((m) => ({ start: m.startOffset, end: m.endOffset, estimateMd: m.estimateMd }));
  const plans = teamSizes.map((size, t) => {
    const items = spans(t + 1);
    const count = size >= 100 ? 4 : size >= 50 ? 3 : rng.int(2, 3);
    const lo = mondayOf(Math.min(...items.map((i) => i.start))) - 7 * rng.int(0, 3);
    const hi = mondayOf(Math.max(...items.map((i) => i.end)));
    const bases = [lo];
    for (let j = 1; j < count; j++) bases.push(Math.max(bases[j - 1] + 14, lo + 7 * Math.round((j * (hi - lo)) / 7 / count) + 7 * rng.int(-2, 2)));
    return { team: t + 1, items, bases };
  });
  // Day-of-week of each period's start: most on the Monday, about a fifth mid-week, exactly two on a weekend day (never a team's first).
  const slots = plans.flatMap((p) => p.bases.map((_, j) => ({ plan: p, j })));
  const later = rng.shuffle(slots.filter((s) => s.j > 0));
  const kind = new Map();
  later.slice(0, 2).forEach((s) => kind.set(s, rng.pick([5, 6])));
  later.slice(2, 2 + Math.round(slots.length * 0.2)).forEach((s) => kind.set(s, rng.int(1, 4)));
  const limited = new Set(rng.shuffle(slots).slice(0, Math.round(slots.length / 2))); // half of the periods carry a WIP limit
  const rows = [];
  for (const plan of plans) {
    const loads = weeklyLoads(plan.items);
    const wip = dailyWip(plan.items);
    const froms = plan.bases.map((base, j) => base + (kind.get(slots.find((s) => s.plan === plan && s.j === j)) ?? 0));
    froms.forEach((from, j) => {
      const slot = slots.find((s) => s.plan === plan && s.j === j);
      const next = j + 1 < froms.length ? froms[j + 1] : Number.POSITIVE_INFINITY;
      const inRange = [...loads].filter(([mon, load]) => load > 0 && mon >= mondayOf(from) && mon < mondayOf(next)).map(([, load]) => load);
      const wipInRange = [...wip].filter(([day]) => day >= from && day < next).map(([, n]) => n);
      const cap = inRange.length > 0 ? Math.min(60, Math.max(5, Math.ceil(quantile(inRange, rng.pick([0.78, 0.82, 0.86])) * 2) / 2)) : (rows.at(-1)?.mdPerWeek ?? 5);
      rows.push({
        teamRef: plan.team,
        effectiveFromOffset: from,
        mdPerWeek: cap,
        wipLimit: limited.has(slot) && wipInRange.length > 0 ? Math.min(12, Math.max(2, quantile(wipInRange, rng.pick([0.75, 0.85, 0.95])))) : null,
      });
    });
  }
  return rows;
}

/** Three teams get a partial custom order: a handful of their milestones, listed in an order of the manager's own. */
function makeTeamOrders(rng, milestones) {
  return [1, 5, 13].slice(0, COUNTS.customOrderTeams).map((team, i) => {
    const mine = milestones.filter((m) => m.teamRef === team && m.startOffset !== null);
    const listed = rng.shuffle(mine).slice(0, [12, 8, 5][i]);
    return { teamRef: team, milestoneRefs: listed.map((m) => m.ref) };
  });
}

/** A project's target window: a few weeks around where the project is actually drawn to run (some of them too tight, so drift shows). */
function addTargetWindows(rng, projects, milestones) {
  const spanOf = new Map();
  for (const m of milestones) {
    if (m.startOffset === null) continue;
    const s = spanOf.get(m.projectRef) ?? { start: Infinity, end: -Infinity };
    s.start = Math.min(s.start, m.startOffset);
    s.end = Math.max(s.end, m.endOffset);
    spanOf.set(m.projectRef, s);
  }
  for (const project of rng.shuffle(projects).slice(0, COUNTS.targetWindows)) {
    const span = spanOf.get(project.ref) ?? { start: project.startOffset, end: project.startOffset + 60 };
    project.targetStartOffset = mondayOf(span.start) + 7 * rng.int(-2, 2);
    project.targetEndOffset = mondayOf(span.end) + 4 + 7 * rng.int(-3, 3);
    if (project.targetEndOffset < project.targetStartOffset) project.targetEndOffset = project.targetStartOffset + 4;
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The dataset
// ---------------------------------------------------------------------------------------------------------------------------------

/** The whole dataset as plain objects, one entry per file (without the README). */
export function buildDataset(seed = DEFAULT_SEED) {
  const rng = makeRng(seed);
  const people = makePeople(rng);
  const teamSizes = zipfSizes(COUNTS.teams, COUNTS.milestones, ZIPF_S);
  const teams = TEAM_NAMES.map((name, i) => ({ ref: i + 1, name, description: i === 0 ? "Sample team (generated; never production). The largest: its page takes the virtualised path." : null, managerRef: people[i].ref }));
  const workStreams = makeStructure(rng, people);
  const projects = flattenProjects(workStreams);

  // The global rank: a shuffled order of all projects, the first 80 ranked. Better-ranked projects start earlier, on average.
  const rankOrder = rng.shuffle(projects);
  const rankIndexOf = new Map(rankOrder.map((p, i) => [p.ref, i]));
  for (const project of projects) project.startOffset = 7 * Math.max(-10, -8 + Math.floor(rankIndexOf.get(project.ref) / 2) + rng.int(-6, 6));

  const milestones = makeMilestones(rng, projects, teamSizes);
  const dependencies = makeDependencies(rng, milestones, projects, rankIndexOf);
  addTargetWindows(rng, projects, milestones);
  for (const project of projects) delete project.startOffset; // a drawing aid, not part of the file
  const capacity = makeCapacity(rng, teamSizes, milestones);
  const teamOrders = makeTeamOrders(rng, milestones);

  const perTeamRows = teams.map((t) => weeklyRows(milestones.filter((m) => m.teamRef === t.ref && m.startOffset !== null).map((m) => ({ start: m.startOffset, end: m.endOffset, estimateMd: m.estimateMd })), periodsOf(capacity, t.ref)));
  const rates = overallRates(perTeamRows);
  const summary = {
    seed,
    zipfExponent: ZIPF_S,
    counts: { people: people.length, teams: teams.length, workStreams: workStreams.length, programs: workStreams.reduce((n, w) => n + w.programs.length, 0), projects: projects.length, milestones: milestones.length, scheduledMilestones: milestones.filter((m) => m.startOffset !== null).length, dependencies: dependencies.length, capacityPeriods: capacity.length, rankedProjects: COUNTS.rankedProjects, customOrderTeams: teamOrders.length },
    teamMilestones: Object.fromEntries(teams.map((t, i) => [t.name, teamSizes[i]])),
    scheduledByTeam: Object.fromEntries(teams.map((t) => [t.name, milestones.filter((m) => m.teamRef === t.ref && m.startOffset !== null).length])),
    dependencyStats: dependencyStats(dependencies, milestones),
    capacityStats: capacityStats(capacity),
    customOrders: Object.fromEntries(teamOrders.map((o) => [teams[o.teamRef - 1].name, o.milestoneRefs.length])),
    loadedWeeks: rates.weeks,
    overloadedWeekShare: round2(rates.overloaded / rates.weeks),
    wipExceededWeekShare: round2(rates.wipExceeded / rates.weeks),
  };
  return {
    people,
    teams,
    plan: { workStreams },
    milestones,
    dependencies,
    capacity,
    ranking: { projectRefs: rankOrder.slice(0, COUNTS.rankedProjects).map((p) => p.ref) },
    teamOrders,
    summary,
  };
}

/** What the dependencies look like against the drawn schedule: types, cross-project links, violated ones, ones with an unscheduled end. */
export function dependencyStats(dependencies, milestones) {
  const byRef = new Map(milestones.map((m) => [m.ref, m]));
  const span = (m) => (m.startOffset === null ? null : { start: m.startOffset, end: m.endOffset });
  const stats = { byType: { FS: 0, SS: 0, FF: 0 }, crossProject: 0, violated: 0, withUnscheduledEnd: 0 };
  for (const d of dependencies) {
    const pred = byRef.get(d.predecessorRef);
    const succ = byRef.get(d.successorRef);
    stats.byType[d.type]++;
    if (pred.projectRef !== succ.projectRef) stats.crossProject++;
    if (!span(pred) || !span(succ)) stats.withUnscheduledEnd++;
    else if (linkShortfall(d.type, d.lagDays, span(pred), span(succ)) > 0) stats.violated++;
  }
  return stats;
}

/** The mix of capacity periods: weekday of the start, WIP limits, value ranges. */
export function capacityStats(capacity) {
  const days = capacity.map((c) => weekday(c.effectiveFromOffset));
  const limits = capacity.map((c) => c.wipLimit).filter((x) => x !== null);
  return {
    startsOnMonday: days.filter((d) => d === 0).length,
    startsMidWeek: days.filter((d) => d >= 1 && d <= 4).length,
    startsOnWeekend: days.filter((d) => d >= 5).length,
    withWipLimit: limits.length,
    mdPerWeek: { min: Math.min(...capacity.map((c) => c.mdPerWeek)), max: Math.max(...capacity.map((c) => c.mdPerWeek)) },
    wipLimit: { min: Math.min(...limits), max: Math.max(...limits) },
  };
}

/** A team's periods in the shape stats.mjs reads. */
export function periodsOf(capacity, teamRef) {
  return capacity.filter((c) => c.teamRef === teamRef).map((c) => ({ from: c.effectiveFromOffset, mdPerWeek: c.mdPerWeek, wipLimit: c.wipLimit })).sort((a, b) => a.from - b.from);
}

export const FILES = { people: "people.json", teams: "teams.json", plan: "plan.json", milestones: "milestones.json", dependencies: "dependencies.json", capacity: "capacity.json", ranking: "ranking.json", teamOrders: "team-orders.json", summary: "summary.json" };

/** The files to write: file name -> exact text (pretty JSON, a trailing newline). */
export function render(dataset) {
  return Object.fromEntries(Object.entries(FILES).map(([key, file]) => [file, `${JSON.stringify(dataset[key], null, 2)}\n`]));
}

function parseArgs(argv) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const args = { seed: DEFAULT_SEED, out: path.join(root, "sample-data", "plan") };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split("=", 2);
    const value = () => inline ?? argv[++i];
    if (flag === "--seed") args.seed = Number(value());
    else if (flag === "--out") args.out = path.resolve(value());
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!Number.isInteger(args.seed) || args.seed < 0) throw new Error(`--seed must be a non-negative integer, got: ${args.seed}`);
  return args;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { seed, out } = parseArgs(process.argv.slice(2));
  const dataset = buildDataset(seed);
  mkdirSync(out, { recursive: true });
  for (const [file, text] of Object.entries(render(dataset))) writeFileSync(path.join(out, file), text);
  const { counts, teamMilestones } = dataset.summary;
  console.log(`sample plan (seed ${seed}) written to ${path.relative(process.cwd(), out) || "."}`);
  console.log(JSON.stringify(counts));
  console.log(`team sizes: ${Object.values(teamMilestones).join(", ")}`);
  console.log(`loaded weeks ${dataset.summary.loadedWeeks}: overloaded ${dataset.summary.overloadedWeekShare}, over the WIP limit ${dataset.summary.wipExceededWeekShare}`);
}
