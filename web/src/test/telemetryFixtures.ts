import type { TelemetryCurrent, TelemetryHistory, TelemetryProcess, TelemetrySeries } from "../api/telemetry";

// Shared telemetry answers for the panel, section and trend tests (shaped like the server's `Telemetry*` schemas).

export const MB = 1024 * 1024;
export const GENERATED_AT = Date.UTC(2026, 9, 24, 12, 0, 0);
const SAMPLED_AT = Date.UTC(2026, 9, 24, 11, 55, 0);

export function processFixture(overrides: Partial<TelemetryProcess> = {}): TelemetryProcess {
  return {
    id: 1,
    role: "app",
    instance: "astrolabe-app-1",
    startedAt: Date.UTC(2026, 9, 23, 8, 0, 0),
    lastSeenAt: SAMPLED_AT,
    sampledAt: SAMPLED_AT,
    stale: false,
    version: "1.17.0",
    commit: "abc1234",
    memory: {
      heapUsedBytes: 200 * MB,
      heapCommittedBytes: 300 * MB,
      heapMaxBytes: 400 * MB,
      oldGenPeakBytes: 150 * MB,
      nonHeapBytes: 90 * MB,
      directBytes: 4 * MB,
      rssBytes: 650 * MB,
      cgroupCurrentBytes: 700 * MB,
      cgroupAnonBytes: 600 * MB,
      workingSetBytes: 640 * MB,
      cgroupPeakBytes: 700 * MB,
      containerLimitBytes: 768 * MB,
      percentOfLimit: 83.3,
    },
    jvm: {
      cpuRatio: 0.123,
      threads: 41,
      gcCount: 3,
      gcTimeMs: 25,
      poolAcquired: 2,
      poolIdle: 5,
      poolPending: 0,
      poolAllocated: 7,
    },
    ...overrides,
  };
}

export function currentFixture(overrides: Partial<TelemetryCurrent> = {}): TelemetryCurrent {
  const second = processFixture({
    id: 2,
    instance: "astrolabe-app-2",
    stale: true,
    sampledAt: Date.UTC(2026, 9, 24, 11, 0, 0),
    memory: { ...processFixture().memory, containerLimitBytes: 512 * MB, workingSetBytes: 472 * MB, percentOfLimit: 92.1 },
  });
  return {
    generatedAt: GENERATED_AT,
    sampleIntervalSeconds: 300,
    processes: [processFixture(), second],
    storage: {
      measuredAt: Date.UTC(2026, 9, 24, 11, 0, 0),
      databaseBytes: 1_610_612_736,
      schemas: [
        { name: "public", bytes: 900 * MB },
        { name: "ops", bytes: 300 * MB },
      ],
    },
    requests: {
      windowSeconds: 300,
      percentileWindowSeconds: 300,
      measuredAt: SAMPLED_AT,
      total: { route: "*", count: 1500, p50Ms: 12, p95Ms: 480, serverErrors: 2, rateLimited: 0 },
      routes: [
        { route: "/api/v1/teams", count: 900, p50Ms: 40, p95Ms: 900, serverErrors: 0, rateLimited: 3 },
        { route: "/api/v1/users", count: 100, p50Ms: 30, p95Ms: 200, serverErrors: 0, rateLimited: 0 },
      ],
    },
    sync: { schedulerEnabled: true, tickSeconds: 60, connections: [] },
    ...overrides,
  };
}

const HOUR = 3_600_000;

export function seriesFixture(
  metric: string,
  values: number[],
  extra: Partial<TelemetrySeries> = {},
): TelemetrySeries {
  const role = extra.role === undefined ? "app" : extra.role;
  const label = extra.label ?? "";
  return {
    key: [role, metric, label || null].filter((part) => part !== null).join(":"),
    metric,
    label,
    role,
    unit: "BYTES",
    kind: "GAUGE",
    points: values.map((avg, index) => ({ t: GENERATED_AT - (values.length - index) * HOUR, avg, max: avg * 1.5 })),
    ...extra,
  };
}

export function historyFixture(
  group: TelemetryHistory["group"],
  range: TelemetryHistory["range"],
  series: TelemetrySeries[],
  overrides: Partial<TelemetryHistory> = {},
): TelemetryHistory {
  return {
    group,
    range,
    bucketSeconds: 300,
    from: GENERATED_AT - 86_400_000,
    to: GENERATED_AT,
    historyFrom: GENERATED_AT - 86_400_000,
    truncated: false,
    series,
    ...overrides,
  };
}
