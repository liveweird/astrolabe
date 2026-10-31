import { describe, expect, test } from "vitest";
import i18n from "../i18n";
import type { RoadmapRankedProject } from "../api/roadmap";
import { roadmapAnnouncements } from "./roadmapAnnouncements";

const row = (position: number, id: number, name: string): RoadmapRankedProject => ({
  position,
  project: { id, name, programId: 1, programName: "P", workStreamId: 1, workStreamName: "W", ownerName: "O", targetStart: null, targetEnd: null },
});
const ROWS = [row(1, 11, "Alpha"), row(2, 12, "Beta"), row(3, 13, "Gamma")];
const item = (id: number) => ({ id, data: { current: undefined }, rect: { current: { initial: null, translated: null } } }) as never;

describe("roadmapAnnouncements", () => {
  const t = i18n.t.bind(i18n);
  const a = roadmapAnnouncements(t, ROWS);

  test("says which project is held, where it is, and where it is dropped — by name and rank", () => {
    expect(a.onDragStart({ active: item(12) })).toBe("Picked up Beta, position 2 of 3.");
    expect(a.onDragOver({ active: item(12), over: item(13) })).toBe("Beta is over position 3 of 3.");
    expect(a.onDragEnd({ active: item(12), over: item(11) })).toBe("Dropped Beta at position 1 of 3.");
    expect(a.onDragCancel({ active: item(12), over: null })).toBe("Cancelled; Beta stays at position 2 of 3.");
  });

  test("a drop or hover outside any row says nothing about a target", () => {
    expect(a.onDragOver({ active: item(12), over: null })).toBeUndefined();
    expect(a.onDragEnd({ active: item(12), over: null })).toBe("Dropped Beta; it stays at position 2 of 3.");
  });

  test("reads in the UI language", async () => {
    await i18n.changeLanguage("pl");
    try {
      const pl = roadmapAnnouncements(i18n.t.bind(i18n), ROWS);
      expect(pl.onDragStart({ active: item(12) })).toBe("Chwycono projekt Beta, pozycja 2 z 3.");
    } finally {
      await i18n.changeLanguage("en");
    }
  });
});
