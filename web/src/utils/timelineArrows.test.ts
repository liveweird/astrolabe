import { describe, expect, test } from "vitest";
import { anchorOf, arrowPath, arrowRoute, arrowsToDraw, type Anchor, type Point } from "./timelineArrows";
import type { BarId, TimelineArrowData, TimelineGeometry } from "./timelineModel";

// Rows are 36 px, a bar is 24 px tall inset by 6, so its vertical middle is rowIndex * 36 + 18.
const at = (x: number, row: number, kind: Anchor["kind"]): Anchor => ({ x, y: row * 36 + 18, kind });
const pts = (...pairs: [number, number][]): Point[] => pairs.map(([x, y]) => ({ x, y }));
const mid = (row: number) => row * 36 + 18;

describe("anchorOf", () => {
  const rect = { x: 100, y: 42, width: 50, height: 24 };
  test.each([
    ["START", { x: 100, y: 54, kind: "START" }],
    ["END", { x: 150, y: 54, kind: "END" }],
  ] as const)("the %s anchor is the middle of that edge", (kind, expected) => {
    expect(anchorOf(rect, kind)).toEqual(expected);
  });
});

describe("arrowRoute", () => {
  // detourY is the row boundary the backtrack runs along; rows 0 and 1 meet at 36.
  test.each<[string, Anchor, Anchor, number, Point[]]>([
    ["FS forward: stub, down, straight in", at(150, 0, "END"), at(200, 1, "START"), 36, pts([150, 18], [158, 18], [158, 54], [200, 54])],
    ["FS forward upwards", at(150, 1, "END"), at(200, 0, "START"), 36, pts([150, 54], [158, 54], [158, 18], [200, 18])],
    ["FS forward on the successor's approach point exactly", at(150, 0, "END"), at(166, 1, "START"), 36, pts([150, 18], [158, 18], [158, 54], [166, 54])],
    // a satisfied link with a narrow gap shrinks its stubs (the vertical leg at half the gap, at most 8 px); it is never a backtrack
    ["FS back-to-back (gap 0): straight down the shared edge", at(150, 0, "END"), at(150, 1, "START"), 36, pts([150, 18], [150, 54])],
    ["FS gap 3: the leg at half the gap", at(150, 0, "END"), at(153, 1, "START"), 36, pts([150, 18], [151.5, 18], [151.5, 54], [153, 54])],
    ["FS gap 9 (Fri to Mon at quarter zoom)", at(150, 0, "END"), at(159, 1, "START"), 36, pts([150, 18], [154.5, 18], [154.5, 54], [159, 54])],
    ["FS gap 12: half the gap, still under the full stub", at(150, 0, "END"), at(162, 1, "START"), 36, pts([150, 18], [156, 18], [156, 54], [162, 54])],
    ["FS gap 16: the full 8 px stub", at(150, 0, "END"), at(166, 1, "START"), 36, pts([150, 18], [158, 18], [158, 54], [166, 54])],
    [
      "FS overlapping by 3 px (to.x < from.x): the backtrack",
      at(150, 0, "END"),
      at(147, 1, "START"),
      36,
      pts([150, 18], [158, 18], [158, 36], [139, 36], [139, 54], [147, 54]),
    ],
    ["SF gap 3 the other way (to.x <= from.x): half the gap", at(100, 0, "START"), at(97, 1, "END"), 36, pts([100, 18], [98.5, 18], [98.5, 54], [97, 54])],
    [
      "SS in ONE row: round the bottom boundary, not through the bars",
      at(100, 0, "START"),
      at(200, 0, "START"),
      36,
      pts([100, 18], [92, 18], [92, 36], [192, 36], [192, 18], [200, 18]),
    ],
    [
      "FF in ONE row: round the bottom boundary",
      at(150, 0, "END"),
      at(250, 0, "END"),
      36,
      pts([150, 18], [158, 18], [158, 36], [258, 36], [258, 18], [250, 18]),
    ],
    ["FS forward in the same row", at(150, 0, "END"), at(200, 0, "START"), 36, pts([150, 18], [158, 18], [200, 18])],
    [
      "FS backward, successor below: backtracks along the top of its row",
      at(150, 0, "END"),
      at(120, 1, "START"),
      36,
      pts([150, 18], [158, 18], [158, 36], [112, 36], [112, 54], [120, 54]),
    ],
    [
      "FS backward, successor above: backtracks along the bottom of its row",
      at(150, 1, "END"),
      at(120, 0, "START"),
      36,
      pts([150, 54], [158, 54], [158, 36], [112, 36], [112, 18], [120, 18]),
    ],
    [
      "FS backward, successor two rows below: the vertical leg runs down to the top of ITS row",
      at(150, 0, "END"),
      at(120, 2, "START"),
      72,
      pts([150, 18], [158, 18], [158, 72], [112, 72], [112, 90], [120, 90]),
    ],
    ["SS: both leave to the left, the vertical leg at the further stub", at(100, 0, "START"), at(200, 1, "START"), 36, pts([100, 18], [92, 18], [92, 54], [200, 54])],
    ["SS with the successor starting earlier: the vertical leg at ITS approach point", at(100, 0, "START"), at(60, 1, "START"), 36, pts([100, 18], [92, 18], [52, 18], [52, 54], [60, 54])],
    ["FF: both leave to the right, the vertical leg past the later end", at(150, 0, "END"), at(250, 1, "END"), 36, pts([150, 18], [158, 18], [258, 18], [258, 54], [250, 54])],
    ["FF with the successor ending earlier: the vertical leg at the predecessor's stub", at(150, 0, "END"), at(140, 1, "END"), 36, pts([150, 18], [158, 18], [158, 54], [140, 54])],
    [
      "SF with the successor's end after the predecessor's start: backtracks",
      at(100, 0, "START"),
      at(200, 1, "END"),
      36,
      pts([100, 18], [92, 18], [92, 36], [208, 36], [208, 54], [200, 54]),
    ],
    ["SF with the successor's end well before the predecessor's start: forward", at(100, 0, "START"), at(60, 1, "END"), 36, pts([100, 18], [92, 18], [92, 54], [60, 54])],
  ])("%s", (_name, from, to, detourY, expected) => {
    expect(arrowRoute(from, to, detourY)).toEqual(expected);
  });

  test("the route always starts at the predecessor's anchor and ends at the successor's", () => {
    for (const fromKind of ["START", "END"] as const) {
      for (const toKind of ["START", "END"] as const) {
        for (const toX of [0, 90, 150, 400]) {
          const route = arrowRoute(at(150, 0, fromKind), at(toX, 3, toKind), 108);
          expect(route[0]).toEqual({ x: 150, y: mid(0) });
          expect(route[route.length - 1]).toEqual({ x: toX, y: mid(3) });
          // orthogonal: every leg is horizontal or vertical
          route.slice(1).forEach((p, i) => expect(p.x === route[i].x || p.y === route[i].y).toBe(true));
        }
      }
    }
  });
});

