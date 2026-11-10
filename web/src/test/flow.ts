// Shared fixtures for the Flow pages' tests: a connection, a passing and a failing probe set, the mirrored teams, a run, the team page's panel, the capacity import's preview
// and the capacity deviations document (rows, a team's item, a connection, the view).
import type { CapacityDeviation, CapacityDeviationConnection, CapacityDeviationItem, CapacityDeviationView } from "../api/capacityDeviations";
import type { CapacityApplyResponse, CapacityPreview, CapacityPreviewItem, FlowConnection, FlowPanelBinding, FlowTeamList, FlowTeamListItem, FlowTeamPanel, FlowTestResult } from "../api/flow";
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

/** The team page's panel for an UNLINKED team: the caller may link and (once linked) import. */
export const UNLINKED_PANEL: FlowTeamPanel = {
  team: { id: 1, name: "Payments" },
  can: { link: true, unlink: true, importCapacity: true },
  binding: null,
  roster: null,
  sprints: null,
  connections: [{ id: 1, name: "Acme Flow", enabled: true }],
};

/** An unlinked team for a viewer who may do nothing about it: what the other team-page tests serve so the Flow section stays a quiet text. */
export const READ_ONLY_PANEL: FlowTeamPanel = { ...UNLINKED_PANEL, can: { link: false, unlink: false, importCapacity: false } };

export function panelBinding(overrides: Partial<FlowPanelBinding> = {}): FlowPanelBinding {
  return {
    id: 5,
    connectionId: 1,
    connectionName: "Acme Flow",
    flowTeamId: 12,
    flowTeamName: "Payments Flow",
    connectionEnabled: true,
    status: { state: "CURRENT", lastRun: null, lastSucceededAt: Date.UTC(2026, 10, 8, 9, 40), consecutiveFailures: 0, nextPollAt: null },
    observedAt: Date.UTC(2026, 10, 8, 9, 40),
    gone: false,
    ...overrides,
  };
}

/** A linked team: two current members, one former, 33 sprints, the next on 2026-11-09. */
export function linkedPanel(overrides: Partial<FlowTeamPanel> = {}): FlowTeamPanel {
  return {
    ...UNLINKED_PANEL,
    binding: panelBinding(),
    roster: {
      current: [
        { displayName: "Ada Lovelace", since: "2026-01-05" },
        { displayName: "Unknown account", since: "2026-03-02" },
      ],
      former: [{ displayName: "Grace Hopper", from: "2025-02-03", to: "2026-04-01" }],
    },
    sprints: { count: 33, nextStart: "2026-11-09" },
    ...overrides,
  };
}

export function previewItem(overrides: Partial<CapacityPreviewItem> = {}): CapacityPreviewItem {
  return {
    sprintId: 101,
    name: "Sprint 101",
    state: "future",
    start: "2026-11-09",
    end: "2026-11-20",
    effectiveFrom: "2026-11-09",
    workingDays: 10,
    flowMd: 40,
    mdPerWeek: 20,
    action: "CREATE",
    reason: null,
    infos: [],
    ticked: true,
    existing: null,
    ...overrides,
  };
}

/** One of every row kind: a CREATE and an UPDATE (ticked), a ZERO_CAPACITY CREATE (unticked), a MANUAL_PERIOD, a SKIP, an UNCHANGED; plus one removal. */
export const PREVIEW: CapacityPreview = {
  bindingId: 5,
  teamId: 1,
  observedAt: Date.UTC(2026, 10, 8, 9, 40),
  zone: "Europe/Warsaw",
  from: "2026-11-08",
  includeClosed: false,
  totals: { create: 2, update: 1, unchanged: 1, skip: 2, removals: 1 },
  items: [
    previewItem({ sprintId: 101, name: "Sprint 101" }),
    previewItem({
      sprintId: 102,
      name: "Sprint 102",
      start: "2026-11-23",
      end: "2026-12-04",
      effectiveFrom: "2026-11-23",
      flowMd: 36,
      mdPerWeek: 18,
      action: "UPDATE",
      infos: [{ code: "MANUAL_PERIOD_INSIDE", date: "2026-11-30" }],
      existing: { periodId: 31, mdPerWeek: 16, source: "FLOW" },
    }),
    previewItem({ sprintId: 103, name: "Sprint 103", start: "2026-12-07", end: "2026-12-18", effectiveFrom: "2026-12-07", flowMd: 0, mdPerWeek: 0, infos: [{ code: "ZERO_CAPACITY", date: null }], ticked: false }),
    previewItem({ sprintId: 104, name: "Sprint 104", start: "2027-01-04", end: "2027-01-15", effectiveFrom: "2027-01-04", action: "MANUAL_PERIOD", ticked: false, existing: { periodId: 32, mdPerWeek: 12, source: "MANUAL" } }),
    previewItem({ sprintId: 105, name: "Sprint 105", start: null, end: null, effectiveFrom: null, workingDays: null, flowMd: null, mdPerWeek: null, action: "SKIP", reason: "NO_DATES", ticked: false }),
    previewItem({ sprintId: 106, name: "Sprint 106", start: "2027-01-18", end: "2027-01-29", effectiveFrom: "2027-01-18", action: "UNCHANGED", ticked: false, existing: { periodId: 33, mdPerWeek: 20, source: "FLOW" } }),
  ],
  removals: [{ periodId: 34, effectiveFrom: "2026-10-12", mdPerWeek: 15, flowSprintId: 90, flowSprintName: "Sprint 90" }],
};

