import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ApiError } from "./http";
import { jsonResponse } from "../test/http";
import { getRoadmapView, isStaleRevision, putRanking, roadmapViewKey } from "./roadmap";

type FetchMock = ReturnType<typeof vi.fn>;

describe("roadmap API wrappers", () => {
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

  test("getRoadmapView GETs the view", async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, { revision: 4, can: { editRank: true }, ranked: [], unranked: [] }));
    expect((await getRoadmapView()).revision).toBe(4);
    expect(lastCall()[0]).toBe("/api/v1/views/roadmap");
  });

  test("getRoadmapView asks for the picked baseline with ?baseline= (none, null: the plain view)", async () => {
    mockFetch.mockImplementation(() => Promise.resolve(jsonResponse(200, { revision: 4, can: { editRank: true }, ranked: [], unranked: [] })));
    await getRoadmapView(5);
    expect(lastCall()[0]).toBe("/api/v1/views/roadmap?baseline=5");
    await getRoadmapView(null);
    expect(lastCall()[0]).toBe("/api/v1/views/roadmap");
  });

  test("the cached view's key carries the pick, under the roadmap prefix", () => {
    expect(roadmapViewKey(null)).toEqual(["roadmap", "view", { baseline: null }]);
    expect(roadmapViewKey(5)).not.toEqual(roadmapViewKey(null));
  });

  test("putRanking PUTs the complete list with the expected revision and answers the new revision", async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, { revision: 8 }));
    expect(await putRanking({ projectIds: [3, 1, 2], expectedRevision: 7 })).toEqual({ revision: 8 });
    const [url, init] = lastCall();
    expect(url).toBe("/api/v1/roadmap/ranking");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({ projectIds: [3, 1, 2], expectedRevision: 7 });
  });

  test("isStaleRevision is true only for a 409 carrying the stale-revision problem type", () => {
    expect(isStaleRevision(new ApiError(409, { type: "urn:astrolabe:problem:stale-revision", status: 409 }))).toBe(true);
    expect(isStaleRevision(new ApiError(409, { type: "about:blank", status: 409 }))).toBe(false);
    expect(isStaleRevision(new ApiError(400, { type: "urn:astrolabe:problem:stale-revision" }))).toBe(false);
    expect(isStaleRevision(new Error("network"))).toBe(false);
  });
});
