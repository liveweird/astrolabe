// Self-test of the Flow stub generator (run: node --test sample-data/flow/generate.test.mjs): determinism (two runs, byte-identical), the
// committed sample-data/flow-stub and expected.json equal to a fresh run, the contract (token grammar, every served key), the planted
// cases, the cadence checked against the platform's own time-zone database, and the match regexes (JavaScript and Java share the syntax).
// The JVM side (FlowStubFixtureTest) replays the served contract over HTTP.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { AUTH_HEADER, AUTH_SHAPE_PATTERN, FIELDS, memberItem, sprintItem, teamItem, SPRINTS_SINCE_PATTERN, STUB_TOKEN, TOKEN_PATTERN, UNAUTHORIZED } from "./contract.mjs";
import { generate } from "./generate.mjs";
import { AXE_TEAM, E2E_CAPACITIES, E2E_TEAM, EMPTY_TEAM, FIRST_N, LAST_N, LEGACY_TEAM, PLANTED, RENAMED, warsawInstant } from "./world.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const first = generate();
const expected = JSON.parse(first.expected);
const { world } = first;
const byName = (name, teams = world.teams) => teams.find((t) => t.name === name);
const bodyOf = (prefix) => JSON.parse(first.files.get([...first.files.keys()].find((f) => f.startsWith(`${prefix}-`))));

test("two runs write byte-identical output", () => {
  const second = generate();
  for (const part of ["mappings", "files"]) {
    assert.deepEqual([...second[part].keys()], [...first[part].keys()]);
    for (const [name, text] of first[part]) assert.equal(second[part].get(name), text, name);
  }
  assert.equal(second.expected, first.expected);
});

