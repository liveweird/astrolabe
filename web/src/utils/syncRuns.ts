import type { ParseKeys, TFunction } from "i18next";
import type { SyncKind, SyncOutcome } from "../api/sync";

/** The poll period while a run is running. */
export const RUN_POLL_MS = 3_000;

/**
 * The slow refresh of a Jira page that stays open (the connection, its runs, the registry): a scheduled run starts without anyone clicking, so
 * an open page re-reads at this period while it is visible (TanStack pauses `refetchInterval` in a background tab). Far slower than
 * {@link RUN_POLL_MS}, which only applies while a run is known to be running.
 */
export const IDLE_REFRESH_MS = 30_000;

/** The poll period of the Deviations page while a run is running: the page is one big document, so it asks less often than the run table. */
export const DEVIATIONS_POLL_MS = 10_000;

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
  AUTHENTICATION_FAILED: "sync.errorCode.AUTHENTICATION_FAILED",
  FORBIDDEN_SCOPE: "sync.errorCode.FORBIDDEN_SCOPE",
  NOT_FOUND: "sync.errorCode.NOT_FOUND",
  RATE_LIMITED: "sync.errorCode.RATE_LIMITED",
  UPSTREAM_UNAVAILABLE: "sync.errorCode.UPSTREAM_UNAVAILABLE",
  TIMEOUT: "sync.errorCode.TIMEOUT",
  BUSY: "sync.errorCode.BUSY",
  INVALID_RESPONSE: "sync.errorCode.INVALID_RESPONSE",
  LIMIT_EXCEEDED: "sync.errorCode.LIMIT_EXCEEDED",
  BLOCKED_HOST: "sync.errorCode.BLOCKED_HOST",
  REDIRECT: "sync.errorCode.REDIRECT",
  CURSOR_EXPIRED: "sync.errorCode.CURSOR_EXPIRED",
  PROJECT_NOT_VISIBLE: "sync.errorCode.PROJECT_NOT_VISIBLE",
  TOKEN_UNREADABLE: "sync.errorCode.TOKEN_UNREADABLE",
  NOT_DISCOVERED: "sync.errorCode.NOT_DISCOVERED",
  MAPPING_INVALID: "sync.errorCode.MAPPING_INVALID",
  MAPPING_UNREADABLE: "sync.errorCode.MAPPING_UNREADABLE",
  CONNECTION_GONE: "sync.errorCode.CONNECTION_GONE",
  CONNECTION_DISABLED: "sync.errorCode.CONNECTION_DISABLED",
  RUN_DEADLINE: "sync.errorCode.RUN_DEADLINE",
  SHUTDOWN: "sync.errorCode.SHUTDOWN",
  INTERNAL: "sync.errorCode.INTERNAL",
  ABANDONED: "sync.errorCode.ABANDONED",
} as const satisfies Record<string, ParseKeys>;

/**
 * The codes a Flow run or probe row words differently from Jira's (Flow's token is a service token, its one 401 is uniform, the origin list is
 * the operator's); every other code a Flow run can carry (`CONNECTION_GONE`, `CONNECTION_DISABLED`, `TOKEN_UNREADABLE`, `RUN_DEADLINE`,
 * `SHUTDOWN`, `INTERNAL`, `ABANDONED`) reads as the shared sentence above.
 */
const FLOW_ERROR_CODE_KEYS = {
  AUTHENTICATION_FAILED: "flow.errorCode.AUTHENTICATION_FAILED",
  NOT_FOUND: "flow.errorCode.NOT_FOUND",
  RATE_LIMITED: "flow.errorCode.RATE_LIMITED",
  UPSTREAM_UNAVAILABLE: "flow.errorCode.UPSTREAM_UNAVAILABLE",
  TIMEOUT: "flow.errorCode.TIMEOUT",
  BUSY: "flow.errorCode.BUSY",
  INVALID_RESPONSE: "flow.errorCode.INVALID_RESPONSE",
  LIMIT_EXCEEDED: "flow.errorCode.LIMIT_EXCEEDED",
  BLOCKED_HOST: "flow.errorCode.BLOCKED_HOST",
  REDIRECT: "flow.errorCode.REDIRECT",
  TIME_ZONE_INVALID: "flow.errorCode.TIME_ZONE_INVALID",
} as const satisfies Record<string, ParseKeys>;

function isKnownErrorCode(code: string): code is keyof typeof ERROR_CODE_KEYS {
  return Object.hasOwn(ERROR_CODE_KEYS, code);
}

function isFlowErrorCode(code: string): code is keyof typeof FLOW_ERROR_CODE_KEYS {
  return Object.hasOwn(FLOW_ERROR_CODE_KEYS, code);
}

/**
 * "Jira refused the credentials (AUTHENTICATION_FAILED)": the human sentence with the code kept visible; an unknown code reads as itself.
 * `kind` picks the connector's wording (`FLOW` for a Flow run or probe row; Jira's by default, unchanged); a code the Flow table does not
 * word reads as the shared sentence.
 */
export function errorCodeText(code: string, t: TFunction, kind: SyncKind = "JIRA"): string {
  if (kind === "FLOW" && isFlowErrorCode(code)) return `${t(FLOW_ERROR_CODE_KEYS[code])} (${code})`;
  return isKnownErrorCode(code) ? `${t(ERROR_CODE_KEYS[code])} (${code})` : code;
}
