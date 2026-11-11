// The WireMock mappings and bodies of the stub, built from the world (world.mjs). Pure: returns { mappings, files } maps of filename -> text.
//
// What a mapping matches is the contract with the client (jira/JiraClient.kt, later steps), kept in the named constants and builders below
// so a client tweak is a local edit plus a regenerate:
//   - every authenticated route needs `Authorization: Basic|Bearer ...`; a missing one falls to `auth-catchall-401`, and the token
//     REJECTED_TOKEN (any email) is refused with a 401 by `auth-wrong-token-401` (the e2e "wrong token" scenario);
//   - `GET search/jql` is told apart by its `fields` and `jql` parameters (SHAPES below), one mapping per (scope, shape, day, page), the
//     page token being the exact `nextPageToken`; a `fields` value that does not name `summary` and `issuetype` (e.g. a client that forgot
//     `fields`) matches NOTHING and falls to the catch-all 401, which is how the real site's id-only default would have failed the first run;
//   - `GET issue/{id|key}` per issue (one mapping, the id OR the key in the path regex), a 404 for any other key.
// The `jira-day2` WireMock scenario flips between `Started` and `day2` (PUT /__admin/scenarios/jira-day2/state).
import { createHash } from "node:crypto";
import { isoDateAt } from "../../scripts/sample-plan/days.mjs";
import {
  ACCOUNT, AUTH_HEADER_PATTERN, BASE, CLOUD_ID, F, REJECTED_TOKEN, STATUS, TYPE, fieldCatalog, issueTypeCatalog, projectRow, typeOf,
} from "./catalog.mjs";

export const SCENARIO = "jira-day2";
export const PAGE_SIZE = 100;
const STATES = ["started", "day2"]; // the scenario states `Started` and `day2`, as file-name parts
const SCENARIO_STATE = { started: "Started", day2: "day2" };

/** The project-key sets a connection can be scoped to (the `project in (...)` clause, in any order). Add a line for another scope. */
export const scopesOf = (world) => [
  { name: "e2e", keys: ["E2E"] },
  { name: "sample", keys: world.keys },
  { name: "all", keys: [...world.keys, "E2E"] },
  { name: "imp", keys: ["IMP"] },
  { name: "cov", keys: ["COV"] },
];

/**
 * The single-key scopes of the import's browse (an import picks a subset of the connection's keys, one work stream's worth): the typed full
 * read ONLY, the one shape the browse sends. No connection is scoped to one of them, so they have no `project/search` or probe mapping.
 */
export const keyScopesOf = (world) => world.keys.map((key) => ({ name: key.toLowerCase(), keys: [key], only: ["fulltypes"] }));

/**
 * The issue-type sets a sweep/probe `issuetype in (...)` clause can name: the mapped levels from the milestone level upward, and `s`, the
 * child level below it (Story, Task, Bug: what the server's `typeIdsAtLevel(0)` names; the 1.4 census reads it).
 */
export const TYPE_SETS = [
  { name: "e", types: [TYPE.epic] },
  { name: "ei", types: [TYPE.epic, TYPE.initiative] },
  { name: "eip", types: [TYPE.epic, TYPE.initiative, TYPE.program] },
  { name: "s", types: [TYPE.story, TYPE.task, TYPE.bug] },
];

/** The fixed-order JSON the files are written in (2-space indent for mappings, minified for bodies). */
export const pretty = (value) => `${JSON.stringify(value, null, 2)}\n`;
export const compact = (value) => `${JSON.stringify(value)}\n`;

// --- regexes (JS and Java accept the same syntax: no flags, [\s\S] instead of dotall) -------------------------------------------------
const esc = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** `<clause> in (a, "b", c)` naming exactly the given items, in any order, quoted or not. */
export function listClause(clause, items) {
  const alt = items.map(esc).join("|");
  const each = items.map((item) => `(?=[^)]*\\b${esc(item)}\\b)`).join("");
  return `[\\s\\S]*\\b${clause} in \\(${each}\\s*"?(?:${alt})"?(?:\\s*,\\s*"?(?:${alt})"?)*\\s*\\)[\\s\\S]*`;
}
const UPDATED_CLAUSE = '[\\s\\S]*\\bupdated >= "-\\d+m"[\\s\\S]*';
const FIELDS_CARRY_SUMMARY = "(?=[\\s\\S]*\\bsummary\\b)(?=[\\s\\S]*\\bissuetype\\b)[\\s\\S]*";

