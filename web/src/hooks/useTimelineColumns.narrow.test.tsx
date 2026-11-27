import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useTimelineColumns } from "./useTimelineColumns";
import type { TimelineColumn } from "../utils/timelineModel";

// A phone-width scroller: the fit leaves the extra columns out for the session, and the control's view describes what is drawn.
const KEY = "astrolabe.viewSettings.timeline.columns.project";
const COLUMNS: TimelineColumn[] = [
  { id: "name", header: "Milestone", width: 220 },
  { id: "team", header: "Team", width: 130, hideable: true },
  { id: "estimate", header: "Estimate", width: 120, hideable: true },
  { id: "flags", header: "Flags", width: 130, hideable: true },
  { id: "ops", header: "Operations", width: 56 },
];
const ids = (set: ReadonlySet<string>) => [...set].sort();
const stored = () => JSON.parse(localStorage.getItem(KEY) ?? "null");

/** The hook on a scroller of `width` px (the ref is attached during render, before the layout effect measures it). */
function onScroller(width: number) {
  const scroller = document.createElement("div");
  Object.defineProperty(scroller, "clientWidth", { configurable: true, value: width });
  return renderHook(() => {
    const view = useTimelineColumns("project", COLUMNS);
    view.scrollRef.current = scroller;
    return view;
  });
}

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe("useTimelineColumns on a narrow scroller", () => {
  test("the fit leaves the columns out, the view says so, and nothing is stored", () => {
    const { result } = onScroller(358);
    expect(ids(result.current.hidden)).toEqual(["estimate", "flags", "team"]);
    expect(result.current.allHidden).toBe(true);
    expect(result.current.columns.find((column) => column.id === "name")?.width).toBe(141);
    expect(localStorage).toHaveLength(0);
  });

  test("a wide scroller changes nothing", () => {
    const { result } = onScroller(900);
    expect(result.current.hidden.size).toBe(0);
    expect(result.current.columns).toBe(COLUMNS);
  });

  test("a tick draws the column the fit dropped, the pane gives way, and the stored choice is not touched", () => {
    const { result } = onScroller(358);
    act(() => result.current.setShown(["flags"]));
    expect(ids(result.current.hidden)).toEqual(["estimate", "team"]);
    expect(result.current.allHidden).toBe(false);
    expect(result.current.columns.find((column) => column.id === "name")?.width).toBe(88);
    // The viewer's pick was "everything shown" and still is: nothing to write.
    expect(localStorage).toHaveLength(0);
  });

  test("unticking a column drawn only because it was asked for forgets the ask and stores nothing", () => {
    const { result } = onScroller(358);
    act(() => result.current.setShown(["flags"]));
    act(() => result.current.setShown([]));
    expect(result.current.allHidden).toBe(true);
    expect(localStorage).toHaveLength(0);
  });

  test("unticking a column the fit left drawn is the viewer's pick and is stored, that column alone", () => {
    const { result } = onScroller(500);
    expect(ids(result.current.hidden)).toEqual(["estimate", "flags"]);
    act(() => result.current.setShown([]));
    // The pane has the room team left: the fit now draws Estimate in its place, and only Team's pick is stored.
    expect(ids(result.current.hidden)).toEqual(["flags", "team"]);
    expect(stored()).toEqual({ collapsed: false, hidden: ["team"] });
  });

  test("Show columns with everything dropped asks for all of them and writes nothing", () => {
    const { result } = onScroller(358);
    expect(result.current.allHidden).toBe(true);
    act(() => result.current.toggleAll());
    expect(ids(result.current.hidden)).toEqual([]);
    expect(result.current.allHidden).toBe(false);
    expect(localStorage).toHaveLength(0);
  });

  test("Hide columns while something is drawn collapses and stores that, as a viewer action", () => {
    const { result } = onScroller(358);
    act(() => result.current.setShown(["team"]));
    act(() => result.current.toggleAll());
    expect(result.current.allHidden).toBe(true);
    expect(stored()).toEqual({ collapsed: true, hidden: [] });
    // Collapsed, the next Show columns expands the stored choice and asks for everything.
    act(() => result.current.toggleAll());
    expect(result.current.allHidden).toBe(false);
    expect(stored()).toEqual({ collapsed: false, hidden: [] });
  });

  test("the viewer's own pick stays hidden whatever the fit does", () => {
    localStorage.setItem(KEY, JSON.stringify({ collapsed: false, hidden: ["team"] }));
    const { result } = onScroller(358);
    expect(ids(result.current.hidden)).toEqual(["estimate", "flags", "team"]);
    act(() => result.current.setShown(["estimate"]));
    expect(ids(result.current.hidden)).toEqual(["flags", "team"]);
    expect(stored()).toEqual({ collapsed: false, hidden: ["team"] });
  });
});
