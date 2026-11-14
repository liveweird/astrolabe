import type { TFunction } from "i18next";
import { ApiError } from "../api/http";
import { isJiraMappingInvalid, isJiraNotDiscovered, isJiraRootUnusable, isJiraTokenUnreadable, type JiraImportItem, type JiraImportSkipReason } from "../api/jira";
import { upstreamCode } from "./jiraBind";

// The import modal's sentences: every skip reason and info in words (never the raw enum), and every failure of the two calls.

/** A skip (or `CHANGED`) in words. `holder` names the plan item an ALREADY_BOUND row is linked to, when the preview knows it. */
export function reasonText(reason: JiraImportSkipReason, t: TFunction, holder?: string): string {
  switch (reason) {
    case "ALREADY_BOUND":
      return holder ? t("jira.import.reason.alreadyBoundTo", { name: holder }) : t("jira.import.reason.alreadyBound");
    case "NO_PARENT":
      return t("jira.import.reason.noParent");
    case "NAME_TAKEN":
      return t("jira.import.reason.nameTaken");
    case "LEVEL_UNMAPPED":
      return t("jira.import.reason.levelUnmapped");
    case "NO_TEAM":
      return t("jira.import.reason.noTeam");
    case "PARENT_SKIPPED":
      return t("jira.import.reason.parentSkipped");
    case "OUTSIDE_ROOT":
      return t("jira.import.reason.outsideRoot");
    case "CHANGED":
      return t("jira.import.reason.changed");
  }
}

type Info = JiraImportItem["infos"][number];

/** A preview note in words. (With "Copy Jira's dates" off the dates line says so; the server only reports DATES_NOT_COPIED for rights.) */
export function infoText(info: Info, t: TFunction): string {
  switch (info) {
    case "NAME_TRUNCATED":
      return t("jira.import.info.nameTruncated");
    case "ESTIMATE_NOT_CONVERTED":
      return t("jira.import.info.estimateNotConverted");
    case "DATES_NOT_COPIED":
      return t("jira.import.info.datesNotManaged");
    case "DATES_INVALID":
      return t("jira.import.info.datesInvalid");
    case "NO_WORKING_DAY":
      return t("jira.import.info.noWorkingDay");
    case "TARGET_NOT_COPIED":
      return t("jira.import.info.targetNotCopied");
    case "KEPT_AS_PARENT":
      return t("jira.import.info.keptAsParent");
    case "PARENT_UNREADABLE":
      return t("jira.import.info.parentUnreadable");
    case "MATCH_CONFIRMED":
      return t("jira.import.info.matchConfirmed");
  }
}

/** An inline failure: a fixed localized lead, the server's own sentence under it when that adds the specifics, and whether a new preview is the way on. */
export type ImportFailure = { message: string; detail?: string; repreview: boolean };

/**
 * Whether an APPLY that failed this way may nevertheless have been written: the client's own 180 s abort, a failure with no server answer at
 * all (the connection dropped; not an `ApiError`), or a 5xx other than the server's own 502 (a refusal of Jira's side, raised before any write).
 */
export function applyMayHaveLanded(err: unknown, timedOut: boolean): boolean {
  return timedOut || !(err instanceof ApiError) || (err.status >= 500 && err.status !== 502);
}

/**
 * Every answer the two calls can give, in words (never `error.message`). `null` = the user cancelled a preview: nothing to say. A client
 * abort (`timedOut`, the 180 s mark) is told apart, and for the APPLY so is any answer that leaves the write in doubt (`applyMayHaveLanded`). 409 in the apply
 * (the mapping or discovery changed while the import was read, or a name was taken at the last moment) rolls back whole: preview again.
 */
export function importFailure(err: unknown, t: TFunction, ctx: { apply: boolean; timedOut: boolean; cancelled: boolean }): ImportFailure | null {
  if (ctx.cancelled) return null;
  if (ctx.apply && applyMayHaveLanded(err, ctx.timedOut)) return { message: t("jira.import.error.timeoutApply"), repreview: true };
  if (ctx.timedOut) return { message: t("jira.import.error.timeoutPreview"), repreview: true };
  if (!(err instanceof ApiError)) return { message: t("jira.import.error.failed"), repreview: false };
  if (isJiraMappingInvalid(err)) return { message: t(ctx.apply ? "jira.import.error.mappingChanged" : "jira.import.error.mappingInvalid"), detail: err.detail, repreview: ctx.apply };
  if (isJiraNotDiscovered(err)) return { message: t("jira.import.error.notDiscovered"), repreview: false };
  if (isJiraTokenUnreadable(err)) return { message: t("jira.import.error.tokenUnreadable"), repreview: false };
  if (isJiraRootUnusable(err)) return { message: t("jira.import.error.rootUnusable"), repreview: false };
  switch (err.status) {
    case 400:
      return { message: t("jira.import.error.invalid"), detail: err.detail, repreview: ctx.apply };
    case 403:
      return { message: t("jira.import.error.forbidden"), detail: err.detail, repreview: false };
    case 404:
      return { message: t("jira.import.error.gone"), detail: err.detail, repreview: false };
    case 409:
      return { message: t("jira.import.error.conflict"), repreview: ctx.apply };
    case 429:
      return { message: t("jira.import.error.rateLimited"), repreview: false };
    case 502:
      return { message: t("jira.import.error.upstream"), detail: upstreamCode(err.detail, t), repreview: false };
    default:
      return { message: t("jira.import.error.failedStatus", { status: err.status }), repreview: false };
  }
}
