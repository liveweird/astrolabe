#!/usr/bin/env node
// Loads the sample plan (sample-data/plan, written by generate.mjs) into a RUNNING DEVELOPMENT stack through its public API, as the
// seed administrator. Zero dependencies (Node built-ins only, Node >= 24). NEVER for production: the stack must serve the OpenAPI
// document (GET /openapi/documentation.yaml), which only a development stack does (`plugins/Http.kt exposesOpenApi`); anything else is
// refused BEFORE a credential is sent.
//
// Usage:
//   ASTROLABE_ADMIN_PASSWORD=... node scripts/sample-plan/load.mjs [--base-url http://localhost:8086] [--anchor 2027-01-04]
//        [--logins] [--reset] [--polish-holidays] [--concurrency 6] [--data sample-data/plan] [--insecure-http]
//
//   --base-url       the stack's origin (default http://localhost:8086); plain http only for localhost, loopback and *.local hosts
//   --insecure-http  allow plain http to any other host (the admin password then crosses the network in clear text)
//   --anchor         the Monday that day offset 0 of the dataset lands on (default: the Monday of the current week, so the plan surrounds today)
//   --logins         also create one login per person (<first>.<last>@sample.astrolabe.local) and link it; the password is read from
//                    ASTROLABE_SAMPLE_LOGIN_PASSWORD (10-71 bytes), so a manager or owner can be signed in as
//   --reset          delete an earlier load first, then load again. An earlier load is what the loader created and can recognise: a work
//                    stream with a sample NAME and a sample OWNER (a person whose email is one of the dataset's), the programs and projects
//                    under it that sample people own, the sample teams (name AND a sample manager), the sample people and their logins.
//                    Anything else under a sample work stream is never deleted: the loader refuses and lists it. Without --reset an existing
//                    load makes the loader stop before writing anything
//   --polish-holidays  after the load, apply the Polish public-holiday preset (POST /public-holidays/apply-preset) for every calendar year the
//                    dataset's dates span (anchor-relative: 2026-2028 for an anchor in late 2026). Idempotent (a date that already holds a
//                    holiday is skipped, so a re-run adds nothing). The holiday dictionary is GLOBAL, not sample-owned: --reset NEVER removes holidays
//   --concurrency    requests in flight at once, 1..16 (default 6); plan writes serialise on the server's plan lock anyway
//
// Before any write the loader also refuses when a REAL (non-sample) team, program or work stream already uses a name of the dataset (those
// names are globally unique), and it ADDS the sample projects to the existing global project ranking instead of replacing it.
//
// Environment: ASTROLABE_ADMIN_PASSWORD (required; read only after the stack passed the development-stack check),
// ASTROLABE_ADMIN_EMAIL (default admin@astrolabe.local), ASTROLABE_SAMPLE_LOGIN_PASSWORD (with --logins). The admin password is never read
// from a file nor printed.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isMonday, isoDateAt, mondayOfWeek } from "./days.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SAMPLE_DOMAIN = "@sample.astrolabe.local";
const RANKING_CAP = 1000; // PUT /roadmap/ranking accepts at most this many project ids
const RESET_HINT = " (a name or email already in use? if an earlier sample load is only partly present, retry with --reset)";

/** A usage error or a safety refusal: reported without a stack, exit code 2. */
export class Refusal extends Error {}

const VALUE_FLAGS = new Set(["--base-url", "--anchor", "--concurrency", "--data"]);
const BOOLEAN_FLAGS = new Set(["--logins", "--reset", "--insecure-http", "--polish-holidays"]);
const BOOLEAN_KEYS = { "--logins": "logins", "--reset": "reset", "--insecure-http": "insecureHttp", "--polish-holidays": "polishHolidays" };

/** Plain http is for the machine itself or a local development name; anything else needs https (or --insecure-http). */
const isLocalHost = (host) => host === "localhost" || host === "[::1]" || /^127(\.\d{1,3}){3}$/.test(host) || host.endsWith(".local") || host.endsWith(".localhost");

