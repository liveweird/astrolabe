import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { jsonResponse } from "../test/http";
import { ApiError } from "./http";
import { BASELINE_CAP, createBaseline, deleteBaseline, getBaseline, getBaselineView, isBaselineLimit, listBaselines, updateBaseline } from "./baselines";

type FetchMock = ReturnType<typeof vi.fn>;

describe("baseline API wrappers", () => {
  let mockFetch: FetchMock;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    localStorage.setItem("astrolabe.auth.token", "fake-token");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  const lastCall = () => mockFetch.mock.calls.at(-1) as [string, RequestInit];

  test("listBaselines GETs the unpaged registry and keeps the caller's can", async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, { items: [{ id: 3, name: "Q1" }], can: { manage: true } }));
    const list = await listBaselines();
    expect(list.items).toHaveLength(1);
    expect(list.can.manage).toBe(true);
    expect(lastCall()[0]).toBe("/api/v1/baselines");
  });

  test("getBaseline and getBaselineView GET by id", async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, { id: 3, name: "Q1" }));
    await getBaseline(3);
    expect(lastCall()[0]).toBe("/api/v1/baselines/3");
    mockFetch.mockResolvedValue(jsonResponse(200, { revision: 9 }));
    expect((await getBaselineView(3)).revision).toBe(9);
    expect(lastCall()[0]).toBe("/api/v1/views/baseline/3");
  });

  test("createBaseline POSTs the name and description and answers the baseline", async () => {
    mockFetch.mockResolvedValue(jsonResponse(201, { id: 4, name: "Q2" }));
    expect((await createBaseline({ name: "Q2", description: null })).id).toBe(4);
    const [url, init] = lastCall();
    expect(url).toBe("/api/v1/baselines");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ name: "Q2", description: null });
  });

  test("updateBaseline PUTs the full replace; deleteBaseline DELETEs", async () => {
    mockFetch.mockResolvedValue(new Response(null, { status: 204 }));
    await updateBaseline(4, { name: "Q2b", description: "x" });
    expect(lastCall()[0]).toBe("/api/v1/baselines/4");
    expect(lastCall()[1].method).toBe("PUT");
    await deleteBaseline(4);
    expect(lastCall()[1].method).toBe("DELETE");
  });

  test("isBaselineLimit tells the cap's 409 from a name clash and from other errors", () => {
    expect(BASELINE_CAP).toBe(100);
    expect(isBaselineLimit(new ApiError(409, { type: "urn:astrolabe:problem:baseline-limit" }))).toBe(true);
    expect(isBaselineLimit(new ApiError(409, { type: "about:blank" }))).toBe(false);
    expect(isBaselineLimit(new ApiError(400, { type: "urn:astrolabe:problem:baseline-limit" }))).toBe(false);
    expect(isBaselineLimit(new Error("x"))).toBe(false);
  });
});
