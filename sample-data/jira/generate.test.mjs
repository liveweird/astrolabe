// Self-test of the Jira stub generator (run: node --test sample-data/jira/generate.test.mjs): determinism (two runs, byte-identical), the
// committed sample-data/jira-stub and expected.json equal to a fresh run, the planted counts, the hierarchy, and the regexes the mappings
// match with (the same syntax in JavaScript and Java). The JVM side (JiraStubFixtureTest) replays the served contract over HTTP.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { generate } from "./generate.mjs";
import { listClause, wrongTokenPattern } from "./mappings.mjs";
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
  assert.deepEqual(expected.projects.map((p) => p.key), ["CE", "PF", "CG", "DI", "OE", "E2E", "OUT", "IMP", "COV"]);
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

test("the paging figures: 100 per page, the last page closes the chain", () => {
  // The untyped full read lists the 1,120 plan issues AND the stories (1.4): 1,120 + stories in the sample scope.
  assert.equal(expected.search["sample/full/any/started"].issues, 1120 + expected.totals.stories);
  assert.equal(expected.search["sample/full/any/started"].pages, Math.ceil((1120 + expected.totals.stories) / 100));
  assert.equal(expected.search["sample/full/any/day2"].issues, 1120 + expected.totals.stories - PLANTED.deleted - PLANTED.movedOut);
  assert.equal(expected.search["sample/sweep/e/started"].issues, 1000);
  assert.equal(expected.search["e2e/full/any/day2"].issues, 9);
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