describe("arrowPath", () => {
  test("a polyline: M then L", () => {
    expect(arrowPath(pts([1, 2], [3, 2], [3, 9]))).toBe("M1 2 L3 2 L3 9");
  });
});

describe("arrowsToDraw", () => {
  interface RowFixture {
    id: number | string;
    bars: Record<string, { x: number; width: number }>;
  }
  // A data-derived geometry like Timeline.tsx builds it (rowTop = i * 36, y = rowTop + 6, height 24).
  const geometryOf = (rows: RowFixture[], visibleRows: { first: number; last: number }): TimelineGeometry => ({
    scale: undefined as unknown as TimelineGeometry["scale"],
    xOf: () => 0,
    rowTop: (i) => i * 36,
    rowHeight: 36,
    rowIndexOf: (id) => {
      const index = rows.findIndex((row) => row.id === id);
      return index < 0 ? null : index;
    },
    barRect: (i, barId: BarId) => {
      const bar = rows[i]?.bars[String(barId)];
      return bar === undefined ? null : { x: bar.x, y: i * 36 + 6, width: bar.width, height: 24 };
    },
    visibleRows,
  });
  const rows: RowFixture[] = [
    { id: "a", bars: { 1: { x: 100, width: 50 } } },
    { id: "b", bars: { 2: { x: 200, width: 50 } } },
    { id: "c", bars: { 3: { x: 120, width: 50 } } },
    { id: "d", bars: { 4: { x: 300, width: 50 } } },
  ];
  const arrow = (id: string, from: [string, number], to: [string, number], violated = false, kinds: ["START" | "END", "START" | "END"] = ["END", "START"]): TimelineArrowData => ({
    id,
    from: { row: from[0], bar: from[1], kind: kinds[0] },
    to: { row: to[0], bar: to[1], kind: kinds[1] },
    violated,
    label: `${id} label`,
  });
  const everything = { first: 0, last: 3 };

  test("resolves ids to rows and bars; flag and label travel with the path", () => {
    const drawn = arrowsToDraw([arrow("ab", ["a", 1], ["b", 2]), arrow("bc", ["b", 2], ["c", 3], true)], geometryOf(rows, everything));
    expect(drawn).toEqual([
      { id: "ab", d: "M150 18 L158 18 L158 54 L200 54", violated: false, critical: false, label: "ab label" },
      // b ends at 250 and c starts at 120: backward, and c's row (2) is below b's, so the backtrack runs along the top of row 2 (y 72)
      { id: "bc", d: "M250 54 L258 54 L258 72 L112 72 L112 90 L120 90", violated: true, critical: false, label: "bc label" },
    ]);
  });

  test("an arrow with a missing row or bar is skipped, the others are still drawn", () => {
    const drawn = arrowsToDraw(
      [arrow("no-row", ["a", 1], ["zzz", 2]), arrow("no-bar", ["a", 1], ["b", 99]), arrow("no-source-bar", ["a", 99], ["b", 2]), arrow("ok", ["a", 1], ["b", 2])],
      geometryOf(rows, everything),
    );
    expect(drawn.map((a) => a.id)).toEqual(["ok"]);
  });

  test("only arrows with an end in a mounted row are drawn; an unmounted end is still positioned from data", () => {
    const window = geometryOf(rows, { first: 0, last: 1 });
    const drawn = arrowsToDraw([arrow("both", ["a", 1], ["b", 2]), arrow("one", ["b", 2], ["d", 4]), arrow("none", ["c", 3], ["d", 4])], window);
    expect(drawn.map((a) => a.id)).toEqual(["both", "one"]);
    // the unmounted end (row 3) is where the data puts it: y = 3 * 36 + 18
    expect(drawn[1].d).toMatch(/L300 126$/);
  });

  test("an empty window or no arrows draws nothing", () => {
    expect(arrowsToDraw([], geometryOf(rows, everything))).toEqual([]);
    expect(arrowsToDraw([arrow("ab", ["a", 1], ["b", 2])], geometryOf(rows, { first: 0, last: -1 }))).toEqual([]);
  });

  test("the type's edges pick the anchors", () => {
    const [ss] = arrowsToDraw([arrow("ss", ["a", 1], ["b", 2], false, ["START", "START"])], geometryOf(rows, everything));
    expect(ss.d).toBe("M100 18 L92 18 L92 54 L200 54");
    const [ff] = arrowsToDraw([arrow("ff", ["a", 1], ["b", 2], false, ["END", "END"])], geometryOf(rows, everything));
    expect(ff.d).toBe("M150 18 L158 18 L258 18 L258 54 L250 54");
  });
});
