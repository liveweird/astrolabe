import { describe, expect, test } from "vitest";
import type { SyncState } from "../api/sync";
import { hasStaleSource, isStaleSource, verifiedAt } from "./staleness";

type C = { enabled: boolean; stale: boolean; at: number | null };
const isStale = (c: C) => c.stale;
const succeededAt = (c: C) => c.at;

describe("hasStaleSource", () => {
  test("only an ENABLED stale connection counts", () => {
    expect(hasStaleSource([], isStale)).toBe(false);
    expect(hasStaleSource([{ enabled: false, stale: true, at: 1 }], isStale)).toBe(false);
    expect(hasStaleSource([{ enabled: true, stale: false, at: 1 }], isStale)).toBe(false);
    expect(hasStaleSource([{ enabled: true, stale: false, at: 1 }, { enabled: true, stale: true, at: 1 }], isStale)).toBe(true);
  });
});

describe("verifiedAt", () => {
  test("null without connections, with any stale one (disabled or not) or any without a success", () => {
    expect(verifiedAt<C>([], isStale, succeededAt)).toBeNull();
    expect(verifiedAt([{ enabled: false, stale: true, at: 5 }], isStale, succeededAt)).toBeNull();
    expect(verifiedAt([{ enabled: true, stale: false, at: 5 }, { enabled: true, stale: false, at: null }], isStale, succeededAt)).toBeNull();
  });

  test("the OLDEST success otherwise", () => {
    expect(verifiedAt([{ enabled: true, stale: false, at: 9 }, { enabled: true, stale: false, at: 4 }], isStale, succeededAt)).toBe(4);
  });
});

describe("isStaleSource - the one rule: the server's state is anything but CURRENT, or the mapping does not fit", () => {
  const states: [SyncState, boolean][] = [
    ["CURRENT", false],
    ["STALE", true],
    ["NEVER_SYNCED", true],
    ["FAILED", true],
    ["DISABLED", true],
  ];
  test.each(states)("%s with a fitting mapping: %s", (state, stale) => {
    expect(isStaleSource({ state, mappingOk: true })).toBe(stale);
  });
  test.each(states)("%s with a mapping that does not fit: stale", (state) => {
    expect(isStaleSource({ state, mappingOk: false })).toBe(true);
  });
  test.each(states)("%s with no mapping to judge (Flow's): the state alone", (state, stale) => {
    expect(isStaleSource({ state })).toBe(stale);
  });
});
