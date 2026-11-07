import { afterEach, describe, expect, test } from "vitest";
import i18n from "../i18n";
import type { SyncStatus } from "../api/sync";
import { nextPollText, pollingText, syncStatusDetail } from "./syncStatus";

const t = i18n.t.bind(i18n);
const NOW = Date.UTC(2026, 10, 6, 11, 0);
const MIN = 60_000;

function status(over: Partial<SyncStatus> = {}): SyncStatus {
  return { state: "CURRENT", lastRun: null, lastSucceededAt: 1, consecutiveFailures: 0, nextPollAt: null, ...over };
}
const next = (nextPollAt: number | null, extra: { ready?: boolean; pollIntervalMinutes?: number | null } = {}) => nextPollText({ status: status({ nextPollAt }), now: NOW, ...extra }, t);

describe("nextPollText", () => {
  test("minutes are rounded UP (never 'in 0 min' while a moment is still ahead), hours past two hours, 'due now' once passed", () => {
    expect(next(NOW + 1)).toBe("next poll in 1 min");
    expect(next(NOW + 7 * MIN)).toBe("next poll in 7 min");
    expect(next(NOW + 7 * MIN + 1)).toBe("next poll in 8 min");
    expect(next(NOW + 119 * MIN)).toBe("next poll in 119 min");
    expect(next(NOW + 120 * MIN)).toBe("next poll in 2 h");
    // The NEAREST hour: 2 h 01 min never reads "3 h".
    expect(next(NOW + 121 * MIN)).toBe("next poll in 2 h");
    expect(next(NOW + 149 * MIN)).toBe("next poll in 2 h");
    expect(next(NOW + 151 * MIN)).toBe("next poll in 3 h");
    expect(next(NOW + 360 * MIN)).toBe("next poll in 6 h");
    expect(next(NOW)).toBe("due now");
    expect(next(NOW - 5 * MIN)).toBe("due now");
  });

  test("an untested connection and a manual-only one say so before any moment; a disabled one says nothing; unknown context adds nothing", () => {
    expect(next(NOW + MIN, { ready: false, pollIntervalMinutes: null })).toBe("not polled: test the connection first");
    expect(next(NOW + MIN, { ready: true, pollIntervalMinutes: null })).toBe("manual only");
    expect(nextPollText({ status: status({ state: "DISABLED", nextPollAt: NOW + MIN }), now: NOW, ready: false }, t)).toBeNull();
    expect(next(null)).toBeNull();
    expect(next(NOW + MIN)).toBe("next poll in 1 min");
  });
});

describe("syncStatusDetail", () => {
  test("the failure streak wins over the next poll, with the newest run's code when it has one", () => {
    const lastRun = { id: 1, startedAt: 1, finishedAt: 2, outcome: "FAILED" as const, errorCode: "TIMEOUT", trigger: "SCHEDULED" as const, running: false };
    expect(syncStatusDetail({ status: status({ state: "FAILED", consecutiveFailures: 2, lastRun, nextPollAt: NOW + MIN }), now: NOW }, t)).toBe("2 failures in a row · TIMEOUT");
    expect(syncStatusDetail({ status: status({ state: "FAILED", consecutiveFailures: 1, lastRun: { ...lastRun, errorCode: null } }), now: NOW }, t)).toBe("1 failure in a row");
    expect(syncStatusDetail({ status: status({ nextPollAt: NOW + MIN }), now: NOW }, t)).toBe("next poll in 1 min");
  });
});

describe("pollingText", () => {
  test("the interval, or Manual only", () => {
    expect(pollingText(15, t)).toBe("every 15 min");
    expect(pollingText(null, t)).toBe("Manual only");
  });
});

describe("in Polish", () => {
  afterEach(() => i18n.changeLanguage("en"));

  test.each([
    [1, "1 błąd z rzędu"],
    [2, "2 błędy z rzędu"],
    [4, "4 błędy z rzędu"],
    [5, "5 błędów z rzędu"],
    [12, "12 błędów z rzędu"],
    [22, "22 błędy z rzędu"],
    [25, "25 błędów z rzędu"],
  ])("%i failures in a row take the one/few/many forms", async (count, expected) => {
    await i18n.changeLanguage("pl");
    expect(syncStatusDetail({ status: status({ state: "FAILED", consecutiveFailures: count }), now: NOW }, i18n.t.bind(i18n))).toBe(expected);
  });

  test.each([
    [1, "następne odpytanie za 1 minutę"],
    [2, "następne odpytanie za 2 minuty"],
    [5, "następne odpytanie za 5 minut"],
    [22, "następne odpytanie za 22 minuty"],
    [60, "następne odpytanie za 60 minut"],
    [120, "następne odpytanie za 2 godziny"],
    [360, "następne odpytanie za 6 godzin"],
  ])("a poll in %i minutes takes the Polish plural forms", async (minutes, expected) => {
    await i18n.changeLanguage("pl");
    expect(nextPollText({ status: status({ nextPollAt: NOW + minutes * MIN }), now: NOW }, i18n.t.bind(i18n))).toBe(expected);
  });

  test("the other lines", async () => {
    await i18n.changeLanguage("pl");
    const pl = i18n.t.bind(i18n);
    expect(next(NOW)).toBe("do odpytania teraz");
    expect(pollingText(null, pl)).toBe("Tylko ręcznie");
    expect(pollingText(15, pl)).toBe("co 15 min");
  });
});
