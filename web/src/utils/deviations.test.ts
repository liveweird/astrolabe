import { describe, expect, test } from "vitest";
import i18n from "../i18n";
import type { Deviation, DeviationKind } from "../api/deviations";
import { DEV_CONNECTION, detail } from "../test/deviations";
import { ageText, countDeviations, deviationKindLabel, deviationSentence, formatPoints, hasStaleSource, rollupSentence, rollupText, staleConnection, verifiedAt } from "./deviations";

const en = i18n.getFixedT("en");
const pl = i18n.getFixedT("pl");
const POINTS = { jira: { estimateUnit: "POINTS" as const } };
const NO_UNIT = { jira: { estimateUnit: null } };

const shifted = (kind: "START_DIFFERS" | "END_DIFFERS" | "TARGET_DIFFERS", days: number | null, dates = true): Deviation => ({
  kind,
  severity: "WARNING",
  detail: detail({ days, ...(dates && kind !== "TARGET_DIFFERS" ? { jira: "2044-03-04", plan: "2044-03-07" } : {}) }),
});

describe("deviationSentence - the working-day phrasing (positive days = the plan is later)", () => {
  test.each([
    [3, "Ends 3 working days later than Jira (plan 2044-03-07, Jira 2044-03-04)"],
    [-3, "Ends 3 working days earlier than Jira (plan 2044-03-07, Jira 2044-03-04)"],
    [1, "Ends 1 working day later than Jira (plan 2044-03-07, Jira 2044-03-04)"],
    [-1, "Ends 1 working day earlier than Jira (plan 2044-03-07, Jira 2044-03-04)"],
    [2, "Ends 2 working days later than Jira (plan 2044-03-07, Jira 2044-03-04)"],
    [5, "Ends 5 working days later than Jira (plan 2044-03-07, Jira 2044-03-04)"],
    [23, "Ends 23 working days later than Jira (plan 2044-03-07, Jira 2044-03-04)"],
    [-23, "Ends 23 working days earlier than Jira (plan 2044-03-07, Jira 2044-03-04)"],
  ])("EN end, %i days", (days, expected) => {
    expect(deviationSentence(shifted("END_DIFFERS", days), POINTS, en)).toBe(expected);
  });

  test.each([
    [1, "Koniec 1 dzień roboczy później niż w Jirze"],
    [2, "Koniec 2 dni robocze później niż w Jirze"],
    [5, "Koniec 5 dni roboczych później niż w Jirze"],
    [23, "Koniec 23 dni robocze później niż w Jirze"],
    [-1, "Koniec 1 dzień roboczy wcześniej niż w Jirze"],
    [-2, "Koniec 2 dni robocze wcześniej niż w Jirze"],
    [-5, "Koniec 5 dni roboczych wcześniej niż w Jirze"],
    [-23, "Koniec 23 dni robocze wcześniej niż w Jirze"],
  ])("PL end, %i days: the one/few/many forms", (days, lead) => {
    expect(deviationSentence(shifted("END_DIFFERS", days), POINTS, pl)).toBe(`${lead} (plan 2044-03-07, Jira 2044-03-04)`);
  });

  test.each([
    [1, "Starts 1 working day later than Jira"],
    [5, "Starts 5 working days later than Jira"],
    [-2, "Starts 2 working days earlier than Jira"],
    [-23, "Starts 23 working days earlier than Jira"],
  ])("EN start, %i days", (days, lead) => {
    expect(deviationSentence(shifted("START_DIFFERS", days, false), POINTS, en)).toBe(lead);
  });

  test.each([
    [1, "Początek 1 dzień roboczy później niż w Jirze"],
    [3, "Początek 3 dni robocze później niż w Jirze"],
    [12, "Początek 12 dni roboczych później niż w Jirze"],
    [-22, "Początek 22 dni robocze wcześniej niż w Jirze"],
  ])("PL start, %i days", (days, lead) => {
    expect(deviationSentence(shifted("START_DIFFERS", days, false), POINTS, pl)).toBe(lead);
  });

  test("the target window: days is the end's shift, else the start's, so the sentence names no count and no edge; the dates line carries the figures", () => {
    for (const days of [3, -1, null]) {
      expect(deviationSentence(shifted("TARGET_DIFFERS", days), POINTS, en)).toBe("The target window differs from Jira's project dates");
    }
    expect(deviationSentence(shifted("TARGET_DIFFERS", 5), POINTS, pl)).toBe("Okno docelowe różni się od dat projektu w Jirze");
  });

  test("a date is never made up from an absent side, and a missing or zero figure degrades to a plain 'differs'", () => {
    const oneSided: Deviation = { kind: "END_DIFFERS", severity: "WARNING", detail: detail({ days: 3, plan: "2044-03-07" }) };
    expect(deviationSentence(oneSided, POINTS, en)).toBe("Ends 3 working days later than Jira");
    expect(deviationSentence(shifted("END_DIFFERS", 0, false), POINTS, en)).toBe("Ends on a different day than in Jira");
    expect(deviationSentence(shifted("START_DIFFERS", null, false), POINTS, pl)).toBe("Początek w innym dniu niż w Jirze");
  });
});

