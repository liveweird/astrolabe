// THE Flow contract, in one place. Everything Astrolabe assumes about Flow's read-only service-token surface (Flow 1.57.0, the plan
// ~/.claude/plans/flow-service-token.md: section 3.1 the documents, section 5 the token grammar, section 7 the uniform 401) is stated here and
// nowhere else in the stub: the paths, the query name, the token grammar, the 401 body and the two document builders with EVERY field name.
// The mappings (mappings.mjs), the world (world.mjs) and expected.json all take their facts from this file, so when the real Flow differs
// the fix is one edit here plus server/src/main/kotlin/flow/FlowDocument.kt (the only decoder), a regenerate, and FlowStubFixtureTest /
// FlowClientTest proving the two aligned (flow-sync.md "The contract and drift").
//
// Pure: no I/O, no clock, no randomness.

/** The two operations (both GET, both `Authorization: Bearer flow_int_...`). */
export const PATHS = { me: "/api/v1/integration/me", teams: "/api/v1/integration/teams" };
/** The one query parameter of `teams`: an ISO date, the effective filter on sprints (default today - 365 days on the real server). */
export const SPRINTS_SINCE = "sprintsSince";
/** A full-match pattern for a well-formed `sprintsSince` (a calendar-shaped YYYY-MM-DD; the real server parses it as an ISO date). */
export const SPRINTS_SINCE_PATTERN = "\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])";

/** The token grammar (Flow plan section 5): `flow_int_` + 43 base64url characters (256 bits). */
export const TOKEN_PREFIX = "flow_int_";
export const TOKEN_BODY_LENGTH = 43;
export const TOKEN_PATTERN = /^flow_int_[A-Za-z0-9_-]{43}$/;
/**
 * THE token the stub accepts (any other, or none, is the uniform 401). Fixed, public and obviously fake: it is in expected.json and the
 * README, never a secret. It satisfies the grammar, so Astrolabe's own validation accepts it.
 */
export const STUB_TOKEN = `${TOKEN_PREFIX}${"stub-".repeat(8)}stu`;
if (!TOKEN_PATTERN.test(STUB_TOKEN)) throw new Error("the stub token does not satisfy the token grammar");
/** The only `Authorization` header value the stub accepts. */
export const AUTH_HEADER = `Bearer ${STUB_TOKEN}`;
/**
 * A full-match pattern for a WELL-FORMED bearer (any token that satisfies the grammar). Flow checks the shape before the database
 * (section 5): a malformed header is the uniform 401, a well-formed unknown token costs a lookup, and during an outage that lookup
 * throws: a 500, never a 401 (section 7).
 */
export const AUTH_SHAPE_PATTERN = `Bearer ${TOKEN_PATTERN.source.slice(1, -1)}`;

/** RFC 7807, as Flow (and Astrolabe) answer every error. */
export const PROBLEM_JSON = "application/problem+json";
export const problem = (status, title, detail) => ({ type: "about:blank", title, status, detail });
/** Section 7: ONE text and one status for every authentication failure (missing, malformed, unknown, revoked, expired). */
export const UNAUTHORIZED = problem(401, "Unauthorized", "Missing or invalid service token");
/** A malformed `sprintsSince` (the real server's detail wording differs; only the status matters to the client). */
export const BAD_SINCE = problem(400, "Bad Request", "Malformed sprintsSince: expected a date as YYYY-MM-DD");
/** An outage is a 500, never a 401 (section 7: "a thrown lookup is a 500"). */
export const OUTAGE = problem(500, "Internal Server Error", "The service is unavailable");

/** Every field name of the documents, in wire order (the self-test and FlowStubFixtureTest compare the served keys with these). */
export const FIELDS = {
  me: ["tokenId", "name", "createdAt", "expiresAt", "lastUsedAt"],
  teams: ["asOf", "sprintsSince", "teamsTruncated", "sprintsTruncated", "items"],
  team: ["id", "name", "managerName", "defaultCapacityMd", "members", "sprints"],
  member: ["accountId", "displayName", "validFrom", "validTo"],
  sprint: ["sprintId", "connectionId", "name", "state", "startAt", "endAt", "completeAt", "hasCalendar", "capacityMd", "capacitySource"],
};
/**
 * The values `capacitySource` takes (null = the sprint has no capacity at all), as Flow 1.57.0's spec enumerates them: `CONFIGURED` is a
 * pre-V24 stored value an old Flow sprint row can still carry (the stub never emits it); and the sprint states the stub uses (Jira's).
 */
export const CAPACITY_SOURCES = ["CALENDAR", "TEAM_DEFAULT", "DEFAULT", "CONFIGURED"];
export const SPRINT_STATES = ["closed", "active", "future"];
/** The team cap of the real server (1,000 active teams): past it the document carries `teamsTruncated: true`. */
export const TEAM_CAP = 1000;
/** The sprint cap of the real server: past it the document carries `sprintsTruncated: true`. */
export const SPRINT_CAP = 2000;

/** The named fields of `source`, in wire order. Only `null` is a legal "absent" value: an `undefined` is a typo or a drifted field and throws. */
const pick = (names, source) => Object.fromEntries(names.map((name) => {
  if (source[name] === undefined) throw new Error(`contract: field "${name}" is undefined in ${JSON.stringify(Object.keys(source))}`);
  return [name, source[name]];
}));

/** GET /integration/me: the facts of the presenting token. */
export function meDocument({ tokenId = 1, name = "astrolabe", createdAt = 1_792_000_000_000, expiresAt = null, lastUsedAt = null } = {}) {
  return pick(FIELDS.me, { tokenId, name, createdAt, expiresAt, lastUsedAt });
}

/**
 * One membership interval, HALF-OPEN as in Flow (`metrics/TeamMembership.kt`): the account is a member over `[validFrom, validTo)`, so `validTo`
 * is the first instant that is NOT a member (Flow's "End membership" sets it to the start of today); `validTo: null` = still a member.
 * `accountId` is the Jira account id; `displayName` may be unknown (null).
 */
export const memberItem = (member) => pick(FIELDS.member, member);
/** One sprint row; every non-null `capacityMd` is already the TOTAL for the sprint (Flow's DeriveSprintStep), whatever its source. */
export const sprintItem = (sprint) => pick(FIELDS.sprint, sprint);
/** One team with its intervals and sprints (both lists in document order: members by account then start, sprints by startAt). */
export const teamItem = (team) => ({
  ...pick(FIELDS.team.slice(0, 4), team),
  members: (team.members ?? []).map(memberItem),
  sprints: (team.sprints ?? []).map(sprintItem),
});

/** GET /integration/teams: one document, every team (active, at most 100) with its members and sprints. */
export function teamsDocument(teams, { asOf, sprintsSince, teamsTruncated = false, sprintsTruncated = false }) {
  return { asOf, sprintsSince, teamsTruncated, sprintsTruncated, items: teams.map(teamItem) };
}
