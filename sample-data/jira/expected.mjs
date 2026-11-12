// expected.json: the figures a test or the manual walk-through compares the sync's findings with, derived from the same world as the
// mappings (so they cannot drift) and rendered with short arrays on one line (the key lists are 1,000 entries).
import { isoDateAt } from "../../scripts/sample-plan/days.mjs";
import { TYPE, typeOf } from "./catalog.mjs";
import { ANCHOR, COV_ANCHOR, E2E_ANCHOR, IMC_ANCHOR, IMF_ANCHOR, IMP_ANCHOR, PLANTED } from "./world.mjs";
import { CHILD_SETS, PAGE_SIZE, SCENARIO, keyScopesOf, scopesOf } from "./mappings.mjs";
import { REJECTED_TOKEN, CLOUD_ID } from "./catalog.mjs";

const isPrimitive = (v) => v === null || typeof v !== "object";
const ROW = 10;

function render(value, depth = 0) {
  const pad = "  ".repeat(depth);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    if (value.every(isPrimitive)) {
      if (value.length <= ROW) return `[${value.map((x) => JSON.stringify(x)).join(", ")}]`;
      const rows = [];
      for (let i = 0; i < value.length; i += ROW) rows.push(`${pad}  ${value.slice(i, i + ROW).map((x) => JSON.stringify(x)).join(", ")}`);
      return `[\n${rows.join(",\n")}\n${pad}]`;
    }
    return `[\n${value.map((x) => `${pad}  ${render(x, depth + 1)}`).join(",\n")}\n${pad}]`;
  }
  if (!isPrimitive(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) return "{}";
    if (entries.every(([, v]) => isPrimitive(v))) return `{ ${entries.map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(", ")} }`;
    return `{\n${entries.map(([k, v]) => `${pad}  ${JSON.stringify(k)}: ${render(v, depth + 1)}`).join(",\n")}\n${pad}}`;
  }
  return JSON.stringify(value);
}
export const renderExpected = (value) => `${render(value)}\n`;

const dates = (issue) => ({ start: issue.start === null ? null : isoDateAt(issue.anchor, issue.start), end: issue.end === null ? null : isoDateAt(issue.anchor, issue.end) });

/** The roll-up the server computes for an epic from its children: how many, how many done, the sum of their points (null when none carries any). */
function rollupOf(children) {
  const withPoints = children.filter((c) => c.points !== null);
  return { children: children.length, done: children.filter((c) => c.status === "done").length, points: withPoints.length === 0 ? null : withPoints.reduce((sum, c) => sum + c.points, 0) };
}

/**
 * What the import's server-side filter makes of the IMF project (1.13.2), computed from the world by the SAME rules the server applies (the stub
 * does not evaluate the filter): a listed issue is kept unless it is done (with `excludeDone`) or quiet (with a window; "stale" is outside every
 * window); the missing direct parents of the kept issues are then read by id, round by round (never one already held or tried, ascending id), and
 * what a read brings is KEPT AS A PARENT. A hidden parent answers 404: its child is skipped with NO_PARENT (without a filter nothing is read and
 * IMF-15 is skipped NO_PARENT all the same). Only the three mapped levels exist here, so a parent chain ends at the program.
 */
function imfOutcome(imf, { excludeDone, window }) {
  const byId = new Map([...imf.issues, ...imf.hidden].map((i) => [i.id, i]));
  const stale = (i) => i.updated.startsWith("2010");
  const kept = imf.issues.filter((i) => !(excludeDone && i.status === "done") && !(window && stale(i)));
  const held = new Set(kept.map((i) => i.id));
  const reads = [];
  const keptAsParent = [];
  const unreadable = [];
  if (excludeDone || window) {
    const tried = new Set();
    let round = kept;
    while (round.length > 0) {
      const wanted = [...new Set(round.filter((i) => i.parentId !== null && !held.has(i.parentId) && !tried.has(i.parentId)).map((i) => i.parentId))].sort((a, b) => Number(a) - Number(b));
      const fetched = [];
      for (const parentId of wanted) {
        tried.add(parentId);
        const parent = byId.get(parentId);
        const listed = imf.issues.includes(parent);
        reads.push({ key: parent.key, answer: listed ? 200 : 404 });
        if (!listed) {
          unreadable.push(...round.filter((i) => i.parentId === parentId).map((i) => i.key));
          continue;
        }
        held.add(parent.id);
        keptAsParent.push(parent.key);
        fetched.push(parent);
      }
      round = fetched;
    }
  }
  const rows = imf.issues.filter((i) => held.has(i.id));
  const skipped = unreadable.length > 0 ? unreadable : ["IMF-15"];
  return {
    rows: rows.length,
    create: rows.length - skipped.length,
    skip: skipped.length,
    skipped,
    leftOut: imf.issues.filter((i) => !held.has(i.id)).map((i) => i.key),
    keptAsParent: keptAsParent.sort((a, b) => Number(a.slice(4)) - Number(b.slice(4))),
    byIdReads: reads,
  };
}