describe("deviationSentence - every other kind, in both languages", () => {
  const cases: [Deviation, string, string][] = [
    [{ kind: "GONE", severity: "WARNING", detail: detail({ jira: "DELETED" }) }, "Deleted in Jira (or no longer visible to the connection's account)", "Usunięty w Jirze (albo konto połączenia już go nie widzi)"],
    [{ kind: "GONE", severity: "WARNING", detail: detail({ jira: "FORBIDDEN" }) }, "No longer visible to the connection's account", "Konto połączenia już go nie widzi"],
    [{ kind: "GONE", severity: "WARNING", detail: detail() }, "No longer readable in Jira", "Nie da się już odczytać z Jiry"],
    [
      { kind: "LEVEL_MISMATCH", severity: "WARNING", detail: detail({ jira: "0", plan: "1" }) },
      "The Jira item is at hierarchy level 0, but the mapping expects level 1 here",
      "Element Jiry leży na poziomie hierarchii 0, a mapowanie oczekuje tu poziomu 1",
    ],
    [
      { kind: "LEVEL_MISMATCH", severity: "WARNING", detail: detail({ jira: "unknown", plan: "1" }) },
      "The Jira item's hierarchy level is unknown, but the mapping expects level 1 here",
      "Poziom hierarchii elementu Jiry jest nieznany, a mapowanie oczekuje tu poziomu 1",
    ],
    [
      { kind: "PARENT_MISMATCH", severity: "WARNING", detail: detail({ jira: "E2E-1", plan: "Invoices" }) },
      "Its parent in Jira is E2E-1, but in the plan it sits under Invoices",
      "Jego rodzicem w Jirze jest E2E-1, a w planie leży on pod: Invoices",
    ],
    [{ kind: "RENAMED", severity: "INFO", detail: detail({ jira: "Checkout v2", plan: "Checkout" }) }, "Named “Checkout v2” in Jira and “Checkout” in the plan", "W Jirze nazywa się „Checkout v2”, a w planie „Checkout”"],
    [{ kind: "UNSCHEDULED_IN_PLAN", severity: "INFO", detail: detail() }, "Jira has dates, but the plan item is not scheduled", "Jira ma daty, a element planu nie ma terminu"],
    [{ kind: "UNSCHEDULED_IN_JIRA", severity: "INFO", detail: detail() }, "The plan item is scheduled, but the Jira item has no dates", "Element planu ma termin, a element Jiry nie ma dat"],
    [
      { kind: "ESTIMATE_DIFFERS", severity: "INFO", detail: detail({ jira: "7.5", plan: "5" }) },
      "Estimate is 5 man-days in the plan and 7.5 man-days in Jira",
      "Estymata to 5 osobodni w planie i 7.5 osobodni w Jirze",
    ],
    [
      { kind: "ESTIMATE_NOT_COMPARABLE", severity: "INFO", detail: detail({ jira: "8", plan: "5" }) },
      "Jira's estimate of 8 points cannot be compared with the plan's 5 man-days",
      "Estymaty Jiry (8, punkty) nie da się porównać z 5 osobodniami w planie",
    ],
    [{ kind: "PROGRESS_MISMATCH", severity: "INFO", detail: detail({ jira: "DONE", plan: "2044-04-01" }) }, "Done in Jira, but the plan ends on 2044-04-01", "W Jirze zrobione, a plan kończy się 2044-04-01"],
    [{ kind: "PROGRESS_MISMATCH", severity: "INFO", detail: detail({ jira: "TODO", plan: "2044-01-03" }) }, "Not started in Jira, but the plan started on 2044-01-03", "W Jirze niezaczęte, a plan zaczął się 2044-01-03"],
    [{ kind: "PROGRESS_MISMATCH", severity: "INFO", detail: detail({ jira: "IN_PROGRESS", plan: "2044-06-01" }) }, "In progress in Jira, but the plan starts on 2044-06-01", "W Jirze w toku, a plan zaczyna się 2044-06-01"],
  ];
  test.each(cases)("%#", (deviation, english, polish) => {
    expect(deviationSentence(deviation, POINTS, en)).toBe(english);
    expect(deviationSentence(deviation, POINTS, pl)).toBe(polish);
  });

  test("an estimate with no unit on the item reads without one", () => {
    const deviation: Deviation = { kind: "ESTIMATE_NOT_COMPARABLE", severity: "INFO", detail: detail({ jira: "8", plan: "5" }) };
    expect(deviationSentence(deviation, NO_UNIT, en)).toBe("Jira's estimate of 8 cannot be compared with the plan's 5 man-days");
  });

  test("every DeviationKind has a sentence and a badge word in both languages (no key falls through to its own name)", () => {
    const kinds: DeviationKind[] = [
      "GONE", "LEVEL_MISMATCH", "PARENT_MISMATCH", "RENAMED", "START_DIFFERS", "END_DIFFERS", "TARGET_DIFFERS",
      "UNSCHEDULED_IN_PLAN", "UNSCHEDULED_IN_JIRA", "ESTIMATE_DIFFERS", "ESTIMATE_NOT_COMPARABLE", "PROGRESS_MISMATCH",
      "UNLINKED_IN_JIRA", "UNLINKED_IN_PLAN", "CHILDREN_DONE",
    ];
    for (const kind of kinds) {
      for (const t of [en, pl]) {
        expect(deviationSentence({ kind, severity: "INFO", detail: detail() }, POINTS, t)).not.toMatch(/^deviations\./);
        expect(deviationKindLabel(kind, t)).not.toMatch(/^deviations\./);
      }
    }
  });
});

