import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useJiraBarsPick } from "./useJiraBarsPick";

const KEY = "astrolabe.viewSettings.timeline.jiraBars";

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe("useJiraBarsPick", () => {
  test("the Jira bars are shown by default, and nothing is written until the user chooses", () => {
    expect(renderHook(() => useJiraBarsPick()).result.current.shown).toBe(true);
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  test("a choice is remembered under timeline.jiraBars and read back by the next mount", () => {
    const { result, unmount } = renderHook(() => useJiraBarsPick());
    act(() => result.current.setShown(false));
    expect(result.current.shown).toBe(false);
    expect(JSON.parse(localStorage.getItem(KEY) ?? "null")).toBe(false);
    unmount();
    expect(renderHook(() => useJiraBarsPick()).result.current.shown).toBe(false);
    const again = renderHook(() => useJiraBarsPick());
    act(() => again.result.current.setShown(true));
    expect(JSON.parse(localStorage.getItem(KEY) ?? "null")).toBe(true);
  });

  test.each(["\"no\"", "0", "null", "{}", "[]", "not json"])("a stored value that is no boolean (%s) is ignored: shown", (raw) => {
    localStorage.setItem(KEY, raw);
    expect(renderHook(() => useJiraBarsPick()).result.current.shown).toBe(true);
  });

  test("without a usable localStorage the choice still works for the page", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    const { result } = renderHook(() => useJiraBarsPick());
    expect(result.current.shown).toBe(true);
    act(() => result.current.setShown(false));
    expect(result.current.shown).toBe(false);
  });
});