export const APPLIED: CapacityApplyResponse = { created: [{ periodId: 40, sprintId: 101 }], updated: [{ periodId: 31, sprintId: 102 }], deleted: [], skipped: [] };

const READ_AT = Date.UTC(2026, 10, 8, 9, 40);

/** A Flow connection as the capacity deviations document lists it: enabled, CURRENT, read at 2026-11-08 09:40 UTC. */
export const CAPACITY_CONNECTION: CapacityDeviationConnection = {
  id: 1,
  name: "Acme Flow",
  enabled: true,
  teamsAt: READ_AT,
  status: {
    state: "CURRENT",
    lastRun: { id: 7, startedAt: READ_AT, finishedAt: READ_AT + 60_000, outcome: "SUCCEEDED", errorCode: null, trigger: "MANUAL", running: false },
    lastSucceededAt: READ_AT,
    consecutiveFailures: 0,
    nextPollAt: READ_AT + 60 * 60_000,
  },
};

type DeviationDetail = CapacityDeviation["detail"];
const NO_DETAIL: DeviationDetail = { sprintId: null, sprintName: null, start: null, end: null, effectiveFrom: null, workingDays: null, flowMd: null, flowTotalMd: null, planMd: null, gapMd: null };

/** A 64-hex fingerprint stand-in for a fixture row, distinct per [seed] (the server's is a SHA-256 of the row). */
const fingerprintOf = (seed: number): string => (seed + 1).toString(16).padStart(64, "0");

/** `CAPACITY_DIFFERS` for the e2e world's second sprint: the plan has 36.00, Flow 30.00 (a WARNING, +6.00); pass `planMd`/`flowMd` to move the figures (the gap and the severity follow). */
export function differsRow(over: Partial<DeviationDetail> = {}): CapacityDeviation {
  const detail: DeviationDetail = { ...NO_DETAIL, sprintId: 90002, sprintName: "E2E Flow Sprint 2", start: "2047-01-21", end: "2047-02-01", effectiveFrom: "2047-01-21", workingDays: 10, flowMd: 30, flowTotalMd: 30, planMd: 36, ...over };
  const gapMd = over.gapMd ?? Math.round(((detail.planMd ?? 0) - (detail.flowMd ?? 0)) * 100) / 100;
  return { kind: "CAPACITY_DIFFERS", severity: gapMd > 0 ? "WARNING" : "INFO", detail: { ...detail, gapMd }, fingerprint: fingerprintOf(detail.sprintId ?? 0), acknowledgement: null };
}

/** `CAPACITY_MISSING` (an INFO): no capacity in the plan for the sprint that starts on `start` (a two-week sprint), Flow says 40.00. */
export function missingRow(sprintId: number, start: string, end: string, over: Partial<DeviationDetail> = {}): CapacityDeviation {
  return { kind: "CAPACITY_MISSING", severity: "INFO", detail: { ...NO_DETAIL, sprintId, sprintName: `E2E Flow Sprint ${sprintId - 90000}`, start, end, effectiveFrom: start, workingDays: 10, flowMd: 40, flowTotalMd: 40, ...over }, fingerprint: fingerprintOf(sprintId), acknowledgement: null };
}

export const GONE_ROW: CapacityDeviation = { kind: "TEAM_GONE", severity: "WARNING", detail: NO_DETAIL, fingerprint: fingerprintOf(0), acknowledgement: null };

/** Payments, linked to "Payments Flow" on connection 1, with one WARNING sprint unless told otherwise. */
export function capacityItem(over: Partial<CapacityDeviationItem> = {}): CapacityDeviationItem {
  return { bindingId: 5, connectionId: 1, team: { id: 1, name: "Payments" }, flowTeam: { id: 12, name: "Payments Flow" }, observedAt: READ_AT, zone: "Europe/Warsaw", can: { acknowledge: false }, deviations: [differsRow()], ...over };
}

/** The document: totals are counted from the items unless given (as the server counts them, before any cap). */
export function capacityView(over: Partial<CapacityDeviationView> = {}): CapacityDeviationView {
  const items = over.items ?? [capacityItem()];
  const rows = items.flatMap((item) => item.deviations);
  return {
    asOf: "2026-11-08",
    connections: [CAPACITY_CONNECTION],
    totals: { warnings: rows.filter((row) => row.severity === "WARNING").length, infos: rows.filter((row) => row.severity === "INFO").length, gone: rows.filter((row) => row.kind === "TEAM_GONE").length, acknowledged: 0, teams: items.length },
    items,
    truncated: false,
    ...over,
  };
}

/** What a Jira-only stack answers: no Flow connection, so the Deviations page shows no Flow section. */
export const NO_FLOW_VIEW: CapacityDeviationView = capacityView({ connections: [], items: [] });
