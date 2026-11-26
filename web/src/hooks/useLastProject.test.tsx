import { afterEach, describe, expect, test } from "vitest";
import { renderHook } from "@testing-library/react";
import { forgetLastProject, readLastProject, useRememberProject } from "./useLastProject";

const KEY = "astrolabe.viewSettings.projects.last";

afterEach(() => localStorage.clear());

describe("the remembered project", () => {
  test("nothing, a corrupt value, a non-id and a negative id all read as none", () => {
    expect(readLastProject()).toBeNull();
    for (const stored of ["not json", "\"7\"", "7.5", "0", "-3", "null"]) {
      localStorage.setItem(KEY, stored);
      expect(readLastProject()).toBeNull();
    }
    localStorage.setItem(KEY, "7");
    expect(readLastProject()).toBe(7);
  });

  test("a project is remembered only once its page has loaded", () => {
    const { rerender } = renderHook(({ loaded }) => useRememberProject(7, loaded), { initialProps: { loaded: false } });
    expect(readLastProject()).toBeNull();
    rerender({ loaded: true });
    expect(readLastProject()).toBe(7);
  });

  test("forgetting clears the remembered project only when it is the one named", () => {
    localStorage.setItem(KEY, "7");
    forgetLastProject(8);
    expect(readLastProject()).toBe(7);
    forgetLastProject(7);
    expect(readLastProject()).toBeNull();
  });
});