const IMC_ROOTS = ["IMC-1", "IMC-2", "IMC-14"]; // the program root, the project root, the program with nothing under it
/** Whether `issue` hangs (at any depth) under the issue keyed `rootKey`. */
function isUnder(list, issue, rootKey) {
  for (let parent = list.find((i) => i.id === issue.parentId); parent !== undefined; parent = list.find((i) => i.id === parent.parentId)) {
    if (parent.key === rootKey) return true;
  }
  return false;
}
const LEVEL_RANK = { program: 0, project: 1, milestone: 2 };
const LEVEL_TYPE = { project: "Initiative", milestone: "Epic" };
const byNumber = (a, b) => Number(a.slice(4)) - Number(b.slice(4));

/**
 * What the server makes of a ROOTED browse of the IMC project (1.14.0: the import from a linked node), computed from the world by the SAME rules the
 * server applies (the stub evaluates no filter): the root is read by id and is never a row; round one asks for its children at every mapped level
 * below it; round two (a program root only) asks for the milestones under ALL of round one's projects, ids ascending; a milestone is held only when the
 * filter admits it; a project is always held (it is a parent to walk) and, when the filter does not admit it, is kept ONLY if a held row hangs under it
 * (`keptAsParent`). `skipped` = the held milestones hanging straight under a root program (no default project given: NO_PARENT); the default team is
 * given, so nothing else is skipped. `searches` are the stub's children groups the walk reads, `parents` as keys.
 */
function imcOutcome(imc, rootKey, { excludeDone, window }) {
  const stale = (i) => i.updated.startsWith("2010");
  const admitted = (i) => !(excludeDone && i.status === "done") && !(window && stale(i));
  const root = imc.issues.find((i) => i.key === rootKey);
  const childrenOf = (parents) => imc.issues.filter((i) => parents.some((p) => p.id === i.parentId) && LEVEL_RANK[i.level] > LEVEL_RANK[root.level]);
  const searches = [];
  const listed = [];
  const search = (parents, levels) => {
    const found = childrenOf(parents).filter((i) => levels.includes(i.level));
    searches.push({ parents: parents.map((p) => p.key), types: levels.map((l) => LEVEL_TYPE[l]) });
    listed.push(...found);
    return found;
  };
  const round = search([root], root.level === "program" ? ["project", "milestone"] : ["milestone"]);
  if (root.level === "program") {
    const projects = round.filter((i) => i.level === "project");
    if (projects.length > 0) search(projects, ["milestone"]);
  }
  const held = listed.filter((i) => i.level === "project" || admitted(i));
  const hasHeldChild = (i) => held.some((h) => h.parentId === i.id);
  const rows = held.filter((i) => i.level === "milestone" || admitted(i) || hasHeldChild(i));
  const skipped = root.level === "program" ? rows.filter((i) => i.level === "milestone" && i.parentId === root.id).map((i) => i.key) : [];
  const keys = (list) => list.map((i) => i.key).sort(byNumber);
  return {
    rows: rows.length,
    create: rows.length - skipped.length,
    skip: skipped.length,
    skipped,
    leftOut: keys(listed.filter((i) => !rows.includes(i))),
    keptAsParent: keys(rows.filter((i) => i.level === "project" && !admitted(i))),
    rowKeys: keys(rows),
    searches,
  };
}

