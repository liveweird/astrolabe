import type { TFunction } from "i18next";
import type { CapacityDeviation, CapacityDeviationConnection, CapacityDeviationKind } from "../api/capacityDeviations";

type Detail = CapacityDeviation["detail"];

/** Man-days the way the whole app shows them: two decimals, a dot (never a locale's separator - the figures must read the same in a test and in the e2e). */
export const formatMd = (md: number): string => md.toFixed(2);

/** "E2E Flow Sprint 2 (2047-01-21 – 2047-02-01)": Flow's own sprint name, then its dates when both are known; an unnamed sprint reads by its id. */
export function sprintLabel(detail: Detail, t: TFunction): string {
  const name = detail.sprintName ?? (detail.sprintId === null ? t("deviations.capacity.unnamedSprint") : t("deviations.capacity.sprintId", { id: detail.sprintId }));
  return detail.start !== null && detail.end !== null ? `${name} (${detail.start} – ${detail.end})` : name;
}

/** The short badge word of a kind ("Capacity", "No capacity", "Gone from Flow"). */
export function capacityKindLabel(kind: CapacityDeviationKind, t: TFunction): string {
  return t(`deviations.kind.${kind}`);
}

/** `flowTotalMd` is Flow's total for the whole sprint; it differs from `flowMd` (the share that falls on the days the sprint holds in the plan) for a fixed per-sprint figure that shares days with an earlier sprint. */
function sharesDays(flowMd: number, flowTotalMd: number | null): flowTotalMd is number {
  return flowTotalMd !== null && formatMd(flowTotalMd) !== formatMd(flowMd);
}

function differs(detail: Detail, t: TFunction): string {
  const { planMd, flowMd, gapMd, flowTotalMd } = detail;
  if (planMd === null || flowMd === null || gapMd === null) return t("deviations.kind.CAPACITY_DIFFERS");
  const base = t(gapMd > 0 ? "deviations.capacity.differsMore" : "deviations.capacity.differsLess", {
    sprint: sprintLabel(detail, t),
    plan: formatMd(planMd),
    flow: formatMd(flowMd),
    gap: formatMd(Math.abs(gapMd)),
  });
  return sharesDays(flowMd, flowTotalMd) ? `${base}. ${t("deviations.capacity.fixedFigure", { total: formatMd(flowTotalMd), flow: formatMd(flowMd) })}` : base;
}

function missing(detail: Detail, t: TFunction): string {
  const sprint = sprintLabel(detail, t);
  return detail.flowMd === null ? t("deviations.capacity.missingBare", { sprint }) : t("deviations.capacity.missing", { sprint, flow: formatMd(detail.flowMd) });
}

/**
 * One capacity deviation as a sentence in the UI language: "E2E Flow Sprint 2 (2047-01-21 – 2047-02-01): the plan has 36.00 man-days, Flow 30.00 —
 * 6.00 more in the plan". `gapMd` is POSITIVE when the plan has MORE; a fixed per-sprint figure that shares days adds Flow's whole-sprint total. A
 * missing figure degrades to the plain kind label, never to an invented number.
 */
export function capacityDeviationSentence(deviation: CapacityDeviation, t: TFunction): string {
  switch (deviation.kind) {
    case "CAPACITY_DIFFERS":
      return differs(deviation.detail, t);
    case "CAPACITY_MISSING":
      return missing(deviation.detail, t);
    case "TEAM_GONE":
      return t("deviations.capacity.gone");
  }
}

/** What a team's rows come to: the sprints that differ (and how many of them the plan has MORE for), the sprints without capacity, and whether the Flow team is gone. */
export function countCapacityDeviations(deviations: readonly CapacityDeviation[]): { differs: number; warnings: number; missing: number; gone: boolean } {
  let differsCount = 0;
  let warnings = 0;
  let missingCount = 0;
  let gone = false;
  for (const deviation of deviations) {
    if (deviation.kind === "CAPACITY_DIFFERS") {
      differsCount += 1;
      if (deviation.severity === "WARNING") warnings += 1;
    } else if (deviation.kind === "CAPACITY_MISSING") missingCount += 1;
    else gone = true;
  }
  return { differs: differsCount, warnings, missing: missingCount, gone };
}

/** One line of a team's list: a sentence of its own, or the sprints without capacity folded into one ("6 sprints without capacity in the plan, from 2047-01-07"). */
export type CapacityEntry =
  | { type: "row"; key: string; deviation: CapacityDeviation }
  | { type: "missing"; key: string; rows: readonly CapacityDeviation[]; from: string | null };

/**
 * A team's rows as the lines the UI lists: the Flow team gone, then the sprints whose figures differ (the server's order, by date), the sprints
 * without capacity folded into ONE entry at the place of the first of them, and the warnings before the infos (a stable sort, so the part of the list a
 * limit cuts off is the quiet one). `from` is the first day any of the folded sprints holds.
 */
export function capacityEntries(deviations: readonly CapacityDeviation[]): CapacityEntry[] {
  const entries: CapacityEntry[] = [];
  const missingRows = deviations.filter((deviation) => deviation.kind === "CAPACITY_MISSING");
  let folded = false;
  for (const deviation of deviations) {
    if (deviation.kind !== "CAPACITY_MISSING") {
      entries.push({ type: "row", key: `${deviation.kind}:${deviation.detail.sprintId ?? "team"}`, deviation });
    } else if (!folded) {
      folded = true;
      const days = missingRows.map((row) => row.detail.effectiveFrom ?? row.detail.start).filter((day): day is string => day !== null);
      entries.push({ type: "missing", key: "missing", rows: missingRows, from: days.length === 0 ? null : days.reduce((a, b) => (a <= b ? a : b)) });
    }
  }
  const rank = (entry: CapacityEntry) => (entry.type === "row" && entry.deviation.severity === "WARNING" ? 0 : 1);
  return entries.sort((a, b) => rank(a) - rank(b));
}

/**
 * Whether what a connection's teams show may be out of date: it is disabled, or its derived state is anything but CURRENT (never synced, failed,
 * stale). The Jira rule without the mapping, read off the server's `status` (nothing is judged on the client's clock).
 */
export function staleFlowConnection(connection: Pick<CapacityDeviationConnection, "enabled" | "status">): boolean {
  return !connection.enabled || connection.status.state !== "CURRENT";
}

/** True when an ENABLED connection is stale (a disabled one has its own note): the section may be out of date. */
export function hasStaleFlowSource(connections: readonly CapacityDeviationConnection[]): boolean {
  return connections.some((connection) => connection.enabled && staleFlowConnection(connection));
}

/**
 * When an empty section may be called "in line with Flow in the data read at T": the OLDEST successful run's start among the connections, and only when
 * there is a connection and none is stale (a disabled one may hold teams nobody refreshes, so one anywhere withholds the claim). The claim is dated,
 * never in the present tense.
 */
export function verifiedFlowAt(connections: readonly CapacityDeviationConnection[]): number | null {
  if (connections.length === 0 || connections.some((connection) => staleFlowConnection(connection) || connection.status.lastSucceededAt === null)) return null;
  return Math.min(...connections.map((connection) => connection.status.lastSucceededAt ?? 0));
}
