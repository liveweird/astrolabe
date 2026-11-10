import { describe, expect, test } from "vitest";
import i18n from "../i18n";
import type { Deviation } from "../api/deviations";
import type { PlanFlag } from "../api/roadmap";
import { detail, endLater } from "../test/deviations";
import { flagSentence, jiraTrayNote, milestoneFlagLabel } from "./flagSentences";

const en = i18n.getFixedT("en");
const pl = i18n.getFixedT("pl");

const flag = (kind: PlanFlag["kind"], severity: PlanFlag["severity"], over: Partial<PlanFlag> = {}): PlanFlag => ({ deviation: null, count: null, kind, severity, days: null, teamId: null, otherProjectId: null, ...over });
const deviationFlag = (deviation: Deviation) => flag("JIRA_DEVIATION", deviation.severity, { deviation });
const unscheduledInPlan: Deviation = { kind: "UNSCHEDULED_IN_PLAN", severity: "INFO", detail: detail({ jira: "2027-03-01" }) };
const NAMES = { project: (id: number) => `P${id}`, team: (id: number) => `T${id}` };

describe("flagSentence", () => {
  test("a Jira deviation is the deviation page's sentence behind the row's key; without a key it is the bare sentence", () => {
    expect(flagSentence(en, deviationFlag(endLater(3)), NAMES, "E2E-3")).toBe("Jira E2E-3: Ends 3 working days later than Jira (plan 2044-03-07, Jira 2044-03-04)");
    expect(flagSentence(en, deviationFlag(endLater(3)), NAMES, null)).toBe("Ends 3 working days later than Jira (plan 2044-03-07, Jira 2044-03-04)");
    expect(flagSentence(pl, deviationFlag(endLater(3)), NAMES, "E2E-3")).toMatch(/^Jira E2E-3: /);
  });

  test("the coverage kinds ride the same phrasing behind the key (1.4)", () => {
    const unlinked: Deviation = { kind: "UNLINKED_IN_JIRA", severity: "WARNING", detail: detail({ jira: "COV-5", count: 1 }) };
    const done: Deviation = { kind: "CHILDREN_DONE", severity: "INFO", detail: detail({ jira: "2/2", plan: "2046-03-01", count: 2 }) };
    expect(flagSentence(en, deviationFlag(unlinked), NAMES, "COV-2")).toBe("Jira COV-2: 1 Jira item is not in the plan: COV-5");
    expect(flagSentence(en, deviationFlag(done), NAMES, "COV-4")).toBe("Jira COV-4: All 2 child issues are done in Jira while the plan ends 2046-03-01");
    expect(flagSentence(pl, deviationFlag(unlinked), NAMES, "COV-2")).toBe("Jira COV-2: W planie brakuje 1 elementu Jiry: COV-5");
  });

  test("without the evidence it degrades to the bare 'differs', and the roll-up counts milestones", () => {
    expect(flagSentence(en, flag("JIRA_DEVIATION", "WARNING"), NAMES, "E2E-3")).toBe("Jira E2E-3: Differs from Jira");
    expect(flagSentence(en, flag("JIRA_MILESTONES", "WARNING", { count: 1 }), NAMES, null)).toBe("1 milestone deviates from Jira");
    expect(flagSentence(en, flag("JIRA_MILESTONES", "WARNING", { count: 3 }), NAMES, null)).toBe("3 milestones deviate from Jira");
  });

  test("the team page's Flow capacity roll-up counts the open sprints, in both languages", () => {
    expect(flagSentence(en, flag("FLOW_CAPACITY", "WARNING", { count: 1 }), NAMES, null)).toBe("Capacity differs from Flow in 1 sprint");
    expect(flagSentence(en, flag("FLOW_CAPACITY", "INFO", { count: 3 }), NAMES, null)).toBe("Capacity differs from Flow in 3 sprints");
    expect(flagSentence(pl, flag("FLOW_CAPACITY", "WARNING", { count: 1 }), NAMES, null)).toBe("Pojemność różni się od Flow w 1 sprincie");
    expect(flagSentence(pl, flag("FLOW_CAPACITY", "WARNING", { count: 3 }), NAMES, null)).toBe("Pojemność różni się od Flow w 3 sprintach");
  });

  test("the plan flags name the project and team they compare", () => {
    expect(flagSentence(en, flag("DRIFT_END_LATE", "WARNING", { days: 10 }), NAMES, null)).toBe("Ends 10 days after the target");
    expect(flagSentence(en, flag("RANK_INVERSION", "WARNING", { days: 7, teamId: 2, otherProjectId: 9 }), NAMES, null)).toContain("P9");
  });
});

describe("milestoneFlagLabel", () => {
  test("every flag's sentence behind the key, in order, joined by semicolons; empty for no flags", () => {
    const flags = [deviationFlag(endLater(3)), deviationFlag(unscheduledInPlan)];
    expect(milestoneFlagLabel(en, flags, "E2E-3")).toBe(
      "Jira E2E-3: Ends 3 working days later than Jira (plan 2044-03-07, Jira 2044-03-04); Jira E2E-3: Jira has dates, but the plan item is not scheduled",
    );
    expect(milestoneFlagLabel(en, [], "E2E-3")).toBe("");
  });
});

describe("jiraTrayNote", () => {
  const link = { start: "2027-03-01", end: "2027-03-05" };

  test("'Jira: start to end' for an open UNSCHEDULED_IN_PLAN deviation, in both languages", () => {
    expect(jiraTrayNote(en, link, [deviationFlag(unscheduledInPlan)])).toBe("Jira: 2027-03-01 to 2027-03-05");
    expect(jiraTrayNote(pl, link, [deviationFlag(unscheduledInPlan)])).toBe("Jira: od 2027-03-01 do 2027-03-05");
  });

  test("nothing without that flag (acknowledged, clean or another deviation), without a link, or with only one date", () => {
    expect(jiraTrayNote(en, link, [])).toBeUndefined();
    expect(jiraTrayNote(en, link, [deviationFlag(endLater(2))])).toBeUndefined();
    expect(jiraTrayNote(en, null, [deviationFlag(unscheduledInPlan)])).toBeUndefined();
    expect(jiraTrayNote(en, { start: "2027-03-01", end: null }, [deviationFlag(unscheduledInPlan)])).toBeUndefined();
    expect(jiraTrayNote(en, { start: null, end: null }, [deviationFlag(unscheduledInPlan)])).toBeUndefined();
  });
});