export function parseArgs(argv) {
  const args = { baseUrl: "http://localhost:8086", anchor: mondayOfWeek(), logins: false, reset: false, insecureHttp: false, polishHolidays: false, concurrency: 6, data: path.join(ROOT, "sample-data", "plan") };
  for (let i = 0; i < argv.length; i++) {
    // A value is never echoed back (it may be a URL with credentials): errors name the flag or the position only.
    const eq = argv[i].indexOf("=");
    const flag = eq < 0 ? argv[i] : argv[i].slice(0, eq);
    const inline = eq < 0 ? undefined : argv[i].slice(eq + 1);
    if (BOOLEAN_FLAGS.has(flag) && inline === undefined) {
      args[BOOLEAN_KEYS[flag]] = true;
    } else if (VALUE_FLAGS.has(flag)) {
      const value = inline ?? argv[++i];
      if (value === undefined || value === "" || value.startsWith("--")) throw new Refusal(`${flag} needs a value`);
      if (flag === "--base-url") args.baseUrl = value;
      else if (flag === "--anchor") args.anchor = value;
      else if (flag === "--concurrency") args.concurrency = Number(value);
      else args.data = path.resolve(value);
    } else {
      throw new Refusal(`unexpected argument at position ${i + 1}`);
    }
  }
  if (!Number.isInteger(args.concurrency) || args.concurrency < 1 || args.concurrency > 16) throw new Refusal("--concurrency must be an integer from 1 to 16");
  try {
    if (!isMonday(args.anchor)) throw new Error("not a Monday");
  } catch {
    throw new Refusal("--anchor must be an ISO date (YYYY-MM-DD) that is a Monday");
  }
  let url;
  try {
    url = new URL(args.baseUrl);
  } catch {
    throw new Refusal("--base-url must be an absolute http(s) URL");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Refusal("--base-url must be a plain http(s) origin without credentials");
  if (url.protocol === "http:" && !isLocalHost(url.hostname) && !args.insecureHttp) {
    throw new Refusal("plain http is only allowed for localhost, loopback addresses and *.local hosts; use https, or --insecure-http if you accept sending the password in clear text");
  }
  args.origin = url.origin;
  return args;
}

const readJson = (dir, file) => JSON.parse(readFileSync(path.join(dir, file), "utf8"));
export function loadDataset(dir) {
  try {
    return {
      people: readJson(dir, "people.json"),
      teams: readJson(dir, "teams.json"),
      workStreams: readJson(dir, "plan.json").workStreams,
      milestones: readJson(dir, "milestones.json"),
      dependencies: readJson(dir, "dependencies.json"),
      capacity: readJson(dir, "capacity.json"),
      ranking: readJson(dir, "ranking.json"),
      teamOrders: readJson(dir, "team-orders.json"),
    };
  } catch (e) {
    throw new Refusal(`cannot read the sample plan files (${e?.code ?? "invalid JSON"}); generate them with node scripts/sample-plan/generate.mjs or point --data at them`);
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// HTTP: one client holding the bearer pair; a 401 refreshes once (shared by every request in flight). Messages never carry a URL, a
// token or a password.
// ---------------------------------------------------------------------------------------------------------------------------------
export function createClient(origin) {
  let session = null;
  let requests = 0;
  let refreshing = null;
  const send = async (method, p, body, authed) => {
    requests++;
    const res = await fetch(`${origin}${p}`, {
      method,
      headers: { "content-type": "application/json", ...(authed && session ? { authorization: `Bearer ${session.token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* an empty body (204) or a non-JSON answer */
    }
    return { status: res.status, json, text };
  };
  const refresh = async () => {
    if (!session?.refreshToken) return;
    const refreshed = await send("POST", "/api/v1/refresh", { refreshToken: session.refreshToken }, false);
    if (refreshed.status === 200 && refreshed.json?.token) session = refreshed.json;
  };
  const client = {
    get requests() {
      return requests;
    },
    async login(email, password) {
      const res = await send("POST", "/api/v1/login", { email, password }, false);
      if (res.status === 200 && res.json?.token) {
        session = res.json;
        return;
      }
      if (res.status === 200) throw new Refusal("this account has email MFA enabled; the loader cannot complete a second factor (use the seed administrator)");
      throw new Refusal(`sign-in refused (${res.status}); check ASTROLABE_ADMIN_EMAIL / ASTROLABE_ADMIN_PASSWORD`);
    },
    /** Revokes the bearer pair (best effort: the load is over either way). */
    async logout() {
      if (!session) return;
      try {
        await send("POST", "/api/v1/logout", { refreshToken: session.refreshToken }, true);
      } catch {
        /* nothing to do about it */
      }
      session = null;
    },
    async call(method, p, body) {
      const used = session?.token;
      let res = await send(method, p, body, true);
      if (res.status === 401 && session) {
        // Single flight: the first request that sees the 401 refreshes, the others wait for that promise (a rotated refresh token
        // would fail a second refresh); a request that arrives after the swap just retries with the new token.
        if (session.token === used) {
          refreshing ??= refresh().finally(() => {
            refreshing = null;
          });
          await refreshing;
        }
        if (session.token !== used) res = await send(method, p, body, true);
      }
      return res;
    },
    /** A call that must succeed (2xx): returns the parsed body, or throws naming `what` and the problem's title/detail (+ `hintOn409`). */
    async must(method, p, body, what, hintOn409 = "") {
      let res;
      try {
        res = await client.call(method, p, body);
      } catch (e) {
        throw new Error(`${what}: ${e?.cause?.code ?? e?.message ?? "network error"}`);
      }
      if (res.status >= 300) {
        const problem = [res.json?.title, res.json?.detail].filter(Boolean).join(": ").slice(0, 240);
        throw new Error(`${what} answered ${res.status}${problem ? ` (${problem})` : ""}${res.status === 409 ? hintOn409 : ""}`);
      }
      return res.json;
    },
    async *pages(p, what) {
      for (let page = 1, seen = 0; ; page++) {
        const body = await client.must("GET", `${p}${p.includes("?") ? "&" : "?"}page=${page}&pageSize=100`, undefined, what);
        yield* body.items;
        seen += body.items.length;
        if (body.items.length === 0 || seen >= body.total) return;
      }
    },
  };
  return client;
}

/**
 * The tripwire: a stack that does not serve the OpenAPI document is not a development stack. Production mode answers redirects (HTTPS),
 * HSTS and the SPA's HTML at this path, so a bare 200 proves nothing: no redirect, no Strict-Transport-Security and a real `openapi: 3`.
 */
export async function assertDevelopmentStack(origin) {
  let res;
  try {
    res = await fetch(`${origin}/openapi/documentation.yaml`, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
  } catch (e) {
    throw new Refusal(`cannot reach the stack (${e?.cause?.code ?? e?.cause?.errors?.[0]?.code ?? e?.cause?.message ?? e?.name ?? "network error"}); is it running?`);
  }
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel();
    throw new Refusal("refused: the stack redirects (production?); the sample plan is never loaded into production");
  }
  if (res.headers.has("strict-transport-security")) {
    await res.body?.cancel();
    throw new Refusal("refused: the stack sends Strict-Transport-Security, which only production mode does; the sample plan is never loaded into production");
  }
  const text = res.ok ? await res.text() : "";
  if (!res.ok) await res.body?.cancel();
  if (!res.ok || /html/i.test(res.headers.get("content-type") ?? "") || !/^openapi:\s*3/m.test(text.slice(0, 2000))) {
    throw new Refusal("this stack does not serve the OpenAPI document: not a development stack; refusing (the sample plan is never loaded into production)");
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Bounded concurrency and progress
// ---------------------------------------------------------------------------------------------------------------------------------
const counts = {};
const phaseTimes = [];
const resetProgress = () => {
  for (const k of Object.keys(counts)) delete counts[k];
  phaseTimes.length = 0;
};

/** Runs `fn` over `items` with at most `limit` in flight, stops handing out work after the first failure, and prints progress. */
async function phase(label, items, limit, fn) {
  const started = Date.now();
  let next = 0;
  let done = 0;
  let failure = null;
  let shown = 0;
  const tty = process.stdout.isTTY;
  const show = (final) => {
    if (tty) process.stdout.write(`\r${label.padEnd(26)} ${String(done).padStart(5)}/${items.length}${final ? "\n" : ""}`);
    else if (final) console.log(`${label.padEnd(26)} ${done}/${items.length}`);
    else if (done < items.length && Math.floor((done * 4) / items.length) > shown) {
      shown = Math.floor((done * 4) / items.length);
      console.log(`${label.padEnd(26)} ${done}/${items.length}`);
    }
  };
  const worker = async () => {
    while (failure === null && next < items.length) {
      const item = items[next++];
      try {
        await fn(item);
        done++;
        show(false);
      } catch (e) {
        failure ??= e;
      }
    }
  };
  if (items.length > 0) await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failure) {
    if (tty) process.stdout.write("\n");
    throw failure;
  }
  show(true);
  counts[label] = items.length;
  phaseTimes.push([label, Date.now() - started]);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Recognising an earlier load: by the dataset's own names AND its sample identities (a person whose email is one of the dataset's), never
// by a name alone. Real data that shares a name is not matched - it is reported as a collision, and the loader refuses.
// ---------------------------------------------------------------------------------------------------------------------------------
const lower = (s) => String(s ?? "").toLowerCase();

/**
 * What an earlier load looks like on the stack: {streams, programs, projects, people, teams, users} (the things to delete), `foreign` (items
 * inside a matched sample work stream that sample people do not own: never deleted) and `collisions` (REAL teams, programs and work
 * streams whose names the dataset would reuse; those names are unique across the whole plan).
 */
export async function findExistingLoad(client, data) {
  const sampleEmails = new Set(data.people.map((p) => lower(p.email)));
  const people = [];
  for await (const p of client.pages("/api/v1/people?email=sample.astrolabe.local", "listing people")) if (sampleEmails.has(lower(p.email))) people.push(p);
  const personIds = new Set(people.map((p) => p.id));
  const isSample = (ownerPersonId) => personIds.has(ownerPersonId);

  const plan = await client.must("GET", "/api/v1/views/plan", undefined, "reading the plan");
  const streamNames = new Set(data.workStreams.map((w) => lower(w.name)));
  const programNames = new Set(data.workStreams.flatMap((w) => w.programs.map((p) => lower(p.name))));
  const streams = plan.workStreams.filter((w) => streamNames.has(lower(w.name)) && isSample(w.ownerPersonId));
  const programs = [];
  const projects = [];
  const foreign = [];
  for (const stream of streams) {
    for (const program of stream.programs) {
      if (isSample(program.ownerPersonId)) programs.push(program);
      else foreign.push(`program "${program.name}" (id ${program.id}) in work stream "${stream.name}"`);
      for (const project of program.projects) {
        if (isSample(project.ownerPersonId)) projects.push(project);
        else foreign.push(`project "${project.name}" (id ${project.id}) in program "${program.name}"`);
      }
    }
  }

  const teamNames = new Set(data.teams.map((t) => lower(t.name)));
  const teams = [];
  const otherTeams = [];
  for await (const t of client.pages("/api/v1/teams", "listing teams")) (teamNames.has(lower(t.name)) && isSample(t.managerPersonId) ? teams : otherTeams).push(t);

  const users = [];
  for await (const u of client.pages("/api/v1/users?email=sample.astrolabe.local", "listing users")) if (lower(u.email).endsWith(SAMPLE_DOMAIN) && sampleEmails.has(lower(u.email))) users.push(u);

  const matchedPrograms = new Set(programs.map((p) => p.id));
  const collisions = [
    ...plan.workStreams.filter((w) => streamNames.has(lower(w.name)) && !streams.includes(w)).map((w) => `work stream "${w.name}" (id ${w.id})`),
    ...plan.workStreams.flatMap((w) => w.programs).filter((p) => programNames.has(lower(p.name)) && !matchedPrograms.has(p.id)).map((p) => `program "${p.name}" (id ${p.id})`),
    ...otherTeams.filter((t) => teamNames.has(lower(t.name))).map((t) => `team "${t.name}" (id ${t.id})`),
  ];
  return { streams, programs, projects, people, teams, users, foreign, collisions };
}

const listed = (items) => items.slice(0, 10).map((s) => `\n  - ${s}`).join("") + (items.length > 10 ? `\n  - ... and ${items.length - 10} more` : "");

export async function resetLoad(client, existing, limit) {
  const del = (kind, path) => (item) => client.must("DELETE", `${path}/${item.id}`, undefined, `deleting ${kind} ${item.id}`);
  await phase("delete projects", existing.projects, limit, del("project", "/api/v1/projects"));
  await phase("delete programs", existing.programs, limit, del("program", "/api/v1/programs"));
  await phase("delete work streams", existing.streams, limit, del("work stream", "/api/v1/work-streams"));
  await phase("delete teams", existing.teams, limit, del("team", "/api/v1/teams"));
  await phase("delete people", existing.people, limit, del("person", "/api/v1/people"));
  await phase("delete logins", existing.users, limit, del("login", "/api/v1/users"));
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The load
// ---------------------------------------------------------------------------------------------------------------------------------
async function loadPlan(client, data, args, loginPassword) {
  const post = (p, body, what) => client.must("POST", p, body, what, RESET_HINT);
  const at = (offset) => (offset === null || offset === undefined ? null : isoDateAt(args.anchor, offset));
  const limit = args.concurrency;
  const ids = { person: new Map(), team: new Map(), project: new Map(), milestone: new Map() };

  await phase(args.logins ? "people + logins" : "people", data.people, limit, async (p) => {
    const userId = args.logins ? (await post("/api/v1/users", { name: p.name, email: p.email, password: loginPassword }, `creating login ${p.ref}`)).id : null;
    const created = await post("/api/v1/people", { name: p.name, email: p.email, userId }, `creating person ${p.ref}`);
    ids.person.set(p.ref, created.id);
  });
  await phase("teams", data.teams, limit, async (t) => {
    const created = await post("/api/v1/teams", { name: t.name, description: t.description, managerPersonId: ids.person.get(t.managerRef) }, `creating team ${t.ref}`);
    ids.team.set(t.ref, created.id);
  });

  const streamIds = new Map();
  await phase("work streams", data.workStreams, limit, async (w) => {
    const created = await post("/api/v1/work-streams", { name: w.name, description: w.description, ownerPersonId: ids.person.get(w.ownerRef), startDate: at(w.startOffset) }, `creating work stream ${w.ref}`);
    streamIds.set(w.ref, created.id);
  });
  const programs = data.workStreams.flatMap((w) => w.programs.map((p) => ({ ...p, streamRef: w.ref })));
  const programIds = new Map();
  await phase("programs", programs, limit, async (p) => {
    const created = await post(`/api/v1/work-streams/${streamIds.get(p.streamRef)}/programs`, { name: p.name, description: p.description, ownerPersonId: ids.person.get(p.ownerRef) }, `creating program ${p.ref}`);
    programIds.set(p.ref, created.id);
  });
  const projects = programs.flatMap((p) => p.projects.map((pr) => ({ ...pr, programRef: p.ref })));
  await phase("projects", projects, limit, async (p) => {
    const body = { name: p.name, description: p.description, ownerPersonId: ids.person.get(p.ownerRef), targetStart: at(p.targetStartOffset), targetEnd: at(p.targetEndOffset) };
    ids.project.set(p.ref, (await post(`/api/v1/programs/${programIds.get(p.programRef)}/projects`, body, `creating project ${p.ref}`)).id);
  });

  await phase("milestones", data.milestones, limit, async (m) => {
    const body = { name: m.name, description: m.description, teamId: ids.team.get(m.teamRef), estimateMd: m.estimateMd };
    ids.milestone.set(m.ref, (await post(`/api/v1/projects/${ids.project.get(m.projectRef)}/milestones`, body, `creating milestone ${m.ref}`)).id);
  });

  // The schedule PUT is staled only by a LATER write of the same milestone's dates, so the plan revision read now (after every create)
  // is a valid expectedRevision for all of them; each answer can only raise it.
  let revision = (await client.must("GET", "/api/v1/views/plan", undefined, "reading the plan revision")).revision;
  await phase("schedules", data.milestones.filter((m) => m.startOffset !== null), limit, async (m) => {
    const body = { expectedRevision: revision, startDate: at(m.startOffset), endDate: at(m.endOffset) };
    const answer = await client.must("PUT", `/api/v1/milestones/${ids.milestone.get(m.ref)}/schedule`, body, `scheduling milestone ${m.ref}`);
    revision = Math.max(revision, answer.revision);
  });

  // An end is a milestone or a project (`kind` + the dataset ref); the SUCCESSOR's project authorizes the write (the path), whatever the predecessor is.
  const endpoint = (kind, ref) => ({ kind, id: (kind === "PROJECT" ? ids.project : ids.milestone).get(ref) });
  await phase("dependencies", data.dependencies, limit, (d) => {
    const body = { predecessor: endpoint(d.predecessorKind, d.predecessorRef), successor: endpoint(d.successorKind, d.successorRef), type: d.type, lagDays: d.lagDays };
    return post(`/api/v1/projects/${ids.project.get(d.successorProjectRef)}/dependencies`, body, `linking dependency ${d.ref}`);
  });
  await phase("capacity periods", data.capacity, limit, (c) =>
    post(`/api/v1/teams/${ids.team.get(c.teamRef)}/capacity`, { effectiveFrom: at(c.effectiveFromOffset), mdPerWeek: c.mdPerWeek, wipLimit: c.wipLimit }, `adding a capacity period of team ${c.teamRef}`),
  );

  // PUT /roadmap/ranking REPLACES the whole global rank, so the existing order (minus the sample projects) goes first and the sample
  // ranking follows it: the stack's own ranked projects keep their positions.
  let keptRanks = 0;
  await phase("project ranking", [data.ranking], 1, async (r) => {
    const view = await client.must("GET", "/api/v1/views/roadmap", undefined, "reading the roadmap");
    const sample = new Set(ids.project.values());
    const kept = view.ranked.map((entry) => entry.project.id).filter((id) => !sample.has(id));
    const mine = r.projectRefs.map((ref) => ids.project.get(ref));
    if (kept.length + mine.length > RANKING_CAP) throw new Error(`the existing ranking holds ${kept.length} projects; with the ${mine.length} sample projects it would pass the ${RANKING_CAP}-project cap of the ranking PUT`);
    keptRanks = kept.length;
    await client.must("PUT", "/api/v1/roadmap/ranking", { expectedRevision: view.revision, projectIds: [...kept, ...mine] }, "ranking the projects");
  });
  counts["project ranking"] = data.ranking.projectRefs.length;
  if (keptRanks > 0) console.log(`  (the ${keptRanks} projects already ranked on the stack keep their positions above the sample projects)`);
  await phase("team orders", data.teamOrders, limit, async (o) => {
    const teamId = ids.team.get(o.teamRef);
    const view = await client.must("GET", `/api/v1/views/team/${teamId}`, undefined, `reading team ${o.teamRef}`);
    await client.must("PUT", `/api/v1/teams/${teamId}/milestone-order`, { expectedRevision: view.order.revision, milestoneIds: o.milestoneRefs.map((ref) => ids.milestone.get(ref)) }, `ordering team ${o.teamRef}`);
  });
  return ids;
}
// ---------------------------------------------------------------------------------------------------------------------------------
// The Polish public holidays (--polish-holidays). The dictionary is global and not sample-owned: the loader only ever ADDS to it (the preset
// is idempotent) and --reset never deletes a holiday.
// ---------------------------------------------------------------------------------------------------------------------------------
/**
 * Every calendar year the dataset's PLANNING dates span once offset 0 is `anchor`: the projects' target windows, the milestones' spans and the
 * capacity periods' starts. A work stream's start is a label, not a planning date (no calendar rule reads it), so it does not widen the span.
 */
export function spannedYears(data, anchor) {
  const offsets = [
    ...data.workStreams.flatMap((w) => w.programs.flatMap((p) => p.projects.flatMap((pr) => [pr.targetStartOffset, pr.targetEndOffset]))),
    ...data.milestones.flatMap((m) => [m.startOffset, m.endOffset]),
    ...data.capacity.map((c) => c.effectiveFromOffset),
  ].filter((o) => typeof o === "number");
  if (offsets.length === 0) return [];
  const first = Number(isoDateAt(anchor, Math.min(...offsets)).slice(0, 4));
  const last = Number(isoDateAt(anchor, Math.max(...offsets)).slice(0, 4));
  return Array.from({ length: last - first + 1 }, (_, i) => first + i);
}

/** Applies the POLISH preset for each year, one call at a time (each is a plan write). Returns the numbers of holidays added and skipped. */
export async function applyPolishHolidays(client, years) {
  let added = 0;
  let skipped = 0;
  await phase("polish holidays", years, 1, async (year) => {
    const answer = await client.must("POST", "/api/v1/public-holidays/apply-preset", { preset: "POLISH", year }, `applying the Polish holidays of ${year}`);
    added += answer.added.length;
    skipped += answer.skipped.length;
  });
  return { added, skipped };
}

export async function main(argv, env = process.env) {
  resetProgress();
  const args = parseArgs(argv);
  const loginPassword = env.ASTROLABE_SAMPLE_LOGIN_PASSWORD ?? "";
  if (args.logins && (Buffer.byteLength(loginPassword) < 10 || Buffer.byteLength(loginPassword) > 71)) throw new Refusal("--logins needs ASTROLABE_SAMPLE_LOGIN_PASSWORD (10 to 71 bytes) in the environment");
  const data = loadDataset(args.data);

  console.log(`target ${args.origin}, anchor ${args.anchor}, concurrency ${args.concurrency}`);
  await assertDevelopmentStack(args.origin);
  // Only now is the credential read: a stack that failed the check above never sees it.
  const adminPassword = env.ASTROLABE_ADMIN_PASSWORD;
  if (!adminPassword) throw new Refusal("set ASTROLABE_ADMIN_PASSWORD (the seed administrator's password) in the environment");
  const client = createClient(args.origin);
  await client.login(env.ASTROLABE_ADMIN_EMAIL || "admin@astrolabe.local", adminPassword);
  try {
    const existing = await findExistingLoad(client, data);
    if (existing.foreign.length > 0) {
      throw new Refusal(`a sample work stream holds items that sample people do not own; the loader never deletes those, so it stops. Move or delete them first:${listed(existing.foreign)}`);
    }
    const found = existing.streams.length + existing.teams.length + existing.people.length + existing.users.length;
    if (found > 0 && !args.reset) {
      throw new Refusal(`an earlier sample load is present (${existing.streams.length} work streams, ${existing.teams.length} teams, ${existing.people.length} people, ${existing.users.length} logins); run again with --reset to replace it`);
    }
    if (existing.collisions.length > 0) {
      throw new Refusal(`names of the dataset are already used by data that is not sample data (names of teams, programs and work streams are unique across the plan), so nothing was written. Rename or delete them first:${listed(existing.collisions)}`);
    }
    const started = Date.now();
    if (found > 0) await resetLoad(client, existing, args.concurrency);
    else if (args.reset) console.log("--reset: no earlier sample load found");
    const ids = await loadPlan(client, data, args, loginPassword);
    let holidays = null;
    if (args.polishHolidays) {
      try {
        holidays = await applyPolishHolidays(client, spannedYears(data, args.anchor));
      } catch (e) {
        throw new Error(`${e?.message ?? e}; the sample plan itself is loaded, only the holidays are missing: re-run with --reset --polish-holidays`, { cause: e });
      }
    }

    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`\nloaded in ${seconds}s with ${client.requests} requests:`);
    for (const [label, ms] of phaseTimes) console.log(`  ${label.padEnd(22)} ${String(counts[label]).padStart(5)}  ${(ms / 1000).toFixed(1)}s`);
    if (holidays) console.log(`Polish holidays: ${holidays.added} added, ${holidays.skipped} already present (the dictionary is global; --reset never removes holidays)`);
    const biggest = [...data.milestones.reduce((m, x) => m.set(x.teamRef, (m.get(x.teamRef) ?? 0) + 1), new Map())].sort((a, b) => b[1] - a[1])[0];
    console.log(`largest team: "${data.teams.find((t) => t.ref === biggest[0]).name}" (${biggest[1]} milestones) at /teams/${ids.team.get(biggest[0])}`);
    if (args.logins) console.log(`logins: <first>.<last>${SAMPLE_DOMAIN}, e.g. ${data.people[0].email} (manager of "${data.teams[0].name}")`);
  } finally {
    await client.logout();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((e) => {
    if (e instanceof Refusal) {
      console.error(`load.mjs: ${e.message}`);
      process.exit(2);
    }
    console.error(`load.mjs: failed: ${e?.message ?? e}`);
    process.exit(1);
  });
}
