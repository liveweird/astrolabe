import type { ParseKeys, TFunction } from "i18next";
import type { ApiError } from "../api/http";
import { errorCodeText } from "./syncRuns";

/** An inline failure: a fixed localized lead, and a second line under it when there is one (the server's own sentence, or Jira's failure code in words). */
export type JiraFailure = { message: string; detail?: string };

/** The status table of one Jira dialog. A status without a key (and every other status) reads `failedStatus`, which interpolates `{{status}}`. */
export interface JiraFailureKeys {
  /** 400 - the server's sentence under it (it says which rule). */
  invalid?: ParseKeys;
  forbidden?: ParseKeys;
  notFound?: ParseKeys;
  conflict?: ParseKeys;
  rateLimited?: ParseKeys;
  /** 502 - Jira failed: its code in words under the lead. */
  upstream?: ParseKeys;
  failedStatus: ParseKeys;
  /** The statuses whose answer carries the server's own sentence as `detail`; 400 alone when omitted. */
  detailFor?: readonly number[];
}

/** "Jira did not answer (AUTHENTICATION_FAILED)": only the code is lifted out and put in words. */
function upstreamCode(detail: string | undefined, t: TFunction): string | undefined {
  const code = /\(([A-Z_]+)\)/.exec(detail ?? "")?.[1];
  return code === undefined ? undefined : errorCodeText(code, t);
}

const KEY_OF: Partial<Record<number, "invalid" | "forbidden" | "notFound" | "conflict" | "rateLimited" | "upstream">> = {
  400: "invalid",
  403: "forbidden",
  404: "notFound",
  409: "conflict",
  429: "rateLimited",
  502: "upstream",
};

/**
 * The status table the three Jira dialogs (bind, import, Peek) share, in words (never `error.message`). The problem-type branches and each
 * dialog's own preamble stay with the dialog; this maps one `ApiError` by status through that dialog's keys. A keyed status carries `detail`
 * (the key present even when the server sent none) only where the table asks for it; the 502 always carries Jira's code in words.
 */
export function jiraFailure(err: ApiError, t: TFunction, keys: JiraFailureKeys): JiraFailure {
  const field = KEY_OF[err.status];
  const key = field === undefined ? undefined : keys[field];
  if (key === undefined) return { message: t(keys.failedStatus, { status: err.status }) };
  if (err.status === 502) return { message: t(key), detail: upstreamCode(err.detail, t) };
  return (keys.detailFor ?? [400]).includes(err.status) ? { message: t(key), detail: err.detail } : { message: t(key) };
}
