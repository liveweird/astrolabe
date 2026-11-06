import type { ParseKeys, TFunction } from "i18next";
import type { SyncOutcome } from "../api/sync";

/** The poll period while a run is running. */
export const RUN_POLL_MS = 3_000;

/**
 * The page-side safety net of the poll: it stops this long after the page first saw a given run running, whatever the server keeps
 * saying (a server that never ends a run's `running` must not keep a tab polling for ever). The server's `running` verdict is what
 * normally ends it.
 */
export const RUN_POLL_MAX_MS = 10 * 60_000;

export type RunState = "running" | "interrupted" | "succeeded" | "failed" | "abandoned";

/** What a run row or a connection's `lastRun` carries of its state: the outcome, and the SERVER's `running` verdict. */
type RunLike = { outcome?: SyncOutcome | null; running: boolean };

/**
 * What a run says now. The outcome when it has one; otherwise the server's `running` verdict: running, or interrupted (unfinished and
 * past the server's claim window, so nothing is working on it). The client never judges a run's age by its own clock.
 */
export function runState(run: RunLike): RunState {
  switch (run.outcome) {
    case "SUCCEEDED":
      return "succeeded";
    case "FAILED":
      return "failed";
    case "ABANDONED":
      return "abandoned";
    default:
      return run.running ? "running" : "interrupted";
  }
}

/** The colour of a run state: green = success, red = failed, orange = it did not finish (abandoned / interrupted), gray = still running. */
export const RUN_STATE_COLOR: Record<RunState, string> = {
  succeeded: "green",
  failed: "red",
  abandoned: "orange",
  interrupted: "orange",
  running: "gray",
};

/** The failure codes a probe row or a run row can carry (Jira's fetch vocabulary plus the run's and the probes' own), with their EN/PL sentence. */
const ERROR_CODE_KEYS = {
  AUTHENTICATION_FAILED: "jira.errorCode.AUTHENTICATION_FAILED",
  FORBIDDEN_SCOPE: "jira.errorCode.FORBIDDEN_SCOPE",
  NOT_FOUND: "jira.errorCode.NOT_FOUND",
  RATE_LIMITED: "jira.errorCode.RATE_LIMITED",
  UPSTREAM_UNAVAILABLE: "jira.errorCode.UPSTREAM_UNAVAILABLE",
  TIMEOUT: "jira.errorCode.TIMEOUT",
  INVALID_RESPONSE: "jira.errorCode.INVALID_RESPONSE",
  LIMIT_EXCEEDED: "jira.errorCode.LIMIT_EXCEEDED",
  BLOCKED_HOST: "jira.errorCode.BLOCKED_HOST",
  REDIRECT: "jira.errorCode.REDIRECT",
  CURSOR_EXPIRED: "jira.errorCode.CURSOR_EXPIRED",
  PROJECT_NOT_VISIBLE: "jira.errorCode.PROJECT_NOT_VISIBLE",
  TOKEN_UNREADABLE: "jira.errorCode.TOKEN_UNREADABLE",
  NOT_DISCOVERED: "jira.errorCode.NOT_DISCOVERED",
  MAPPING_INVALID: "jira.errorCode.MAPPING_INVALID",
  MAPPING_UNREADABLE: "jira.errorCode.MAPPING_UNREADABLE",
  CONNECTION_GONE: "jira.errorCode.CONNECTION_GONE",
  CONNECTION_DISABLED: "jira.errorCode.CONNECTION_DISABLED",
  RUN_DEADLINE: "jira.errorCode.RUN_DEADLINE",
  SHUTDOWN: "jira.errorCode.SHUTDOWN",
  INTERNAL: "jira.errorCode.INTERNAL",
  ABANDONED: "jira.errorCode.ABANDONED",
} as const satisfies Record<string, ParseKeys>;

function isKnownErrorCode(code: string): code is keyof typeof ERROR_CODE_KEYS {
  return Object.hasOwn(ERROR_CODE_KEYS, code);
}

/** "Jira refused the credentials (AUTHENTICATION_FAILED)": the human sentence with the code kept visible; an unknown code reads as itself. */
export function errorCodeText(code: string, t: TFunction): string {
  return isKnownErrorCode(code) ? `${t(ERROR_CODE_KEYS[code])} (${code})` : code;
}
