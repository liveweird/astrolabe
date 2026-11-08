import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { jsonResponse } from "../test/http";
import { capacityView } from "../test/flow";
import { getCapacityDeviations } from "./capacityDeviations";

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
});
