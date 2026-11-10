import { describe, expect, test } from "vitest";
import i18n from "../i18n";
import type { Movement, MovementTotals } from "../api/baselines";
import type { RemovedProject } from "../api/roadmap";
import {
  baselineBars,
  baselineDays,
  movementRows,
  movementSentence,
  movementStatus,
  movementTotalsOf,
  movementTotalsParts,
  movementTotalsSentence,
  newSince,
  projectTotals,
  rankTotals,
  rankTotalsParts,
  removedProjectDays,
  removedProjectRows,
  removedRows,
  rowChanged,
  rowSuffix,
  shadowBar,
  signedDays,
  spanBadges,
  type LiveMilestone,
} from "./baselineOverlay";

const t = i18n.getFixedT("en");
const pl = i18n.getFixedT("pl");

const moved = (startDays: number, endDays: number, estimateDelta: number | null = null): Movement => ({ kind: "MOVED", startDays, endDays, estimateDelta });
const plain = (kind: Movement["kind"], estimateDelta: number | null = null): Movement => ({ kind, startDays: null, endDays: null, estimateDelta });
const totals = (over: Partial<MovementTotals>): MovementTotals => ({ unchanged: 0, moved: 0, later: 0, earlier: 0, scheduled: 0, unscheduled: 0, added: 0, removed: 0, ...over });

describe("movementSentence", () => {
  test("both ends by the same amount are said once", () => {
    expect(movementSentence(moved(5, 5), t)).toBe("5 working days later (start and end)");
    expect(movementSentence(moved(-1, -1), t)).toBe("1 working day earlier (start and end)");
  });

  test("different ends say both, an unmoved end says unchanged", () => {
    expect(movementSentence(moved(5, 3), t)).toBe("start 5 working days later, end 3 working days later");
    expect(movementSentence(moved(-2, 0), t)).toBe("start 2 working days earlier, end unchanged");
    expect(movementSentence(moved(0, 1), t)).toBe("start unchanged, end 1 working day later");
    expect(movementSentence(moved(2, -4), t)).toBe("start 2 working days later, end 4 working days earlier");
  });

  test("the kinds without a delta read as the plan words", () => {
    expect(movementSentence(plain("ADDED"), t)).toBe("new since the baseline");
    expect(movementSentence(plain("REMOVED"), t)).toBe("removed since the baseline");
    expect(movementSentence(plain("SCHEDULED"), t)).toBe("scheduled since the baseline");
    expect(movementSentence(plain("UNSCHEDULED"), t)).toBe("unscheduled since the baseline");
  });

  test("an unchanged row is unchanged, unless only its estimate changed", () => {
    expect(movementSentence(moved(0, 0, 0), t)).toBe("start unchanged, end unchanged");
    expect(movementSentence(plain("UNCHANGED", 0), t)).toBe("unchanged");
    expect(movementSentence(plain("UNCHANGED"), t)).toBe("unchanged");
    expect(movementSentence(plain("UNCHANGED", 2.5), t)).toBe("estimate changed");
  });

  test("Polish picks the plural form of the working days", () => {
    expect(movementSentence(moved(1, 1), pl)).toBe("o 1 dzień roboczy później (początek i koniec)");
    expect(movementSentence(moved(2, 2), pl)).toBe("o 2 dni robocze później (początek i koniec)");
    expect(movementSentence(moved(5, 0), pl)).toBe("początek o 5 dni roboczych później, koniec bez zmian");
    expect(movementSentence(moved(-3, -5), pl)).toBe("początek o 3 dni robocze wcześniej, koniec o 5 dni roboczych wcześniej");
  });
});

describe("movementStatus", () => {
  test("a moved row is the ORANGE Later exactly when its end is later", () => {
    expect(movementStatus(moved(0, 3))).toEqual({ key: "later", late: true });
    expect(movementStatus(moved(-2, 3))).toEqual({ key: "later", late: true });
    expect(movementStatus(moved(5, -1))).toEqual({ key: "earlier", late: false });
    expect(movementStatus(moved(4, 0))).toEqual({ key: "moved", late: false });
  });

  test("every other kind is a gray word; an estimate-only change is its own", () => {
    expect(movementStatus(plain("ADDED"))).toEqual({ key: "added", late: false });
    expect(movementStatus(plain("REMOVED"))).toEqual({ key: "removed", late: false });
    expect(movementStatus(plain("SCHEDULED"))).toEqual({ key: "scheduled", late: false });
    expect(movementStatus(plain("UNSCHEDULED"))).toEqual({ key: "unscheduled", late: false });
    expect(movementStatus(plain("UNCHANGED", -1))).toEqual({ key: "estimate", late: false });
    expect(movementStatus(plain("UNCHANGED", 0))).toEqual({ key: "unchanged", late: false });
    expect(movementStatus(plain("UNCHANGED"))).toEqual({ key: "unchanged", late: false });
  });
});

