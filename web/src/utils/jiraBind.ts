import type { TFunction } from "i18next";
import { ApiError, isDatabaseTimeout, isTimeoutError } from "../api/http";
import { isAlreadyBound, isJiraMappingInvalid, isJiraNotDiscovered, isJiraTokenUnreadable } from "../api/jira";
import { jiraFailure, type JiraFailure, type JiraFailureKeys } from "./jiraFailure";

/** An inline failure of a bind: a fixed localized lead, and the server's own English sentence under it when it adds the specifics (the C8 pattern). */
export type BindFailure = JiraFailure;

/** The bind dialog's status table (`jiraFailure`). */
const BIND_KEYS: JiraFailureKeys = {
  invalid: "jira.bind.error.invalid",
  forbidden: "jira.bind.error.forbidden",
  notFound: "jira.bind.error.gone",
  rateLimited: "jira.bind.error.rateLimited",
  upstream: "jira.bind.error.upstream",
  failedStatus: "jira.bind.error.failedStatus",
};

/**
 * Every answer a bind can give, in words (never `error.message`): 400 (unknown issue, outside the connection's projects, wrong level - the
 * server's sentence names which), 403 (not an owner), 404 (the plan item vanished), 409 `already-bound` (the sentence names the other side),
 * 409 `jira-mapping-invalid` / `jira-not-discovered` / `jira-token-unreadable` (an administrator's to fix), 429 (the per-user bucket) and 502
 * (Jira failed: its code in words).
 */
export function bindFailure(err: unknown, t: TFunction): BindFailure {
  if (isDatabaseTimeout(err)) return { message: t("common.error.timeout") };
  if (isAlreadyBound(err)) return { message: t("jira.bind.error.alreadyBound"), detail: (err as ApiError).detail };
  if (isJiraMappingInvalid(err)) return { message: t("jira.bind.error.mappingInvalid"), detail: (err as ApiError).detail };
  if (isJiraNotDiscovered(err)) return { message: t("jira.bind.error.notDiscovered") };
  if (isJiraTokenUnreadable(err)) return { message: t("jira.bind.error.tokenUnreadable") };
  if (err instanceof ApiError) return jiraFailure(err, t, BIND_KEYS);
  return { message: isTimeoutError(err) ? t("common.error.timeout") : t("jira.bind.error.failed") };
}
