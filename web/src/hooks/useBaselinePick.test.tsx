import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { ApiError } from "../api/http";
import { useBaselinePick, useDropUnknownPick, withoutStaleOverlay } from "./useBaselinePick";

const KEY = "astrolabe.viewSettings.timeline.baseline";
const UNKNOWN = new ApiError(400, { type: "urn:astrolabe:problem:unknown-baseline", status: 400 });

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe("useBaselinePick", () => {
  test("no baseline by default", () => {
    expect(renderHook(() => useBaselinePick()).result.current.pick).toBeNull();
  });

  test("the stored id is the pick; a pick is remembered and cleared through the same setter", () => {
    localStorage.setItem(KEY, "5");
    const { result } = renderHook(() => useBaselinePick());
    expect(result.current.pick).toBe(5);
    act(() => result.current.setPick(8));
    expect(result.current.pick).toBe(8);
    expect(JSON.parse(localStorage.getItem(KEY) ?? "null")).toBe(8);
    act(() => result.current.setPick(null));
    expect(result.current.pick).toBeNull();
    expect(JSON.parse(localStorage.getItem(KEY) ?? "null")).toBeNull();
  });

  test.each(["\"x\"", "0", "-3", "1.5", "true", "{}"])("a stored value that is no baseline id (%s) is ignored", (raw) => {
    localStorage.setItem(KEY, raw);
    expect(renderHook(() => useBaselinePick()).result.current.pick).toBeNull();
  });

  test("without a usable localStorage the pick still works for the page", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    const { result } = renderHook(() => useBaselinePick());
    expect(result.current.pick).toBeNull();
    act(() => result.current.setPick(4));
    expect(result.current.pick).toBe(4);
  });
});

describe("useDropUnknownPick", () => {
  test("clears the pick on the typed 400 and reports it is dropping; once cleared it is quiet", () => {
    const setPick = vi.fn();
    const { result, rerender } = renderHook(({ error, pick }) => useDropUnknownPick(error, pick, setPick), { initialProps: { error: UNKNOWN as unknown, pick: 5 as number | null } });
    expect(result.current).toBe(true);
    expect(setPick).toHaveBeenCalledWith(null);
    // the page's next render has no pick (and a fresh query without an error): nothing more is cleared
    setPick.mockClear();
    rerender({ error: null, pick: null });
    expect(result.current).toBe(false);
    expect(setPick).not.toHaveBeenCalled();
  });

  test.each([
    ["any other 400", new ApiError(400, { type: "about:blank", status: 400 })],
    ["a 404", new ApiError(404, { type: "urn:astrolabe:problem:unknown-baseline", status: 404 })],
    ["a 500", new ApiError(500, null)],
    ["no error", null],
  ])("%s keeps the pick", (_name, error) => {
    const setPick = vi.fn();
    const { result } = renderHook(() => useDropUnknownPick(error, 5, setPick));
    expect(result.current).toBe(false);
    expect(setPick).not.toHaveBeenCalled();
  });

  test("re-reads the stored pick first: another tab's newer pick is adopted, never overwritten with null", () => {
    const setPick = vi.fn();
    localStorage.setItem(KEY, "8");
    renderHook(() => useDropUnknownPick(UNKNOWN, 5, setPick));
    expect(setPick).toHaveBeenCalledWith(8);
    expect(JSON.parse(localStorage.getItem(KEY) ?? "null")).toBe(8);
  });

  test("a stored pick that is already cleared, unusable or still the deleted id reads as no pick", () => {
    for (const stored of [null, "\"x\"", "5"]) {
      const setPick = vi.fn();
      if (stored === null) localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, stored);
      renderHook(() => useDropUnknownPick(UNKNOWN, 5, setPick));
      expect(setPick).toHaveBeenCalledWith(null);
    }
  });

  test("with no pick the unknown-baseline error is not ours to clear", () => {
    const setPick = vi.fn();
    expect(renderHook(() => useDropUnknownPick(UNKNOWN, null, setPick)).result.current).toBe(false);
    expect(setPick).not.toHaveBeenCalled();
  });
});

describe("withoutStaleOverlay", () => {
  test("clears every nested overlay of a plan view (project rows, program and work stream nodes), not only the top-level block", () => {
    const programs = {
      revision: 1,
      baseline: { id: 5 },
      workStreams: [{ id: 1, baseline: { span: null }, programs: [{ id: 2, baseline: { span: null }, projects: [{ id: 3, name: "p", baseline: { span: null } }] }] }],
    };
    const stripped = withoutStaleOverlay(programs, true);
    expect(JSON.stringify(stripped)).not.toContain("baseline");
    expect(stripped?.workStreams[0].programs[0].projects[0]).toEqual({ id: 3, name: "p" });
    const roadmap = { baseline: { id: 5 }, ranked: [{ position: 1, project: { id: 3, baseline: {} } }], unranked: [{ id: 4, baseline: {} }] };
    expect(JSON.stringify(withoutStaleOverlay(roadmap, true))).not.toContain("baseline");
    // the arrived copy is left alone
    expect(withoutStaleOverlay(programs, false)).toBe(programs);
  });

  const data = { revision: 1, baseline: { id: 5 } };

  test("drops the overlay of a previous pick's copy only", () => {
    expect(withoutStaleOverlay(data, true)).toEqual({ revision: 1 });
    expect(withoutStaleOverlay(data, false)).toBe(data);
    const plain: { revision: number; baseline?: undefined } = { revision: 1 };
    expect(withoutStaleOverlay(plain, true)).toBe(plain);
    expect(withoutStaleOverlay(undefined, true)).toBeUndefined();
  });
});