describe("movementTotals", () => {
  test("lists the non-zero figures in reading order, the later ones flagged; the rest of 'moved' is the end-unchanged ones", () => {
    const sample = totals({ moved: 20, later: 14, earlier: 3, added: 2, removed: 1, unchanged: 900 });
    expect(movementTotalsParts(sample, t).map((p) => [p.key, p.late])).toEqual([
      ["later", true],
      ["earlier", false],
      ["movedOther", false],
      ["added", false],
      ["removed", false],
    ]);
    expect(movementTotalsSentence(sample, t)).toBe("14 end later, 3 end earlier, 3 moved, end unchanged, 2 new, 1 removed");
  });

  test("scheduled and unscheduled flips are listed; nothing changed says so", () => {
    expect(movementTotalsSentence(totals({ scheduled: 4, unscheduled: 1 }), t)).toBe("4 newly scheduled, 1 unscheduled");
    expect(movementTotalsSentence(totals({ unchanged: 12 }), t)).toBe("No schedule changes");
    expect(movementTotalsSentence(totals({ unchanged: 12 }), pl)).toBe("Brak zmian w harmonogramie");
  });
});

describe("signedDays", () => {
  test("signs the figure, or a dash for a row not dated on both sides", () => {
    expect(signedDays(5)).toBe("+5");
    expect(signedDays(-2)).toBe("−2");
    expect(signedDays(0)).toBe("0");
    expect(signedDays(null)).toBe("—");
  });
});

// ---- the timelines' overlay (v0.9 C9) ----

