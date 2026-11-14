// Shared fixtures for the Deviations page, the chips and the bind dialog: a deviations document, an item and its connection.
import type { Deviation, DeviationConnection, DeviationItem, DeviationLine, DeviationView } from "../api/deviations";

const OBSERVED_AT = Date.UTC(2026, 10, 6, 10, 0);
/** "Now" for the age wording: five minutes after the observation. */
export const NOW = OBSERVED_AT + 5 * 60_000;

const DEV_LAST_RUN: NonNullable<DeviationConnection["lastRun"]> = {
  id: 9,
  startedAt: OBSERVED_AT,
  finishedAt: OBSERVED_AT + 60_000,
  outcome: "SUCCEEDED",
  errorCode: null,
  trigger: "MANUAL",
  running: false,
};

export const DEV_CONNECTION: DeviationConnection = {
  id: 1,
  name: "Acme Jira",
  siteUrl: "https://acme.atlassian.net",
  enabled: true,
  projectKeys: ["E2E"],
  mappingOk: true,
  lastRun: DEV_LAST_RUN,
  status: { state: "CURRENT", lastRun: DEV_LAST_RUN, lastSucceededAt: OBSERVED_AT, consecutiveFailures: 0, nextPollAt: OBSERVED_AT + 15 * 60_000 },
};

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
