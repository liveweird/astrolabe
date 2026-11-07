// expected.json: the figures a test or the manual walk-through compares the sync's findings with, derived from the same world as the
// mappings (so they cannot drift) and rendered with short arrays on one line (the key lists are 1,000 entries).
import { isoDateAt } from "../../scripts/sample-plan/days.mjs";
import { TYPE } from "./catalog.mjs";
import { ANCHOR, E2E_ANCHOR, IMP_ANCHOR, PLANTED } from "./world.mjs";
import { PAGE_SIZE, SCENARIO, keyScopesOf, scopesOf } from "./mappings.mjs";
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

export function buildExpected(world, counts, stub) {
  const { issues, planted, milestoneIssue, e2e, imp } = world;
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
    totals: { programs: level("program").length, projects: level("project").length, milestones: level("milestone").length, issues: issues.length, e2eIssues: e2e.issues.length },
    projects: world.projectRows.map((p) => ({
      key: p.key, id: p.id, name: p.name,
      issues: [...issues, ...e2e.issues, ...imp.issues].filter((i) => i.projectKey === p.key).length,
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
    e2e: {
      project: "E2E",
      anchor: E2E_ANCHOR,
      issues: e2e.issues.map((i) => ({ key: i.key, id: i.id, level: i.level, summary: i.summary, parent: i.parentId === null ? null : e2e.issues.find((p) => p.id === i.parentId).key, ...dates(i) })),
      linkedEpic: { key: linked.key, jira: dates(linked), planEnd: isoDateAt(E2E_ANCHOR, 34), endLaterWorkingDays: 3, note: "a plan milestone ending 2044-02-07 against this epic reads 3 working days later in Jira" },
      unscheduled: e2e.issues.filter((i) => i.start === null).map((i) => i.key),
      deletedOnDay2: e2e.deleted.map((i) => i.key),
      recent: e2e.recent.map((i) => i.key),
    },
  };
}