describe("the overlay derivations", () => {
  const entry = (milestoneId: number, start: string | null, end: string | null, movement: Movement, estimateMd = 5) => ({ milestoneId, teamIdThen: 1, start, end, estimateMd, movement });
  const gone = (milestoneId: number, name: string, start: string | null, end: string | null, now?: { teamId: number; teamName: string }) => ({
    milestoneId,
    projectId: 7,
    name,
    teamId: 1,
    teamName: "Payments",
    estimateMd: 3,
    start,
    end,
    ...(now === undefined ? {} : { now }),
  });
  const live = (id: number, name: string, over: Partial<LiveMilestone> = {}): LiveMilestone => ({ id, name, projectId: 7, teamName: "Payments", estimateMd: 5, startDate: null, endDate: null, ...over });
  const BASELINE = {
    name: "Q1",
    milestones: [
      entry(1, "2027-01-04", "2027-01-08", moved(5, 5)),
      entry(2, "2027-01-18", "2027-01-22", plain("UNCHANGED", 0)),
      entry(3, "2027-02-01", "2027-02-05", plain("UNSCHEDULED")),
      entry(4, null, null, plain("SCHEDULED")),
    ],
    removed: [gone(9, "Zed", "2027-01-25", "2027-01-26"), gone(8, "Away", "2027-01-25", "2027-01-26", { teamId: 2, teamName: "Billing" }), gone(7, "Dateless", null, null)],
  };

  test("shadowBar is a read-only baseline-toned bar named with its dates and, when it moved, what became of it", () => {
    const bar = shadowBar(1, "Build", { start: "2027-01-04", end: "2027-01-08" }, moved(5, 5), t);
    expect(bar).toMatchObject({ id: "baseline:1", tone: "baseline", editable: false, start: "2027-01-04", end: "2027-01-08" });
    expect(bar.describe).toBe("Baseline: Build, 2027-01-04 to 2027-01-08, 5 working days later (start and end)");
    expect(shadowBar(1, "Build", { start: "2027-01-04", end: "2027-01-08" }, plain("UNCHANGED", 0), t).describe).toBe("Baseline: Build, 2027-01-04 to 2027-01-08");
    expect(shadowBar(1, "Build", { start: "2027-01-04", end: "2027-01-08" }, null, t).describe).toBe("Baseline: Build, 2027-01-04 to 2027-01-08");
    expect(shadowBar("ws:1", "Platform", { start: "2027-01-04", end: "2027-01-08" }, null, t).id).toBe("baseline:ws:1");
  });

  test("baselineBars holds one bar per live milestone the baseline had scheduled", () => {
    const bars = baselineBars(BASELINE, [live(1, "A"), live(2, "B"), live(3, "C"), live(4, "D"), live(5, "E")], t);
    expect([...bars.keys()]).toEqual([1, 2, 3]);
    expect(bars.get(1)?.label).toBe("A");
  });

  test("newSince is the live milestones the baseline did not freeze", () => {
    expect([...newSince(BASELINE, [live(1, "A"), live(5, "E"), live(6, "F")])]).toEqual([5, 6]);
  });

  test("removedRows appends the gone and the unscheduled-since milestones in (start, end, name) order; undated ones have no row", () => {
    const rows = removedRows(BASELINE, [live(3, "Gamma", { projectName: "Invoices" }), live(4, "Delta")], t);
    expect(rows.map((row) => [row.id, row.name, row.reason, row.movedTo])).toEqual([
      ["baseline-removed:8", "Away", "moved", "Billing"],
      ["baseline-removed:9", "Zed", "removed", null],
      ["baseline-removed:3", "Gamma", "unscheduled", null],
    ]);
    expect(rows[2]).toMatchObject({ projectName: "Invoices", projectId: 7 });
    expect(rows[2].bar.describe).toBe("Baseline: Gamma, 2027-02-01 to 2027-02-05, unscheduled since the baseline");
    expect(rows.map((row) => rowSuffix(row, t))).toEqual(["(moved to Billing)", "(removed)", "(unscheduled since the baseline)"]);
  });

  test("removedProjectRows: a project without a span has no row; the rest follow in (start, end, name, id) order with the shadow bar of the project id", () => {
    const gone = (projectId: number, name: string, span: RemovedProject["span"]): RemovedProject => ({ projectId, name, programId: 10, programName: "Billing", workStreamId: 1, workStreamName: "Platform", span });
    const removed = [
      gone(5, "zeta", { start: "2027-03-01", end: "2027-03-12" }),
      gone(6, "Spanless", null),
      gone(7, "Alpha", { start: "2027-03-01", end: "2027-03-12" }),
      gone(4, "Early", { start: "2027-02-01", end: "2027-02-05" }),
      gone(3, "Alpha", { start: "2027-03-01", end: "2027-03-12" }),
    ];
    const rows = removedProjectRows(removed, t);
    expect(rows.map((row) => [row.id, row.name])).toEqual([
      ["baseline-removed-project:4", "Early"],
      ["baseline-removed-project:3", "Alpha"],
      ["baseline-removed-project:7", "Alpha"],
      ["baseline-removed-project:5", "zeta"],
    ]);
    expect(rows[0]).toMatchObject({ projectId: 4, programId: 10, programName: "Billing", workStreamId: 1, workStreamName: "Platform" });
    expect(rows[0].bar).toMatchObject({ id: "baseline:4", tone: "baseline", editable: false, start: "2027-02-01", end: "2027-02-05" });
    expect(rows[0].bar.describe).toBe("Baseline: Early, 2027-02-01 to 2027-02-05");
    expect(removedProjectRows([], t)).toEqual([]);
    expect(removedProjectDays(removed)).toEqual(["2027-03-01", "2027-03-12", "2027-03-01", "2027-03-12", "2027-02-01", "2027-02-05", "2027-03-01", "2027-03-12"]);
    expect(removedProjectDays(undefined)).toEqual([]);
  });

  test("baselineDays lists every frozen day, the removed milestones' and the project's own span included", () => {
    expect(baselineDays(undefined)).toEqual([]);
    expect(baselineDays({ ...BASELINE, project: { span: { start: "2026-12-01", end: "2027-03-01" }, movement: plain("UNCHANGED") } })).toEqual([
      "2027-01-04", "2027-01-08", "2027-01-18", "2027-01-22", "2027-02-01", "2027-02-05", "2027-01-25", "2027-01-26", "2027-01-25", "2027-01-26", "2026-12-01", "2027-03-01",
    ]);
  });

  test("movementRows: a live milestone without an entry is ADDED, a gone one REMOVED (a moved-away one reads Moved), the estimate-only change counts as changed", () => {
    const rows = movementRows(
      { ...BASELINE, milestones: [...BASELINE.milestones, entry(5, "2027-03-01", "2027-03-02", plain("UNCHANGED", 2.5), 5)] },
      [live(1, "A", { startDate: "2027-01-11", endDate: "2027-01-15" }), live(5, "E", { startDate: "2027-03-01", endDate: "2027-03-02" }), live(6, "F", { startDate: "2027-04-01", endDate: "2027-04-02" })],
    );
    expect(rows.map((row) => [row.name, row.movement.kind, row.status.key, rowChanged(row)])).toEqual([
      ["A", "MOVED", "later", true],
      ["E", "UNCHANGED", "estimate", true],
      ["F", "ADDED", "added", true],
      ["Zed", "REMOVED", "removed", true],
      ["Away", "REMOVED", "moved", true],
      ["Dateless", "REMOVED", "removed", true],
    ]);
    expect(rows[4].movedTo).toBe("Billing");
    const unchanged = movementRows({ milestones: [entry(2, "2027-01-18", "2027-01-22", plain("UNCHANGED", 0))], removed: [] }, [live(2, "B", { startDate: "2027-01-18", endDate: "2027-01-22" })]);
    expect(unchanged.map(rowChanged)).toEqual([false]);
    const estimate = movementRows({ milestones: [entry(2, "2027-01-18", "2027-01-22", plain("UNCHANGED", 3))], removed: [] }, [live(2, "B", { startDate: "2027-01-18", endDate: "2027-01-22" })]);
    expect(estimate.map((row) => [row.status.key, rowChanged(row)])).toEqual([["estimate", true]]);
  });

  test("movementTotalsOf counts by kind, later/earlier being the moved rows whose end is later/earlier", () => {
    expect(movementTotalsOf([moved(1, 2), moved(0, -1), moved(3, 0), plain("ADDED"), plain("REMOVED"), plain("SCHEDULED"), plain("UNSCHEDULED"), plain("UNCHANGED")])).toEqual(
      totals({ unchanged: 1, moved: 3, later: 1, earlier: 1, added: 1, removed: 1, scheduled: 1, unscheduled: 1 }),
    );
  });

  test("projectTotals: a project without a baseline block is new, one with it counts by its movement, the gone ones are added", () => {
    expect(projectTotals([{ baseline: { movement: moved(0, 4) } }, { baseline: { movement: plain("UNCHANGED") } }, {}], 2)).toEqual(totals({ moved: 1, later: 1, unchanged: 1, added: 1, removed: 2 }));
  });

  test("spanBadges: ORANGE only when the end is later; a project newer than the baseline and a (un)scheduled span say so", () => {
    expect(spanBadges({ span: null, movement: moved(0, 3) }, t)).toEqual([{ key: "end", label: "Ends 3 working days later than the baseline", late: true }]);
    expect(spanBadges({ span: null, movement: moved(-1, -2) }, t)).toEqual([
      { key: "end", label: "Ends 2 working days earlier than the baseline", late: false },
      { key: "start", label: "Starts 1 working day earlier than the baseline", late: false },
    ]);
    expect(spanBadges({ span: null, movement: moved(2, 0) }, t)).toEqual([{ key: "start", label: "Starts 2 working days later than the baseline", late: false }]);
    expect(spanBadges({ span: null, movement: moved(0, 0) }, t)).toEqual([]);
    expect(spanBadges({ span: null, movement: plain("UNCHANGED") }, t)).toEqual([]);
    expect(spanBadges(null, t)).toEqual([{ key: "new", label: "Project is new since the baseline", late: false }]);
    expect(spanBadges({ span: null, movement: plain("SCHEDULED") }, t)).toEqual([{ key: "sentence", label: "Project scheduled since the baseline", late: false }]);
    expect(spanBadges({ span: null, movement: plain("UNSCHEDULED") }, t)).toEqual([{ key: "sentence", label: "Project unscheduled since the baseline", late: false }]);
    expect(spanBadges({ span: null, movement: plain("SCHEDULED") }, pl)[0].label).toBe("Projekt: zaplanowany od utworzenia bazy odniesienia");
    expect(spanBadges({ span: null, movement: plain("UNSCHEDULED") }, pl)[0].label).toBe("Projekt: wycofany z harmonogramu od utworzenia bazy odniesienia");
    expect(spanBadges({ span: null, movement: moved(0, 2) }, pl)[0].label).toBe("Koniec o 2 dni robocze później niż w bazie odniesienia");
  });
});

