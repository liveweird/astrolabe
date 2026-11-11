// Self-test of the Jira stub generator (run: node --test sample-data/jira/generate.test.mjs): determinism (two runs, byte-identical), the
// committed sample-data/jira-stub and expected.json equal to a fresh run, the planted counts, the hierarchy, and the regexes the mappings
// match with (the same syntax in JavaScript and Java). The JVM side (JiraStubFixtureTest) replays the served contract over HTTP.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { generate } from "./generate.mjs";
import { IMPORT_TYPE_IDS, JQL_SHAPES, listClause, wrongTokenPattern } from "./mappings.mjs";
import { PLANTED } from "./world.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const first = generate();
const expected = JSON.parse(first.expected);

test("two runs write byte-identical output", () => {
  const second = generate();
  for (const part of ["mappings", "files"]) {
    assert.deepEqual([...second[part].keys()], [...first[part].keys()]);
    for (const [name, text] of first[part]) assert.equal(second[part].get(name), text, name);
  }
  assert.equal(second.expected, first.expected);
});

test("the committed stub directory and expected.json equal a fresh run", () => {
  const committed = (dir) => new Map(readdirSync(join(here, "../jira-stub", dir)).map((name) => [name, readFileSync(join(here, "../jira-stub", dir, name), "utf8")]));
  for (const [part, dir] of [["mappings", "mappings"], ["files", "__files"]]) {
    const onDisk = committed(dir);
    assert.deepEqual([...onDisk.keys()].sort(), [...first[part].keys()].sort(), `${dir}: file list (regenerate: node sample-data/jira/generate.mjs)`);
    for (const [name, text] of first[part]) assert.equal(onDisk.get(name), text, `${dir}/${name}`);
  }
  assert.equal(readFileSync(join(here, "expected.json"), "utf8"), first.expected);
});

test("every mapping names a body that exists, and no body is orphaned", () => {
  const used = new Set();
  for (const [name, text] of first.mappings) {
    const body = JSON.parse(text).response.bodyFileName;
    assert.ok(first.files.has(body), `${name} -> ${body}`);
    used.add(body);
  }
  assert.deepEqual([...first.files.keys()].filter((f) => !used.has(f)), []);
});

test("the hierarchy and the planted sets have the documented sizes", () => {
  assert.deepEqual(expected.totals, { programs: 20, projects: 100, milestones: 1000, issues: 1120, e2eIssues: 10, stories: expected.totals.stories });
  for (const name of ["endLater", "endEarlier", "renamed", "reparented", "undatedInJira", "doneEarly", "estimateChanged", "datedInJiraOnly", "childrenDone"]) {
    assert.equal(expected.planted[name].count, PLANTED[name], name);
  }
  const all = Object.values(expected.planted).flatMap((p) => p.items ?? []).map((i) => i.ref);
  assert.equal(new Set(all).size, all.length, "the planted milestone sets are disjoint");
  assert.equal(expected.day2.deleted.count, PLANTED.deleted);
  assert.equal(expected.day2.movedOut.length, PLANTED.movedOut);
  assert.ok(expected.planted.endLater.items.every((i) => i.days >= 1 && i.days <= 10));
  assert.ok(expected.planted.endEarlier.items.every((i) => i.days <= -1 && i.days >= -10));
  const { world } = first;
  const ids = new Set();
  for (const issue of [...world.issues, ...world.stories, ...world.e2e.issues, ...world.imp.issues, ...world.cov.issues]) {
    assert.ok(!ids.has(issue.id), `duplicate id ${issue.id}`);
    ids.add(issue.id);
    assert.match(issue.projectKey, /^[A-Z][A-Z0-9_]{1,9}$/);
  }
  const byId = new Map(world.issues.map((i) => [i.id, i]));
  for (const issue of world.issues) {
    const parentLevel = { program: null, project: "program", milestone: "project" }[issue.level];
    assert.equal(issue.parentId === null ? null : byId.get(issue.parentId).level, parentLevel, issue.key);
  }
  assert.deepEqual(expected.projects.map((p) => p.key), ["CE", "PF", "CG", "DI", "OE", "E2E", "OUT", "IMP", "COV", "IMF"]);
  assert.deepEqual(expected.scopes.cov, ["COV"]);
  assert.deepEqual(expected.e2e.issues.map((i) => i.level), ["program", "project", "project", ...Array(7).fill("milestone")]);
  assert.ok(expected.e2e.issues.filter((i) => i.start !== null).every((i) => i.start.startsWith("2044") && i.end.startsWith("2044")));
});

