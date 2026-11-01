import { describe, expect, test } from "vitest";
import i18n from "../i18n";
import type { RoadmapProject } from "../api/roadmap";
import { projectOfWindowBar, projectTrack, windowBarId } from "./planTrack";

const t = i18n.t;

const project = (over: Partial<RoadmapProject> = {}): RoadmapProject => ({
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
    const track = projectTrack(project(), t, none);
    expect(track.bars.map((bar) => [bar.id, bar.editable, bar.tone])).toEqual([
      ["window:7", true, "window"],
      [7, false, "summary"],
    ]);
    expect(track.draw).toBeUndefined();
  });

  test("with the right and no window: the draw surface names the bar the window will have; the span bar stays read-only", () => {
    const track = projectTrack(project({ targetStart: null, targetEnd: null, drift: null }), t, none);
    expect(track.bars.map((bar) => bar.id)).toEqual([7]);
    expect(track.draw).toEqual({ barId: "window:7", label: "Invoices" });
  });

  test("without the right: a read-only window bar and never a draw surface", () => {
    const track = projectTrack(project({ can: { editTargetWindow: false } }), t, none);
    expect(track.bars[0]).toMatchObject({ id: "window:7", editable: false });
    expect(projectTrack(project({ targetStart: null, targetEnd: null, can: { editTargetWindow: false } }), t, none).draw).toBeUndefined();
  });

  test("the drift band is the server's, past the window", () => {
    expect(projectTrack(project(), t, none).bands).toEqual([{ id: "drift:7", start: "2026-04-01", end: "2026-04-10", label: "10 days past the target end", tone: "drift" }]);
  });
});
