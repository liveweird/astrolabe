// The stub's Flow world, derived from sample-data/plan/teams.json: the 15 sample-plan teams (one renamed on purpose) plus the planted
// "Legacy Mainframe", the e2e's "E2E Flow Team" (2047), the accessibility scans' "Axe Flow Team" and an "Empty Team" (no members, no sprints). Pure and deterministic: every random
// draw comes from one seeded mulberry32 stream and there is no clock (the document's `asOf` is a fixed instant on the anchor week).
//
// Membership intervals are HALF-OPEN as in Flow ([validFrom, validTo): validTo is the first instant that is NOT a member); see `interval`.
//
// Every object here is already in the contract's shape (contract.mjs builds the wire form from it): a team is
// { id, name, managerName, defaultCapacityMd, members[], sprints[] }.
import { isoDateAt, parseIsoDate } from "../../scripts/sample-plan/days.mjs";

/** The sample plan's anchor Monday (timeline.md): sprint 0 starts here, so the past/active/future split ages against today, the dates do not. */
export const ANCHOR = "2026-10-26";
/** First Monday of the e2e team's own year (2047-01-07 is a Monday; nothing writes a holiday in 2047). */
export const E2E_FIRST_MONDAY = "2047-01-07";
export const E2E_TEAM = "E2E Flow Team";
export const AXE_TEAM = "Axe Flow Team";
export const LEGACY_TEAM = "Legacy Mainframe";
export const EMPTY_TEAM = "Empty Team";
/** The sample-plan team that Flow spells differently ("Design Systems" there, "Design System" here): the one planted "no suggestion". */
export const RENAMED = { from: "Design Systems", to: "Design System" };

export const CONNECTION_ID = 1;
/** Sprints per team: n from FIRST_N (26 sprints ago) to LAST_N (6 ahead); n = 0 is the active one, starting on ANCHOR. */
export const FIRST_N = -26;
export const LAST_N = 6;
const SPRINT_DAYS = 14; // a two-week cadence: Monday 09:00 to the second Friday 17:00 (Europe/Warsaw)
const SPRINT_LAST_DAY = 11; // Friday of the second week, as an offset from the Monday
export const ASOF = Date.UTC(2026, 9, 29, 12, 0, 0); // Thursday of the anchor week, 12:00 UTC
export const SPRINTS_SINCE_DATE = isoDateAt(ANCHOR, FIRST_N * SPRINT_DAYS); // the Monday 26 sprints back: the window every sprint of the sample teams is inside
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** The planted counts and cases (also written to expected.json). */
export const PLANTED = {
  noSuggestion: [RENAMED.to, LEGACY_TEAM, E2E_TEAM, AXE_TEAM, EMPTY_TEAM], // Flow teams with no same-named Astrolabe team
  overlapTeam: "Support Tooling", // a one-week sprint wholly inside sprint 30
  undatedTeam: "Analytics", // a future sprint with no dates on a team WITH a default: Flow derives TEAM_DEFAULT (the default's figure), hasCalendar false
  undatedNoDefaultTeam: LEGACY_TEAM, // a future sprint with no dates on a team WITHOUT a default: capacityMd null, capacitySource null (reachable in Flow)
  syntheticNoCapacityTeam: LEGACY_TEAM, // SYNTHETIC: its DATED sprints carry null capacity; Flow never derives that (see legacyTeam), the wire type allows it
  defaultSourceTeam: "Mobile", // the last future sprint's capacityMd comes from the global DEFAULT
  unnamedMemberTeam: "Web Frontend", // one membership with a null displayName
  goneOnDay2: "Billing",
};

