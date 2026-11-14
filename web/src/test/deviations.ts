// Shared fixtures for the Deviations page, the chips and the bind dialog: a deviations document, an item and its connection.
import type { SyncState } from "../api/sync";
import type { Deviation, DeviationConnection, DeviationItem, DeviationLine, DeviationView } from "../api/deviations";

const OBSERVED_AT = Date.UTC(2026, 10, 6, 10, 0);
/** "Now" for the age wording: five minutes after the observation. */
export const NOW = OBSERVED_AT + 5 * 60_000;

type LastRun = NonNullable<DeviationConnection["lastRun"]>;

const succeededRun = (over: Partial<LastRun> = {}): LastRun => ({
  id: 9,
  startedAt: OBSERVED_AT,
  finishedAt: OBSERVED_AT + 60_000,
  outcome: "SUCCEEDED",
  errorCode: null,
  trigger: "MANUAL",
  running: false,
  ...over,
});

const DEV_LAST_RUN = succeededRun();

/**
 * The shapes a connection takes: the five derived states, the three runs in flight and the two other ways a newest run fails (abandoned by a later
 * claim; unfinished and no longer running, i.e. interrupted: the server counts both like a failure). A run in flight does not move the server's state by
 * itself (`SyncStatusKernels.derive`): a first run still reads NEVER_SYNCED, a retry after a failure FAILED, a routine refresh on a good
 * connection CURRENT.
 */
type ConnectionShape = SyncState | "NEVER_SYNCED_RUNNING" | "FAILED_RUNNING" | "CURRENT_RUNNING" | "FAILED_ABANDONED" | "FAILED_INTERRUPTED";

const runningRun = (): LastRun => succeededRun({ id: 11, startedAt: OBSERVED_AT + 3_600_000, finishedAt: null, outcome: null, running: true });

/**
 * A connection as the SERVER derives it for each shape: `enabled`, `lastRun` and every member of `status` (`state`, `lastRun`, `lastSucceededAt`,
 * `consecutiveFailures`) agree, so a staleness case built on it tests the rule the page reads. A fixture that overrides `lastRun` alone proves
 * nothing since 1.17 (the rule reads `status.state`): the identity members stay the caller's, the run state never.
 */
export function connectionIn(shape: ConnectionShape, over: Partial<Omit<DeviationConnection, "enabled" | "lastRun" | "status">> = {}): DeviationConnection {
  const failed = succeededRun({ id: 10, outcome: "FAILED", errorCode: "TIMEOUT" });
  const base = { id: 1, name: "Acme Jira", siteUrl: "https://acme.atlassian.net", projectKeys: ["E2E"], mappingOk: true, ...over };
  const connection = (enabled: boolean, lastRun: LastRun | null, status: Omit<DeviationConnection["status"], "lastRun">): DeviationConnection => ({
    ...base,
    enabled,
    lastRun,
    status: { ...status, lastRun },
  });
  const nextPollAt = OBSERVED_AT + 15 * 60_000;
  switch (shape) {
    case "CURRENT":
      return connection(true, DEV_LAST_RUN, { state: "CURRENT", lastSucceededAt: OBSERVED_AT, consecutiveFailures: 0, nextPollAt });
    case "CURRENT_RUNNING":
      return connection(true, runningRun(), { state: "CURRENT", lastSucceededAt: OBSERVED_AT, consecutiveFailures: 0, nextPollAt: null });
    case "STALE":
      return connection(true, DEV_LAST_RUN, { state: "STALE", lastSucceededAt: OBSERVED_AT, consecutiveFailures: 0, nextPollAt: OBSERVED_AT });
    case "NEVER_SYNCED":
      return connection(true, null, { state: "NEVER_SYNCED", lastSucceededAt: null, consecutiveFailures: 0, nextPollAt: OBSERVED_AT });
    case "NEVER_SYNCED_RUNNING":
      return connection(true, runningRun(), { state: "NEVER_SYNCED", lastSucceededAt: null, consecutiveFailures: 0, nextPollAt: null });
    case "FAILED":
      return connection(true, failed, { state: "FAILED", lastSucceededAt: null, consecutiveFailures: 1, nextPollAt: OBSERVED_AT });
    case "FAILED_RUNNING":
      return connection(true, runningRun(), { state: "FAILED", lastSucceededAt: null, consecutiveFailures: 1, nextPollAt: null });
    case "FAILED_ABANDONED":
      return connection(true, succeededRun({ id: 12, outcome: "ABANDONED" }), { state: "FAILED", lastSucceededAt: null, consecutiveFailures: 1, nextPollAt: OBSERVED_AT });
    case "FAILED_INTERRUPTED":
      return connection(true, succeededRun({ id: 13, finishedAt: null, outcome: null }), { state: "FAILED", lastSucceededAt: null, consecutiveFailures: 1, nextPollAt: OBSERVED_AT });
    case "DISABLED":
      return connection(false, DEV_LAST_RUN, { state: "DISABLED", lastSucceededAt: OBSERVED_AT, consecutiveFailures: 0, nextPollAt: null });
  }
}

