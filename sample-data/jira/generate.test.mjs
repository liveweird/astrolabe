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
  assert.deepEqual(expected.totals, { programs: 20, projects: 100, milestones: 1000, issues: 1120, e2eIssues: 10 });
  for (const name of ["endLater", "endEarlier", "renamed", "reparented", "undatedInJira", "doneEarly", "estimateChanged", "datedInJiraOnly"]) {
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
  for (const issue of [...world.issues, ...world.e2e.issues]) {
    assert.ok(!ids.has(issue.id), `duplicate id ${issue.id}`);
    ids.add(issue.id);
    assert.match(issue.projectKey, /^[A-Z][A-Z0-9_]{1,9}$/);
  }
  const byId = new Map(world.issues.map((i) => [i.id, i]));
  for (const issue of world.issues) {
    const parentLevel = { program: null, project: "program", milestone: "project" }[issue.level];
    assert.equal(issue.parentId === null ? null : byId.get(issue.parentId).level, parentLevel, issue.key);
  }
  assert.deepEqual(expected.e2e.issues.map((i) => i.level), ["program", "project", "project", ...Array(7).fill("milestone")]);
  assert.ok(expected.e2e.issues.filter((i) => i.start !== null).every((i) => i.start.startsWith("2044") && i.end.startsWith("2044")));
});

test("the paging figures: 100 per page, the last page closes the chain", () => {
  assert.equal(expected.search["sample/full/any/started"].pages, 12);
  assert.equal(expected.search["sample/full/any/day2"].issues, 1120 - PLANTED.deleted - PLANTED.movedOut);
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