/**
 * The Authorization header values the stub refuses: `Bearer wrong-token`, or a Basic value whose decoded password ends in that token (the
 * regex matches the last 16 base64 characters, one spelling per alignment of the email's length: 12 bytes `:wrong-token`, or 10-11 of them).
 */
export function wrongTokenPattern(token = REJECTED_TOKEN) {
  const suffixes = new Set();
  for (let pad = 0; pad < 3; pad++) suffixes.add(Buffer.from(`${"a".repeat(pad)}:${token}`).toString("base64").slice(-16));
  const basic = `Basic [A-Za-z0-9+/]*(?:${[...suffixes].map(esc).join("|")})`;
  return `^(?:Bearer ${esc(token)}|${basic})$`;
}

// --- documents ---------------------------------------------------------------------------------------------------------------------
const authHeader = { Authorization: { matches: AUTH_HEADER_PATTERN } };
const statusObject = (key) => ({ id: STATUS[key].id, name: STATUS[key].name, statusCategory: STATUS[key].category });
const typeObject = (issue) => {
  const type = typeOf(issue);
  return { id: type.id, name: type.name, subtask: false, ...(issue.omitLevel ? {} : { hierarchyLevel: type.hierarchyLevel }) };
};
const date = (issue, offset) => (offset === null ? null : isoDateAt(issue.anchor, offset));

export function makeDocs(world) {
  const all = [...world.issues, ...world.stories, ...world.e2e.issues, ...world.imp.issues, ...world.cov.issues];
  const byId = new Map(all.map((i) => [i.id, i]));
  const projectOf = new Map(world.projectRows.map((p) => [p.key, p]));
  const project = (key) => ({ id: projectOf.get(key).id, key, name: projectOf.get(key).name });
  const rank = (issue) => `0|i${String(issue.id).padStart(5, "0")}:`;
  /** An issue as the API returns it; `moved` = { key, projectKey } for the day-2 destination. */
  function issueDoc(issue, moved = null) {
    const parent = issue.parentId === null ? null : byId.get(issue.parentId);
    const key = moved?.key ?? issue.key;
    const fields = {
      summary: issue.summary,
      issuetype: typeObject(issue),
      project: project(moved?.projectKey ?? issue.projectKey),
      status: statusObject(issue.status),
      created: "2026-01-12T08:00:00.000+0000",
      updated: issue.updated,
      resolutiondate: issue.status === "done" ? issue.updated : null,
      duedate: issue.decoy ? date(issue, issue.end + 14) : null,
      [F.startDate]: issue.decoy ? date(issue, issue.start - 7) : null,
      [F.targetStart]: date(issue, issue.start),
      [F.targetEnd]: date(issue, issue.end),
      [F.storyPoints]: issue.points,
      [F.storyPointEstimate]: null,
      [F.team]: issue.team,
      [F.sprint]: null,
      [F.rank]: rank(issue),
      [F.epicLink]: null,
      [F.parentLink]: null,
    };
    if (parent !== null) {
      fields.parent = { id: parent.id, key: parent.key, fields: { summary: parent.summary, status: statusObject(parent.status), issuetype: typeObject(parent) } };
    }
    return { id: issue.id, key, fields };
  }
  return { issueDoc, byId, all };
}

