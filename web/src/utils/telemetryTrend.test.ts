import { describe, expect, test } from "vitest";
import type { TFunction } from "i18next";
import i18n from "../i18n";
import { GENERATED_AT, MB, seriesFixture } from "../test/telemetryFixtures";
import {
  chartRows,
  formatTrendValue,
  jvmColumns,
  memoryColumns,
  requestsColumns,
  storageColumns,
  trendTimes,
} from "./telemetryTrend";

const t = i18n.t.bind(i18n) as TFunction;

describe("telemetryTrend", () => {
  test("memory plots the working set per role and tells roles apart only when there are several", () => {
    const one = memoryColumns([seriesFixture("mem.cgroup_working_set", [100 * MB, 200 * MB]), seriesFixture("mem.heap_used", [50 * MB])], t, new Map());
    expect(one.map((c) => [c.label, c.plot])).toEqual([
      ["Working set (mean)", true],
      ["Working set (peak)", false],
      ["Heap used (mean)", false],
    ]);
    const two = memoryColumns(
      [
        seriesFixture("mem.cgroup_working_set", [1], { role: "app" }),
        seriesFixture("mem.cgroup_working_set", [2], { role: "batch" }),
      ],
      t,
      new Map(),
    );
    expect(two.filter((c) => c.plot).map((c) => c.label)).toEqual(["Working set (mean) (App)", "Working set (mean) (batch)"]);
    // The peak column reads the bucket's largest sample (1.5 x the mean in the fixture).
    expect(two.find((c) => c.label === "Working set (peak) (App)")?.values.get(GENERATED_AT - 3_600_000)).toBe(1.5);
  });

  test("without a container the heap is what memory draws", () => {
    const columns = memoryColumns([seriesFixture("mem.heap_used", [10])], t, new Map());
    expect(columns.filter((c) => c.plot).map((c) => c.label)).toEqual(["Heap used (mean)"]);
  });

  test("with a container limit for every role the DRAWN memory line is the share of it, and the bytes stay in the table", () => {
    const ws = [seriesFixture("mem.cgroup_working_set", [384 * MB], { role: "app" }), seriesFixture("mem.cgroup_working_set", [256 * MB], { role: "batch" })];
    const columns = memoryColumns(ws, t, new Map([["app", 768 * MB], ["batch", 512 * MB]]));
    const plotted = columns.filter((c) => c.plot);
    expect(plotted.map((c) => [c.label, c.unit])).toEqual([["Share of the limit (mean) (App)", "PERCENT"], ["Share of the limit (mean) (batch)", "PERCENT"]]);
    expect([...plotted[0]!.values.values()]).toEqual([50]);
    expect([...plotted[1]!.values.values()]).toEqual([50]);
    // The peak share is the largest sample over the limit (1.5 x in the fixture); the bytes columns follow, undrawn.
    expect([...columns.find((c) => c.label === "Share of the limit (peak) (App)")!.values.values()]).toEqual([75]);
    expect(columns.find((c) => c.label === "Working set (mean) (App)")).toMatchObject({ unit: "BYTES", plot: false });
    // One role without a limit and the bytes are drawn for both (one axis, one unit).
    const partial = memoryColumns(ws, t, new Map([["app", 768 * MB]]));
    expect(partial.filter((c) => c.plot).map((c) => c.unit)).toEqual(["BYTES", "BYTES"]);
    expect(partial.some((c) => c.label.startsWith("Share of the limit"))).toBe(false);
  });

  test("storage draws the database and every schema", () => {
    const columns = storageColumns(
      [
        seriesFixture("db.size", [5], { role: null }),
        seriesFixture("db.schema.size", [3], { role: null, label: "public" }),
        seriesFixture("conn.issues", [3], { role: null, label: "5", unit: "COUNT" }),
      ],
      t,
    );
    expect(columns.map((c) => c.label)).toEqual(["Database", "public"]);
    expect(columns.every((c) => c.plot)).toBe(true);
  });

  test("requests keep the all-routes series: p50 and p95 drawn, the counts beside them", () => {
    // Requests merge every serving role: their series carry no role.
    const columns = requestsColumns(
      [
        seriesFixture("http.p50", [10], { label: "*", role: null, unit: "MILLISECONDS", kind: "PERCENTILE" }),
        seriesFixture("http.p95", [90], { label: "*", role: null, unit: "MILLISECONDS", kind: "PERCENTILE" }),
        seriesFixture("http.count", [7], { label: "*", role: null, unit: "COUNT", kind: "DELTA" }),
        seriesFixture("http.p95", [400], { label: "/api/v1/reports/home", role: null, unit: "MILLISECONDS", kind: "PERCENTILE" }),
      ],
      t,
    );
    expect(columns.map((c) => [c.label, c.plot])).toEqual([["p50", true], ["p95", true], ["Requests", false]]);
  });

  test("jvm shows CPU as a percentage and sums GC time over the collectors of a role", () => {
    const columns = jvmColumns(
      [
        seriesFixture("jvm.cpu_ratio", [0.25], { unit: "RATIO" }),
        seriesFixture("jvm.gc_time_ms", [10, 20], { unit: "MILLISECONDS", kind: "DELTA", label: "G1 Young" }),
        seriesFixture("jvm.gc_time_ms", [5, 5], { unit: "MILLISECONDS", kind: "DELTA", label: "G1 Old" }),
        seriesFixture("jvm.threads", [40], { unit: "COUNT" }),
      ],
      t,
    );
    const cpu = columns.find((c) => c.label === "CPU (mean)");
    expect(cpu?.unit).toBe("PERCENT");
    expect([...(cpu?.values.values() ?? [])]).toEqual([25]);
    expect(cpu?.plot).toBe(true);
    const gc = columns.find((c) => c.label === "GC time");
    expect([...(gc?.values.values() ?? [])]).toEqual([15, 25]);
    expect(columns.some((c) => c.label === "Threads (mean)")).toBe(true);
  });

  test("times are the union of the columns' buckets, and chart rows leave a gap where a column has none", () => {
    const a = seriesFixture("db.size", [1, 2], { role: null });
    const b = seriesFixture("db.schema.size", [9], { role: null, label: "public" });
    const columns = storageColumns([a, b], t);
    const times = trendTimes(columns);
    expect(times).toHaveLength(2);
    const rows = chartRows(columns, times);
    expect(rows[0]).toMatchObject({ s0: 1, s1: undefined });
    expect(rows[1]).toMatchObject({ s0: 2, s1: 9 });
    expect(rows[1]?.label).toBe("2026-10-24 11:00");
  });

  test("values format by unit", () => {
    expect(formatTrendValue("BYTES", 1536)).toBe("1.5 KB");
    expect(formatTrendValue("MILLISECONDS", 1500)).toBe("1.5 s");
    expect(formatTrendValue("PERCENT", 12.34)).toBe("12.3%");
    expect(formatTrendValue("COUNT", 12.4)).toBe("12");
  });
});
