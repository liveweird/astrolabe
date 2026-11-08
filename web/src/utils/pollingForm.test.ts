import { describe, expect, test } from "vitest";
import i18n from "../i18n";
import { MAX_POLL_INTERVAL_MINUTES, MIN_POLL_INTERVAL_MINUTES, pollIntervalRule, validPollInterval } from "./pollingForm";

describe("pollingForm", () => {
  test("a whole number of minutes from 5 to 1440 is an interval; a blank, a fraction or anything outside is not", () => {
    expect(validPollInterval(MIN_POLL_INTERVAL_MINUTES)).toBe(5);
    expect(validPollInterval(String(MAX_POLL_INTERVAL_MINUTES))).toBe(1440);
    for (const refused of [4, 1441, "", "  ", 7.5, "abc"]) expect(validPollInterval(refused), String(refused)).toBeNull();
  });

  test("the rule refuses a bad number with the shared sentence, except while manual only is ticked", () => {
    const rule = pollIntervalRule(i18n.t.bind(i18n));
    expect(rule(3, { pollIntervalMinutes: 3, manualOnly: false })).toBe("The polling interval must be a whole number of minutes from 5 to 1440");
    expect(rule(3, { pollIntervalMinutes: 3, manualOnly: true })).toBeNull();
    expect(rule(30, { pollIntervalMinutes: 30, manualOnly: false })).toBeNull();
  });
});