const GREEK = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta", "Eta", "Theta", "Iota", "Kappa", "Lambda", "Mu", "Nu", "Xi", "Omicron"];
const ORDINAL = ["One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight"];

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- Europe/Warsaw without a time-zone database (the generator must not depend on the runtime's ICU) --------------------------------
const lastSundayUtc = (year, month, hour) => {
  const last = new Date(Date.UTC(year, month + 1, 0, hour));
  return last.getTime() - last.getUTCDay() * DAY_MS;
};
/** UTC offset in hours of Europe/Warsaw at a UTC instant: +2 from the last Sunday of March 01:00 UTC to the last Sunday of October 01:00 UTC. */
function warsawOffsetHours(utcMs) {
  const year = new Date(utcMs).getUTCFullYear();
  return utcMs >= lastSundayUtc(year, 2, 1) && utcMs < lastSundayUtc(year, 9, 1) ? 2 : 1;
}
/** The epoch ms of `isoDate` `hour`:00 on Europe/Warsaw's wall clock. */
export function warsawInstant(isoDate, hour = 0) {
  const asUtc = parseIsoDate(isoDate) + hour * HOUR_MS;
  return asUtc - warsawOffsetHours(asUtc - 2 * HOUR_MS) * HOUR_MS;
}

const sprintDates = (mondayIso) => ({ start: mondayIso, end: isoDateAt(mondayIso, SPRINT_LAST_DAY) });
const stateOf = (n) => (n < 0 ? "closed" : n === 0 ? "active" : "future");
const halfUp = (x) => Math.round(x * 2) / 2;

/**
 * A membership interval, HALF-OPEN as in Flow: a member over [validFrom, validTo). `firstMemberDay` and `firstNonMemberDay` are ISO dates read as
 * Warsaw midnights; the account is NOT a member on `firstNonMemberDay` itself (Flow's "End membership" sets validTo to the start of today).
 * `firstNonMemberDay` null = still a member (validTo null).
 */
const interval = (accountId, displayName, firstMemberDay, firstNonMemberDay = null) => ({
  accountId,
  displayName,
  validFrom: warsawInstant(firstMemberDay),
  validTo: firstNonMemberDay === null ? null : warsawInstant(firstNonMemberDay),
});
const accountId = (teamId, index) => `712020:0000f10e-0000-4000-8000-${String(teamId * 100 + index).padStart(12, "0")}`;

/** One sprint of the fixed cadence for sprint number `n` (all dates absolute, no clock). */
function cadenceSprint({ teamId, n, name, capacityMd, hasCalendar = true, capacitySource = "CALENDAR", rand }) {
  const { start, end } = sprintDates(isoDateAt(ANCHOR, n * SPRINT_DAYS));
  const state = stateOf(n);
  const endAt = warsawInstant(end, 17);
  return {
    sprintId: teamId * 1000 + 27 + n,
    connectionId: CONNECTION_ID,
    name,
    state,
    startAt: warsawInstant(start, 9),
    endAt,
    completeAt: state === "closed" ? endAt + Math.round((1 + rand() * 29) * HOUR_MS) : null,
    hasCalendar,
    capacityMd,
    capacitySource,
  };
}

/** A sample-plan team: 4-8 current members, 1-2 closed intervals, 33 sprints (26 closed, 1 active, 6 future). */
function sampleTeam(index, name, rand) {
  const id = index + 1;
  const greek = GREEK[index];
  const current = 4 + Math.floor(rand() * 5);
  const closedIntervals = 1 + (rand() < 0.5 ? 1 : 0);
  const members = [];
  for (let j = 0; j < current; j++) {
    const from = j === 0 && closedIntervals === 2 ? isoDateAt("2025-02-03", Math.floor(rand() * 20)) : isoDateAt("2024-01-08", Math.floor(rand() * 900));
    members.push(interval(accountId(id, j + 1), `Stub ${greek} ${ORDINAL[j]}`, from));
  }
  members.push(interval(accountId(id, 90), `Stub ${greek} Former`, isoDateAt("2024-02-05", Math.floor(rand() * 100)), isoDateAt("2025-09-01", Math.floor(rand() * 300))));
  if (closedIntervals === 2) members.push(interval(accountId(id, 1), `Stub ${greek} ${ORDINAL[0]}`, "2023-03-06", "2024-06-28")); // left and came back
  members.sort((a, b) => (a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : a.validFrom - b.validFrom));
  const defaultCapacityMd = current * 8;
  const sprints = [];
  for (let n = FIRST_N; n <= LAST_N; n++) {
    const noCalendar = (n - FIRST_N) % 6 === 5; // every sixth sprint falls back to the team's default
    const factor = [0.75, 0.85, 0.9, 1, 1, 1.05, 1.1][Math.floor(rand() * 7)];
    sprints.push(cadenceSprint({
      teamId: id, n, name: `${name} Sprint ${27 + n}`, rand,
      capacityMd: noCalendar ? defaultCapacityMd : halfUp(defaultCapacityMd * factor),
      hasCalendar: !noCalendar, capacitySource: noCalendar ? "TEAM_DEFAULT" : "CALENDAR",
    }));
  }
  return { id, name, managerName: `Stub Manager ${greek}`, defaultCapacityMd, members, sprints };
}

/** A future sprint Jira has not scheduled yet: no dates; Flow derives its capacity from the team default when there is one. */
function undatedSprint(teamId, number, name, capacityMd, capacitySource) {
  return {
    sprintId: teamId * 1000 + number, connectionId: CONNECTION_ID, name, state: "future",
    startAt: null, endAt: null, completeAt: null, hasCalendar: false, capacityMd, capacitySource,
  };
}

/**
 * "Legacy Mainframe": no Astrolabe counterpart, no default capacity. Its DATED sprints carry null capacity: SYNTHETIC, a robustness case for
 * the nullable wire type, because Flow's DeriveSprintStep never emits null for a dated sprint of a team (it falls back to TEAM_DEFAULT or
 * DEFAULT = members x days, possibly 0.0). Its one UNDATED sprint (null dates, null capacity, null source) IS reachable in Flow.
 */
function legacyTeam(id, rand) {
  const members = [1, 2, 3, 4, 5].map((j) => interval(accountId(id, j), `Stub Legacy ${ORDINAL[j - 1]}`, "2024-03-04"));
  const sprints = [];
  for (let n = -8; n <= LAST_N; n++) {
    sprints.push(cadenceSprint({ teamId: id, n, name: `${LEGACY_TEAM} Sprint ${27 + n}`, capacityMd: null, hasCalendar: false, capacitySource: null, rand }));
  }
  sprints.push(undatedSprint(id, 35, `${LEGACY_TEAM} Sprint 35 (undated)`, null, null));
  return { id, name: LEGACY_TEAM, managerName: null, defaultCapacityMd: null, members, sprints };
}

/** The e2e team: six future two-week sprints in 2047, capacity 40/36/44/40/38/42 = 20.00/18.00/22.00/20.00/19.00/21.00 MD per week on Mon-Fri. */
export const E2E_CAPACITIES = [40, 36, 44, 40, 38, 42];
function e2eTeam(id) {
  const members = [
    ...["One", "Two", "Three", "Four"].map((ord, j) => interval(accountId(id, j + 1), `Stub Quebec ${ord}`, "2025-01-06")),
    interval(accountId(id, 90), "Stub Quebec Former", "2025-01-06", "2026-03-31"),
  ];
  const sprints = E2E_CAPACITIES.map((capacityMd, k) => {
    const { start, end } = sprintDates(isoDateAt(E2E_FIRST_MONDAY, k * SPRINT_DAYS));
    return {
      sprintId: 90_001 + k, connectionId: CONNECTION_ID, name: `E2E Flow Sprint ${k + 1}`, state: "future",
      startAt: warsawInstant(start, 9), endAt: warsawInstant(end, 17), completeAt: null,
      hasCalendar: true, capacityMd, capacitySource: "CALENDAR",
    };
  });
  return { id, name: E2E_TEAM, managerName: "Stub Manager Quebec", defaultCapacityMd: 40, members, sprints };
}

/** The accessibility team: 2026 dates (one closed, one active, two future sprints), enough rows for the panel and the preview to render. */
function axeTeam(id, rand) {
  const members = [
    ...["One", "Two", "Three"].map((ord, j) => interval(accountId(id, j + 1), `Stub Xray ${ord}`, "2025-06-02")),
    interval(accountId(id, 90), "Stub Xray Former", "2025-06-02", "2026-06-30"),
  ];
  const capacities = [24, 24, 30, 24];
  const sprints = [-1, 0, 1, 2].map((n, k) => cadenceSprint({ teamId: id, n, name: `Axe Flow Sprint ${k + 1}`, capacityMd: capacities[k], rand }));
  sprints.forEach((sprint, k) => { sprint.sprintId = 91_001 + k; });
  return { id, name: AXE_TEAM, managerName: "Stub Manager Xray", defaultCapacityMd: 24, members, sprints };
}

const sortSprints = (sprints) => sprints.sort((a, b) => (a.startAt ?? Infinity) - (b.startAt ?? Infinity) || a.sprintId - b.sprintId);
const clone = (value) => JSON.parse(JSON.stringify(value));

/** Plants the cases on the named sample teams (see PLANTED). */
function plant(teams) {
  const byName = new Map(teams.map((t) => [t.name, t]));
  const support = byName.get(PLANTED.overlapTeam);
  const hotfixStart = isoDateAt(ANCHOR, 3 * SPRINT_DAYS + 7); // sprint 30 is n = 3: the hotfix is its second week, Monday to Friday
  support.sprints.push({
    sprintId: support.id * 1000 + 99, connectionId: CONNECTION_ID, name: "Support Tooling Sprint 30 (hotfix)", state: "future",
    startAt: warsawInstant(hotfixStart, 9), endAt: warsawInstant(isoDateAt(hotfixStart, 4), 17), completeAt: null,
    hasCalendar: true, capacityMd: 4, capacitySource: "CALENDAR",
  });
  const analytics = byName.get(PLANTED.undatedTeam);
  analytics.sprints.push(undatedSprint(analytics.id, 34, "Analytics Sprint 34 (undated)", analytics.defaultCapacityMd, "TEAM_DEFAULT"));
  const mobile = byName.get(PLANTED.defaultSourceTeam);
  const lastMobile = mobile.sprints[mobile.sprints.length - 1];
  Object.assign(lastMobile, { hasCalendar: false, capacityMd: 40, capacitySource: "DEFAULT" });
  const frontend = byName.get(PLANTED.unnamedMemberTeam);
  frontend.members.find((m) => m.accountId === accountId(frontend.id, 3)).displayName = null;
  for (const team of teams) sortSprints(team.sprints);
}

/** Day 2: Billing vanishes, Platform's calendar-sourced future sprints lose 8 MD each, the e2e team's sprints 2 and 3 change. */
function dayTwo(teams) {
  const changed = [];
  const next = clone(teams).filter((team) => team.name !== PLANTED.goneOnDay2);
  for (const team of next) {
    const change = (sprint, to) => {
      changed.push({ team: team.name, sprintId: sprint.sprintId, name: sprint.name, from: sprint.capacityMd, to });
      sprint.capacityMd = to;
    };
    if (team.name === "Platform") {
      for (const sprint of team.sprints.filter((s) => s.state === "future" && s.hasCalendar && s.capacityMd !== null)) change(sprint, sprint.capacityMd - 8);
    } else if (team.name === E2E_TEAM) {
      change(team.sprints[1], 30);
      change(team.sprints[2], 48);
    }
  }
  return { teams: next, changed, gone: [PLANTED.goneOnDay2], asOf: ASOF + DAY_MS };
}

/** The whole world from the sample plan's teams.json (`planTeams`: [{ref, name, ...}]) and the seed. */
export function buildWorld(planTeams, seed) {
  const rand = mulberry32(seed);
  const names = planTeams.map((t) => (t.name === RENAMED.from ? RENAMED.to : t.name));
  const teams = names.map((name, index) => sampleTeam(index, name, rand));
  teams.push(legacyTeam(names.length + 1, rand), e2eTeam(names.length + 2), axeTeam(names.length + 3, rand));
  teams.push({ id: names.length + 4, name: EMPTY_TEAM, managerName: null, defaultCapacityMd: null, members: [], sprints: [] });
  plant(teams);
  return { seed, asOf: ASOF, sprintsSince: SPRINTS_SINCE_DATE, teams, day2: dayTwo(teams) };
}