test("the stories sit under every fifth epic (1..4) and under the childrenDone epics (2..3, all done); stories are never deleted or moved", () => {
  const { world } = first;
  assert.equal(expected.totals.stories, world.stories.length);
  assert.ok(world.stories.length > 400 && world.stories.length < 700, `about 500 stories, got ${world.stories.length}`);
  const epics = new Map(world.issues.map((i) => [i.id, i]));
  const done = new Set(expected.planted.childrenDone.items.map((i) => i.ref));
  const perEpic = new Map();
  for (const story of world.stories) {
    const epic = epics.get(story.parentId);
    assert.equal(epic.level, "milestone", story.key);
    assert.equal(story.projectKey, epic.projectKey, story.key);
    assert.ok([1, 2, 3, 5, 8].includes(story.points), story.key);
    assert.ok(["story"].includes(story.level) && story.type === undefined, story.key);
    perEpic.set(epic.ref, [...(perEpic.get(epic.ref) ?? []), story]);
  }
  for (const [ref, stories] of perEpic) {
    if (done.has(ref)) assert.ok(stories.length >= 2 && stories.length <= 3 && stories.every((s) => s.status === "done"), `childrenDone ${ref}`);
    else assert.ok(ref % 5 === 0 && stories.length >= 1 && stories.length <= 4, `epic ${ref}`);
  }
  const stored = new Set([...expected.day2.deleted.refs, ...expected.day2.movedOut.map((m) => m.ref)]);
  const wanted = world.issues.filter((i) => i.level === "milestone" && (done.has(i.ref) || i.ref % 5 === 0) && !stored.has(i.ref));
  assert.equal(perEpic.size, wanted.length, "every fifth epic and each childrenDone epic, once, but never a day-2 epic");
  for (const item of expected.planted.childrenDone.items) {
    const epic = world.milestoneIssue.get(item.ref);
    assert.equal(epic.status, "todo", `${item.key}: To Do with a future start, so CHILDREN_DONE is its only deviation`);
    assert.ok(epic.start > 0 && epic.end >= 14, `${item.key}: starts after the anchor, the plan end is two weeks past it`);
    assert.equal(item.children, perEpic.get(item.ref).length, item.key);
  }
  const allDone = [...perEpic].filter(([ref, list]) => list.every((x) => x.status === "done") && world.milestoneIssue.get(ref).status !== "done").map(([ref]) => ref);
  assert.deepEqual(allDone.sort((a, b) => a - b), [...done].sort((a, b) => a - b), "the only non-done epics with all-done children are the planted childrenDone");
  assert.ok([...done].every((r) => !stored.has(r)), "the childrenDone epics are not day-2 epics");
  assert.ok([...perEpic.keys()].every((r) => !stored.has(r)), "no deleted or moved epic holds stories: the child level reads the same on both days");
  assert.deepEqual(expected.search["sample/sweep/s/day2"], expected.search["sample/sweep/s/started"]);
});

test("the COV project: the documented epics, stories, roll-ups and unbound sets, all in 2046", () => {
  const { cov } = expected;
  assert.equal(cov.project, "COV");
  assert.equal(cov.issues.length, 12);
  assert.deepEqual(cov.issues.map((i) => i.key), Array.from({ length: 12 }, (_, n) => `COV-${n + 1}`));
  assert.deepEqual(cov.issues.map((i) => i.level), ["program", "project", "milestone", "milestone", "milestone", "story", "story", "story", "story", "milestone", "story", "story"]);
  assert.deepEqual(cov.issues.filter((i) => i.level === "story").map((i) => i.type), ["Story", "Story", "Task", "Bug", "Story", "Story"]);
  assert.deepEqual(cov.issues.filter((i) => i.level === "story").map((i) => i.parent), ["COV-3", "COV-3", "COV-3", "COV-3", "COV-4", "COV-4"]);
  assert.deepEqual(cov.rollups, { "COV-3": { children: 4, done: 2, points: 13 }, "COV-4": { children: 2, done: 2, points: 5 } });
  assert.deepEqual(cov.unlinkedOpen, ["COV-5"]);
  assert.deepEqual(cov.unlinkedDone, ["COV-10"]);
  assert.ok(cov.issues.filter((i) => i.start !== null).every((i) => i.start.startsWith("2046") && i.end.startsWith("2046")));
  assert.ok(cov.issues.filter((i) => i.level === "milestone" && i.key !== "COV-10").every((i) => i.status !== "done"));
  assert.equal(expected.projects.find((p) => p.key === "COV").issues, 12);
  // The child level has its own typed read and sweep per scope; the untyped full read lists the stories too.
  assert.deepEqual(expected.search["cov/fulltypes/s/started"], { issues: 6, pages: 1 });
  assert.deepEqual(expected.search["cov/sweep/s/started"], { issues: 6, pages: 1 });
  assert.equal(expected.search["cov/full/any/started"].issues, 12);
  assert.equal(expected.search["sample/fulltypes/s/started"].issues, expected.totals.stories);
  assert.equal(expected.search["sample/sweep/s/day2"].issues, expected.totals.stories);
  assert.equal(expected.search["ce/fulltypes/s/started"].issues > 0, true, "a single-key scope answers the child level too");
});