describe("deviationSentence - a missing member degrades to a plainer sentence, never to an invented value", () => {
  const bare = (kind: DeviationKind, over: Partial<Deviation["detail"]> = {}): Deviation => ({ kind, severity: "INFO", detail: detail(over) });
  test("level, parent, rename, estimate and progress without their evidence", () => {
    expect(deviationSentence(bare("LEVEL_MISMATCH"), POINTS, en)).toBe("The Jira item is at a different hierarchy level than the mapping expects");
    expect(deviationSentence(bare("LEVEL_MISMATCH", { plan: "1" }), POINTS, en)).toBe("The Jira item's hierarchy level is unknown, but the mapping expects level 1 here");
    expect(deviationSentence(bare("PARENT_MISMATCH"), POINTS, en)).toBe("Its parent differs from Jira's");
    expect(deviationSentence(bare("PARENT_MISMATCH", { jira: "E2E-2" }), POINTS, en)).toBe("Its parent in Jira is E2E-2, which is linked to another plan item");
    expect(deviationSentence(bare("RENAMED", { jira: "X" }), POINTS, en)).toBe("Named differently in Jira");
    expect(deviationSentence(bare("ESTIMATE_DIFFERS"), POINTS, en)).toBe("Estimate");
    expect(deviationSentence(bare("ESTIMATE_NOT_COMPARABLE"), POINTS, en)).toBe(
      "Jira's estimate of ? points cannot be compared with the plan's ? man-days",
    );
    expect(deviationSentence(bare("PROGRESS_MISMATCH"), POINTS, en)).toBe("The Jira status does not fit the plan's dates");
    expect(deviationSentence(bare("PROGRESS_MISMATCH", { jira: "UNKNOWN", plan: "2044-01-01" }), POINTS, en)).toBe("The Jira status does not fit the plan's dates");
  });
});

