import type { TFunction } from "i18next";
import type { SyncState, SyncStatus } from "../api/sync";

/** The colour of a connection's derived state: green = current, red = failed, orange = stale, gray = nothing to say (never synced, disabled). */
export const SYNC_STATE_COLOR: Record<SyncState, string> = {
  CURRENT: "green",
  FAILED: "red",
  STALE: "orange",
  NEVER_SYNCED: "gray",
  DISABLED: "gray",
};

/** What the status line needs besides the status itself. `ready` / `pollIntervalMinutes` are left out where the caller's document does not carry them. */
export type SyncStatusContext = {
  status: SyncStatus;
  /** The moment the line is read at (epoch millis): a ticking client clock, or the server's `generatedAt`. */
  now: number;
  /** Whether a passing connection test stored a discovery; `false` = the connection is never polled. Undefined = not known here. */
  ready?: boolean;
  /** Minutes between scheduled runs, `null` = manual only. Undefined = not known here. */
  pollIntervalMinutes?: number | null;
};

const MINUTE_MS = 60_000;
/** Up to this many minutes the next poll reads in minutes; beyond it, in hours. */
const MINUTES_LIMIT = 120;

/** Whether the next poll's moment has come: such a connection is due and no clock time is worth showing for it. */
export function isDue(status: SyncStatus, now: number): boolean {
  return status.nextPollAt !== null && status.nextPollAt <= now;
}

/** "due now" when the moment has passed, else "next poll in 7 min" / "next poll in 6 h". Pure: `now` is passed. */
function dueText(nextPollAt: number, now: number, t: TFunction): string {
  const remaining = nextPollAt - now;
  if (remaining <= 0) return t("sync.status.dueNow");
  const minutes = Math.ceil(remaining / MINUTE_MS);
  // Hours are the NEAREST hour (2 h 01 min reads "2 h", never "3 h").
  return minutes < MINUTES_LIMIT ? t("sync.status.nextPollIn", { count: minutes }) : t("sync.status.nextPollInHours", { count: Math.round(minutes / 60) });
}

/**
 * When the connection is polled next, in words, or null when there is nothing to say (a disabled connection, or a run that is going and
 * no moment is known): "Test the connection first" (never polled), "manual only", "due now", "next poll in 7 min".
 */
export function nextPollText({ status, now, ready, pollIntervalMinutes }: SyncStatusContext, t: TFunction): string | null {
  if (status.state === "DISABLED") return null;
  if (ready === false) return t("sync.status.testFirst");
  if (pollIntervalMinutes === null) return t("sync.status.manualOnly");
  if (status.nextPollAt !== null) return dueText(status.nextPollAt, now, t);
  return status.lastRun?.running ? t("sync.status.refreshing") : null;
}

/** "3 failures in a row · TOKEN_UNREADABLE": the streak and the newest run's typed code (kept as the code, language-neutral). */
function failuresText(status: SyncStatus, t: TFunction): string {
  const streak = t("sync.status.failuresInARow", { count: status.consecutiveFailures });
  const code = status.lastRun?.errorCode;
  return code ? `${streak} · ${code}` : streak;
}

/** The secondary line under a state badge: the failure streak while there is one, else when the next poll is. */
export function syncStatusDetail(context: SyncStatusContext, t: TFunction): string | null {
  const { status } = context;
  if (status.state !== "DISABLED" && status.consecutiveFailures > 0) return failuresText(status, t);
  return nextPollText(context, t);
}

/** The interval as a fact: "every 15 min" or "Manual only". */
export function pollingText(pollIntervalMinutes: number | null, t: TFunction): string {
  return pollIntervalMinutes === null ? t("sync.status.manualOnlyTitle") : t("sync.status.every", { count: pollIntervalMinutes });
}
