import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { jsonResponse } from "../test/http";
import { capacityView } from "../test/flow";
import { acknowledgeCapacityDeviation, acknowledgeCapacityDeviations, getCapacityDeviations, unacknowledgeCapacityDeviation } from "./capacityDeviations";

describe("getCapacityDeviations", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    mockFetch = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(200, capacityView())));
    vi.stubGlobal("fetch", mockFetch);
    localStorage.setItem("astrolabe.auth.token", "fake-token");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });
  const lastUrl = () => (mockFetch.mock.calls.at(-1) as [string])[0];

  test("sends nothing for no filter, and only the filters that are set otherwise (a 0 included)", async () => {
    const view = await getCapacityDeviations();
    expect(lastUrl()).toBe("/api/v1/views/capacity-deviations");
    expect(view.items).toHaveLength(1);
    await getCapacityDeviations({ teamId: 3, severity: "WARNING", kind: "CAPACITY_MISSING", connectionId: 0 });
    expect(Object.fromEntries(new URL(lastUrl(), "http://x").searchParams)).toEqual({ teamId: "3", severity: "WARNING", kind: "CAPACITY_MISSING", connectionId: "0" });
  });

  test("`acknowledged` and `all` are sent when set, `false` too (the override of the team scope's implied all)", async () => {
    await getCapacityDeviations({ acknowledged: true });
    expect(lastUrl()).toBe("/api/v1/views/capacity-deviations?acknowledged=true");
    await getCapacityDeviations({ teamId: 3, all: false });
    expect(Object.fromEntries(new URL(lastUrl(), "http://x").searchParams)).toEqual({ teamId: "3", all: "false" });
    await getCapacityDeviations({ all: true });
    expect(lastUrl()).toBe("/api/v1/views/capacity-deviations?all=true");
  });
});

describe("the per-sprint acknowledge", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  const call = () => mockFetch.mock.calls.at(-1) as [string, RequestInit];
  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    localStorage.setItem("astrolabe.auth.token", "fake-token");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  test("POST names the sprint and the fingerprint the client read in the body of the binding's route", async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, { bindingId: 5, sprintId: 90002, fingerprint: "a".repeat(64), acknowledgedAt: 1, acknowledgedBy: "Ada" }));
    const result = await acknowledgeCapacityDeviation(5, { sprintId: 90002, fingerprint: "a".repeat(64) });
    expect(result.acknowledgedBy).toBe("Ada");
    const [url, init] = call();
    expect(url).toBe("/api/v1/integrations/flow/team-bindings/5/acknowledge");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ sprintId: 90002, fingerprint: "a".repeat(64) });
  });

  test("the team's own row is acknowledged with an explicit `sprintId: null` (an absent key is a 400 on the server)", async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, { bindingId: 6, sprintId: null, fingerprint: "b".repeat(64), acknowledgedAt: 1, acknowledgedBy: null }));
    await acknowledgeCapacityDeviation(6, { sprintId: null, fingerprint: "b".repeat(64) });
    expect(call()[1].body).toBe(JSON.stringify({ sprintId: null, fingerprint: "b".repeat(64) }));
  });

  test("acknowledge all POSTs the items (the team's own row as an explicit null) to the binding's acknowledge-all route", async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, { acknowledged: [] }));
    const result = await acknowledgeCapacityDeviations(5, [
      { sprintId: 90002, fingerprint: "a".repeat(64) },
      { sprintId: null, fingerprint: "b".repeat(64) },
    ]);
    expect(result.acknowledged).toEqual([]);
    const [url, init] = call();
    expect(url).toBe("/api/v1/integrations/flow/team-bindings/5/acknowledge-all");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      items: [
        { sprintId: 90002, fingerprint: "a".repeat(64) },
        { sprintId: null, fingerprint: "b".repeat(64) },
      ],
    });
  });

  test("DELETE names the sprint in the query; the team's own row is the route with no parameter", async () => {
    mockFetch.mockImplementation(() => Promise.resolve(new Response(null, { status: 204 })));
    await unacknowledgeCapacityDeviation(5, 90002);
    expect(call()[0]).toBe("/api/v1/integrations/flow/team-bindings/5/acknowledge?sprintId=90002");
    expect(call()[1].method).toBe("DELETE");
    await unacknowledgeCapacityDeviation(6, null);
    expect(call()[0]).toBe("/api/v1/integrations/flow/team-bindings/6/acknowledge");
  });
});
