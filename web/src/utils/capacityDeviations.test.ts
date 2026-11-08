import { describe, expect, test } from "vitest";
import i18n from "../i18n";
import type { CapacityDeviation } from "../api/capacityDeviations";
import { CAPACITY_CONNECTION, GONE_ROW, differsRow, missingRow } from "../test/flow";
import {
  capacityDeviationSentence,
  capacityEntries,
  capacityKindLabel,
  countCapacityDeviations,
  formatMd,
  hasStaleFlowSource,
  sprintLabel,
  staleFlowConnection,
  verifiedFlowAt,
} from "./capacityDeviations";

const en = i18n.getFixedT("en");
const pl = i18n.getFixedT("pl");
const SPRINT = "E2E Flow Sprint 2 (2047-01-21 – 2047-02-01)";

describe("capacityDeviationSentence - CAPACITY_DIFFERS (a positive gap = the plan has more)", () => {
  test("the plan has more: the figures with two decimals, the gap as a positive number", () => {
    const row = differsRow();
    expect(capacityDeviationSentence(row, en)).toBe(`${SPRINT}: the plan has 36.00 man-days, Flow 30.00 — 6.00 more in the plan`);
    expect(capacityDeviationSentence(row, pl)).toBe(`${SPRINT}: w planie jest 36.00 osobodni, we Flow 30.00 — o 6.00 osobodni więcej w planie`);
  });

  test("the plan has less: the gap is said without its sign", () => {
    const row = differsRow({ planMd: 44, flowMd: 48, flowTotalMd: 48 });
    expect(row.severity).toBe("INFO");
    expect(capacityDeviationSentence(row, en)).toBe(`${SPRINT}: the plan has 44.00 man-days, Flow 48.00 — 4.00 less in the plan`);
    expect(capacityDeviationSentence(row, pl)).toBe(`${SPRINT}: w planie jest 44.00 osobodni, we Flow 48.00 — o 4.00 osobodni mniej w planie`);
  });

  test("a fixed per-sprint figure that shares days names Flow's whole-sprint total as well; an equal total adds nothing", () => {
    const shared = differsRow({ planMd: 30, flowMd: 22, flowTotalMd: 44 });
    expect(capacityDeviationSentence(shared, en)).toBe(`${SPRINT}: the plan has 30.00 man-days, Flow 22.00 — 8.00 more in the plan. Flow plans 44.00 man-days for the whole sprint; 22.00 fall on the days it holds here.`);
    expect(capacityDeviationSentence(shared, pl)).toBe(
      `${SPRINT}: w planie jest 30.00 osobodni, we Flow 22.00 — o 8.00 osobodni więcej w planie. Flow planuje 44.00 osobodni na cały sprint; na dni, które sprint zajmuje w planie, przypada 22.00.`,
    );
    expect(capacityDeviationSentence(differsRow({ flowTotalMd: 30 }), en)).not.toContain("whole sprint");
    // Totals that differ only below the second decimal are the same figure.
    expect(capacityDeviationSentence(differsRow({ flowTotalMd: 30.001 }), en)).not.toContain("whole sprint");
    expect(capacityDeviationSentence(differsRow({ flowTotalMd: null }), en)).not.toContain("whole sprint");
  });

  test("a figure the server left out degrades to the kind label, never to an invented number", () => {
    const bare: CapacityDeviation = { ...differsRow(), detail: { ...differsRow().detail, planMd: null } };
    expect(capacityDeviationSentence(bare, en)).toBe("Capacity");
    expect(capacityDeviationSentence(bare, pl)).toBe("Przepustowość");
  });
});