describe("deviationSentence - the coverage kinds (1.4)", () => {
  const coverage = (kind: DeviationKind, over: Partial<Deviation["detail"]>, severity: Deviation["severity"] = "INFO"): Deviation => ({ kind, severity, detail: detail(over) });

  test("UNLINKED_IN_JIRA names the keys and the count; one reads in the singular", () => {
    expect(deviationSentence(coverage("UNLINKED_IN_JIRA", { jira: "COV-5", count: 1 }, "WARNING"), POINTS, en)).toBe("1 Jira item is not in the plan: COV-5");
    expect(deviationSentence(coverage("UNLINKED_IN_JIRA", { jira: "COV-5, COV-6", count: 2 }, "WARNING"), POINTS, en)).toBe("2 Jira items are not in the plan: COV-5, COV-6");
  });

  test("UNLINKED_IN_PLAN names the plan items and the count", () => {
    expect(deviationSentence(coverage("UNLINKED_IN_PLAN", { plan: "Rollout", count: 1 }), POINTS, en)).toBe("1 plan item is not linked to Jira: Rollout");
    expect(deviationSentence(coverage("UNLINKED_IN_PLAN", { plan: "A, B, C", count: 3 }), POINTS, en)).toBe("3 plan items are not linked to Jira: A, B, C");
  });

  test("the 'and N more' rule: only when the count exceeds the ten the server lists; a name containing a comma does not move it", () => {
    const keys = Array.from({ length: 10 }, (_, i) => `COV-${i + 1}`).join(", ");
    expect(deviationSentence(coverage("UNLINKED_IN_JIRA", { jira: keys, count: 10 }, "WARNING"), POINTS, en)).toBe(`10 Jira items are not in the plan: ${keys}`);
    expect(deviationSentence(coverage("UNLINKED_IN_JIRA", { jira: keys, count: 13 }, "WARNING"), POINTS, en)).toBe(`13 Jira items are not in the plan: ${keys} and 3 more`);
    const names = "Phase 1, backend, B, C, D, E, F, G, H, I";
    expect(deviationSentence(coverage("UNLINKED_IN_PLAN", { plan: names, count: 11 }), POINTS, en)).toBe(`11 plan items are not linked to Jira: ${names} and 1 more`);
    expect(deviationSentence(coverage("UNLINKED_IN_PLAN", { plan: names, count: 10 }), POINTS, en)).toBe(`10 plan items are not linked to Jira: ${names}`);
    expect(deviationSentence(coverage("UNLINKED_IN_PLAN", { plan: names, count: 12 }), POINTS, pl)).toBe(`12 elementów planu nie jest powiązanych z Jirą: ${names} i jeszcze 2`);
  });

  test("CHILDREN_DONE: the children and the plan's end; one child reads 'the only'", () => {
    expect(deviationSentence(coverage("CHILDREN_DONE", { jira: "2/2", plan: "2046-03-01", count: 2 }), POINTS, en)).toBe("All 2 child issues are done in Jira while the plan ends 2046-03-01");
    expect(deviationSentence(coverage("CHILDREN_DONE", { jira: "1/1", plan: "2046-03-01", count: 1 }), POINTS, en)).toBe("The only child issue is done in Jira while the plan ends 2046-03-01");
  });

  test("a missing member degrades to the plain kind label, never to an invented value", () => {
    expect(deviationSentence(coverage("UNLINKED_IN_JIRA", { jira: "COV-5", count: null }, "WARNING"), POINTS, en)).toBe("Not in plan");
    expect(deviationSentence(coverage("UNLINKED_IN_JIRA", { jira: null, count: 2 }, "WARNING"), POINTS, en)).toBe("Not in plan");
    expect(deviationSentence(coverage("UNLINKED_IN_PLAN", { plan: "", count: 2 }), POINTS, en)).toBe("Not in Jira");
    expect(deviationSentence(coverage("CHILDREN_DONE", { plan: null, count: 2 }), POINTS, en)).toBe("Children done");
    expect(deviationSentence(coverage("CHILDREN_DONE", { plan: "2046-03-01", count: null }), POINTS, en)).toBe("Children done");
  });

  test.each([
    [1, "W planie brakuje 1 elementu Jiry: COV-5", "1 element planu nie jest powiązany z Jirą: A", "Jedyne zgłoszenie podrzędne jest ukończone w Jirze, a plan kończy się 2046-03-01"],
    [2, "W planie brakuje 2 elementów Jiry: COV-5", "2 elementy planu nie są powiązane z Jirą: A", "Wszystkie zgłoszenia podrzędne (2) są ukończone w Jirze, a plan kończy się 2046-03-01"],
    [5, "W planie brakuje 5 elementów Jiry: COV-5", "5 elementów planu nie jest powiązanych z Jirą: A", "Wszystkie zgłoszenia podrzędne (5) są ukończone w Jirze, a plan kończy się 2046-03-01"],
    [22, "W planie brakuje 22 elementów Jiry: COV-5", "22 elementy planu nie są powiązane z Jirą: A", "Wszystkie zgłoszenia podrzędne (22) są ukończone w Jirze, a plan kończy się 2046-03-01"],
  ])("PL, count %i: the one/few/many forms", (count, inJira, inPlan, done) => {
    const more = count > 10 ? ` i jeszcze ${count - 10}` : "";
    expect(deviationSentence(coverage("UNLINKED_IN_JIRA", { jira: "COV-5", count }, "WARNING"), POINTS, pl)).toBe(`${inJira}${more}`);
    expect(deviationSentence(coverage("UNLINKED_IN_PLAN", { plan: "A", count }), POINTS, pl)).toBe(`${inPlan}${more}`);
    expect(deviationSentence(coverage("CHILDREN_DONE", { jira: `${count}/${count}`, plan: "2046-03-01", count }), POINTS, pl)).toBe(done);
  });
});

