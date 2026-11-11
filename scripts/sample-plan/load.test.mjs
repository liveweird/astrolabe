// Self-test of the sample-plan loader: `node --test scripts/sample-plan/load.test.mjs` (Node >= 24, no install). No real stack: every test
// talks to an `http.createServer` stub on a loopback port and checks what the loader sent - above all that it refuses BEFORE it sends a
// credential or writes anything when the target is not a development stack, and that it never touches data it did not create.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extendedEnd, isoDateAt, MAX_EXTENSION_DAYS } from "./days.mjs";
import { TimePointGraph } from "./graph.mjs";
import { Refusal, applyPolishHolidays, assertDevelopmentStack, createClient, findExistingLoad, loadDataset, main, parseArgs, resetLoad, spannedYears } from "./load.mjs";

const DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "sample-data", "plan");
const data = loadDataset(DATA_DIR);
const OPENAPI = "openapi: 3.1.0\ninfo:\n  title: Astrolabe\n";
const ENV = { ASTROLABE_ADMIN_PASSWORD: "admin-secret-for-tests" };

/** A stub server: `handler(req, res, body)` answers; `log` records `METHOD path` (and the Authorization header presence). */
async function stub(handler) {
  const log = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString();
      log.push({ line: `${req.method} ${req.url.split("?")[0]}`, body: raw });
      handler(req, res, raw);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { origin: `http://127.0.0.1:${server.address().port}`, log, lines: () => log.map((l) => l.line), close: () => new Promise((resolve) => server.close(resolve)) };
}

/** Runs `fn` with console output muted (the loader narrates its progress). */
async function quiet(fn) {
  const { log, error } = console;
  console.log = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
    console.error = error;
  }
}

const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body === undefined ? "" : JSON.stringify(body));
};

// ---------------------------------------------------------------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------------------------------------------------------------
test("--base-url: only http(s) origins without credentials; plain http only for local hosts", () => {
  for (const ok of ["http://localhost:8086", "http://127.0.0.1:8086", "http://127.8.8.8", "http://[::1]:8086", "http://stack.local", "http://app.orb.local", "https://astrolabe.example.com"]) {
    assert.equal(parseArgs(["--base-url", ok]).origin, new URL(ok).origin, ok);
  }
  for (const bad of ["ftp://localhost", "file:///etc/passwd", "localhost:8086", "not a url", "http://user:pw@localhost:8086", "https://user@example.com"]) {
    assert.throws(() => parseArgs(["--base-url", bad]), Refusal, bad);
  }
  assert.throws(() => parseArgs(["--base-url", "http://astrolabe.example.com"]), /plain http is only allowed/);
  assert.equal(parseArgs(["--base-url", "http://astrolabe.example.com", "--insecure-http"]).origin, "http://astrolabe.example.com");
  assert.equal(parseArgs(["--base-url=http://localhost:9"]).origin, "http://localhost:9");
});

