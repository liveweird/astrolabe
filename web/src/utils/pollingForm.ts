import type { TFunction } from "i18next";

/** The polling interval's bounds, in minutes (`MIN/MAX_*_POLL_INTERVAL_MINUTES` in `JiraConnection.kt` and `FlowConnection.kt`: one rule for every connector). */
export const MIN_POLL_INTERVAL_MINUTES = 5;
export const MAX_POLL_INTERVAL_MINUTES = 1440;

/** The polling members of a connector's form: the connection editors (Jira, Flow) share them and `components/PollingFields.tsx`. */
export type PollingValues = {
  /** Minutes between scheduled runs. A NumberInput hands back a string while it holds no number (cleared, or half typed). Ignored while {@link manualOnly}. */
  pollIntervalMinutes: number | string;
  /** No polling: the wire carries an explicit `null`. */
  manualOnly: boolean;
};

/** The interval a NumberInput value stands for: a whole number of minutes inside the server's bounds, else null. */
export function validPollInterval(value: number | string): number | null {
  if (typeof value === "string" && value.trim() === "") return null;
  const minutes = Number(value);
  return Number.isInteger(minutes) && minutes >= MIN_POLL_INTERVAL_MINUTES && minutes <= MAX_POLL_INTERVAL_MINUTES ? minutes : null;
}

/** The Mantine `validate` rule of `pollIntervalMinutes`: 5..1440 minutes, or manual only (then the number is not looked at). */
export function pollIntervalRule(t: TFunction) {
  return (value: number | string, values: PollingValues) =>
    values.manualOnly || validPollInterval(value) !== null ? null : t("common.polling.invalid");
}
