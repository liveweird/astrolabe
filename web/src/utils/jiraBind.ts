import type { TFunction } from "i18next";
import { ApiError, isTimeoutError } from "../api/http";
import { isAlreadyBound, isJiraMappingInvalid, isJiraNotDiscovered, isJiraTokenUnreadable } from "../api/jira";
import { errorCodeText } from "./syncRuns";

/** An inline failure of a bind: a fixed localized lead, and the server's own English sentence under it when it adds the specifics (the C8 pattern). */
export type BindFailure = { message: string; detail?: string };

/** "Jira did not answer (AUTHENTICATION_FAILED)": only the code is lifted out and put in words. */
function upstreamCode(detail: string | undefined, t: TFunction): string | undefined {
  const code = /\(([A-Z_]+)\)/.exec(detail ?? "")?.[1];
  return code === undefined ? undefined : errorCodeText(code, t);
}

/**
 * Every answer a bind can give, in words (never `error.message`): 400 (unknown issue, outside the connection's projects, wrong level - the
 * server's sentence names which), 403 (not an owner), 404 (the plan item vanished), 409 `already-bound` (the sentence names the other side),
 * 409 `jira-mapping-invalid` / `jira-not-discovered` / `jira-token-unreadable` (an administrator's to fix), 429 (the per-user bucket) and 502
 * (Jira failed: its code in words).
 */
export function bindFailure(err: unknown, t: TFunction): BindFailure {
  if (isAlreadyBound(err)) return { message: t("jira.bind.error.alreadyBound"), detail: (err as ApiError).detail };
  if (isJiraMappingInvalid(err)) return { message: t("jira.bind.error.mappingInvalid"), detail: (err as ApiError).detail };
  if (isJiraNotDiscovered(err)) return { message: t("jira.bind.error.notDiscovered") };
  if (isJiraTokenUnreadable(err)) return { message: t("jira.bind.error.tokenUnreadable") };
  if (err instanceof ApiError) {
    switch (err.status) {
      case 400:
        return { message: t("jira.bind.error.invalid"), detail: err.detail };
      case 403:
        return { message: t("jira.bind.error.forbidden") };
      case 404:
        return { message: t("jira.bind.error.gone") };
      case 429:
        return { message: t("jira.bind.error.rateLimited") };
      case 502:
        return { message: t("jira.bind.error.upstream"), detail: upstreamCode(err.detail, t) };
      default:
        return { message: t("jira.bind.error.failedStatus", { status: err.status }) };
    }
  }
  return { message: isTimeoutError(err) ? t("common.error.timeout") : t("jira.bind.error.failed") };
}
