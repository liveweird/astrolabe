// The WireMock mappings and bodies of the Flow stub, built from the world (world.mjs) and the contract (contract.mjs). Pure: returns
// { mappings, files } maps of filename -> text (and `counts` for expected.json).
//
// What a mapping matches is the contract with the client (flow/FlowClient.kt, later steps), all of it named in contract.mjs:
//   - every authenticated route needs `Authorization: Bearer <the stub token>`; ANYTHING else under /api/v1/integration/ (no header, another
//     scheme, another token, an unknown path, another method) falls to `auth-catchall-401` at priority 100: the ONE uniform 401 of the Flow
//     plan section 7 (application/problem+json, "Missing or invalid service token");
//   - `GET .../teams` answers a well-formed `sprintsSince` (or none) with the document and a malformed one with a 400 problem (priority 9);
//     the value itself is ignored (the window is fixed in the document: `sprintsSince` there is the world's, not an echo);
//   - the `flow-day2` WireMock scenario flips `teams` between `Started` and `day2` (PUT /__admin/scenarios/flow-day2/state);
//   - the `flow-outage` scenario answers BOTH endpoints with a 500 problem while it is in the state `down` (priority 5, beating the above) to
//     any WELL-FORMED bearer (the database lookup throws: a 500, never a 401); only a missing or MALFORMED header still gets the 401, because
//     Flow checks the shape before it touches the database (Flow plan sections 5 and 7).
import { createHash } from "node:crypto";
import {
  AUTH_HEADER, AUTH_SHAPE_PATTERN, BAD_SINCE, OUTAGE, PATHS, PROBLEM_JSON, SPRINTS_SINCE, SPRINTS_SINCE_PATTERN, UNAUTHORIZED, meDocument, teamsDocument,
} from "./contract.mjs";

export const DAY2_SCENARIO = "flow-day2";
export const OUTAGE_SCENARIO = "flow-outage";
/** The scenario states, as WireMock names them (the initial one is always `Started`). */
export const STATES = { started: "Started", day2: "day2", down: "down" };

/** The fixed-order JSON the files are written in (2-space indent for mappings, minified for bodies). */
export const pretty = (value) => `${JSON.stringify(value, null, 2)}\n`;
export const compact = (value) => `${JSON.stringify(value)}\n`;

export function buildStub(world) {
  const mappings = new Map();
  const files = new Map();
  const addBody = (prefix, value) => {
    const text = compact(value);
    const name = `${prefix}-${createHash("sha256").update(text).digest("hex").slice(0, 10)}.json`;
    files.set(name, text);
    return name;
  };
  const addMapping = (name, request, response, extra = {}) => {
    if (mappings.has(`${name}.json`)) throw new Error(`duplicate mapping ${name}`);
    mappings.set(`${name}.json`, pretty({ priority: 10, request, response, ...extra }));
  };
  const respond = (status, bodyFileName, contentType = "application/json") => ({ status, headers: { "Content-Type": contentType }, bodyFileName });
  const authorized = { Authorization: { equalTo: AUTH_HEADER } };
  const scenario = (name, state) => ({ scenarioName: name, requiredScenarioState: STATES[state] });

  // The problems (one body each) and the two documents.
  const unauthorized = addBody("problem-401", UNAUTHORIZED);
  const badSince = addBody("problem-400", BAD_SINCE);
  const outage = addBody("problem-500", OUTAGE);
  const me = addBody("me", meDocument());
  const teamsStarted = addBody("teams-started", teamsDocument(world.teams, { asOf: world.asOf, sprintsSince: world.sprintsSince }));
  const teamsDay2 = addBody("teams-day2", teamsDocument(world.day2.teams, { asOf: world.day2.asOf, sprintsSince: world.sprintsSince }));

  // The catch-all: every other request under the namespace is the uniform 401.
  addMapping("auth-catchall-401", { urlPathPattern: "/api/v1/integration/.*" }, respond(401, unauthorized, PROBLEM_JSON), { priority: 100 });

  // GET /integration/me: the same on every day.
  addMapping("me", { method: "GET", urlPath: PATHS.me, headers: authorized }, respond(200, me));

  // GET /integration/teams: a well-formed sprintsSince, or none (the real server defaults it), answers the day's document.
  const teams = (since) => ({ method: "GET", urlPath: PATHS.teams, headers: authorized, queryParameters: { [SPRINTS_SINCE]: since } });
  const wellFormed = { matches: SPRINTS_SINCE_PATTERN };
  for (const [state, body] of [["started", teamsStarted], ["day2", teamsDay2]]) {
    addMapping(`teams-${state}`, teams(wellFormed), respond(200, body), scenario(DAY2_SCENARIO, state));
    addMapping(`teams-${state}-no-since`, teams({ absent: true }), respond(200, body), scenario(DAY2_SCENARIO, state));
  }
  // A malformed value (present, not an ISO date): the 400, ahead of the document mappings. `matches ".*"` is the "present" half: WireMock's
  // `doesNotMatch` alone is also true of an ABSENT parameter, which would turn the default into a 400.
  addMapping(
    "teams-malformed-since-400",
    { method: "GET", urlPath: PATHS.teams, headers: authorized, queryParameters: { [SPRINTS_SINCE]: { and: [{ matches: ".*" }, { doesNotMatch: SPRINTS_SINCE_PATTERN }] } } },
    respond(400, badSince, PROBLEM_JSON),
    { priority: 9 },
  );

  // The outage scenario: both endpoints answer 500 to a well-formed bearer while it is in `down`.
  const wellFormedBearer = { Authorization: { matches: AUTH_SHAPE_PATTERN } };
  for (const [name, path] of [["me", PATHS.me], ["teams", PATHS.teams]]) {
    addMapping(`${name}-outage-500`, { method: "GET", urlPath: path, headers: wellFormedBearer }, respond(500, outage, PROBLEM_JSON), { priority: 5, ...scenario(OUTAGE_SCENARIO, "down") });
  }

  const counts = {
    teamsStarted: world.teams.length,
    teamsDay2: world.day2.teams.length,
    teamsStartedBytes: files.get(teamsStarted).length,
  };
  return { mappings, files, counts };
}
