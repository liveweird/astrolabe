import { describe, expect, test } from "vitest";
import i18n from "../i18n";
import type { RoadmapProject } from "../api/roadmap";
import type { JiraWindow } from "./jiraBars";
import { projectOfWindowBar, projectTrack, windowBarId } from "./planTrack";

const t = i18n.t;

const project = (over: Partial<RoadmapProject> = {}): RoadmapProject => ({
  jira: null,
  id: 7,
  name: "Invoices",
  programId: 10,
  programName: "Billing",
  workStreamId: 1,
  workStreamName: "Platform",
  ownerPersonId: 5,
  ownerName: "Ola",
  targetStart: "2026-02-02",
  targetEnd: "2026-03-31",
  rankPosition: null,
  teamIds: [],
  span: { start: "2026-03-02", end: "2026-04-10" },
  drift: { startDays: 28, endDays: 10 },
  flags: [],
  can: { editTargetWindow: true },
  ...over,
});

const none = new Map<number, number>();

describe("the window bar's id", () => {
  test("round-trips; any other bar id is not a window", () => {
    expect(windowBarId(7)).toBe("window:7");
    expect(projectOfWindowBar("window:7")).toBe(7);
    expect(projectOfWindowBar("7")).toBeNull();
    expect(projectOfWindowBar(7)).toBeNull();
    expect(projectOfWindowBar("window:")).toBeNull();
    expect(projectOfWindowBar("window:7:x")).toBeNull();
    expect(projectOfWindowBar("pg:7")).toBeNull();
  });
});

describe("projectTrack: what the viewer may do with the window", () => {
  test("with the right: an editable window bar and no draw (there is a window)", () => {
    const track = projectTrack(project(), t, none, null);
    expect(track.bars.map((bar) => [bar.id, bar.editable, bar.tone])).toEqual([
      ["window:7", true, "window"],
      [7, false, "summary"],
    ]);
    expect(track.draw).toBeUndefined();
  });

  test("with the right and no window: the draw surface names the bar the window will have; the span bar stays read-only", () => {
    const track = projectTrack(project({ targetStart: null, targetEnd: null, drift: null }), t, none, null);
    expect(track.bars.map((bar) => bar.id)).toEqual([7]);
    expect(track.draw).toEqual({ barId: "window:7", label: "Invoices" });
  });

  test("without the right: a read-only window bar and never a draw surface", () => {
    const track = projectTrack(project({ can: { editTargetWindow: false } }), t, none, null);
    expect(track.bars[0]).toMatchObject({ id: "window:7", editable: false });
    expect(projectTrack(project({ targetStart: null, targetEnd: null, can: { editTargetWindow: false } }), t, none, null).draw).toBeUndefined();
  });

  test("the drift band is the server's, past the window", () => {
    expect(projectTrack(project(), t, none, null).bands).toEqual([{ id: "drift:7", start: "2026-04-01", end: "2026-04-10", label: "10 days past the target end", tone: "drift" }]);
  });
});

describe("projectTrack: the Jira shadow bar (1.3)", () => {
  const WINDOW: JiraWindow = { from: "2025-02-02", to: "2027-04-10" };
  const link = { bindingId: 3, connectionId: 2, issueKey: "E2E-6", start: "2026-03-09", end: "2026-04-03" };
  const lateEnd = {
    kind: "JIRA_DEVIATION" as const,
    severity: "WARNING" as const,
    days: null,
    teamId: null,
    otherProjectId: null,
    count: null,
    deviation: { kind: "END_DIFFERS" as const, severity: "WARNING" as const, detail: { plan: "2026-04-10", jira: "2026-04-03", days: 5, count: null } },
  };

  test("while shown: the bar jira:<id> from the link's dates, read-only, after the span bar", () => {
    const track = projectTrack(project({ jira: link }), t, none, WINDOW);
    expect(track.bars.map((bar) => [bar.id, bar.tone])).toEqual([
      ["window:7", "window"],
      [7, "summary"],
      ["jira:7", "jira"],
    ]);
    expect(track.bars[2]).toMatchObject({ start: "2026-03-09", end: "2026-04-03", editable: false, label: "Invoices", describe: "Jira E2E-6: 2026-03-09 to 2026-04-03" });
  });

  test("hidden by the toggle, unbound, or with a date Jira does not hold: no bar", () => {
    expect(projectTrack(project({ jira: link }), t, none, null).bars.map((bar) => bar.id)).toEqual(["window:7", 7]);
    expect(projectTrack(project(), t, none, WINDOW).bars.map((bar) => bar.id)).toEqual(["window:7", 7]);
    for (const partial of [{ start: null }, { end: null }, { start: null, end: null }]) {
      expect(projectTrack(project({ jira: { ...link, ...partial } }), t, none, WINDOW).bars.map((bar) => bar.id)).toEqual(["window:7", 7]);
    }
  });

  test("a project with no span still draws its Jira bar (the dates are Jira's)", () => {
    expect(projectTrack(project({ jira: link, span: null }), t, none, WINDOW).bars.map((bar) => bar.id)).toEqual(["window:7", "jira:7"]);
  });

  test("the bar's name carries the row's open DATE deviations and nothing else", () => {
    const level = { ...lateEnd, deviation: { kind: "LEVEL_MISMATCH" as const, severity: "WARNING" as const, detail: { plan: "2", jira: "3", days: null, count: null } } };
    const roll = { ...lateEnd, kind: "JIRA_MILESTONES" as const, deviation: null, count: 2 };
    const bar = projectTrack(project({ jira: link, flags: [level, roll, lateEnd] }), t, none, WINDOW).bars.at(-1);
    expect(bar?.describe).toBe("Jira E2E-6: 2026-03-09 to 2026-04-03, Ends 5 working days later than Jira (plan 2026-04-10, Jira 2026-04-03)");
  });

  test("a mistyped Jira date is cut at the window: the bar ends at its edge, the name keeps the real dates; a range wholly outside draws nothing", () => {
    const bar = projectTrack(project({ jira: { ...link, end: "2206-04-03" } }), t, none, WINDOW).bars.at(-1);
    expect(bar).toMatchObject({ id: "jira:7", start: "2026-03-09", end: "2027-04-10", describe: "Jira E2E-6: 2026-03-09 to 2206-04-03" });
    const early = projectTrack(project({ jira: { ...link, start: "1906-03-09" } }), t, none, WINDOW).bars.at(-1);
    expect(early).toMatchObject({ start: "2025-02-02", end: "2026-04-03", describe: "Jira E2E-6: 1906-03-09 to 2026-04-03" });
    expect(projectTrack(project({ jira: { ...link, start: "2206-03-09", end: "2206-04-03" } }), t, none, WINDOW).bars.map((b) => b.id)).toEqual(["window:7", 7]);
  });

  test("coexists with the baseline's shadow bar, after it", () => {
    const frozen = { span: { start: "2026-03-02", end: "2026-04-01" }, movement: { kind: "MOVED" as const, startDays: 0, endDays: 5, estimateDelta: null }, rankPosition: null, targetStart: null, targetEnd: null };
    expect(projectTrack(project({ jira: link, baseline: frozen }), t, none, WINDOW).bars.map((bar) => bar.tone)).toEqual(["window", "summary", "baseline", "jira"]);
  });
});
