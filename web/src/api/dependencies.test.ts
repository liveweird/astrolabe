import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { jsonResponse } from "../test/http";
import { createDependency, deleteDependency, isDependencyCycle, updateDependency } from "./dependencies";
import { ApiError } from "./http";

type FetchMock = ReturnType<typeof vi.fn>;

const CYCLE = {
  type: "urn:astrolabe:problem:dependency-cycle",
  title: "Conflict",
  status: 409,
  detail: "Adding this dependency would close a cycle: a1 → b1 → a1",
  cycle: [
    { kind: "MILESTONE", id: 1, name: "a1" },
    { kind: "MILESTONE", id: 2, name: "b1" },
    { kind: "MILESTONE", id: 1, name: "a1" },
  ],
};

describe("dependencies API wrappers", () => {
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

  test("createDependency POSTs the body under the successor's project", async () => {
    mockFetch.mockResolvedValue(jsonResponse(201, { id: 9 }));
    const body = { predecessor: { kind: "MILESTONE", id: 1 }, successor: { kind: "MILESTONE", id: 2 }, type: "FS", lagDays: 0 } as const;
    expect((await createDependency(7, body)).id).toBe(9);
    const [url, init] = lastCall();
    expect(url).toBe("/api/v1/projects/7/dependencies");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual(body);
  });

  test("updateDependency PUTs the type and lag to the link and resolves on 204", async () => {
    mockFetch.mockResolvedValue(new Response(null, { status: 204 }));
    await updateDependency(9, { type: "SS", lagDays: -2 });
    const [url, init] = lastCall();
    expect(url).toBe("/api/v1/dependencies/9");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({ type: "SS", lagDays: -2 });
  });

  test("updateDependency rejects with the ApiError, a cycle 409 recognised by its problem type", async () => {
    mockFetch.mockResolvedValue(jsonResponse(409, CYCLE));
    const error = await updateDependency(9, { type: "SS", lagDays: 0 }).catch((e: unknown) => e);
    expect(isDependencyCycle(error)).toBe(true);
    mockFetch.mockResolvedValue(jsonResponse(400, { title: "Bad", status: 400 }));
    expect(await updateDependency(9, { type: "SS", lagDays: 999 }).catch((e: unknown) => e)).toMatchObject({ status: 400 });
  });

  test("deleteDependency DELETEs the link", async () => {
    mockFetch.mockResolvedValue(new Response(null, { status: 204 }));
    await deleteDependency(9);
    const [url, init] = lastCall();
    expect(url).toBe("/api/v1/dependencies/9");
    expect(init.method).toBe("DELETE");
  });

  test("a cycle 409 is recognised by its problem type and carries the typed path", async () => {
    mockFetch.mockResolvedValue(jsonResponse(409, CYCLE));
    const error = await createDependency(7, { predecessor: { kind: "MILESTONE", id: 1 }, successor: { kind: "MILESTONE", id: 2 }, type: "FS", lagDays: 0 }).catch((e: unknown) => e);
    expect(isDependencyCycle(error)).toBe(true);
    expect((error as ApiError).cycle?.map((node) => node.name)).toEqual(["a1", "b1", "a1"]);
  });

  test("any other 409, other statuses and non-API errors are not a cycle", () => {
    expect(isDependencyCycle(new ApiError(409, { title: "Conflict", detail: "These two endpoints are already linked" }))).toBe(false);
    expect(isDependencyCycle(new ApiError(400, CYCLE))).toBe(false);
    expect(isDependencyCycle(new Error("x"))).toBe(false);
    expect(isDependencyCycle(null)).toBe(false);
  });

  test("the cycle getter is absent without the member and drops malformed entries", () => {
    expect(new ApiError(409, { title: "Conflict" }).cycle).toBeUndefined();
    expect(new ApiError(500, null).cycle).toBeUndefined();
    expect(new ApiError(409, { cycle: "nope" }).cycle).toBeUndefined();
    expect(new ApiError(409, { cycle: [{ kind: "PROJECT", id: 1, name: "ok" }, { id: "x" }, null, 3] }).cycle).toEqual([{ kind: "PROJECT", id: 1, name: "ok" }]);
  });
});