describe("rollupText and rollupSentence - Jira's own figures, never converted", () => {
  const base = { children: 12, done: 5, points: 34, observedAt: 1 };
  test("the compact text and the sentence, in both languages", () => {
    expect(rollupText(base, en)).toBe("5/12 · 34 pt");
    expect(rollupSentence(base, en)).toBe("12 child issues in Jira, done: 5, story points: 34");
    expect(rollupText(base, pl)).toBe("5/12 · 34 pkt");
    expect(rollupSentence(base, pl)).toBe("12 zgłoszeń podrzędnych w Jirze, ukończone: 5, punkty: 34");
  });

  test("null points omit the points part; the plural forms follow the children", () => {
    expect(rollupText({ ...base, points: null }, en)).toBe("5/12");
    expect(rollupSentence({ ...base, points: null, children: 1 }, en)).toBe("1 child issue in Jira, done: 5");
    expect(rollupSentence({ ...base, points: null, children: 1 }, pl)).toBe("1 zgłoszenie podrzędne w Jirze, ukończone: 5");
    expect(rollupSentence({ ...base, points: null, children: 3 }, pl)).toBe("3 zgłoszenia podrzędne w Jirze, ukończone: 5");
  });

  test("points keep up to two decimals and drop trailing zeros; zero points are a figure, not an absence", () => {
    expect(formatPoints(7.5)).toBe("7.5");
    expect(formatPoints(13)).toBe("13");
    expect(formatPoints(13.0)).toBe("13");
    expect(formatPoints(0.125)).toBe("0.13");
    expect(rollupText({ ...base, points: 0 }, en)).toBe("5/12 · 0 pt");
  });
});

