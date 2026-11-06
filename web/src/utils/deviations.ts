import type { TFunction } from "i18next";
import type { Deviation, DeviationConnection, DeviationItem, DeviationKind } from "../api/deviations";
import { runState } from "./syncRuns";

/** The part of an item the phrasing needs besides the deviation itself (the estimate's unit is on Jira's side of the item). */
type Phrased = { jira: Pick<DeviationItem["jira"], "estimateUnit"> };

const UNKNOWN = "unknown";

/** `detail.days` is in working days, POSITIVE = the plan is later; null or 0 is "no usable figure" and reads as a plain "differs". */
function shift(days: number | null): { later: boolean; count: number } | null {
  return days === null || days === 0 ? null : { later: days > 0, count: Math.abs(days) };
}

/** "(plan 2044-03-07, Jira 2044-03-04)" only when BOTH dates are known: a date is never made up from an absent side. */
function datesSuffix(detail: Deviation["detail"], t: TFunction): string {
  return detail.plan !== null && detail.jira !== null ? ` (${t("deviations.phrase.dates", { plan: detail.plan, jira: detail.jira })})` : "";
}

function startOrEnd(kind: "START_DIFFERS" | "END_DIFFERS", detail: Deviation["detail"], t: TFunction): string {
  const moved = shift(detail.days);
  const suffix = datesSuffix(detail, t);
  if (moved === null) return `${t(kind === "START_DIFFERS" ? "deviations.phrase.startDiffers" : "deviations.phrase.endDiffers")}${suffix}`;
  const count = moved.count;
  if (kind === "START_DIFFERS") return `${t(moved.later ? "deviations.phrase.startLater" : "deviations.phrase.startEarlier", { count })}${suffix}`;
  return `${t(moved.later ? "deviations.phrase.endLater" : "deviations.phrase.endEarlier", { count })}${suffix}`;
}

function gone(detail: Deviation["detail"], t: TFunction): string {
  switch (detail.jira) {
    case "OUT_OF_SCOPE":
      return t("deviations.phrase.goneOutOfScope");
    case "DELETED":
      return t("deviations.phrase.goneDeleted");
    case "FORBIDDEN":
      return t("deviations.phrase.goneForbidden");
    default:
      return t("deviations.phrase.gone");
  }
}

function levelMismatch(detail: Deviation["detail"], t: TFunction): string {
  if (detail.plan === null) return t("deviations.phrase.levelMismatchBare");
  if (detail.jira === null || detail.jira === UNKNOWN) return t("deviations.phrase.levelMismatchUnknown", { plan: detail.plan });
  return t("deviations.phrase.levelMismatch", { jira: detail.jira, plan: detail.plan });
}

function parentMismatch(detail: Deviation["detail"], t: TFunction): string {
  if (detail.jira === null) return t("deviations.phrase.parentMismatchBare");
  if (detail.plan === null) return t("deviations.phrase.parentMismatchJira", { jira: detail.jira });
  return t("deviations.phrase.parentMismatch", { jira: detail.jira, plan: detail.plan });
}

/** Two causes share this kind (no conversion declared, or the figure was read under another unit than the mapping names now): the sentence names neither. */
function estimateNotComparable(detail: Deviation["detail"], item: Phrased, t: TFunction): string {
  const jira = detail.jira ?? "?";
  const plan = detail.plan ?? "?";
  const unit = item.jira.estimateUnit;
  return unit == null
    ? t("deviations.phrase.estimateNotComparableBare", { jira, plan })
    : t("deviations.phrase.estimateNotComparable", { jira, plan, unit: t(`deviations.phrase.unit.${unit}`) });
}

function progress(detail: Deviation["detail"], t: TFunction): string {
  if (detail.plan === null) return t("deviations.phrase.progressBare");
  switch (detail.jira) {
    case "DONE":
      return t("deviations.phrase.progressDone", { plan: detail.plan });
    case "TODO":
      return t("deviations.phrase.progressTodo", { plan: detail.plan });
    case "IN_PROGRESS":
      return t("deviations.phrase.progressInProgress", { plan: detail.plan });
    default:
      return t("deviations.phrase.progressBare");
  }
}

/**
 * One deviation as a sentence in the UI language: "Ends 3 working days later than Jira (plan 2044-03-07, Jira 2044-03-04)". Every kind of
 * `DeviationKind` has one; the evidence is the server's `detail` (`days` in WORKING days, positive = the plan is later; the member
 * meanings per kind are in the OpenAPI `DeviationDetail`). A missing member degrades to a plainer sentence, never to an invented value.
 */