test("the IMF project: the fifteen listed issues, the hidden parent and what the server's filter makes of them (1.13.2)", () => {
  const { imf } = expected;
  assert.equal(imf.project, "IMF");
  assert.equal(imf.issues.length, 15);
  assert.deepEqual(imf.issues.map((i) => i.key), Array.from({ length: 15 }, (_, n) => `IMF-${n + 1}`));
  assert.deepEqual(imf.issues.map((i) => [i.level, i.parent ?? "null", i.status, i.updated.startsWith("2010") ? "stale" : "fresh"].join("/")), [
    "program/null/todo/fresh", "project/IMF-1/doing/fresh", "project/IMF-1/done/fresh", "project/IMF-1/todo/stale", "project/IMF-1/done/fresh",
    "milestone/IMF-2/todo/fresh", "milestone/IMF-3/doing/fresh", "milestone/IMF-4/todo/fresh", "milestone/IMF-2/done/fresh", "milestone/IMF-5/done/fresh",
    "milestone/IMF-2/todo/stale", "program/null/done/stale", "project/IMF-12/done/stale", "milestone/IMF-13/todo/fresh", "milestone/IMF-16/todo/fresh",
  ]);
  assert.ok(imf.issues.filter((i) => i.start !== null).every((i) => i.start.startsWith("2045") && i.end.startsWith("2045")));
  assert.equal(expected.projects.find((p) => p.key === "IMF").issues, 15);
  assert.deepEqual(expected.scopes.imf, ["IMF"]);
  // The hidden parent: named by IMF-15's document and by nothing else.
  assert.deepEqual(imf.hidden.map((i) => [i.key, i.id, i.level]), [["IMF-16", "98016", "project"]]);
  for (const [name, text] of first.mappings) assert.ok(!text.includes("98016") && !text.includes("IMF-16"), `${name} names the hidden issue`);
  for (const [name, text] of first.files) {
    if (!name.startsWith("search-")) continue;
    assert.ok(!JSON.parse(text).issues.some((i) => i.id === "98016" || i.key === "IMF-16"), `${name} lists the hidden issue`);
  }
  assert.ok([...first.files].some(([name, text]) => name.startsWith("issue-98015-") && JSON.parse(text).fields.parent.key === "IMF-16"), "IMF-15's parent member names it");
  assert.ok(![...first.files.keys()].some((name) => name.startsWith("issue-98016")), "no issue body");
  assert.ok(![...first.mappings.keys()].some((name) => name.startsWith("issue-98016")), "no issue mapping: by id and by key it falls to the 404");
  const reads = (outcome) => outcome.byIdReads.map((r) => `${r.key}${r.answer === 404 ? " (404)" : ""}`);
  const none = imf.byFilter.none;
  assert.deepEqual([none.rows, none.create, none.skip, none.skipped, none.leftOut, none.keptAsParent, none.byIdReads], [15, 14, 1, ["IMF-15"], [], [], []]);
  const table = {
    doneAndWindow: [11, 10, ["IMF-5", "IMF-9", "IMF-10", "IMF-11"], ["IMF-3", "IMF-4", "IMF-12", "IMF-13"], ["IMF-3", "IMF-4", "IMF-13", "IMF-16 (404)", "IMF-12"]],
    doneOnly: [12, 11, ["IMF-5", "IMF-9", "IMF-10"], ["IMF-3", "IMF-12", "IMF-13"], ["IMF-3", "IMF-13", "IMF-16 (404)", "IMF-12"]],
    windowOnly: [14, 13, ["IMF-11"], ["IMF-4", "IMF-12", "IMF-13"], ["IMF-4", "IMF-13", "IMF-16 (404)", "IMF-12"]],
  };
  for (const [name, [rows, create, leftOut, keptAsParent, byId]] of Object.entries(table)) {
    const outcome = imf.byFilter[name];
    assert.deepEqual([outcome.rows, outcome.create, outcome.skip, outcome.skipped, outcome.leftOut, outcome.keptAsParent, reads(outcome)], [rows, create, 1, ["IMF-15"], leftOut, keptAsParent, byId], name);
  }
  // The listing of every scope answers the windowed browse with the typed read's own pages, count for count.
  for (const [group, count] of Object.entries(expected.search)) {
    if (!group.includes("/importwindow/")) continue;
    assert.deepEqual(count, expected.search[group.replace("/importwindow/", "/fulltypes/")], group);
  }
  assert.deepEqual(expected.search["imf/importwindow/eip/started"], { issues: 15, pages: 1 });
});

