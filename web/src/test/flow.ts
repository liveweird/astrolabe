// Shared fixtures for the Flow pages' tests: a connection, a passing and a failing probe set, the mirrored teams and a run.
import type { FlowConnection, FlowTeamList, FlowTeamListItem, FlowTestResult } from "../api/flow";
import type { SyncRun } from "../api/sync";

export const CONNECTION: FlowConnection = {
  id: 1,
  name: "Acme Flow",
  baseUrl: "https://flow.acme.example",
  timeZone: "Europe/Warsaw",
  hasApiToken: true,
  enabled: true,
  pollIntervalMinutes: 60,
  lastTestedAt: Date.UTC(2026, 10, 8, 9, 30),
  lastTestOk: true,
  teamsAt: Date.UTC(2026, 10, 8, 9, 40),
  lastRun: null,
  status: { state: "NEVER_SYNCED", lastRun: null, lastSucceededAt: null, consecutiveFailures: 0, nextPollAt: null },
  createdAt: 1,
  updatedAt: 2,
};

export const PASSING_TEST: FlowTestResult = {
  rows: [
    { name: "me", path: "/api/v1/integration/me", required: true, ok: true, status: 200 },
    { name: "teams", path: "/api/v1/integration/teams", required: true, ok: true, status: 200 },
  ],
  teamCount: 18,
  sprintCount: 640,
  truncated: false,
  recorded: true,
};

/** A revoked token: `me` answers the uniform 401 and `teams` is skipped. */
export const REVOKED_TEST: FlowTestResult = {
  rows: [
    { name: "me", path: "/api/v1/integration/me", required: true, ok: false, status: 401, code: "AUTHENTICATION_FAILED", scopeHint: "Flow 1.57.0 or later" },
    { name: "teams", path: "/api/v1/integration/teams", required: true, ok: false, code: "SKIPPED" },
  ],
  teamCount: null,
  sprintCount: null,
  truncated: false,
  recorded: true,
};

export function flowTeam(overrides: Partial<FlowTeamListItem> = {}): FlowTeamListItem {
  return {
    flowTeamId: 11,
    name: "Platform",
    bindingId: null,
    boundTeamId: null,
    boundTeamName: null,
    suggestedTeamId: null,
    suggestedTeamName: null,
    members: 6,
    sprints: 33,
    observedAt: Date.UTC(2026, 10, 8, 9, 40),
    ...overrides,
  };
}

/** Platform: linked; Payments: one unique suggestion; Design System: nothing matches. */
export const TEAMS: FlowTeamList = {
  connectionId: 1,
  teamsAt: Date.UTC(2026, 10, 8, 9, 40),
  items: [
    flowTeam({ flowTeamId: 11, name: "Platform", bindingId: 5, boundTeamId: 3, boundTeamName: "Platform", members: 6, sprints: 33 }),
    flowTeam({ flowTeamId: 12, name: "Payments", suggestedTeamId: 4, suggestedTeamName: "Payments", members: 5, sprints: 31 }),
    flowTeam({ flowTeamId: 13, name: "Design System", members: 3, sprints: 12 }),
  ],
};

export function run(overrides: Partial<SyncRun> = {}): SyncRun {
  return {
    id: 7,
    kind: "FLOW",
    connectionId: 1,
    trigger: "MANUAL",
    requestedByUserId: 1,
    startedAt: Date.UTC(2026, 10, 8, 10, 0),
    finishedAt: Date.UTC(2026, 10, 8, 10, 1),
    outcome: "SUCCEEDED",
    errorCode: null,
    errorDetail: null,
    running: false,
    observedCount: 18,
    goneCount: 0,
    callCount: 1,
    rateLimitedCount: 0,
    backoffMs: 0,
    ...overrides,
  };
}