describe("capacityDeviationSentence - the other kinds", () => {
  test("no capacity in the plan names Flow's figure; without it, only the sprint", () => {
    const row = missingRow(90002, "2047-01-21", "2047-02-01", { sprintName: "E2E Flow Sprint 2" });
    expect(capacityDeviationSentence(row, en)).toBe(`${SPRINT}: no capacity in the plan, Flow has 40.00 man-days`);
    expect(capacityDeviationSentence(row, pl)).toBe(`${SPRINT}: brak przepustowości w planie, Flow podaje 40.00 osobodni`);
    const bare = missingRow(90002, "2047-01-21", "2047-02-01", { sprintName: "E2E Flow Sprint 2", flowMd: null });
    expect(capacityDeviationSentence(bare, en)).toBe(`${SPRINT}: no capacity in the plan`);
    expect(capacityDeviationSentence(bare, pl)).toBe(`${SPRINT}: brak przepustowości w planie`);
  });

  test("a Flow team that left the document", () => {
    expect(capacityDeviationSentence(GONE_ROW, en)).toBe("The Flow team is no longer in Flow's document");
    expect(capacityDeviationSentence(GONE_ROW, pl)).toBe("Zespołu Flow nie ma już w danych Flow");
  });

  test("the badge words", () => {
    expect(capacityKindLabel("CAPACITY_DIFFERS", en)).toBe("Capacity");
    expect(capacityKindLabel("CAPACITY_MISSING", en)).toBe("No capacity");
    expect(capacityKindLabel("TEAM_GONE", en)).toBe("Gone from Flow");
    expect(capacityKindLabel("CAPACITY_MISSING", pl)).toBe("Brak przepustowości");
    expect(capacityKindLabel("TEAM_GONE", pl)).toBe("Nie ma we Flow");
  });
});

describe("sprintLabel", () => {
  test("Flow's name with the dates when both are known; an unnamed sprint reads by its id; no id, just Sprint", () => {
    expect(sprintLabel(differsRow().detail, en)).toBe(SPRINT);
    expect(sprintLabel(differsRow({ end: null }).detail, en)).toBe("E2E Flow Sprint 2");
    expect(sprintLabel(differsRow({ sprintName: null }).detail, en)).toBe("Sprint 90002 (2047-01-21 – 2047-02-01)");
    expect(sprintLabel(differsRow({ sprintName: null, sprintId: null }).detail, pl)).toBe("Sprint (2047-01-21 – 2047-02-01)");
  });

  test("man-days always carry two decimals and a dot", () => {
    expect(formatMd(6)).toBe("6.00");
    expect(formatMd(0.5)).toBe("0.50");
    expect(formatMd(1234.5)).toBe("1234.50");
  });
});

describe("the sprint-count wording (plural forms of both languages)", () => {
  test.each([
    [1, "1 sprint without capacity in the plan (from 2047-01-07)", "1 sprint bez przepustowości w planie (od 2047-01-07)"],
    [2, "2 sprints without capacity in the plan (from 2047-01-07)", "2 sprinty bez przepustowości w planie (od 2047-01-07)"],
    [5, "5 sprints without capacity in the plan (from 2047-01-07)", "5 sprintów bez przepustowości w planie (od 2047-01-07)"],
    [22, "22 sprints without capacity in the plan (from 2047-01-07)", "22 sprinty bez przepustowości w planie (od 2047-01-07)"],
  ])("%i folded sprints", (count, english, polish) => {
    expect(en("deviations.capacity.missingSummary", { count, date: "2047-01-07" })).toBe(english);
    expect(pl("deviations.capacity.missingSummary", { count, date: "2047-01-07" })).toBe(polish);
  });

  test.each([
    [1, "Differs from Flow for 1 sprint", "Różni się od Flow dla 1 sprintu"],
    [2, "Differs from Flow for 2 sprints", "Różni się od Flow dla 2 sprintów"],
    [5, "Differs from Flow for 5 sprints", "Różni się od Flow dla 5 sprintów"],
  ])("the team page's count for %i sprints", (count, english, polish) => {
    expect(en("flow.panel.capacity.differs", { count })).toBe(english);
    expect(pl("flow.panel.capacity.differs", { count })).toBe(polish);
  });

  test.each([
    [1, "of which 1 team gone from Flow", "w tym 1 zespół zniknął z Flow"],
    [3, "of which 3 teams gone from Flow", "w tym 3 zespoły zniknęły z Flow"],
    [7, "of which 7 teams gone from Flow", "w tym 7 zespołów zniknęło z Flow"],
  ])("the totals badge for %i gone teams", (count, english, polish) => {
    expect(en("deviations.flowSection.totals.gone", { count })).toBe(english);
    expect(pl("deviations.flowSection.totals.gone", { count })).toBe(polish);
  });
});

describe("countCapacityDeviations", () => {
  test("counts the sprints that differ (and the ones the plan has more for), the ones without capacity, and the gone flag", () => {
    const rows = [differsRow(), differsRow({ planMd: 20 }), missingRow(90003, "2047-02-04", "2047-02-15"), missingRow(90004, "2047-02-18", "2047-03-01")];
    expect(countCapacityDeviations(rows)).toEqual({ differs: 2, warnings: 1, missing: 2, gone: false });
    expect(countCapacityDeviations([GONE_ROW])).toEqual({ differs: 0, warnings: 0, missing: 0, gone: true });
    expect(countCapacityDeviations([])).toEqual({ differs: 0, warnings: 0, missing: 0, gone: false });
  });
});