test("the paging figures: 100 per page, the last page closes the chain", () => {
  // The untyped full read lists the 1,120 plan issues AND the stories (1.4): 1,120 + stories in the sample scope.
  assert.equal(expected.search["sample/full/any/started"].issues, 1120 + expected.totals.stories);
  assert.equal(expected.search["sample/full/any/started"].pages, Math.ceil((1120 + expected.totals.stories) / 100));
  assert.equal(expected.search["sample/full/any/day2"].issues, 1120 + expected.totals.stories - PLANTED.deleted - PLANTED.movedOut);
  assert.equal(expected.search["sample/sweep/e/started"].issues, 1000);
  // The E2E project: ten issues, minus E2E-6 (deleted) and E2E-10 (moved to OUT-6) on day 2.
  assert.equal(expected.search["e2e/full/any/started"].issues, 10);
  assert.equal(expected.search["e2e/full/any/day2"].issues, 8);
  assert.deepEqual(expected.e2e.movedOnDay2, [{ key: "E2E-10", movedKey: "OUT-6", id: "90010" }]);
});

const matches = (pattern, text) => new RegExp(`^(?:${pattern})$`).test(text);

test("the project-scope clause matches the key set in any order and quoting, and nothing else", () => {
  const re = listClause("project", ["CE", "PF"]);
  for (const jql of ['project in ("CE","PF") ORDER BY id ASC', 'project in (PF, CE) AND updated >= "-15m" ORDER BY updated ASC', 'project in ("CE", "PF", "CE")']) {
    assert.ok(matches(re, jql), jql);
  }
  for (const jql of ['project in ("CE")', 'project in ("CE","PF","OE")', 'project in ("CEX","PF")', 'issuetype in ("CE","PF")', 'project in ()']) {
    assert.ok(!matches(re, jql), jql);
  }
  assert.ok(matches(listClause("issuetype", ["10004", "10005"]), "project in (\"CE\") AND issuetype in (10005, 10004) ORDER BY id ASC"));
  assert.ok(!matches(listClause("issuetype", ["10004", "10005"]), "project in (\"CE\") AND issuetype in (10004) ORDER BY id ASC"));
});

