import { describe, expect, test } from "vitest";
import { ApiError } from "../api/http";
import { isRejectedTarget } from "./useCriticalTarget";

describe("isRejectedTarget", () => {
  test("a plain 400 is the target's rejection", () => {
    expect(isRejectedTarget(new ApiError(400, { type: "about:blank", status: 400 }))).toBe(true);
    expect(isRejectedTarget(new ApiError(400, null))).toBe(true);
  });

  test("the typed unknown-baseline 400 is the baseline pick's, not the target's", () => {
    expect(isRejectedTarget(new ApiError(400, { type: "urn:astrolabe:problem:unknown-baseline", status: 400 }))).toBe(false);
  });

  test("any other status, and anything that is not an ApiError, is not a rejection", () => {
    expect(isRejectedTarget(new ApiError(403, { type: "about:blank" }))).toBe(false);
    expect(isRejectedTarget(new ApiError(500, { type: "about:blank" }))).toBe(false);
    expect(isRejectedTarget(new Error("boom"))).toBe(false);
    expect(isRejectedTarget(null)).toBe(false);
    expect(isRejectedTarget(undefined)).toBe(false);
  });
});