describe("countDeviations", () => {
  test("counts warnings and infos, and never an estimate that cannot be compared", () => {
    const list: Deviation[] = [
      { kind: "END_DIFFERS", severity: "WARNING", detail: detail() },
      { kind: "RENAMED", severity: "INFO", detail: detail() },
      { kind: "ESTIMATE_NOT_COMPARABLE", severity: "INFO", detail: detail() },
    ];
    expect(countDeviations(list)).toEqual({ warnings: 1, infos: 1 });
    expect(countDeviations([])).toEqual({ warnings: 0, infos: 0 });
  });
});

describe("ageText - how long ago the server last READ the item", () => {
  const now = Date.UTC(2026, 10, 6, 12, 0);
  test.each([
    [30_000, "just now"],
    [60_000, "1 minute ago"],
    [5 * 60_000, "5 minutes ago"],
    [59 * 60_000, "59 minutes ago"],
    [60 * 60_000, "1 hour ago"],
    [23 * 60 * 60_000, "23 hours ago"],
    [24 * 60 * 60_000, "1 day ago"],
    [3 * 24 * 60 * 60_000, "3 days ago"],
    [-5_000, "just now"],
  ])("%i ms ago", (age, expected) => {
    expect(ageText(now - age, now, en)).toBe(expected);
  });

  test("Polish plural forms", () => {
    expect(ageText(now - 2 * 60_000, now, pl)).toBe("2 minuty temu");
    expect(ageText(now - 5 * 60_000, now, pl)).toBe("5 minut temu");
    expect(ageText(now - 22 * 60 * 60_000, now, pl)).toBe("22 godziny temu");
    expect(ageText(now - 5 * 24 * 60 * 60_000, now, pl)).toBe("5 dni temu");
  });
});

describe("hasStaleSource, staleConnection and verifiedAt", () => {
  const ok = DEV_CONNECTION;
  const run = ok.lastRun!;
  test("a missing, failed, abandoned or interrupted newest run of an ENABLED connection makes the list possibly out of date", () => {
    expect(hasStaleSource([ok])).toBe(false);
    expect(hasStaleSource([{ ...ok, lastRun: null }])).toBe(true);
    expect(hasStaleSource([{ ...ok, lastRun: { ...run, outcome: "FAILED", errorCode: "TIMEOUT" } }])).toBe(true);
    expect(hasStaleSource([{ ...ok, lastRun: { ...run, outcome: "ABANDONED" } }])).toBe(true);
    expect(hasStaleSource([{ ...ok, lastRun: { ...run, outcome: null, finishedAt: null, running: false } }])).toBe(true);
  });
  test("a mapping that does not fit makes the list possibly out of date (no level or estimate is compared)", () => {
    expect(hasStaleSource([{ ...ok, mappingOk: false }])).toBe(true);
  });
  test("a running refresh is not stale yet, and a disabled connection is not asked about (it has its own note)", () => {
    expect(hasStaleSource([{ ...ok, lastRun: { ...run, outcome: null, finishedAt: null, running: true } }])).toBe(false);
    expect(hasStaleSource([{ ...ok, enabled: false, lastRun: null }])).toBe(false);
    expect(staleConnection({ ...ok, enabled: false })).toBe(true);
  });
  test("an empty list is called 'no deviations' only for a read: the OLDEST finish, withheld for a disabled, unmapped, failed or never-run connection", () => {
    expect(verifiedAt([ok])).toBe(run.finishedAt);
    const older = { ...ok, id: 2, lastRun: { ...run, id: 3, finishedAt: 5 } };
    expect(verifiedAt([ok, older])).toBe(5);
    expect(verifiedAt([])).toBeNull();
    expect(verifiedAt([ok, { ...ok, id: 2, enabled: false }])).toBeNull();
    expect(verifiedAt([ok, { ...ok, id: 2, mappingOk: false }])).toBeNull();
    expect(verifiedAt([{ ...ok, lastRun: null }])).toBeNull();
    expect(verifiedAt([{ ...ok, lastRun: { ...run, outcome: "FAILED", errorCode: "TIMEOUT" } }])).toBeNull();
  });
});
