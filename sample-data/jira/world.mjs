// The stub's Jira world, derived from sample-data/plan/*.json: 20 programs -> `Program`, 100 projects -> `Initiative`, 1,000 milestones
// -> `Epic`, one Jira project per work stream, plus the small isolated `E2E` project (2044) and the day-2 destination project `OUT`.
// Pure and deterministic: every random draw comes from one seeded mulberry32 stream and there is no clock.
//
// The Jira dates start as the plan's dates (day offsets from the anchor Monday, absolute here); the PLANTED deviations then differ from the
// plan on purpose and are counted in expected.json, so a test or the manual walk-through knows exactly what the sync must find.
import { containsWorkingDay, dayOfWorkIndex, isoDateAt, nextWorkingOnOrAfter, prevWorkingOnOrBefore, workIndex } from "../../scripts/sample-plan/days.mjs";
import { TYPE_OF_LEVEL } from "./catalog.mjs";

export const ANCHOR = "2026-10-26"; // the sample plan's default anchor Monday (timeline.md)
export const E2E_ANCHOR = "2044-01-04"; // a Monday in the e2e suite's own holiday-free year
const FIRST_ID = 20_001;
const E2E_FIRST_ID = 90_001;
const MS = 1000;

/** The planted counts (disjoint sets of scheduled milestones unless noted). */
export const PLANTED = {
  endLater: 120, // Jira later than the plan by +1..+10 working days
  endEarlier: 40, // Jira earlier by -1..-10
  renamed: 30,
  reparented: 25,
  undatedInJira: 20, // the plan is dated, Jira is not
  doneEarly: 15, // Jira Done while the plan's end is still ahead
  estimateChanged: 10, // story points differ from 2 x man-days
  datedInJiraOnly: 20, // unscheduled in the plan, dated in Jira
  deleted: 12, // day 2: gone
  movedOut: 5, // day 2: moved to project OUT
  incremental: 15, // recently updated: what the incremental shape returns
  projectsTargetLater: 10, // a project's Jira dates end +5 working days after its target window
  projectsRenamed: 5,
  programsShifted: 2, // a program's Jira span is +3 working days
};

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pad = (n, width) => String(n).padStart(width, "0");
export const teamUuid = (ref) => `0000a57e-0000-4000-8000-${pad(ref, 12)}`;

/** `date` shifted by `n` working days: normalised to a working day first (start: on/after; end: on/before), then moved in the working index. */
const shiftStart = (d, n) => dayOfWorkIndex(workIndex(nextWorkingOnOrAfter(d)) + n);
const shiftEnd = (d, n) => dayOfWorkIndex(workIndex(prevWorkingOnOrBefore(d)) + n);

function projectKeys(names) {
  const used = new Set();
  return names.map((name) => {
    const words = name.split(/[^A-Za-z]+/).filter(Boolean);
    let key = words.map((w) => w[0]).join("").toUpperCase();
    for (let i = 1; used.has(key); i++) key = `${words[0].slice(0, i + 1)}${words.slice(1).map((w) => w[0]).join("")}`.toUpperCase();
    used.add(key);
    return key;
  });
}

/** Jira status from the dates, relative to the anchor (offset 0): ended before it = done, started by it = in progress, else to do. */
function statusFor(start, end) {
  if (start === null || end === null) return "todo";
  if (end < 0) return "done";
  return start <= 0 ? "doing" : "todo";
}

function stamp(anchor, dayOffset, rng) {
  const t = isoDateAt(anchor, dayOffset);
  return `${t}T${pad(Math.floor(rng() * 9) + 8, 2)}:${pad(Math.floor(rng() * 60), 2)}:${pad(Math.floor(rng() * 60), 2)}.${pad(Math.floor(rng() * MS), 3)}+0000`;
}