test("the committed stub directory and expected.json equal a fresh run", () => {
  const committed = (dir) => new Map(readdirSync(join(here, "../flow-stub", dir)).map((name) => [name, readFileSync(join(here, "../flow-stub", dir, name), "utf8")]));
  for (const [part, dir] of [["mappings", "mappings"], ["files", "__files"]]) {
    const onDisk = committed(dir);
    assert.deepEqual([...onDisk.keys()].sort(), [...first[part].keys()].sort(), `${dir}: file list (regenerate: node sample-data/flow/generate.mjs)`);
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

test("the mappings: one uniform 401 catch-all at 100, the outage at 5, the 400 at 9, the documents at 10, all but the catch-all need the stub token", () => {
  const parsed = new Map([...first.mappings].map(([name, text]) => [name.replace(/\.json$/, ""), JSON.parse(text)]));
  assert.deepEqual([...parsed.keys()].sort(), ["auth-catchall-401", "me", "me-outage-500", "teams-day2", "teams-day2-no-since", "teams-malformed-since-400", "teams-outage-500", "teams-started", "teams-started-no-since"]);
  const priority = (name) => parsed.get(name).priority;
  assert.deepEqual([priority("auth-catchall-401"), priority("me-outage-500"), priority("teams-outage-500"), priority("teams-malformed-since-400"), priority("me"), priority("teams-started"), priority("teams-day2"), priority("teams-started-no-since"), priority("teams-day2-no-since")], [100, 5, 5, 9, 10, 10, 10, 10, 10]);
  for (const [name, mapping] of parsed) {
    if (name === "auth-catchall-401") assert.equal(mapping.request.headers, undefined, "the catch-all matches any header");
    else if (name.endsWith("-outage-500")) assert.deepEqual(mapping.request.headers, { Authorization: { matches: AUTH_SHAPE_PATTERN } }, name);
    else assert.deepEqual(mapping.request.headers, { Authorization: { equalTo: AUTH_HEADER } }, name);
  }
  assert.equal(parsed.get("auth-catchall-401").request.method, undefined, "any method falls to the 401");
  assert.deepEqual(bodyOf("problem-401"), UNAUTHORIZED);
  assert.equal(UNAUTHORIZED.detail, "Missing or invalid service token");
  for (const name of ["teams-started", "teams-started-no-since"]) assert.equal(parsed.get(name).requiredScenarioState, "Started", name);
  for (const name of ["teams-day2", "teams-day2-no-since"]) assert.equal(parsed.get(name).requiredScenarioState, "day2", name);
  assert.deepEqual(parsed.get("teams-started-no-since").request.queryParameters, { sprintsSince: { absent: true } });
  assert.equal(parsed.get("me-outage-500").requiredScenarioState, "down");
});

test("the token satisfies the grammar and the sprintsSince pattern matches calendar-shaped dates only", () => {
  assert.match(STUB_TOKEN, TOKEN_PATTERN);
  assert.equal(STUB_TOKEN.length, "flow_int_".length + 43);
  for (const bad of ["flow_int_short", `flow_int_${"a".repeat(44)}`, `lettuce_int_${"a".repeat(43)}`, `flow_int_${"a".repeat(42)}!`]) assert.doesNotMatch(bad, TOKEN_PATTERN);
  const re = new RegExp(`^(?:${SPRINTS_SINCE_PATTERN})$`);
  for (const ok of ["2025-10-27", "2026-12-31", "2047-01-07"]) assert.match(ok, re);
  for (const bad of ["2025-13-01", "2025-00-10", "2025-10-32", "2025-1-5", "yesterday", "2025-10-27T00:00", ""]) assert.doesNotMatch(bad, re, bad);
});

test("the served documents carry exactly the contract's field names, in order", () => {
  assert.deepEqual(Object.keys(bodyOf("me")), FIELDS.me);
  const doc = bodyOf("teams-started");
  assert.deepEqual(Object.keys(doc), FIELDS.teams);
  assert.equal(doc.items.length, 19);
  for (const team of doc.items) {
    assert.deepEqual(Object.keys(team), FIELDS.team, team.name);
    for (const member of team.members) assert.deepEqual(Object.keys(member), FIELDS.member, team.name);
    for (const sprint of team.sprints) assert.deepEqual(Object.keys(sprint), FIELDS.sprint, team.name);
  }
  assert.equal(doc.teamsTruncated, false);
  assert.equal(doc.sprintsTruncated, false);
  assert.deepEqual(expected.contract.fields, FIELDS);
});

test("19 teams: the 15 sample-plan names (one renamed), Legacy Mainframe, the e2e team, the axe team and an empty team", () => {
  const names = world.teams.map((t) => t.name);
  const plan = JSON.parse(readFileSync(join(here, "../plan/teams.json"), "utf8")).map((t) => t.name);
  assert.deepEqual(names, [...plan.map((n) => (n === RENAMED.from ? RENAMED.to : n)), LEGACY_TEAM, E2E_TEAM, AXE_TEAM, EMPTY_TEAM]);
  assert.equal(new Set(names).size, 19);
  assert.equal(expected.totals.teams, 19);
  assert.equal(expected.suggestions.count, 14, "every plan team but the renamed one has a same-named Flow team");
  assert.ok(!expected.suggestions.names.includes(RENAMED.to));
  assert.deepEqual(expected.suggestions.none, PLANTED.noSuggestion);
  assert.equal(new Set(world.teams.map((t) => t.id)).size, 19);
});

test("a sample team: 33 sprints (26 closed, 1 active, 6 future), every sixth on the team default, 4-8 current members, 1-2 closed intervals", () => {
  for (const team of world.teams.slice(0, 15)) {
    const sprints = team.sprints.filter((s) => s.startAt !== null && s.name.match(/Sprint \d+$/));
    assert.equal(sprints.length, LAST_N - FIRST_N + 1, team.name);
    assert.deepEqual(
      ["closed", "active", "future"].map((state) => sprints.filter((s) => s.state === state).length), [26, 1, 6], team.name,
    );
    const current = team.members.filter((m) => m.validTo === null);
    assert.ok(current.length >= 4 && current.length <= 8, `${team.name}: ${current.length} current`);
    assert.equal(team.defaultCapacityMd, current.length * 8, team.name);
    const closed = team.members.length - current.length;
    assert.ok(closed >= 1 && closed <= 2, `${team.name}: ${closed} closed intervals`);
    const keys = team.members.map((m) => `${m.accountId}/${m.validFrom}`);
    assert.equal(new Set(keys).size, keys.length, `${team.name}: (account, validFrom) is unique`);
    for (const m of team.members) assert.ok(m.validTo === null || m.validTo > m.validFrom, `${team.name} ${m.displayName}`);
    sprints.forEach((s, k) => {
      const noCalendar = k % 6 === 5;
      assert.equal(s.hasCalendar, team.name === PLANTED.defaultSourceTeam && k === 32 ? false : !noCalendar, `${team.name} ${s.name}`);
      if (noCalendar) assert.deepEqual([s.capacitySource, s.capacityMd], ["TEAM_DEFAULT", team.defaultCapacityMd], `${team.name} ${s.name}`);
      assert.equal(s.completeAt !== null, s.state === "closed", `${team.name} ${s.name}`);
      assert.ok(s.endAt > s.startAt && (s.completeAt === null || s.completeAt >= s.endAt));
    });
  }
});

test("the cadence is Monday 09:00 to the second Friday 17:00 on Europe/Warsaw's own clock (checked against Intl, DST included)", () => {
  const parts = (ms) => Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Warsaw", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(ms).map((p) => [p.type, p.value]));
  let checked = 0;
  for (const team of [...world.teams, ...world.day2.teams]) {
    for (const s of team.sprints) {
      if (s.startAt === null) continue;
      assert.deepEqual([parts(s.startAt).weekday, parts(s.startAt).hour, parts(s.startAt).minute], ["Mon", "09", "00"], s.name);
      assert.deepEqual([parts(s.endAt).weekday, parts(s.endAt).hour, parts(s.endAt).minute], ["Fri", "17", "00"], s.name);
      checked++;
    }
    for (const m of team.members) {
      assert.deepEqual([parts(m.validFrom).hour, parts(m.validFrom).minute], ["00", "00"], `${team.name} ${m.displayName}`);
      if (m.validTo !== null) assert.deepEqual([parts(m.validTo).hour, parts(m.validTo).minute], ["00", "00"]);
    }
  }
  assert.ok(checked > 500);
  assert.equal(new Date(warsawInstant("2026-10-26", 9)).toISOString(), "2026-10-26T08:00:00.000Z", "after the October switch: +1");
  assert.equal(new Date(warsawInstant("2026-10-23", 9)).toISOString(), "2026-10-23T07:00:00.000Z", "before it: +2");
});

test("sprint ids are unique across the document and sprints are in startAt order", () => {
  const ids = world.teams.flatMap((t) => t.sprints.map((s) => s.sprintId));
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(expected.totals.sprints, ids.length);
  for (const team of world.teams) {
    const starts = team.sprints.filter((s) => s.startAt !== null).map((s) => s.startAt);
    assert.deepEqual(starts, [...starts].sort((a, b) => a - b), team.name);
  }
});

test("the planted cases: no capacity (synthetic), the undated sprints, the empty team, the overlap, the undated sprint, the DEFAULT source, the unnamed member", () => {
  const legacy = byName(LEGACY_TEAM);
  assert.equal(legacy.managerName, null);
  assert.equal(legacy.defaultCapacityMd, null);
  // SYNTHETIC: every sprint of Legacy Mainframe is null/null (Flow itself never derives that for a dated sprint; the wire type allows it).
  assert.ok(legacy.sprints.every((s) => s.capacityMd === null && s.capacitySource === null && !s.hasCalendar));
  assert.equal(expected.planted.syntheticNoCapacity.datedSprints, 15);
  const undatedNoDefault = legacy.sprints.filter((s) => s.startAt === null);
  assert.deepEqual(undatedNoDefault.map((s) => s.name), ["Legacy Mainframe Sprint 35 (undated)"], "the one REACHABLE null/null case");
  const empty = byName(EMPTY_TEAM);
  assert.deepEqual([empty.members.length, empty.sprints.length, empty.managerName, empty.defaultCapacityMd], [0, 0, null, null]);
  const support = byName(PLANTED.overlapTeam);
  const thirty = support.sprints.find((s) => s.name === "Support Tooling Sprint 30");
  const hotfix = support.sprints.find((s) => s.name === "Support Tooling Sprint 30 (hotfix)");
  assert.ok(hotfix.startAt > thirty.startAt && hotfix.endAt <= thirty.endAt, "the hotfix sprint lies inside sprint 30");
  const undated = byName(PLANTED.undatedTeam).sprints.find((s) => s.name === "Analytics Sprint 34 (undated)");
  const analytics = byName(PLANTED.undatedTeam);
  assert.deepEqual([undated.startAt, undated.endAt, undated.completeAt], [null, null, null]);
  assert.deepEqual([undated.capacitySource, undated.hasCalendar, undated.capacityMd], ["TEAM_DEFAULT", false, analytics.defaultCapacityMd]);
  const dflt = byName(PLANTED.defaultSourceTeam).sprints.at(-1);
  assert.deepEqual([dflt.capacitySource, dflt.hasCalendar, dflt.capacityMd], ["DEFAULT", false, 40]);
  assert.equal(byName(PLANTED.unnamedMemberTeam).members.filter((m) => m.displayName === null).length, 1);
  assert.equal(expected.planted.unnamedMember.count, 1);
});

test("the e2e team: six future two-week sprints in 2047, 20.00 / 18.00 / 22.00 ... MD a week on Monday-Friday", () => {
  const e2e = byName(E2E_TEAM);
  assert.equal(e2e.sprints.length, 6);
  assert.deepEqual(e2e.sprints.map((s) => s.capacityMd), E2E_CAPACITIES);
  assert.deepEqual(expected.e2e.preview.map((r) => r.mdPerWeek), ["20.00", "18.00", "22.00", "20.00", "19.00", "21.00"]);
  assert.ok(expected.e2e.preview.every((r) => r.start.startsWith("2047") && r.end.startsWith("2047") && r.workingDays === 10));
  assert.equal(expected.e2e.preview[0].start, "2047-01-07");
  assert.equal(expected.e2e.preview[0].end, "2047-01-18");
  assert.ok(e2e.sprints.every((s) => s.state === "future" && s.completeAt === null && s.hasCalendar && s.capacitySource === "CALENDAR"));
  assert.equal(expected.e2e.roster.current.length, 4);
  assert.equal(expected.e2e.roster.former.length, 1);
  assert.deepEqual(expected.e2e.roster.current, ["Stub Quebec One", "Stub Quebec Two", "Stub Quebec Three", "Stub Quebec Four"]);
  // The roster is unambiguous against any clock between 2026 and the sprints: everyone current started before 2026-10 and the former one left in 2026-03.
  assert.ok(e2e.members.filter((m) => m.validTo === null).every((m) => m.validFrom < Date.UTC(2026, 9, 1)));
  const axe = byName(AXE_TEAM);
  assert.deepEqual(axe.sprints.map((s) => s.state), ["closed", "active", "future", "future"]);
  assert.ok(axe.sprints.every((s) => new Date(s.startAt).getUTCFullYear() === 2026));
});

test("day 2: Billing vanishes, Platform's calendar-sourced future sprints and the e2e team's sprints 2 and 3 change, nothing else does", () => {
  assert.equal(world.day2.teams.length, 18);
  assert.deepEqual(world.day2.gone, ["Billing"]);
  assert.equal(byName("Billing", world.day2.teams), undefined);
  const changed = new Map(world.day2.changed.map((c) => [c.sprintId, c]));
  assert.ok(changed.size > 0 && world.day2.changed.every((c) => c.from !== c.to));
  for (const team of world.day2.teams) {
    const before = byName(team.name);
    assert.deepEqual(team.members, before.members, team.name);
    team.sprints.forEach((s, k) => {
      const was = before.sprints[k];
      assert.equal(s.sprintId, was.sprintId);
      if (changed.has(s.sprintId)) assert.deepEqual([was.capacityMd, s.capacityMd], [changed.get(s.sprintId).from, changed.get(s.sprintId).to]);
      else assert.deepEqual(s, was, `${team.name} ${s.name}`);
    });
  }
  const e2eChanged = world.day2.changed.filter((c) => c.team === E2E_TEAM);
  assert.deepEqual(e2eChanged.map((c) => [c.name, c.from, c.to]), [["E2E Flow Sprint 2", 36, 30], ["E2E Flow Sprint 3", 44, 48]]);
  assert.ok(world.day2.changed.filter((c) => c.team === "Platform").length === 5);
  assert.deepEqual(bodyOf("teams-day2").items.map((t) => t.name), world.day2.teams.map((t) => t.name));
});

test("the document is about 130 KB and stays under the 1 MiB the client accepts, far below the 2,000-sprint cap", () => {
  assert.ok(expected.document.bytes > 100_000 && expected.document.bytes < 400_000, `${expected.document.bytes} bytes`);
  assert.ok(expected.totals.sprints < 2000);
});

test("the contract builders throw on an undefined field (only null is a legal absent value), so a drifted field cannot pass silently", () => {
  const member = { accountId: "a", displayName: null, validFrom: 1, validTo: null };
  assert.deepEqual(Object.keys(memberItem(member)), FIELDS.member);
  assert.throws(() => memberItem({ accountId: "a", displayName: null, validFrom: 1 }), /validTo/);
  assert.throws(() => sprintItem({ sprintId: 1 }), /connectionId/);
  assert.throws(() => teamItem({ id: 1, name: "x", managerName: null }), /defaultCapacityMd/);
  assert.match(AUTH_SHAPE_PATTERN, /^Bearer flow_int_\[A-Za-z0-9_-\]\{43\}$/);
});