export const DEV_CONNECTION: DeviationConnection = connectionIn("CURRENT");

/** A flag's evidence as the server sends it since 1.15: the deviation's kind and detail, no severity (the flag's own is the severity). */
export const evidence = (deviation: Pick<Deviation, "kind" | "detail">): { kind: Deviation["kind"]; detail: Deviation["detail"] } => ({
  kind: deviation.kind,
  detail: deviation.detail,
});

/** A detail as the server sends it since 1.15: only the members that apply are present (absent, never null). */
export const detail = (over: Deviation["detail"] = {}): Deviation["detail"] => ({ ...over });

export const endLater = (days: number): DeviationLine => ({
  kind: "END_DIFFERS",
  severity: days > 0 ? "WARNING" : "INFO",
  detail: detail({ jira: "2044-03-04", plan: "2044-03-07", days }),
  acknowledgement: null,
});

/** Further lines for the items that carry more than one: "Starts 1 working day earlier" (INFO) and "Named differently" (INFO). */
export const startEarlier = (): DeviationLine => ({ kind: "START_DIFFERS", severity: "INFO", detail: detail({ jira: "2044-03-01", plan: "2044-02-29", days: -1 }), acknowledgement: null });
export const renamed = (): DeviationLine => ({ kind: "RENAMED", severity: "INFO", detail: detail({ jira: "Checkout", plan: "Checkout page" }), acknowledgement: null });

/** A line stamped by Ada Lovelace on 2026-11-06 (UTC); `over` makes it stale (`current: false`) or nameless (`by: null`). */
export const stamped = (line: DeviationLine, over: Partial<NonNullable<DeviationLine["acknowledgement"]>> = {}): DeviationLine => ({
  ...line,
  acknowledgement: { at: Date.UTC(2026, 10, 6, 12, 30), by: "Ada Lovelace", current: true, ...over },
});

export function item(over: Partial<DeviationItem> = {}): DeviationItem {
  return {
    bindingId: 1,
    connectionId: 1,
    level: "MILESTONE",
    node: {
      kind: "MILESTONE",
      id: 11,
      name: "Checkout page",
      projectId: 7,
      projectName: "Invoices",
      programId: 70,
      programName: "Billing",
      workStreamId: 700,
      workStreamName: "Platform",
      teamId: 3,
      teamName: "Backend",
    },
    jira: {
      issueId: "10001",
      key: "E2E-3",
      previousKey: null,
      url: "https://acme.atlassian.net/browse/E2E-3",
      summary: "Checkout page epic",
      typeName: "Epic",
      hierarchyLevel: 1,
      statusName: "In Progress",
      statusCategory: "IN_PROGRESS",
      start: "2044-03-01",
      end: "2044-03-04",
      estimate: 5,
      estimateUnit: "POINTS",
      parentKey: null,
      teamName: null,
      observedAt: OBSERVED_AT,
      gone: false,
      rollup: null,
    },
    plan: { start: "2044-03-01", end: "2044-03-07", estimateMd: 5, targetStart: null, targetEnd: null, spanStart: null, spanEnd: null },
    deviations: [endLater(3)],
    fingerprint: "a".repeat(64),
    acknowledgement: null,
    can: { acknowledge: false },
    ...over,
  };
}

export function view(over: Partial<DeviationView> = {}): DeviationView {
  const items = over.items ?? [item()];
  const deviations = items.flatMap((i) => i.deviations);
  return {
    revision: 5,
    asOf: "2026-11-06",
    connections: [DEV_CONNECTION],
    totals: {
      warnings: deviations.filter((d) => d.severity === "WARNING").length,
      infos: deviations.filter((d) => d.severity === "INFO").length,
      bindings: items.length,
      gone: items.filter((i) => i.jira.gone).length,
      stillInJira: items.filter((i) => i.jira.gone && i.deviations.some((d) => d.kind === "GONE" && (d.detail.jira === "MOVED_OUT" || d.detail.jira === "NOT_LISTED"))).length,
      acknowledged: items.filter((i) => i.deviations.some((line) => line.acknowledgement?.current)).length,
    },
    items,
    truncated: false,
    ...over,
  };
}