/** Shuffles a copy (Fisher-Yates over the seeded stream). */
function shuffled(items, rng) {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function buildWorld(plan, milestones, teams, seed = 42) {
  const rng = mulberry32(seed);
  const streams = plan.workStreams;
  const programs = streams.flatMap((w) => w.programs.map((g) => ({ ...g, ws: w })));
  const projects = programs.flatMap((g) => g.projects.map((p) => ({ ...p, program: g })));
  const teamName = new Map(teams.map((t) => [t.ref, t.name]));
  const keys = projectKeys(streams.map((w) => w.name));

  // --- the plan's spans (holiday-free offsets) -----------------------------------------------------------------------------------
  const byProject = new Map(projects.map((p) => [p.ref, []]));
  milestones.forEach((m) => byProject.get(m.projectRef).push(m));
  const span = (list) => {
    const dated = list.filter((m) => m.startOffset !== null);
    return dated.length === 0 ? null : { start: Math.min(...dated.map((m) => m.startOffset)), end: Math.max(...dated.map((m) => m.endOffset)) };
  };
  const projectSpan = new Map(projects.map((p) => [p.ref, span(byProject.get(p.ref))]));
  const programSpan = new Map(programs.map((g) => {
    const spans = g.projects.map((p) => projectSpan.get(p.ref)).filter(Boolean);
    return [g.ref, spans.length === 0 ? null : { start: Math.min(...spans.map((s) => s.start)), end: Math.max(...spans.map((s) => s.end)) }];
  }));

  // --- the planted sets: disjoint draws from one shuffled list of the milestones that can carry a working-day shift ----------------
  const schedulable = shuffled(milestones.filter((m) => m.startOffset !== null && m.endOffset >= m.startOffset && containsWorkingDay(m.startOffset, m.endOffset)), rng);
  const take = (count, accept = () => true) => {
    const picked = [];
    for (let i = 0; i < schedulable.length && picked.length < count; ) {
      if (accept(schedulable[i])) picked.push(schedulable.splice(i, 1)[0]);
      else i++;
    }
    if (picked.length < count) throw new Error(`the plan has too few milestones for a planted set of ${count}`);
    return picked;
  };
  const planted = {
    endLater: take(PLANTED.endLater).map((m) => ({ m, days: 1 + Math.floor(rng() * 10) })),
    endEarlier: take(PLANTED.endEarlier).map((m) => ({ m, days: -(1 + Math.floor(rng() * 10)) })),
    renamed: take(PLANTED.renamed).map((m) => ({ m })),
    reparented: take(PLANTED.reparented).map((m) => ({ m })),
    undatedInJira: take(PLANTED.undatedInJira).map((m) => ({ m })),
    doneEarly: take(PLANTED.doneEarly, (m) => m.endOffset >= 14).map((m) => ({ m })),
    estimateChanged: take(PLANTED.estimateChanged).map((m) => ({ m, delta: 3 + Math.floor(rng() * 7) })),
    deleted: take(PLANTED.deleted).map((m) => ({ m })),
    movedOut: take(PLANTED.movedOut).map((m) => ({ m })),
  };
  const unscheduled = shuffled(milestones.filter((m) => m.startOffset === null), rng);
  planted.datedInJiraOnly = unscheduled.slice(0, PLANTED.datedInJiraOnly).map((m) => {
    const start = nextWorkingOnOrAfter(Math.floor(rng() * 120));
    return { m, start, end: dayOfWorkIndex(workIndex(start) + Math.floor(rng() * 15)) };
  });
  const tag = (name) => new Map(planted[name].map((x) => [x.m.ref, x]));
  const tags = Object.fromEntries(Object.keys(planted).map((name) => [name, tag(name)]));

  // The projects' own plants (a project with a target window; programs by their derived span).
  const targeted = shuffled(projects.filter((p) => p.targetStartOffset !== null), rng);
  const projectsTargetLater = new Set(targeted.slice(0, PLANTED.projectsTargetLater).map((p) => p.ref));
  const projectsRenamed = new Set(shuffled(projects, rng).slice(0, PLANTED.projectsRenamed).map((p) => p.ref));
  const programsShifted = new Set(shuffled(programs, rng).slice(0, PLANTED.programsShifted).map((g) => g.ref));

  // --- the issues, in creation (= id) order: per work stream its programs, then its initiatives, then its epics ------------------
  const issues = [];
  const counters = new Map(keys.map((k) => [k, 0]));
  let nextId = FIRST_ID;
  const make = (projectKey, fields) => {
    const number = counters.get(projectKey) + 1;
    counters.set(projectKey, number);
    const issue = { id: String(nextId++), key: `${projectKey}-${number}`, projectKey, parentId: null, points: null, team: null, decoy: false, ...fields };
    issues.push(issue);
    return issue;
  };
  const programIssue = new Map();
  const projectIssue = new Map();
  const milestoneIssue = new Map();
  const recentDay = -1;

  streams.forEach((ws, w) => {
    const projectKey = keys[w];
    ws.programs.forEach((g) => {
      let s = programSpan.get(g.ref);
      if (s !== null && programsShifted.has(g.ref)) s = { start: shiftStart(s.start, 3), end: shiftEnd(s.end, 3) };
      programIssue.set(g.ref, make(projectKey, {
        level: "program", ref: g.ref, summary: g.name, start: s?.start ?? null, end: s?.end ?? null, status: statusFor(s?.start ?? null, s?.end ?? null),
        updated: stamp(ANCHOR, -(10 + Math.floor(rng() * 50)), rng),
      }));
    });
    ws.programs.forEach((g) => g.projects.forEach((p) => {
      const target = p.targetStartOffset === null ? null : { start: p.targetStartOffset, end: p.targetEndOffset };
      let s = target ?? projectSpan.get(p.ref);
      if (target !== null && projectsTargetLater.has(p.ref)) s = { start: target.start, end: shiftEnd(target.end, 5) };
      const renamed = projectsRenamed.has(p.ref);
      projectIssue.set(p.ref, make(projectKey, {
        level: "project", ref: p.ref, summary: renamed ? `${p.name} (renamed)` : p.name, parentId: programIssue.get(g.ref).id,
        start: s?.start ?? null, end: s?.end ?? null, status: statusFor(s?.start ?? null, s?.end ?? null),
        updated: stamp(ANCHOR, -(5 + Math.floor(rng() * 40)), rng),
      }));
    }));
    ws.programs.forEach((g) => g.projects.forEach((p) => byProject.get(p.ref).forEach((m) => {
      let start = m.startOffset;
      let end = m.endOffset;
      const later = tags.endLater.get(m.ref) ?? tags.endEarlier.get(m.ref);
      if (later) {
        start = shiftStart(m.startOffset, later.days);
        end = shiftEnd(m.endOffset, later.days);
      }
      if (tags.undatedInJira.has(m.ref)) start = end = null;
      const dated = tags.datedInJiraOnly.get(m.ref);
      if (dated) ({ start, end } = dated);
      let parent = projectIssue.get(p.ref);
      if (tags.reparented.has(m.ref)) {
        const siblings = g.projects;
        const other = siblings.length > 1 ? siblings[(siblings.findIndex((x) => x.ref === p.ref) + 1) % siblings.length] : programs.find((x) => x.ref !== g.ref).projects[0];
        parent = projectIssue.get(other.ref) ?? parent;
      }
      let status = statusFor(start, end);
      if (tags.doneEarly.has(m.ref)) status = "done";
      const points = Math.round(m.estimateMd * 2 * 100) / 100 + (tags.estimateChanged.get(m.ref)?.delta ?? 0);
      const decoy = m.ref % 10 === 0 && start !== null;
      milestoneIssue.set(m.ref, make(projectKey, {
        level: "milestone", ref: m.ref, summary: tags.renamed.has(m.ref) ? `${m.name} (renamed)` : m.name, parentId: parent.id, start, end, status, points,
        team: { id: teamUuid(m.teamRef), name: teamName.get(m.teamRef) }, decoy,
        updated: stamp(ANCHOR, -(2 + Math.floor(rng() * 60)), rng),
      }));
    })));
  });

  // Recently updated: the first N end-later epics (what an incremental poll sees on both days).
  const recent = planted.endLater.slice(0, PLANTED.incremental).map((x) => milestoneIssue.get(x.m.ref));
  recent.forEach((i) => {
    i.updated = `${isoDateAt(ANCHOR, recentDay)}T09:30:00.000+0000`;
  });

  // --- the E2E project: 3 levels, 10 issues, 2044 ------------------------------------------------------------------------------------
  const e2e = buildE2e();

  // Hierarchy-level presence on the issue's own type object: omitted on every third id so the client's /issuetype fallback is exercised too.
  issues.forEach((i) => {
    i.anchor = ANCHOR;
  });
  e2e.issues.forEach((i) => {
    i.anchor = E2E_ANCHOR;
  });
  [...issues, ...e2e.issues].forEach((i) => {
    i.omitLevel = Number(i.id) % 3 === 0;
  });

  const day2 = {
    deleted: planted.deleted.map((x) => milestoneIssue.get(x.m.ref)),
    movedOut: planted.movedOut.map((x, n) => ({ issue: milestoneIssue.get(x.m.ref), movedKey: `OUT-${n + 1}` })),
  };
  return {
    seed, keys, streams, programs, projects, milestones, issues, e2e, recent, day2, planted, tags, programIssue, projectIssue, milestoneIssue,
    projectsTargetLater, projectsRenamed, programsShifted, typeOf: (i) => TYPE_OF_LEVEL[i.level],
    projectRows: [
      ...streams.map((w, n) => ({ id: String(10_000 + n), key: keys[n], name: w.name })),
      { id: "10005", key: "E2E", name: "Astrolabe e2e" },
      { id: "10006", key: "OUT", name: "Archive (out of scope)" },
    ],
  };
}

/** The isolated e2e project: a Program, two Initiatives, seven Epics, all in 2044 (offsets from E2E_ANCHOR). */
function buildE2e() {
  const issues = [];
  const add = (n, fields) => issues.push({
    id: String(E2E_FIRST_ID + n - 1), key: `E2E-${n}`, projectKey: "E2E", points: null, team: null, parentId: null, decoy: false, ref: null,
    updated: `${isoDateAt(E2E_ANCHOR, -7)}T10:00:00.000+0000`, status: "todo", ...fields,
  });
  const id = (n) => String(E2E_FIRST_ID + n - 1);
  const team = { id: teamUuid(901), name: "E2E Team" };
  add(1, { level: "program", summary: "E2E Program", start: 0, end: 74 });
  add(2, { level: "project", summary: "E2E Initiative Alpha", parentId: id(1), start: 0, end: 45 });
  add(3, { level: "project", summary: "E2E Initiative Beta", parentId: id(1), start: 56, end: 74 });
  add(4, { level: "milestone", summary: "E2E Epic One", parentId: id(2), start: 0, end: 4, points: 5, team });
  add(5, { level: "milestone", summary: "E2E Epic Two", parentId: id(2), start: 28, end: 37, points: 8, team });
  add(6, { level: "milestone", summary: "E2E Epic Three", parentId: id(2), start: 41, end: 45, points: 3, team });
  add(7, { level: "milestone", summary: "E2E Epic Four", parentId: id(3), start: 56, end: 60, points: 5, team });
  add(8, { level: "milestone", summary: "E2E Epic Five", parentId: id(3), start: 63, end: 67, points: 2, team });
  add(9, { level: "milestone", summary: "E2E Epic Six", parentId: id(3), start: null, end: null, points: 1, team });
  add(10, { level: "milestone", summary: "E2E Epic Seven", parentId: id(3), start: 70, end: 74, points: 13, team });
  const byKey = (k) => issues.find((i) => i.key === k);
  return { issues, recent: [byKey("E2E-5"), byKey("E2E-7")], deleted: [byKey("E2E-6")] };
}