describe("capacityEntries", () => {
  test("the sprints without capacity are ONE entry at the place of the first, from the earliest day they hold; warnings come before infos", () => {
    const info = differsRow({ sprintId: 90001, planMd: 20, start: "2047-01-07", end: "2047-01-18" });
    const first = missingRow(90002, "2047-01-21", "2047-02-01");
    const second = missingRow(90003, "2047-02-04", "2047-02-15");
    const warning = differsRow({ sprintId: 90004, start: "2047-02-18", end: "2047-03-01" });
    const entries = capacityEntries([info, first, second, warning]);
    expect(entries.map((entry) => entry.type)).toEqual(["row", "row", "missing"]);
    expect(entries[0]).toMatchObject({ type: "row", deviation: warning });
    expect(entries[1]).toMatchObject({ type: "row", deviation: info });
    expect(entries[2]).toMatchObject({ type: "missing", rows: [first, second], from: "2047-01-21" });
  });

  test("the day a folded sprint holds is its effective start, falling back to its start; none known is null", () => {
    expect(capacityEntries([missingRow(1, "2047-03-04", "2047-03-15", { effectiveFrom: "2047-03-05" }), missingRow(2, "2047-03-18", "2047-03-29")])[0]).toMatchObject({ from: "2047-03-05" });
    expect(capacityEntries([missingRow(1, "2047-03-04", "2047-03-15", { effectiveFrom: null, start: null })])[0]).toMatchObject({ from: null });
  });

  test("a team gone is the one warning row; nothing is nothing", () => {
    expect(capacityEntries([GONE_ROW])).toEqual([{ type: "row", key: "TEAM_GONE:team", deviation: GONE_ROW }]);
    expect(capacityEntries([])).toEqual([]);
  });
});

describe("how current the figures are", () => {
  const failed = { ...CAPACITY_CONNECTION, status: { ...CAPACITY_CONNECTION.status, state: "FAILED" as const } };
  const never = { ...CAPACITY_CONNECTION, status: { ...CAPACITY_CONNECTION.status, state: "NEVER_SYNCED" as const, lastRun: null, lastSucceededAt: null } };

  test("a connection is stale when it is disabled or anything but CURRENT", () => {
    expect(staleFlowConnection(CAPACITY_CONNECTION)).toBe(false);
    expect(staleFlowConnection({ ...CAPACITY_CONNECTION, enabled: false })).toBe(true);
    expect(staleFlowConnection(failed)).toBe(true);
    expect(staleFlowConnection(never)).toBe(true);
    expect(staleFlowConnection({ ...CAPACITY_CONNECTION, status: { ...CAPACITY_CONNECTION.status, state: "STALE" } })).toBe(true);
  });

  test("a stale ENABLED connection makes the section possibly out of date; a disabled one has its own note", () => {
    expect(hasStaleFlowSource([CAPACITY_CONNECTION])).toBe(false);
    expect(hasStaleFlowSource([CAPACITY_CONNECTION, failed])).toBe(true);
    expect(hasStaleFlowSource([{ ...CAPACITY_CONNECTION, enabled: false }])).toBe(false);
  });

  test("'in line' is dated by the OLDEST success and withheld when any connection is stale, disabled or has no success", () => {
    const older = { ...CAPACITY_CONNECTION, id: 2, status: { ...CAPACITY_CONNECTION.status, lastSucceededAt: 1_000 } };
    expect(verifiedFlowAt([CAPACITY_CONNECTION])).toBe(CAPACITY_CONNECTION.status.lastSucceededAt);
    expect(verifiedFlowAt([CAPACITY_CONNECTION, older])).toBe(1_000);
    expect(verifiedFlowAt([])).toBeNull();
    expect(verifiedFlowAt([CAPACITY_CONNECTION, failed])).toBeNull();
    expect(verifiedFlowAt([CAPACITY_CONNECTION, never])).toBeNull();
    expect(verifiedFlowAt([CAPACITY_CONNECTION, { ...CAPACITY_CONNECTION, id: 3, enabled: false }])).toBeNull();
  });
});
