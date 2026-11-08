import { describe, expect, test } from "vitest";
import { hasStaleSource, verifiedAt } from "./staleness";

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