export function deviationSentence(deviation: Deviation, item: Phrased, t: TFunction): string {
  const { detail } = deviation;
  switch (deviation.kind) {
    case "GONE":
      return gone(detail, t);
    case "LEVEL_MISMATCH":
      return levelMismatch(detail, t);
    case "PARENT_MISMATCH":
      return parentMismatch(detail, t);
    case "RENAMED":
      return detail.jira === null || detail.plan === null
        ? t("deviations.phrase.renamedBare")
        : t("deviations.phrase.renamed", { jira: detail.jira, plan: detail.plan });
    case "START_DIFFERS":
    case "END_DIFFERS":
      return startOrEnd(deviation.kind, detail, t);
    case "TARGET_DIFFERS":
      // Neutral on purpose: `days` is the end's shift, else the start's, so no count can be put on a named edge; the dates line carries the figures.
      return t("deviations.phrase.targetDiffers");
    case "UNSCHEDULED_IN_PLAN":
      return t("deviations.phrase.unscheduledInPlan");
    case "UNSCHEDULED_IN_JIRA":
      return t("deviations.phrase.unscheduledInJira");
    case "ESTIMATE_DIFFERS":
      return detail.jira === null || detail.plan === null
        ? t("deviations.kind.ESTIMATE_DIFFERS")
        : t("deviations.phrase.estimateDiffers", { jira: detail.jira, plan: detail.plan });
    case "ESTIMATE_NOT_COMPARABLE":
      return estimateNotComparable(detail, item, t);
    case "PROGRESS_MISMATCH":
      return progress(detail, t);
  }
}

/** The short badge word of a kind ("End", "Estimate"). */
export function deviationKindLabel(kind: DeviationKind, t: TFunction): string {
  return t(`deviations.kind.${kind}`);
}

/**
 * The deviations a chip or a row marker counts: WARNING and INFO items of the server's list. `ESTIMATE_NOT_COMPARABLE` is never in a project's
 * or team's list unless asked for explicitly (the server's rule), and is not counted here either way.
 */
export function countDeviations(deviations: readonly Deviation[]): { warnings: number; infos: number } {
  let warnings = 0;
  let infos = 0;
  for (const deviation of deviations) {
    if (deviation.kind === "ESTIMATE_NOT_COMPARABLE") continue;
    if (deviation.severity === "WARNING") warnings += 1;
    else infos += 1;
  }
  return { warnings, infos };
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** "just now" / "5 minutes ago" / "3 hours ago" / "2 days ago" for the moment the server last read an item from Jira. Pure: `now` is passed. */
export function ageText(observedAt: number, now: number, t: TFunction): string {
  const age = Math.max(0, now - observedAt);
  if (age < MINUTE_MS) return t("deviations.observed.justNow");
  if (age < HOUR_MS) return t("deviations.observed.minutes", { count: Math.floor(age / MINUTE_MS) });
  if (age < DAY_MS) return t("deviations.observed.hours", { count: Math.floor(age / HOUR_MS) });
  return t("deviations.observed.days", { count: Math.floor(age / DAY_MS) });
}

/**
 * Whether what a connection's items show may be out of date: it is disabled, its mapping does not fit the site (no level or estimate is compared),
 * or its newest run is missing or did not succeed (failed, abandoned, interrupted; a running one is not stale yet).
 */
export function staleConnection(connection: DeviationConnection): boolean {
  if (!connection.enabled || !connection.mappingOk || connection.lastRun === null) return true;
  const state = runState(connection.lastRun);
  return state === "failed" || state === "abandoned" || state === "interrupted";
}

/** True when an ENABLED connection is stale (a disabled one has its own note): the list may be out of date. */
export function hasStaleSource(connections: readonly DeviationConnection[]): boolean {
  return connections.some((connection) => connection.enabled && staleConnection(connection));
}

/**
 * When an empty list may be called "no deviations in the data read at T": the OLDEST finish among the connections' newest runs, and only when
 * there is a connection and none is stale (every one enabled, its mapping fitting and its newest run SUCCEEDED). A disabled connection may hold
 * bindings nobody refreshes, so one anywhere withholds the claim. There is no scheduler in 1.1, so the claim is dated, never in the present tense.
 */
export function verifiedAt(connections: readonly DeviationConnection[]): number | null {
  if (connections.length === 0 || connections.some((connection) => staleConnection(connection) || connection.lastRun?.outcome !== "SUCCEEDED")) return null;
  return Math.min(...connections.map((connection) => connection.lastRun?.finishedAt ?? connection.lastRun?.startedAt ?? 0));
}
