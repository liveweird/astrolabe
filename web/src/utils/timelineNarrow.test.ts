import { describe, expect, test } from "vitest";
import { fitColumns, NARROW_BELOW } from "./timelineNarrow";
import type { TimelineColumn } from "./timelineModel";

const NONE: ReadonlySet<string> = new Set();
const PROJECT: TimelineColumn[] = [
  { id: "name", header: "Milestone", width: 220 },
  { id: "team", header: "Team", width: 130, hideable: true },
  { id: "estimate", header: "Estimate", width: 120, hideable: true },
  { id: "flags", header: "Flags", width: 130, hideable: true },
  { id: "actions", header: "Operations", width: 56, iconOnly: true },
];
const ROADMAP: TimelineColumn[] = [
  { id: "rank", header: "#", width: 44 },
  { id: "project", header: "Project", width: 240 },
  { id: "flags", header: "Flags", width: 120, hideable: true },
  { id: "actions", header: "Operations", width: 56, iconOnly: true },
];
const widthOf = (columns: readonly TimelineColumn[], hidden: ReadonlySet<string>) => columns.filter((c) => !hidden.has(c.id)).reduce((sum, c) => sum + c.width, 0);

describe("fitColumns", () => {
  test("an unmeasured or a wide scroller changes nothing (the same objects)", () => {
    for (const width of [null, NARROW_BELOW, 1200]) {
      const fitted = fitColumns(PROJECT, NONE, width);
      expect(fitted.columns).toBe(PROJECT);
      expect(fitted.hidden).toBe(NONE);
    }
  });

  test("a phone drops the hideable columns from the last and shrinks the name to the share left", () => {
    const fitted = fitColumns(PROJECT, NONE, 358);
    expect([...fitted.hidden].sort()).toEqual(["estimate", "flags", "team"]);
    expect(fitted.columns.map((c) => [c.id, c.width])).toEqual([["name", 141], ["team", 130], ["estimate", 120], ["flags", 130], ["actions", 56]]);
    expect(widthOf(fitted.columns, fitted.hidden)).toBe(197);
  });

  test("a column the viewer already hid stays hidden, and what is left is kept while it fits", () => {
    const fitted = fitColumns(ROADMAP, new Set(["flags"]), 358);
    expect(fitted.hidden).toEqual(new Set(["flags"]));
    expect(fitted.columns.map((c) => c.width)).toEqual([44, 97, 120, 56]);
  });

  test("the name never shrinks below 88 px, even if the cap is then missed", () => {
    const wide: TimelineColumn[] = [{ id: "rank", header: "#", width: 96 }, ...ROADMAP.slice(1)];
    const fitted = fitColumns(wide, NONE, 358);
    expect(fitted.columns.find((c) => c.id === "project")?.width).toBe(88);
    expect(fitted.hidden).toEqual(new Set(["flags"]));
  });

  test("a name that already fits is left alone", () => {
    const fitted = fitColumns([{ id: "name", header: "Name", width: 100 }, { id: "actions", header: "Operations", width: 56 }], NONE, 358);
    expect(fitted.columns[0].width).toBe(100);
  });

  test("a column the viewer asked for is dropped last: the others go first, then the name gives way", () => {
    const fitted = fitColumns(PROJECT, NONE, 358, new Set(["flags"]));
    expect([...fitted.hidden].sort()).toEqual(["estimate", "team"]);
    expect(fitted.columns.find((c) => c.id === "name")?.width).toBe(88);
    // asked for everything: nothing is dropped, the cap yields (the name keeps its 88 px)
    const all = fitColumns(PROJECT, NONE, 358, new Set(["team", "estimate", "flags"]));
    expect(all.hidden.size).toBe(0);
    expect(all.columns.find((c) => c.id === "name")?.width).toBe(88);
  });

  test("a floor keeps a very small scroller at 190 px of columns", () => {
    const fitted = fitColumns(PROJECT, NONE, 200);
    expect(widthOf(fitted.columns, fitted.hidden)).toBe(190);
  });
});