export function buildExpected(world, counts, stub) {
  const { issues, stories, planted, milestoneIssue, e2e, imp, cov, imf, imc } = world;
  const childrenOf = (list, epic) => list.filter((s) => s.parentId === epic.id);
  const level = (name) => issues.filter((i) => i.level === name);
  const items = (name, extra = () => ({})) => ({
    count: planted[name].length,
    items: planted[name].map((x) => ({ ref: x.m.ref, key: milestoneIssue.get(x.m.ref).key, ...extra(x) })),
  });
  const byId = new Map(issues.map((i) => [i.id, i]));
  const e2eIssue = (key) => e2e.issues.find((i) => i.key === key);
  const linked = e2eIssue("E2E-5");
  return {
    generator: "sample-data/jira/generate.mjs",
    seed: world.seed,
    anchor: ANCHOR,
    cloudId: CLOUD_ID,
    rejectedToken: REJECTED_TOKEN,
    scenario: SCENARIO,
    pageSize: PAGE_SIZE,
    note: "Dates are absolute for the anchor Monday; statuses are relative to it. Working-day figures are holiday-free (Mon-Fri).",
    stub: { mappings: stub.mappings.size, bodies: stub.files.size },
    issueTypes: Object.fromEntries(Object.entries(TYPE).map(([name, t]) => [name, { id: t.id, hierarchyLevel: t.hierarchyLevel }])),
    scopes: Object.fromEntries(scopesOf(world).map((s) => [s.name, s.keys])),
    importScopes: Object.fromEntries(keyScopesOf(world).map((s) => [s.name, s.keys])),
    totals: { programs: level("program").length, projects: level("project").length, milestones: level("milestone").length, issues: issues.length, e2eIssues: e2e.issues.length, stories: stories.length },
    projects: world.projectRows.map((p) => ({
      key: p.key, id: p.id, name: p.name,
      issues: [...issues, ...stories, ...e2e.issues, ...imp.issues, ...cov.issues, ...imf.issues, ...imc.issues].filter((i) => i.projectKey === p.key).length,
    })),
    keys: {
      programs: level("program").map((i) => i.key),
      projects: level("project").map((i) => i.key),
      milestones: level("milestone").map((i) => i.key),
    },
    statuses: Object.fromEntries(["todo", "doing", "done"].map((s) => [s, issues.filter((i) => i.status === s).length])),
    planted: {
      endLater: items("endLater", (x) => ({ days: x.days })),
      endEarlier: items("endEarlier", (x) => ({ days: x.days })),
      renamed: items("renamed"),
      reparented: items("reparented", (x) => ({ parent: byId.get(milestoneIssue.get(x.m.ref).parentId).key, planParent: world.projectIssue.get(x.m.projectRef).key })),
      undatedInJira: items("undatedInJira"),
      doneEarly: items("doneEarly"),
      estimateChanged: items("estimateChanged", (x) => ({ planPoints: x.m.estimateMd * 2, jiraPoints: milestoneIssue.get(x.m.ref).points })),
      datedInJiraOnly: items("datedInJiraOnly", (x) => dates(milestoneIssue.get(x.m.ref))),
      childrenDone: items("childrenDone", (x) => {
        const children = childrenOf(stories, milestoneIssue.get(x.m.ref));
        return { children: children.length, points: rollupOf(children).points };
      }),
      projectsTargetLater: { count: world.projectsTargetLater.size, refs: [...world.projectsTargetLater].sort((a, b) => a - b), days: 5 },
      projectsRenamed: { count: world.projectsRenamed.size, refs: [...world.projectsRenamed].sort((a, b) => a - b) },
      programsShifted: { count: world.programsShifted.size, refs: [...world.programsShifted].sort((a, b) => a - b), days: 3 },
    },
    plantedTargets: PLANTED,
    incremental: { epics: world.recent.map((i) => i.key), note: "the recently updated epics: what `updated >= \"-Nm\"` returns on both days" },
    day2: {
      deleted: { count: world.day2.deleted.length, keys: world.day2.deleted.map((i) => i.key), refs: world.day2.deleted.map((i) => i.ref) },
      movedOut: world.day2.movedOut.map((m) => ({ ref: m.issue.ref, key: m.issue.key, movedKey: m.movedKey, id: m.issue.id })),
      inScopeDelta: world.day2.deleted.length + world.day2.movedOut.length,
    },
    search: counts,
    imp: {
      project: "IMP",
      anchor: IMP_ANCHOR,
      issues: imp.issues.map((i) => ({ key: i.key, id: i.id, level: i.level, summary: i.summary, parent: i.parentId === null ? null : imp.issues.find((p) => p.id === i.parentId).key, team: i.team?.name ?? null, points: i.points, ...dates(i) })),
      unscheduled: imp.issues.filter((i) => i.start === null).map((i) => i.key),
    },
    cov: {
      project: "COV",
      anchor: COV_ANCHOR,
      issues: cov.issues.map((i) => ({
        key: i.key, id: i.id, level: i.level, type: typeOf(i).name, summary: i.summary, parent: i.parentId === null ? null : cov.issues.find((p) => p.id === i.parentId).key,
        status: i.status, points: i.points, ...dates(i),
      })),
      rollups: Object.fromEntries(cov.issues.filter((i) => i.level === "milestone" && childrenOf(cov.issues, i).length > 0).map((i) => [i.key, rollupOf(childrenOf(cov.issues, i))])),
      unbound: cov.unbound,
      unlinkedOpen: cov.unbound.filter((key) => cov.issues.find((i) => i.key === key).status !== "done"),
      unlinkedDone: cov.unbound.filter((key) => cov.issues.find((i) => i.key === key).status === "done"),
    },
    imf: {
      project: "IMF",
      anchor: IMF_ANCHOR,
      issues: imf.issues.map((i) => ({
        key: i.key, id: i.id, level: i.level, summary: i.summary, parent: i.parentId === null ? null : [...imf.issues, ...imf.hidden].find((p) => p.id === i.parentId).key,
        status: i.status, updated: i.updated, team: i.team?.name ?? null, points: i.points, ...dates(i),
      })),
      hidden: imf.hidden.map((i) => ({ key: i.key, id: i.id, level: i.level, summary: i.summary, status: i.status, updated: i.updated, note: "in no listing and no issue mapping: GET /issue/{id or key} answers 404, while the parent member of its child names it" })),
      note: "the stub does not evaluate the import filter; byFilter is what the SERVER makes of the listing (the rule, then the parents read by id), with a default team and no default parent",
      byFilter: {
        none: imfOutcome(imf, { excludeDone: false, window: false }),
        doneAndWindow: imfOutcome(imf, { excludeDone: true, window: true }),
        doneOnly: imfOutcome(imf, { excludeDone: true, window: false }),
        windowOnly: imfOutcome(imf, { excludeDone: false, window: true }),
      },
    },
    imc: {
      project: "IMC",
      anchor: IMC_ANCHOR,
      issues: imc.issues.map((i) => ({
        key: i.key, id: i.id, level: i.level, summary: i.summary, parent: i.parentId === null ? null : imc.issues.find((p) => p.id === i.parentId).key,
        status: i.status, updated: i.updated, team: i.team?.name ?? null, points: i.points, ...dates(i),
      })),
      childSets: CHILD_SETS.map((set) => ({ name: set.name, parents: set.parents.map((id) => imc.issues.find((i) => i.id === String(id)).key) })),
      roots: IMC_ROOTS,
      neverListed: imc.issues.filter((i) => !IMC_ROOTS.includes(i.key) && !IMC_ROOTS.some((r) => isUnder(imc.issues, i, r))).map((i) => i.key),
      note: "a ROOTED browse: the stub answers `parent in (<set>)` only for the childSets (any other set is a 401) and evaluates no filter; byRoot is what the SERVER makes of the listing (rows exclude the root), with a default team and no default project",
      byRoot: Object.fromEntries(IMC_ROOTS.map((root) => [root, {
        none: imcOutcome(imc, root, { excludeDone: false, window: false }),
        doneAndWindow: imcOutcome(imc, root, { excludeDone: true, window: true }),
        doneOnly: imcOutcome(imc, root, { excludeDone: true, window: false }),
        windowOnly: imcOutcome(imc, root, { excludeDone: false, window: true }),
      }])),
    },
    e2e: {
      project: "E2E",
      anchor: E2E_ANCHOR,
      issues: e2e.issues.map((i) => ({ key: i.key, id: i.id, level: i.level, summary: i.summary, parent: i.parentId === null ? null : e2e.issues.find((p) => p.id === i.parentId).key, ...dates(i) })),
      linkedEpic: { key: linked.key, jira: dates(linked), planEnd: isoDateAt(E2E_ANCHOR, 34), endLaterWorkingDays: 3, note: "a plan milestone ending 2044-02-07 against this epic reads 3 working days later in Jira" },
      unscheduled: e2e.issues.filter((i) => i.start === null).map((i) => i.key),
      deletedOnDay2: e2e.deleted.map((i) => i.key),
      movedOnDay2: e2e.movedOut.map((m) => ({ key: m.issue.key, movedKey: m.movedKey, id: m.issue.id })),
      recent: e2e.recent.map((i) => i.key),
    },
  };
}
