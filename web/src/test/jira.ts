// Shared fixtures for the Jira pages' tests: a connection, the discovery it stored, the mapping response and a passing probe set.
import type { JiraConnection, JiraDiscovery, JiraMapping, JiraMappingResponse, JiraTestResult } from "../api/jira";
import type { SyncRun } from "../api/sync";

export const CONNECTION: JiraConnection = {
  id: 1,
  name: "Acme Jira",
  siteUrl: "https://acme.atlassian.net",
  email: "robot@acme.example",
  hasApiToken: true,
  authScheme: "BASIC",
  projectKeys: ["E2E", "PF"],
  enabled: true,
  pollIntervalMinutes: 15,
  cloudId: "8a1a2b3c-0000-4000-8000-000000000001",
  discoveredAt: Date.UTC(2026, 10, 6, 9, 30),
  lastTestedAt: Date.UTC(2026, 10, 6, 9, 30),
  lastTestOk: true,
  mappingSet: false,
  lastRun: null,
  status: { state: "NEVER_SYNCED", lastRun: null, lastSucceededAt: null, consecutiveFailures: 0, nextPollAt: null },
  createdAt: 1,
  updatedAt: 2,
  stub: false,
};

const START = { id: "customfield_10020", name: "Target start", type: "date", custom: "com.atlassian.jpo:jpo-custom-field-baseline-start" };
const END = { id: "customfield_10021", name: "Target end", type: "date", custom: "com.atlassian.jpo:jpo-custom-field-baseline-end" };
const POINTS = { id: "customfield_10028", name: "Story point estimate", type: "number", custom: null };
const TEAM = { id: "customfield_10001", name: "Team", type: "team", custom: "com.atlassian.jira.plugin.system.customfieldtypes:atlassian-team" };

export const DISCOVERY: JiraDiscovery = {
  discoveredAt: Date.UTC(2026, 10, 6, 9, 30),
  fieldCount: 61,
  issueTypeCount: 7,
  fieldsTruncated: false,
  fields: [
    { id: "duedate", name: "Due date", type: "date", custom: null },
    { id: "customfield_10015", name: "Start date", type: "date", custom: null },
    START,
    END,
    POINTS,
    { id: "customfield_10030", name: "Time in status", type: "number", custom: null },
    TEAM,
  ],
  issueTypes: [
    { id: "10001", name: "Epic", hierarchyLevel: 1, subtask: false },
    { id: "10002", name: "Initiative", hierarchyLevel: 2, subtask: false },
    { id: "10003", name: "Program", hierarchyLevel: 3, subtask: false },
    { id: "10004", name: "Story", hierarchyLevel: 0, subtask: false },
  ],
  levels: [
    { level: 3, typeNames: ["Program"] },
    { level: 2, typeNames: ["Initiative"] },
    { level: 1, typeNames: ["Epic"] },
    { level: 0, typeNames: ["Story"] },
  ],
  markers: { targetStart: START, targetEnd: END, startDate: { id: "customfield_10015", name: "Start date", type: "date", custom: null }, dueDate: { id: "duedate", name: "Due date", type: "date", custom: null }, storyPoints: POINTS, team: TEAM },
};

/** What the discovery resolves by name: Plans' Target start/end, the story-points field, the Team field, levels 3/2/1. */
export const DEFAULT_MAPPING: JiraMapping = {
  levels: {
    program: { hierarchyLevel: 3, fields: { start: START.id, end: END.id, estimate: null } },
    project: { hierarchyLevel: 2, fields: { start: START.id, end: END.id, estimate: null } },
    milestone: { hierarchyLevel: 1, fields: { start: START.id, end: END.id, estimate: POINTS.id } },
  },
  estimate: { unit: "POINTS", manDaysPerUnit: null },
  teamFieldId: TEAM.id,
};

export const MAPPING_DEFAULTS_ONLY: JiraMappingResponse = {
  mapping: null,
  defaults: DEFAULT_MAPPING,
  effective: DEFAULT_MAPPING,
  discoveredAt: DISCOVERY.discoveredAt,
  problems: [],
};

export const PASSING_TEST: JiraTestResult = {
  rows: [
    { name: "tenant_info", path: "/_edge/tenant_info", required: true, ok: true, status: 200 },
    { name: "myself", path: "/rest/api/3/myself", required: true, ok: true, status: 200 },
    { name: "search", path: "/rest/api/3/search/jql", required: true, ok: true, status: 200 },
    { name: "project:E2E", path: "/rest/api/3/project/E2E", required: true, ok: true, status: 200 },
  ],
  cloudId: "8a1a2b3c-0000-4000-8000-000000000001",
  discoveredAt: DISCOVERY.discoveredAt,
  recorded: true,
  stub: false,
};

export const FAILING_TEST: JiraTestResult = {
  rows: [
    { name: "tenant_info", path: "/_edge/tenant_info", required: true, ok: true, status: 200 },
    { name: "myself", path: "/rest/api/3/myself", required: true, ok: true, status: 200 },
    { name: "search", path: "/rest/api/3/search/jql", required: true, ok: false, status: 401, code: "AUTHENTICATION_FAILED", scopeHint: "read:jql:jira" },
    { name: "issue", path: "/rest/api/3/issue/{id}", required: false, ok: false, status: 403, code: "FORBIDDEN_SCOPE", scopeHint: "read:issue-details:jira" },
  ],
  cloudId: null,
  recorded: true,
  stub: false,
};

export function run(overrides: Partial<SyncRun> = {}): SyncRun {
  return {
    id: 7,
    kind: "JIRA",
    connectionId: 1,
    trigger: "MANUAL",
    requestedByUserId: 1,
    startedAt: Date.UTC(2026, 10, 6, 10, 0),
    finishedAt: Date.UTC(2026, 10, 6, 10, 1),
    outcome: "SUCCEEDED",
    errorCode: null,
    errorDetail: null,
    running: false,
    observedCount: 12,
    goneCount: 1,
    callCount: 9,
    rateLimitedCount: 0,
    backoffMs: 0,
    ...overrides,
  };
}