test("an argument error never echoes the value", () => {
  for (const argv of [["--base-url", "http://localhost", "hunter2-secret"], ["--logins=hunter2-secret"], ["--base-url=http://u:hunter2-secret@x"], ["hunter2-secret"]]) {
    assert.throws(
      () => parseArgs(argv),
      (e) => e instanceof Refusal && !e.message.includes("hunter2-secret"),
      JSON.stringify(argv.length),
    );
  }
  assert.throws(() => parseArgs(["--logins", "--bogus"]), /unexpected argument at position 2/);
  assert.throws(() => parseArgs(["--data"]), /--data needs a value/);
  assert.throws(() => parseArgs(["--data", "--reset"]), /--data needs a value/);
  assert.throws(() => parseArgs(["--anchor"]), /needs a value/);
  assert.equal(parseArgs(["--data=/tmp/a=b"]).data, "/tmp/a=b", "a value containing = is not truncated");
  assert.throws(() => parseArgs(["--concurrency", "0"]), Refusal);
  assert.throws(() => parseArgs(["--anchor", "2027-01-05"]), /Monday/);
  assert.deepEqual([parseArgs(["--reset", "--logins"]).reset, parseArgs(["--reset", "--logins"]).logins], [true, true]);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The development-stack check: a login may only follow a valid OpenAPI document, served without a redirect and without HSTS
// ---------------------------------------------------------------------------------------------------------------------------------
const refusals = {
  "an HTML 200 (the SPA of a production stack)": [(_, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end("<!doctype html><html></html>"); }, /does not serve the OpenAPI document/],
  "a 404": [(_, res) => json(res, 404, { title: "Not Found" }), /does not serve the OpenAPI document/],
  "YAML that is not an OpenAPI 3 document": [(_, res) => { res.writeHead(200, { "content-type": "application/yaml" }); res.end("swagger: '2.0'\ninfo: {}\n"); }, /does not serve the OpenAPI document/],
  "a valid document with Strict-Transport-Security": [(_, res) => { res.writeHead(200, { "content-type": "application/yaml", "strict-transport-security": "max-age=31536000" }); res.end(OPENAPI); }, /Strict-Transport-Security/],
};

for (const [name, [handler, message]] of Object.entries(refusals)) {
  test(`refuses ${name} and sends no credential`, async () => {
    const s = await stub(handler);
    try {
      await assert.rejects(quiet(() => main(["--base-url", s.origin], ENV)), (e) => e instanceof Refusal && message.test(e.message));
      assert.deepEqual(s.lines(), ["GET /openapi/documentation.yaml"]);
    } finally {
      await s.close();
    }
  });
}

test("refuses a 301 (even to another host) without following it and sends no credential", async () => {
  const other = await stub((_, res) => { res.writeHead(200, { "content-type": "application/yaml" }); res.end(OPENAPI); });
  const s = await stub((_, res) => { res.writeHead(301, { location: `${other.origin}/openapi/documentation.yaml` }); res.end(); });
  try {
    await assert.rejects(quiet(() => main(["--base-url", s.origin], ENV)), (e) => e instanceof Refusal && /the stack redirects \(production\?\)/.test(e.message));
    assert.deepEqual(s.lines(), ["GET /openapi/documentation.yaml"]);
    assert.deepEqual(other.lines(), [], "the redirect target was never contacted");
  } finally {
    await s.close();
    await other.close();
  }
});

test("a valid OpenAPI document is the only case in which a login is attempted - and the password is read only then", async () => {
  const s = await stub((req, res) => {
    if (req.url === "/openapi/documentation.yaml") { res.writeHead(200, { "content-type": "application/yaml" }); res.end(OPENAPI); } else json(res, 401, { title: "Unauthorized" });
  });
  try {
    await assert.rejects(quiet(() => main(["--base-url", s.origin], ENV)), /sign-in refused \(401\)/);
    assert.deepEqual(s.lines(), ["GET /openapi/documentation.yaml", "POST /api/v1/login"]);
    assert.ok(s.log[1].body.includes("admin-secret-for-tests"));
    s.log.length = 0;
    await assert.rejects(quiet(() => main(["--base-url", s.origin], {})), /set ASTROLABE_ADMIN_PASSWORD/);
    assert.deepEqual(s.lines(), ["GET /openapi/documentation.yaml"], "no password in the environment: the check ran, no login");
  } finally {
    await s.close();
  }
});

test("assertDevelopmentStack accepts a valid document and reports an unreachable stack", async () => {
  const s = await stub((_, res) => { res.writeHead(200, { "content-type": "application/yaml" }); res.end(OPENAPI); });
  await assertDevelopmentStack(s.origin);
  await s.close();
  await assert.rejects(assertDevelopmentStack(s.origin), /cannot reach the stack/);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// A fake Astrolabe API: just enough of login / people / teams / users / the plan view to recognise (and delete) an earlier load
// ---------------------------------------------------------------------------------------------------------------------------------
const SAMPLE_PERSON = 101; // owner / manager id of the sample data in the fake
const REAL_PERSON = 900;
const emailsOf = () => data.people.map((p, i) => ({ id: SAMPLE_PERSON + i, name: p.name, email: p.email }));

/** The fake: `state` = { streams, teams, users } is read on every request, so a test can shape the stack before it runs. */
async function fakeApi(state) {
  const s = await stub((req, res) => {
    const url = new URL(req.url, "http://x");
    const page = (items) => json(res, 200, { items, page: 1, pageSize: 100, total: items.length });
    if (req.url === "/openapi/documentation.yaml") { res.writeHead(200, { "content-type": "application/yaml" }); res.end(OPENAPI); }
    else if (url.pathname === "/api/v1/login") json(res, 200, { token: "t", refreshToken: "r" });
    else if (url.pathname === "/api/v1/logout") json(res, 204);
    else if (req.method === "GET" && url.pathname === "/api/v1/people") page(state.people ?? emailsOf());
    else if (req.method === "GET" && url.pathname === "/api/v1/teams") page(state.teams ?? []);
    else if (req.method === "GET" && url.pathname === "/api/v1/users") page(state.users ?? []);
    else if (req.method === "GET" && url.pathname === "/api/v1/public-holidays") json(res, 200, { items: [] });
    else if (url.pathname === "/api/v1/views/plan") json(res, 200, { revision: 1, workStreams: state.streams ?? [] });
    else if (req.method === "DELETE") json(res, 204);
    else json(res, 500, { title: "unexpected request in the test" });
  });
  return s;
}

const project = (id, ownerPersonId, name = `Project ${id}`) => ({ id, name, ownerPersonId });
const program = (id, ownerPersonId, name, projects = []) => ({ id, name, ownerPersonId, projects });
const stream = (id, ownerPersonId, name, programs = []) => ({ id, name, ownerPersonId, programs });
const writes = (s) => s.lines().filter((l) => !l.startsWith("GET ") && l !== "POST /api/v1/login" && l !== "POST /api/v1/logout");

test("reset matching: a sample name alone is not enough - the owner must be a sample person", async () => {
  const sampleName = data.workStreams[1].name; // e.g. "Platform Foundations"
  const sampleProgram = data.workStreams[1].programs[0].name;
  const state = {
    streams: [
      // A REAL work stream and a real program that share names with the dataset: not matched, reported as collisions.
      stream(1, REAL_PERSON, data.workStreams[0].name, [program(10, REAL_PERSON, data.workStreams[0].programs[0].name, [project(100, REAL_PERSON)])]),
      // The sample stream with sample-owned children.
      stream(2, SAMPLE_PERSON, sampleName, [program(20, SAMPLE_PERSON, sampleProgram, [project(200, SAMPLE_PERSON), project(201, SAMPLE_PERSON)])]),
    ],
    teams: [
      { id: 7, name: data.teams[0].name, managerPersonId: SAMPLE_PERSON },
      { id: 8, name: data.teams[1].name, managerPersonId: REAL_PERSON }, // a real team with a sample name: a collision
      { id: 9, name: "Hand made", managerPersonId: REAL_PERSON },
    ],
    users: [{ id: 50, email: data.people[0].email }, { id: 51, email: "someone@example.com" }],
  };
  const s = await fakeApi(state);
  try {
    const client = createClient(s.origin);
    await client.login("a@b.c", "x");
    const existing = await findExistingLoad(client, data);
    assert.deepEqual(existing.streams.map((w) => w.id), [2], "the real stream with a sample name is NOT matched");
    assert.deepEqual(existing.programs.map((p) => p.id), [20]);
    assert.deepEqual(existing.projects.map((p) => p.id), [200, 201]);
    assert.deepEqual(existing.teams.map((t) => t.id), [7]);
    assert.deepEqual(existing.users.map((u) => u.id), [50]);
    assert.equal(existing.people.length, data.people.length);
    assert.deepEqual(existing.foreign, []);
    assert.equal(existing.collisions.length, 3);
    assert.ok(existing.collisions.some((c) => c.startsWith("work stream") && c.includes("(id 1)")));
    assert.ok(existing.collisions.some((c) => c.startsWith("program") && c.includes("(id 10)")));
    assert.ok(existing.collisions.some((c) => c.startsWith("team") && c.includes("(id 8)")));

    await quiet(() => resetLoad(client, existing, 2));
    assert.deepEqual(writes(s).sort(), [
      "DELETE /api/v1/people/101", ...data.people.slice(1).map((_, i) => `DELETE /api/v1/people/${SAMPLE_PERSON + i + 1}`), "DELETE /api/v1/programs/20", "DELETE /api/v1/projects/200", "DELETE /api/v1/projects/201", "DELETE /api/v1/teams/7", "DELETE /api/v1/users/50", "DELETE /api/v1/work-streams/2",
    ].sort());
    assert.ok(!writes(s).some((l) => /\/(1|10|100|8|9|51)$/.test(l)), "no real object was deleted");
  } finally {
    await s.close();
  }
});

test("a matched sample stream holding something sample people do not own is listed as foreign, and main refuses to reset", async () => {
  const state = {
    streams: [stream(2, SAMPLE_PERSON, data.workStreams[1].name, [
      program(20, SAMPLE_PERSON, data.workStreams[1].programs[0].name, [project(200, SAMPLE_PERSON), project(202, REAL_PERSON, "A real project")]),
      program(21, REAL_PERSON, "A real program", [project(203, REAL_PERSON)]),
    ])],
  };
  const s = await fakeApi(state);
  try {
    const client = createClient(s.origin);
    await client.login("a@b.c", "x");
    const existing = await findExistingLoad(client, data);
    assert.equal(existing.foreign.length, 3);
    assert.ok(existing.foreign.some((f) => f.includes("A real project")) && existing.foreign.some((f) => f.includes("A real program")));
    await assert.rejects(quiet(() => main(["--base-url", s.origin, "--reset"], ENV)), (e) => e instanceof Refusal && /A real project/.test(e.message) && /never deletes/.test(e.message));
    assert.deepEqual(writes(s), [], "nothing was deleted or created");
    assert.equal(s.lines().at(-1), "POST /api/v1/logout", "the session is revoked at the end");
  } finally {
    await s.close();
  }
});

test("an earlier load without --reset stops with the counts (logins included) and writes nothing", async () => {
  const s = await fakeApi({
    streams: [stream(2, SAMPLE_PERSON, data.workStreams[1].name)],
    teams: [{ id: 7, name: data.teams[0].name, managerPersonId: SAMPLE_PERSON }],
    users: [{ id: 50, email: data.people[0].email }],
  });
  try {
    await assert.rejects(quiet(() => main(["--base-url", s.origin], ENV)), (e) => e instanceof Refusal && /1 work streams, 1 teams, 30 people, 1 logins/.test(e.message) && /--reset/.test(e.message));
    assert.deepEqual(writes(s), []);
  } finally {
    await s.close();
  }
});

test("preflight: real teams, programs and work streams that reuse a dataset name stop the load before any write", async () => {
  const cases = {
    "a real work stream": { people: [], streams: [stream(1, REAL_PERSON, data.workStreams[2].name.toUpperCase())] },
    "a real program": { people: [], streams: [stream(1, REAL_PERSON, "Unrelated", [program(10, REAL_PERSON, data.workStreams[0].programs[1].name)])] },
    "a real team": { people: [], teams: [{ id: 8, name: data.teams[3].name, managerPersonId: REAL_PERSON }] },
  };
  for (const [name, state] of Object.entries(cases)) {
    const s = await fakeApi(state);
    try {
      await assert.rejects(quiet(() => main(["--base-url", s.origin], ENV)), (e) => e instanceof Refusal && /not sample data/.test(e.message) && /\(id \d+\)/.test(e.message), name);
      assert.deepEqual(writes(s), [], `${name}: nothing was written`);
    } finally {
      await s.close();
    }
  }
});

test("--reset on an empty stack with no collisions reaches the load (first create is a POST)", async () => {
  const s = await fakeApi({ people: [] });
  try {
    await assert.rejects(quiet(() => main(["--base-url", s.origin, "--reset"], ENV)), /creating person \d+ answered 500/);
    assert.equal(writes(s)[0], "POST /api/v1/people");
  } finally {
    await s.close();
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------------------------------------------------------------
test("token refresh is single-flight: five requests that all see a 401 trigger one refresh", async () => {
  let refreshes = 0;
  const s = await stub((req, res, body) => {
    if (req.url === "/api/v1/login") json(res, 200, { token: "old", refreshToken: "r1" });
    else if (req.url === "/api/v1/refresh") {
      refreshes++;
      assert.equal(JSON.parse(body).refreshToken, "r1", "a rotated refresh token is never replayed");
      setTimeout(() => json(res, 200, { token: "new", refreshToken: "r2" }), 100);
    } else if (req.headers.authorization === "Bearer new") json(res, 200, { ok: true });
    else json(res, 401, { title: "expired" });
  });
  try {
    const client = createClient(s.origin);
    await client.login("a@b.c", "x");
    const answers = await Promise.all(Array.from({ length: 5 }, () => client.must("GET", "/api/v1/thing", undefined, "reading the thing")));
    assert.equal(answers.length, 5);
    assert.equal(refreshes, 1);
  } finally {
    await s.close();
  }
});

test("a network error keeps its context and a 409 on a create suggests --reset", async () => {
  const gone = await stub(() => {});
  const origin = gone.origin;
  await gone.close();
  await assert.rejects(createClient(origin).must("GET", "/api/v1/people", undefined, "listing people"), /^Error: listing people: ECONNREFUSED$/);
  const s = await stub((req, res) => (req.url === "/api/v1/login" ? json(res, 200, { token: "t", refreshToken: "r" }) : json(res, 409, { title: "Conflict", detail: "name taken" })));
  try {
    const client = createClient(s.origin);
    await client.login("a@b.c", "x");
    await assert.rejects(client.must("POST", "/api/v1/teams", {}, "creating team 1", " (retry with --reset)"), /creating team 1 answered 409 \(Conflict: name taken\) \(retry with --reset\)/);
    await assert.rejects(client.must("GET", "/api/v1/teams", undefined, "listing teams", " (retry with --reset)"), /answered 409 \(Conflict: name taken\) \(retry with --reset\)/);
  } finally {
    await s.close();
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------
// --polish-holidays: the preset for every spanned year, after the load, idempotent, never removed by --reset
// ---------------------------------------------------------------------------------------------------------------------------------
const PRESET = "POST /api/v1/public-holidays/apply-preset";

/**
 * A stack that accepts the whole load (every create answers an id, every PUT a revision); `holidayStatus` is the preset's answer, `state` an
 * earlier load for `fakeApi`'s reads, `holidays` the dictionary the stack already holds (ISO dates; the preset adds to it). It replays the
 * server's schedule rule: a PUT whose span holds no Monday-Friday day outside the dictionary is a 400 "must cover at least one working day"
 * (listed in the stub's `refused`), and every accepted span is kept in `scheduled`.
 */
async function loadApi({ holidayStatus = 200, state = {}, intercept, holidays = [] } = {}) {
  let nextId = 1000;
  const held = new Set(holidays);
  const refused = [];
  const scheduled = [];
  const server = await stub((req, res, body) => {
    const url = new URL(req.url, "http://x");
    const page = (items) => json(res, 200, { items, page: 1, pageSize: 100, total: items.length });
    if (url.pathname === "/openapi/documentation.yaml") { res.writeHead(200, { "content-type": "application/yaml" }); res.end(OPENAPI); }
    else if (url.pathname === "/api/v1/login") json(res, 200, { token: "t", refreshToken: "r" });
    else if (url.pathname === "/api/v1/logout") json(res, 204);
    else if (intercept?.(req.method, url.pathname, body, (status, payload) => json(res, status, payload))) return;
    else if (req.method === "GET" && url.pathname === "/api/v1/public-holidays") json(res, 200, { items: [...held].sort().map((date, id) => ({ id, date, name: "holiday" })) });
    else if (req.method === "PUT" && /^\/api\/v1\/milestones\/\d+\/schedule$/.test(url.pathname)) {
      const span = JSON.parse(body);
      if (!hasWorkingDay(span.startDate, span.endDate, held)) {
        refused.push(span);
        return json(res, 400, { title: "Bad Request", detail: "A milestone must cover at least one working day" });
      }
      scheduled.push(span);
      json(res, 200, { revision: 2 });
    }
    else if (url.pathname === "/api/v1/public-holidays/apply-preset") {
      if (holidayStatus !== 200) return json(res, holidayStatus, { title: "Forbidden" });
      const { preset, year } = JSON.parse(body);
      assert.equal(preset, "POLISH");
      const dates = [`${year}-01-01`, `${year}-05-03`];
      const added = dates.filter((d) => !held.has(d));
      for (const d of added) held.add(d);
      json(res, 200, { added: added.map((date) => ({ date })), skipped: dates.filter((d) => !added.includes(d)) });
    }
    else if (req.method === "GET" && url.pathname === "/api/v1/people") page(state.people ?? []);
    else if (req.method === "GET" && url.pathname === "/api/v1/teams") page(state.teams ?? []);
    else if (req.method === "GET" && url.pathname === "/api/v1/users") page(state.users ?? []);
    else if (url.pathname === "/api/v1/views/plan") json(res, 200, { revision: 1, workStreams: state.streams ?? [] });
    else if (url.pathname === "/api/v1/views/roadmap") json(res, 200, { revision: 1, ranked: [] });
    else if (url.pathname.startsWith("/api/v1/views/team/")) json(res, 200, { order: { revision: 1 } });
    else if (req.method === "DELETE") json(res, 204);
    else if (req.method === "PUT") json(res, 200, { revision: 2 });
    else json(res, 201, { id: ++nextId });
  });
  return Object.assign(server, { refused, scheduled });
}

/** The server's rule on ISO dates, written independently of the loader's helper: the span holds a Monday-Friday day that is not a holiday. */
function hasWorkingDay(start, end, held) {
  for (let d = start; d <= end; d = isoDateAt(d, 1)) if (![0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay()) && !held.has(d)) return true;
  return false;
}

/** The Polish statutory days of `year` (what the server's POLISH preset stores), for a stack that already holds them. */
function polishHolidays(year) {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100, d = Math.floor(b / 4), f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, l = (32 + 2 * (b % 4) + 2 * Math.floor(c / 4) - h - (c % 4)) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const easter = `${year}-${String(month).padStart(2, "0")}-${String(((h + l - 7 * m + 114) % 31) + 1).padStart(2, "0")}`;
  return [`${year}-01-01`, `${year}-01-06`, easter, isoDateAt(easter, 1), `${year}-05-01`, `${year}-05-03`, isoDateAt(easter, 49), isoDateAt(easter, 60), `${year}-08-15`, `${year}-11-01`, `${year}-11-11`, `${year}-12-24`, `${year}-12-25`, `${year}-12-26`];
}
const POLISH_2026_2029 = [2026, 2027, 2028, 2029].flatMap(polishHolidays);
const days = (from, to) => Array.from({ length: (Date.parse(to) - Date.parse(from)) / 86_400_000 + 1 }, (_, i) => isoDateAt(from, i));

test("--polish-holidays: parsing, and the spanned years follow the anchor", () => {
  assert.equal(parseArgs([]).polishHolidays, false);
  assert.equal(parseArgs(["--polish-holidays"]).polishHolidays, true);
  assert.deepEqual(spannedYears(data, "2026-10-26"), [2026, 2027, 2028]);
  assert.deepEqual(spannedYears(data, "2027-06-07"), [2027, 2028], "the anchor moves the span; a work stream's start does not widen it");
});

test("--polish-holidays: main applies the preset once per spanned year, before the first plan write (the schedules need the holidays)", async () => {
  const anchor = "2027-06-07";
  const s = await loadApi();
  try {
    await quiet(() => main(["--base-url", s.origin, "--anchor", anchor, "--polish-holidays"], ENV));
    const lines = s.lines();
    const presets = s.log.filter((l) => l.line === PRESET);
    assert.deepEqual(presets.map((l) => JSON.parse(l.body)), spannedYears(data, anchor).map((year) => ({ preset: "POLISH", year })));
    const firstWrite = lines.findIndex((l) => l !== PRESET && !l.startsWith("GET ") && l !== "POST /api/v1/login");
    assert.equal(lines[firstWrite], "POST /api/v1/people", "the first write that is not a preset call is the first plan write");
    assert.equal(lines[firstWrite - 1], "GET /api/v1/public-holidays", "the dictionary is read right before the first plan write");
    assert.ok(lines.lastIndexOf(PRESET) < firstWrite - 1, "every preset call precedes that read, so the read sees the holidays");
    assert.equal(lines.at(-1), "POST /api/v1/logout");
    assert.ok(lines.includes("PUT /api/v1/roadmap/ranking"), "the load really ran");
  } finally {
    await s.close();
  }

  const without = await loadApi();
  try {
    await quiet(() => main(["--base-url", without.origin, "--anchor", anchor], ENV));
    assert.ok(!without.lines().includes(PRESET), "no flag, no holidays");
    assert.ok(without.lines().includes("GET /api/v1/public-holidays"), "no flag, but the dictionary is still read");
  } finally {
    await without.close();
  }
});

test("--polish-holidays: applyPolishHolidays is idempotent (a re-run adds nothing)", async () => {
  const s = await loadApi();
  try {
    const client = createClient(s.origin);
    await client.login("a@b.c", "x");
    assert.deepEqual(await quiet(() => applyPolishHolidays(client, [2027, 2028])), { added: 4, skipped: 0 });
    assert.deepEqual(await quiet(() => applyPolishHolidays(client, [2027, 2028])), { added: 0, skipped: 4 });
  } finally {
    await s.close();
  }
});

test("--polish-holidays: a failing preset call is rejected naming the year, and nothing of the plan has been written", async () => {
  for (const status of [403, 500]) {
    const s = await loadApi({ holidayStatus: status });
    try {
      await assert.rejects(
        quiet(() => main(["--base-url", s.origin, "--anchor", "2027-06-07", "--polish-holidays"], ENV)),
        (e) => new RegExp(`applying the Polish holidays of 2027 answered ${status}`).test(e.message) && /nothing of the sample plan was written/.test(e.message) && !/--reset/.test(e.message),
        String(status),
      );
      assert.equal(s.lines().filter((l) => l === PRESET).length, 1, "stops at the first failing year");
      assert.deepEqual(writes(s), [PRESET], "no plan write was sent");
      assert.equal(s.lines().at(-1), "POST /api/v1/logout", "the session is still revoked");
    } finally {
      await s.close();
    }
  }
});

test("--polish-holidays with --reset: the earlier sample data is deleted, no holiday is ever deleted, the preset follows the reset and precedes the load", async () => {
  const state = { people: emailsOf(), streams: [stream(2, SAMPLE_PERSON, data.workStreams[1].name)], teams: [{ id: 7, name: data.teams[0].name, managerPersonId: SAMPLE_PERSON }] };
  const s = await loadApi({ state });
  try {
    await quiet(() => main(["--base-url", s.origin, "--anchor", "2027-06-07", "--reset", "--polish-holidays"], ENV));
    const lines = s.lines();
    assert.ok(lines.includes("DELETE /api/v1/work-streams/2") && lines.includes("DELETE /api/v1/teams/7"), "the earlier load was reset");
    assert.ok(!lines.some((l) => l.includes("public-holidays") && l !== PRESET && l !== "GET /api/v1/public-holidays"), "nothing but the preset touches the dictionary");
    assert.ok(lines.findLastIndex((l) => l.startsWith("DELETE ")) < lines.indexOf(PRESET), "the preset follows the reset");
    assert.ok(lines.lastIndexOf(PRESET) < lines.indexOf("POST /api/v1/people"), "the preset precedes the load");
    assert.equal(lines.filter((l) => l === PRESET).length, spannedYears(data, "2027-06-07").length);
  } finally {
    await s.close();
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Spans that fall on holidays: the server answers 400 for a span without a working day, so the loader extends the end first
// ---------------------------------------------------------------------------------------------------------------------------------
test("extendedEnd: a span with a working day is unchanged, a span wholly off ends on the next working day", () => {
  const holidays = new Set(["2026-12-24", "2026-12-25", "2026-12-26"]);
  assert.equal(extendedEnd("2026-12-24", "2026-12-25", holidays), "2026-12-28", "24-25 Dec 2026 (Thu-Fri, both holidays) ends on Monday 28 Dec");
  assert.equal(extendedEnd("2026-12-25", "2026-12-25", holidays), "2026-12-28", "a one-day span on a holiday");
  assert.equal(extendedEnd("2026-12-23", "2026-12-25", holidays), "2026-12-25", "Wednesday is a working day: unchanged");
  assert.equal(extendedEnd("2026-12-25", "2026-12-28", holidays), "2026-12-28", "the span reaches Monday: unchanged");
  assert.equal(extendedEnd("2026-12-24", "2026-12-25", new Set()), "2026-12-25", "no holidays: unchanged");
  assert.equal(extendedEnd("2026-12-26", "2026-12-27", new Set()), "2026-12-28", "a weekend alone is off with an empty dictionary too");
  assert.equal(extendedEnd("2026-12-24", "2026-12-25", new Set([...holidays, "2026-12-28"])), "2026-12-29", "a holiday on the following Monday is skipped as well");
  assert.equal(extendedEnd("2026-12-14", "2027-02-26", new Set(days("2026-12-14", "2026-12-18"))), "2027-02-26", "a long span with a working day anywhere is unchanged");
});

test("extendedEnd: looks at most 14 days past the end, then fails naming the span", () => {
  const upTo = (last) => new Set(days("2026-12-28", last));
  assert.equal(MAX_EXTENSION_DAYS, 14);
  assert.equal(extendedEnd("2026-12-24", "2026-12-25", new Set(["2026-12-24", "2026-12-25", ...upTo("2027-01-07")])), "2027-01-08", "exactly 14 days after the end is allowed");
  assert.throws(() => extendedEnd("2026-12-24", "2026-12-25", new Set(["2026-12-24", "2026-12-25", ...upTo("2027-01-08")])), /2026-12-24 to 2026-12-25 holds no working day/);
});

test("a reload over holidays the stack already holds: no 400, the span ends on its next working day (with the flag or without it)", async () => {
  const anchor = "2026-11-02";
  const planned = data.milestones.filter((m) => m.startOffset !== null).map((m) => ({ ref: m.ref, startDate: isoDateAt(anchor, m.startOffset), endDate: isoDateAt(anchor, m.endOffset) }));
  const held = new Set(POLISH_2026_2029);
  const wholly = planned.filter((p) => !hasWorkingDay(p.startDate, p.endDate, held));
  assert.equal(wholly.length, 6, "six spans of the dataset fall wholly on Polish holidays from this anchor (the server would answer 400 for each)");
  assert.ok(wholly.some((p) => p.startDate === "2026-12-24" && p.endDate === "2026-12-24") && wholly.some((p) => p.startDate === "2026-12-25"), "24 and 25 Dec among them");

  for (const flags of [[], ["--polish-holidays"]]) {
    const s = await loadApi({ holidays: POLISH_2026_2029 });
    try {
      await quiet(() => main(["--base-url", s.origin, "--anchor", anchor, "--concurrency", "4", ...flags], ENV));
      assert.deepEqual(s.refused, [], `${flags.join(" ") || "no flag"}: the stub (the server's rule) refused nothing`);
      assert.equal(s.scheduled.length, planned.length, "every milestone was scheduled");
      const nextWorkingDay = (iso) => { let d = isoDateAt(iso, 1); while (!hasWorkingDay(d, d, held)) d = isoDateAt(d, 1); return d; };
      const key = (b) => `${b.startDate} ${b.endDate}`;
      const expected = planned.map((p) => key(wholly.includes(p) ? { startDate: p.startDate, endDate: nextWorkingDay(p.endDate) } : p));
      assert.deepEqual(s.scheduled.map(key).sort(), expected.sort(), "every span as planned, except the six that moved to their next working day");
      assert.ok(s.scheduled.some((b) => key(b) === "2026-12-24 2026-12-28") && s.scheduled.some((b) => key(b) === "2026-12-25 2026-12-28"), "the 24 Dec and 25 Dec spans end on Monday 28 Dec");
      assert.ok(s.lines().includes("GET /api/v1/public-holidays"), "the dictionary was read");
      assert.equal(s.lines().includes(PRESET), flags.length > 0);
      assert.ok(s.lines().indexOf("GET /api/v1/public-holidays") < s.lines().indexOf("POST /api/v1/people"), "the dictionary is read before the first plan write");
    } finally {
      await s.close();
    }
  }
});

test("without any holiday the load sends every span as planned", async () => {
  const s = await loadApi();
  try {
    await quiet(() => main(["--base-url", s.origin, "--anchor", "2026-11-02"], ENV));
    const planned = data.milestones.filter((m) => m.startOffset !== null).map((m) => ({ startDate: isoDateAt("2026-11-02", m.startOffset), endDate: isoDateAt("2026-11-02", m.endOffset) }));
    assert.deepEqual(s.scheduled.map((b) => `${b.startDate} ${b.endDate}`).sort(), planned.map((p) => `${p.startDate} ${p.endDate}`).sort());
    assert.deepEqual(s.refused, []);
  } finally {
    await s.close();
  }
});

test("a span that cannot be placed stops the load naming the milestone, before any plan write", async () => {
  const s = await loadApi({ holidays: days("2026-01-01", "2029-12-31") });
  try {
    await assert.rejects(quiet(() => main(["--base-url", s.origin, "--anchor", "2026-11-02"], ENV)), /milestone \d+ cannot be scheduled: the span \d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2} holds no working day/);
    assert.deepEqual(writes(s), [], "nothing was written");
  } finally {
    await s.close();
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The dependencies phase: milestone AND project ends, replayed against the server's own rules
// ---------------------------------------------------------------------------------------------------------------------------------
test("the load posts every link with its kinds and the successor's project, and a stub that replays the server's cycle rule never answers 400 or 409", async () => {
  const projects = data.workStreams.flatMap((w) => w.programs.flatMap((p) => p.projects));
  const projectByName = new Map(projects.map((p) => [p.name, p.ref]));
  const projectRefOfId = new Map(); // server id -> dataset project ref
  const milestoneRefOfId = new Map(); // server id -> dataset milestone ref
  const milestoneByKey = new Map(data.milestones.map((m) => [`${m.projectRef}/${m.name}`, m.ref]));
  const projectOfMilestone = new Map(data.milestones.map((m) => [m.ref, m.projectRef]));
  const graph = new TimePointGraph(data.milestones); // the server's graph, filled link by link in the order the requests arrive
  const posted = [];
  let nextId = 50_000;
  const intercept = (method, pathname, body, answer) => {
    if (method !== "POST") return false;
    const projectCreate = /^\/api\/v1\/programs\/\d+\/projects$/.exec(pathname);
    const milestoneCreate = /^\/api\/v1\/projects\/(\d+)\/milestones$/.exec(pathname);
    const linkCreate = /^\/api\/v1\/projects\/(\d+)\/dependencies$/.exec(pathname);
    if (projectCreate) {
      const id = ++nextId;
      projectRefOfId.set(id, projectByName.get(JSON.parse(body).name));
      answer(201, { id });
    } else if (milestoneCreate) {
      const id = ++nextId;
      milestoneRefOfId.set(id, milestoneByKey.get(`${projectRefOfId.get(Number(milestoneCreate[1]))}/${JSON.parse(body).name}`));
      answer(201, { id });
    } else if (linkCreate) {
      const request = JSON.parse(body);
      const end = (e) => ({ kind: e.kind, ref: (e.kind === "PROJECT" ? projectRefOfId : milestoneRefOfId).get(e.id) });
      const pred = end(request.predecessor);
      const succ = end(request.successor);
      const pathProject = projectRefOfId.get(Number(linkCreate[1]));
      const model = { predecessorKind: pred.kind, predecessorRef: pred.ref, successorKind: succ.kind, successorRef: succ.ref, type: request.type, lagDays: request.lagDays };
      // 400: both ends must exist and the successor must be the path project or one of its milestones; 409: the cycle and the one-link-per-pair rules.
      const successorProject = succ.kind === "PROJECT" ? succ.ref : projectOfMilestone.get(succ.ref);
      let status = 201;
      if (pred.ref === undefined || succ.ref === undefined || successorProject !== pathProject) status = 400;
      else if (!graph.tryAdd(model)) status = 409;
      posted.push({ ...model, status });
      answer(status, status === 201 ? { id: ++nextId } : { title: "refused" });
    } else return false;
    return true;
  };
  const s = await loadApi({ intercept });
  try {
    await quiet(() => main(["--base-url", s.origin, "--anchor", "2027-06-07", "--concurrency", "4"], ENV));
    assert.equal(posted.length, data.dependencies.length);
    assert.deepEqual(posted.filter((p) => p.status !== 201), [], "no link is refused (400 or 409)");
    const key = (d) => [d.predecessorKind, d.predecessorRef, d.successorKind, d.successorRef, d.type, d.lagDays].join(" ");
    assert.deepEqual(posted.map(key).sort(), data.dependencies.map(key).sort(), "every dataset link is posted exactly once, with its kinds, refs, type and lag");
    assert.ok(posted.some((p) => p.predecessorKind === "PROJECT" && p.successorKind === "PROJECT"), "project -> project");
    assert.ok(posted.some((p) => p.predecessorKind === "MILESTONE" && p.successorKind === "PROJECT"), "milestone -> project");
    assert.ok(posted.some((p) => p.predecessorKind === "PROJECT" && p.successorKind === "MILESTONE"), "project -> milestone");
  } finally {
    await s.close();
  }
});