describe("rankTotals", () => {
  const row = (rankPosition: number | null, was: number | null | "new") => (was === "new" ? { rankPosition } : { rankPosition, baseline: { rankPosition: was } });

  test("counts up (a smaller position), down, newly ranked and no longer ranked; an unchanged rank and a project newer than the baseline add nothing", () => {
    const projects = [row(1, 3), row(2, 5), row(6, 4), row(4, 4), row(null, null), row(3, null), row(null, 2), row(1, "new"), row(null, "new")];
    expect(rankTotals(projects)).toEqual({ up: 2, down: 1, ranked: 1, unranked: 1 });
    expect(rankTotals([])).toEqual({ up: 0, down: 0, ranked: 0, unranked: 0 });
  });

  test("the labels name only the non-zero figures, in reading order, in both languages", () => {
    expect(rankTotalsParts({ up: 2, down: 1, ranked: 0, unranked: 3 }, t)).toEqual([
      { key: "up", label: "2 moved up in rank" },
      { key: "down", label: "1 moved down in rank" },
      { key: "unranked", label: "3 no longer ranked" },
    ]);
    expect(rankTotalsParts({ up: 0, down: 0, ranked: 0, unranked: 0 }, t)).toEqual([]);
    expect(rankTotalsParts({ up: 1, down: 0, ranked: 2, unranked: 0 }, pl).map((part) => part.label)).toEqual(["Wyżej w rankingu: 1", "Nowo w rankingu: 2"]);
  });
});