test("the refused token is matched in Bearer and in Basic form whatever the email's length", () => {
  const re = wrongTokenPattern();
  assert.ok(matches(re, "Bearer wrong-token"));
  assert.ok(!matches(re, "Bearer good-token"));
  for (const email of ["a@b.c", "ab@b.c", "abc@b.c", "e2e-jira@astrolabe.local", "someone.long@example.test"]) {
    const basic = (token) => `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;
    assert.ok(matches(re, basic("wrong-token")), email);
    assert.ok(!matches(re, basic("good-token")), email);
    assert.ok(!matches(re, basic("not-the-wrong-token-at-all")), email);
  }
});

// The exact texts the server sends (JiraJql.full/sweep/incremental, and 1.13.2's importBrowse) against the shapes of mappings.mjs: a request
// matches a mapping when every `matches` regex matches and no `doesNotMatch` does. The observation read's `fields` is the same for all of
// them, so among them only a shape of the SAME priority could make an answer ambiguous: family, refusal and typed read are priority 2, the
// incremental and the untyped full read priority 3 (`search-*-incremental-*` and `search-*-full-*`); the sweep and the probe want `fields=id`.
const accepts = (shape, jql) => shape.matches.every((re) => matches(re, jql)) && shape.doesNotMatch.every((re) => !matches(re, jql));
const IMF_TYPES = "10006,10005,10004";
const browse = (extra) => `project in ("IMF") AND issuetype in (${IMF_TYPES})${extra} ORDER BY id ASC`;
const WINDOW = ' AND updated >= "-525600m"';
const DONE = " AND statusCategory != Done";
const INCREMENTAL = 'project in ("IMF") AND updated >= "-15m" ORDER BY updated ASC';

test("the windowed import browse is the importWindow shape and no other priority-2 shape; other type sets are refused", () => {
  const family = JQL_SHAPES.importWindow(["IMF"], IMPORT_TYPE_IDS);
  const typed = JQL_SHAPES.typed(["IMF"], IMPORT_TYPE_IDS);
  const refusal = JQL_SHAPES.importWindowRefusal(IMPORT_TYPE_IDS);
  const priorityTwo = { family, refusal, typed };
  const who = (jql) => Object.entries(priorityTwo).filter(([, shape]) => accepts(shape, jql)).map(([name]) => name);

  // Both windowed forms of the server's browse: the family, never the refusal or the typed read.
  assert.deepEqual(who(browse(DONE + WINDOW)), ["family"]);
  assert.deepEqual(who(browse(WINDOW)), ["family"]);
  // A window over another type set (one or two mapped levels, or the child level): the refusal, never the family.
  for (const types of ["10004", "10005,10004", "10001,10002,10003"]) {
    assert.deepEqual(who(`project in ("IMF") AND issuetype in (${types}) AND statusCategory != Done AND updated >= "-525600m" ORDER BY id ASC`), ["refusal"], types);
    assert.deepEqual(who(`project in ("IMF") AND issuetype in (${types}) AND updated >= "-525600m" ORDER BY id ASC`), ["refusal"], types);
  }
  // The done-only form (no window) is the typed read's shape, as the run's own full read is: neither new shape sees it.
  assert.deepEqual(who(browse(DONE)), ["typed"]);
  assert.deepEqual(who(browse("")), ["typed"]);
  // The run's other texts: the incremental read and the sweep (same text as the full read, `fields=id`) match neither new shape.
  assert.deepEqual(who(INCREMENTAL), []);
  assert.ok(accepts(JQL_SHAPES.incremental(["IMF"]), INCREMENTAL));
  assert.ok(accepts(JQL_SHAPES.sweep(["IMF"], IMPORT_TYPE_IDS), browse("")) && !accepts(JQL_SHAPES.incremental(["IMF"]), browse("")));
  // The incremental shape also fits the windowed browse (scope + window): the family's priority 2 beats its 3.
  assert.ok(accepts(JQL_SHAPES.incremental(["IMF"]), browse(WINDOW)));
  // Scope: the family needs its key set; the refusal is scope-free (an unknown scope is a 401 either way).
  const other = 'project in ("IMP") AND issuetype in (10006,10005,10004) AND updated >= "-525600m" ORDER BY id ASC';
  assert.ok(!accepts(family, other));
  assert.ok(accepts(JQL_SHAPES.importWindow(["IMP"], IMPORT_TYPE_IDS), other));
  // A window written in days is not a window (nobody sends it); the typed read ignores a clause it does not know.
  assert.deepEqual(who(browse(' AND updated >= "-365d"')), ["typed"]);
});

test("the importwindow family sits at priority 2 beside the refusal, above the incremental mappings (priority 3)", () => {
  const priorityOf = (name) => JSON.parse(first.mappings.get(name)).priority;
  const names = [...first.mappings.keys()].filter((name) => name.startsWith("search-"));
  const family = names.filter((name) => name.includes("-importwindow-eip-"));
  assert.ok(family.length >= 80, `the family covers every scope on both days, got ${family.length}`);
  assert.ok(family.every((name) => priorityOf(name) === 2), "the family sits at priority 2");
  assert.equal(priorityOf("search-importwindow-refused-401.json"), 2);
  assert.equal(JSON.parse(first.mappings.get("search-importwindow-refused-401.json")).response.status, 401);
  assert.ok(names.filter((name) => name.includes("-incremental-")).every((name) => priorityOf(name) === 3));
  // Every family page reuses a body of the typed read's listing: no new body per scope.
  const bodyOf = (name) => JSON.parse(first.mappings.get(name)).response.bodyFileName;
  for (const name of family) assert.equal(bodyOf(name), bodyOf(name.replace("-importwindow-", "-fulltypes-")), name);
});