// --- the builder -------------------------------------------------------------------------------------------------------------------
export function buildStub(world) {
  const mappings = new Map();
  const files = new Map();
  const { issueDoc, all } = makeDocs(world);
  const scopes = [...scopesOf(world), ...keyScopesOf(world)];
  const deletedIds = new Set([...world.day2.deleted, ...world.e2e.deleted].map((i) => i.id));
  const movedIds = new Map([...world.day2.movedOut, ...world.e2e.movedOut].map((m) => [m.issue.id, m]));
  const counts = {}; // "<scope>/<shape>/<types|any>/<state>" -> { issues, pages }

  const addBody = (prefix, text) => {
    const name = `${prefix}-${createHash("sha256").update(text).digest("hex").slice(0, 10)}.json`;
    files.set(name, text);
    return name;
  };
  const addMapping = (name, request, response, extra = {}) => {
    if (mappings.has(`${name}.json`)) throw new Error(`duplicate mapping ${name}`);
    mappings.set(`${name}.json`, pretty({ priority: 3, request, response, ...extra }));
  };
  const json = (status, bodyFileName) => ({ status, headers: { "Content-Type": "application/json" }, bodyFileName });
  const get = (path, extra = {}) => ({ method: "GET", urlPath: `${BASE}${path}`, headers: authHeader, ...extra });

  // --- the unauthenticated lookup, the catch-all and the refused token ---
  files.set("tenant-info.json", compact({ cloudId: CLOUD_ID }));
  addMapping("tenant-info", { method: "GET", urlPath: "/_edge/tenant_info" }, json(200, "tenant-info.json"), { priority: 1 });
  files.set("auth-401.json", compact({ code: 401, message: "Unauthorized; scope does not match" }));
  addMapping("auth-catchall-401", { method: "GET", urlPathPattern: `/ex/jira/${CLOUD_ID}/.*` }, json(401, "auth-401.json"), { priority: 100 });
  addMapping(
    "auth-wrong-token-401",
    { method: "GET", urlPathPattern: `/ex/jira/${CLOUD_ID}/.*`, headers: { Authorization: { matches: wrongTokenPattern() } } },
    json(401, "auth-401.json"),
    { priority: 1 },
  );

  // --- the reference endpoints ---
  const reference = (name, path, body) => {
    files.set(`${name}.json`, compact(body));
    addMapping(name, get(path), json(200, `${name}.json`));
  };
  reference("myself", "/myself", ACCOUNT);
  reference("field", "/field", fieldCatalog());
  reference("issuetype", "/issuetype", issueTypeCatalog());
  const rows = world.projectRows.map((p) => projectRow(p.id, p.key, p.name));
  reference("project-search", "/project/search", { maxResults: 50, startAt: 0, total: rows.length, isLast: true, values: rows });
  // `project/search?keys=A&keys=B` (the Test connection's project probe, assumption A8): only the named projects, for each scope's keys in
  // the order the connection lists them. Any other key set (or none) falls to the unfiltered page above.
  for (const scope of scopesOf(world)) {
    const wanted = rows.filter((row) => scope.keys.includes(row.key));
    const body = { maxResults: 50, startAt: 0, total: wanted.length, isLast: true, values: wanted };
    files.set(`project-search-${scope.name}.json`, compact(body));
    addMapping(
      `project-search-${scope.name}`,
      get("/project/search", { queryParameters: { keys: { hasExactly: scope.keys.map((key) => ({ equalTo: key })) } } }),
      json(200, `project-search-${scope.name}.json`),
      { priority: 2 },
    );
  }

  // --- the issues: one mapping per issue (id OR key in the path); the day-2 changes are scenario-bound pairs ---
  files.set("issue-not-found.json", compact({ errorMessages: ["Issue does not exist or you do not have permission to see it."], errors: {} }));
  const issueMapping = (name, ids, body, extra = {}) => addMapping(
    name,
    { method: "GET", urlPathPattern: `${BASE}/issue/(?:${ids.map(esc).join("|")})`, headers: authHeader },
    typeof body === "string" ? json(200, body) : json(404, "issue-not-found.json"),
    extra,
  );
  const dayTwo = (state) => ({ scenarioName: SCENARIO, requiredScenarioState: SCENARIO_STATE[state] });
  for (const issue of all) {
    const doc = addBody(`issue-${issue.id}`, compact(issueDoc(issue)));
    if (deletedIds.has(issue.id)) {
      issueMapping(`issue-${issue.id}-started`, [issue.id, issue.key], doc, dayTwo("started"));
      issueMapping(`issue-${issue.id}-day2`, [issue.id, issue.key], null, dayTwo("day2"));
    } else if (movedIds.has(issue.id)) {
      const moved = movedIds.get(issue.id);
      const movedDoc = addBody(`issue-${issue.id}-moved`, compact(issueDoc(issue, { key: moved.movedKey, projectKey: "OUT" })));
      issueMapping(`issue-${issue.id}-started`, [issue.id, issue.key], doc, dayTwo("started"));
      issueMapping(`issue-${issue.id}-day2-id`, [issue.id, moved.movedKey], movedDoc, dayTwo("day2"));
      issueMapping(`issue-${issue.id}-day2-oldkey`, [issue.key], null, dayTwo("day2"));
    } else {
      issueMapping(`issue-${issue.id}`, [issue.id, issue.key], doc);
    }
  }
  addMapping("issue-unknown-404", { method: "GET", urlPathPattern: `${BASE}/issue/.*`, headers: authHeader }, json(404, "issue-not-found.json"), { priority: 50 });

  // --- search/jql ---
  const inScope = (scope, state) => all.filter((issue) => {
    if (state === "day2" && (deletedIds.has(issue.id) || movedIds.has(issue.id))) return false;
    return scope.keys.includes(issue.projectKey);
  });
  const recentIds = new Set([...world.recent, ...world.e2e.recent].map((i) => i.id));

  /** Pages of `issues` (already filtered and in id order) under one mapping group; `idsOnly` serves `{id}` entries. */
  function addPages(group, issues, request, { idsOnly, state, priority = null }) {
    const pages = Math.max(1, Math.ceil(issues.length / PAGE_SIZE));
    counts[group] = { issues: issues.length, pages };
    for (let page = 1; page <= pages; page++) {
      const slice = issues.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
      const last = page === pages;
      const body = { issues: slice.map((i) => (idsOnly ? { id: i.id } : issueDoc(i))), isLast: last, ...(last ? {} : { nextPageToken: `${group.replaceAll("/", "-")}-p${page + 1}` }) };
      const file = addBody(idsOnly ? "search-ids" : "search-issues", compact(body));
      const token = page === 1 ? { absent: true } : { equalTo: `${group.replaceAll("/", "-")}-p${page}` };
      addMapping(
        `search-${group.replaceAll("/", "-")}-page-${page}`,
        { ...request, queryParameters: { ...request.queryParameters, nextPageToken: token } },
        json(200, file),
        { ...dayTwo(state), ...(priority === null ? {} : { priority }) },
      );
    }
  }

  for (const scope of scopes) {
    const scopeJql = { matches: listClause("project", scope.keys) };
    const has = (shape) => scope.only === undefined || scope.only.includes(shape);
    for (const state of STATES) {
      const base = (queryParameters) => get("/search/jql", { queryParameters });
      const sweepable = inScope(scope, state);
      // FULL read (no `updated` clause): the first run and the import browse. All types in scope; `fields` must name summary + issuetype.
      if (has("full")) addPages(
        `${scope.name}/full/any/${state}`, sweepable,
        base({ jql: { and: [scopeJql, { doesNotMatch: UPDATED_CLAUSE }] }, fields: { matches: FIELDS_CARRY_SUMMARY } }), { idsOnly: false, state },
      );
      // FULL read LIMITED TO TYPES (the run's first read: `project in (...) AND issuetype in (...) ORDER BY id ASC`, the sweep's clause, with the
      // observation `fields`): per issue-type set, priority 2 so it wins over the unfiltered full read above (whose scope regex also matches).
      for (const set of TYPE_SETS) {
        const typeIds = set.types.map((t) => t.id);
        addPages(
          `${scope.name}/fulltypes/${set.name}/${state}`, sweepable.filter((i) => typeIds.includes(typeOf(i).id)),
          base({
            jql: { and: [scopeJql, { matches: listClause("issuetype", typeIds) }, { doesNotMatch: UPDATED_CLAUSE }] },
            fields: { matches: FIELDS_CARRY_SUMMARY },
          }),
          { idsOnly: false, state, priority: 2 },
        );
      }
      // INCREMENTAL (`updated >= "-Nm"`): the recently updated issues only.
      if (has("incremental")) addPages(
        `${scope.name}/incremental/any/${state}`, sweepable.filter((i) => recentIds.has(i.id)),
        base({ jql: { and: [scopeJql, { matches: UPDATED_CLAUSE }] }, fields: { matches: FIELDS_CARRY_SUMMARY } }), { idsOnly: false, state },
      );
      // SWEEP (`fields=id`, an `issuetype in (...)` clause): the ids still in scope, per issue-type set.
      for (const set of has("sweep") ? TYPE_SETS : []) {
        const typeIds = set.types.map((t) => t.id);
        addPages(
          `${scope.name}/sweep/${set.name}/${state}`, sweepable.filter((i) => typeIds.includes(typeOf(i).id)),
          base({ jql: { and: [scopeJql, { matches: listClause("issuetype", typeIds) }] }, fields: { equalTo: "id" } }), { idsOnly: true, state },
        );
      }
    }
    if (!has("probe")) continue;
    // PROBE (`maxResults=1`, `fields=id`): the Test connection's `search` row; the first epic in scope, on both days.
    const first = inScope(scope, "started").find((i) => i.level === "milestone");
    const probeBody = addBody("search-probe", compact({ issues: [{ id: first.id }], isLast: false, nextPageToken: `probe-${scope.name}` }));
    addMapping(
      `search-probe-${scope.name}`,
      get("/search/jql", { queryParameters: { jql: { matches: listClause("project", scope.keys) }, fields: { equalTo: "id" }, maxResults: { equalTo: "1" }, nextPageToken: { absent: true } } }),
      json(200, probeBody),
      { priority: 2 },
    );
    counts[`${scope.name}/probe/any/any`] = { issues: 1, pages: 1 };
  }
  return { mappings, files, counts };
}
