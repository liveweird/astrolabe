import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useTimelineColumns } from "./useTimelineColumns";
import type { TimelineColumn } from "../utils/timelineModel";

const KEY = (page: string) => `astrolabe.viewSettings.timeline.columns.${page}`;
const COLUMNS: TimelineColumn[] = [
  { id: "name", header: "Name", width: 220 },
  { id: "team", header: "Team", width: 130, hideable: true },
  { id: "estimate", header: "Estimate", width: 120, hideable: true },
  { id: "ops", header: "Operations", width: 56 },
];
const hiddenOf = (view: { hidden: ReadonlySet<string> }) => [...view.hidden].sort();

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe("useTimelineColumns", () => {
  test("a first visit shows everything and writes nothing", () => {
    const { result } = renderHook(() => useTimelineColumns("project", COLUMNS));
    expect(hiddenOf(result.current)).toEqual([]);
    expect(result.current.offered.map((column) => column.id)).toEqual(["team", "estimate"]);
    expect(result.current.allHidden).toBe(false);
    expect(localStorage).toHaveLength(0);
  });

  test("the row header and the last column are never offered, even when marked hideable", () => {
    const marked = COLUMNS.map((column) => ({ ...column, hideable: true }));
    const { result } = renderHook(() => useTimelineColumns("project", marked));
    expect(result.current.offered.map((column) => column.id)).toEqual(["team", "estimate"]);
    act(() => result.current.toggleAll());
    expect(hiddenOf(result.current)).toEqual(["estimate", "team"]);
  });

  test("a page with nothing hideable offers nothing and is never all hidden", () => {
    const { result } = renderHook(() => useTimelineColumns("project", [COLUMNS[0], COLUMNS[3]]));
    expect(result.current.offered).toEqual([]);
    expect(result.current.allHidden).toBe(false);
  });

  test("the toggle collapses and expands, and each page type keeps its own key", () => {
    const project = renderHook(() => useTimelineColumns("project", COLUMNS));
    const team = renderHook(() => useTimelineColumns("team", COLUMNS));
    act(() => project.result.current.toggleAll());
    expect(hiddenOf(project.result.current)).toEqual(["estimate", "team"]);
    expect(project.result.current.allHidden).toBe(true);
    expect(JSON.parse(localStorage.getItem(KEY("project")) ?? "null")).toEqual({ collapsed: true, hidden: [] });
    expect(localStorage.getItem(KEY("team"))).toBeNull();
    expect(hiddenOf(team.result.current)).toEqual([]);
    act(() => project.result.current.toggleAll());
    expect(hiddenOf(project.result.current)).toEqual([]);
  });

  test("setShown hides what is not shown", () => {
    const { result } = renderHook(() => useTimelineColumns("roadmap", COLUMNS));
    act(() => result.current.setShown(["estimate"]));
    expect(hiddenOf(result.current)).toEqual(["team"]);
    expect(JSON.parse(localStorage.getItem(KEY("roadmap")) ?? "null")).toEqual({ collapsed: false, hidden: ["team"] });
  });

  test("a remount reads the stored choice", () => {
    const first = renderHook(() => useTimelineColumns("programs", COLUMNS));
    act(() => first.result.current.setShown(["team"]));
    first.unmount();
    expect(hiddenOf(renderHook(() => useTimelineColumns("programs", COLUMNS)).result.current)).toEqual(["estimate"]);
  });

  test.each(["{not json", "42", "{\"collapsed\":\"yes\",\"hidden\":[]}", "{\"collapsed\":true}"])("a stored value that is no choice (%s) is ignored", (raw) => {
    localStorage.setItem(KEY("team"), raw);
    expect(hiddenOf(renderHook(() => useTimelineColumns("team", COLUMNS)).result.current)).toEqual([]);
  });

  test("without a usable localStorage the choice still works for the page", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    const { result } = renderHook(() => useTimelineColumns("project", COLUMNS));
    act(() => result.current.toggleAll());
    expect(result.current.allHidden).toBe(true);
  });
});
