// expected.json: the figures a test or the manual walk-through compares the stub's documents with, derived from the same world as the
// mappings (so they cannot drift): the token, the contract's field lists, per-team counts, the planted cases, the e2e team's exact
// preview rows and the day-2 changes. Rendered as pretty JSON.
import { parseIsoDate } from "../../scripts/sample-plan/days.mjs";
import {
  AUTH_HEADER, CAPACITY_SOURCES, FIELDS, PATHS, SPRINTS_SINCE, SPRINT_CAP, SPRINT_STATES, STUB_TOKEN, UNAUTHORIZED, meDocument,
} from "./contract.mjs";
import { DAY2_SCENARIO, OUTAGE_SCENARIO } from "./mappings.mjs";
import { ANCHOR, AXE_TEAM, E2E_FIRST_MONDAY, E2E_TEAM, EMPTY_TEAM, LEGACY_TEAM, PLANTED, RENAMED } from "./world.mjs";

export const renderExpected = (value) => `${JSON.stringify(value, null, 2)}\n`;

const fold = (name) => name.trim().replace(/\s+/g, " ").toLowerCase();
/** The Warsaw calendar date of a cadence instant (09:00 and 17:00 local are the same UTC date in both offsets). */
const warsawDate = (ms) => new Date(ms).toISOString().slice(0, 10);
/** Monday-to-Friday days in the inclusive span (the stub's e2e dates meet no holiday). */
function weekdays(startIso, endIso) {
  let count = 0;
  for (let ms = parseIsoDate(startIso); ms <= parseIsoDate(endIso); ms += 86_400_000) if (![0, 6].includes(new Date(ms).getUTCDay())) count++;
  return count;
}

function teamFigures(team, planNames) {
  const sprints = team.sprints;
  const count = (state) => sprints.filter((s) => s.state === state).length;
  return {
    id: team.id,
    name: team.name,
    managerName: team.managerName,
    defaultCapacityMd: team.defaultCapacityMd,
    members: { rows: team.members.length, open: team.members.filter((m) => m.validTo === null).length, closed: team.members.filter((m) => m.validTo !== null).length },
    sprints: {
      count: sprints.length, closed: count("closed"), active: count("active"), future: count("future"),
      noCapacity: sprints.filter((s) => s.capacityMd === null).length,
      noDates: sprints.filter((s) => s.startAt === null || s.endAt === null).length,
      teamDefault: sprints.filter((s) => s.capacitySource === "TEAM_DEFAULT").length,
    },
    suggestedAstrolabeTeam: planNames.find((name) => fold(name) === fold(team.name)) ?? null,
  };
}

const rosterOf = (team) => ({
  current: team.members.filter((m) => m.validTo === null).map((m) => m.displayName),
  former: team.members.filter((m) => m.validTo !== null).map((m) => ({ displayName: m.displayName, validFrom: m.validFrom, validTo: m.validTo })),
});

export function buildExpected(world, counts, planTeams) {
  const planNames = planTeams.map((t) => t.name);
  const all = world.teams;
  const named = (name) => all.find((t) => t.name === name);
  const e2e = named(E2E_TEAM);
  const axe = named(AXE_TEAM);
  const figures = all.map((t) => teamFigures(t, planNames));
  const suggested = figures.filter((t) => t.suggestedAstrolabeTeam !== null).map((t) => t.name);
  const preview = e2e.sprints.map((s) => {
    const start = warsawDate(s.startAt);
    const end = warsawDate(s.endAt);
    const workingDays = weekdays(start, end);
    return { sprintId: s.sprintId, name: s.name, start, end, workingDays, startAt: s.startAt, endAt: s.endAt, flowMd: s.capacityMd, mdPerWeek: ((5 * s.capacityMd) / workingDays).toFixed(2) };
  });
  return {
    contract: {
      paths: PATHS,
      sprintsSinceParameter: SPRINTS_SINCE,
      token: STUB_TOKEN,
      authorization: AUTH_HEADER,
      unauthorized: UNAUTHORIZED,
      fields: FIELDS,
      capacitySources: CAPACITY_SOURCES,
      sprintStates: SPRINT_STATES,
      sprintCap: SPRINT_CAP,
    },
    scenarios: { day2: DAY2_SCENARIO, day2State: "day2", outage: OUTAGE_SCENARIO, outageState: "down" },
    me: meDocument(),
    document: { asOf: world.asOf, sprintsSince: world.sprintsSince, anchor: ANCHOR, sprintsTruncated: false, bytes: counts.teamsStartedBytes },
    totals: {
      teams: all.length,
      sprints: all.reduce((n, t) => n + t.sprints.length, 0),
      memberRows: all.reduce((n, t) => n + t.members.length, 0),
    },
    teams: figures,
    suggestions: { count: suggested.length, names: suggested, none: PLANTED.noSuggestion, renamedFrom: RENAMED.from },
    planted: {
      overlap: { team: PLANTED.overlapTeam, sprints: ["Support Tooling Sprint 30", "Support Tooling Sprint 30 (hotfix)"], winner: "Support Tooling Sprint 30" },
      undated: {
        team: PLANTED.undatedTeam, sprint: "Analytics Sprint 34 (undated)", capacitySource: "TEAM_DEFAULT",
        capacityMd: named(PLANTED.undatedTeam).defaultCapacityMd, note: "no dates; the team default's figure, as Flow derives it",
      },
      undatedNoDefault: {
        team: PLANTED.undatedNoDefaultTeam, sprint: "Legacy Mainframe Sprint 35 (undated)", capacityMd: null, capacitySource: null,
        note: "no dates on a team without a default: null/null is reachable in Flow",
      },
      emptyTeam: { team: EMPTY_TEAM, members: 0, sprints: 0 },
      defaultSource: { team: PLANTED.defaultSourceTeam, sprint: named(PLANTED.defaultSourceTeam).sprints.at(-1).name, capacityMd: 40 },
      unnamedMember: { team: PLANTED.unnamedMemberTeam, count: named(PLANTED.unnamedMemberTeam).members.filter((m) => m.displayName === null).length },
      syntheticNoCapacity: {
        team: PLANTED.syntheticNoCapacityTeam,
        datedSprints: named(LEGACY_TEAM).sprints.filter((s) => s.startAt !== null).length,
        note: "SYNTHETIC: dated sprints with null capacity; Flow's DeriveSprintStep never emits that, the nullable wire type allows it",
      },
    },
    e2e: { team: E2E_TEAM, year: 2047, firstMonday: E2E_FIRST_MONDAY, roster: rosterOf(e2e), preview },
    axe: { team: AXE_TEAM, sprints: axe.sprints.map((s) => ({ name: s.name, state: s.state, capacityMd: s.capacityMd })), roster: rosterOf(axe) },
    day2: { asOf: world.day2.asOf, teams: world.day2.teams.length, gone: world.day2.gone, capacityChanges: world.day2.changed },
  };
}
