import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { consumeSignedOut } from "../auth";
import { jsonResponse, notModified } from "../test/http";
import { ApiError } from "./http";
import { forgetRevalidated, revalidatedRequest } from "./revalidate";
import type { components } from "./schema";
import { clearSession, persistSession } from "./session";

const session = (userId: number, token: string, refreshToken = `refresh-${token}`): components["schemas"]["LoginResponse"] => ({
  token,
  expiresAt: 1,
  refreshToken,
  refreshExpiresAt: 2,
  userId,
  roles: [],
  disabledFeatures: [],
  language: "en",
});

const PATH = "/api/v1/views/home";
const IDENTITY_KEY = "astrolabe.auth.sessionIdentity";
const sentTag = (call: unknown[]) => new Headers((call[1] as RequestInit | undefined)?.headers).get("If-None-Match");
const tagged = (body: unknown, etag: string) => jsonResponse(200, body, { ETag: etag });
const isRefresh = (url: unknown) => String(url).endsWith("/api/v1/refresh");

describe("revalidatedRequest", () => {
  const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    persistSession(session(1, "t1"));
    consumeSignedOut();
    forgetRevalidated();
  });

  afterEach(() => {
    forgetRevalidated();
    vi.unstubAllGlobals();
    localStorage.clear();
    consumeSignedOut();
  });

  test("a first read sends no If-None-Match and no init at all, exactly like jsonRequest", async () => {
    fetchMock.mockResolvedValueOnce(tagged({ n: 1 }, 'W/"a"'));
    expect(await revalidatedRequest(PATH)).toEqual({ n: 1 });
    const init = fetchMock.mock.calls[0][1];
    expect(new Headers(init?.headers).has("If-None-Match")).toBe(false);
    expect(init?.method).toBeUndefined();
  });

  test("a second read sends the tag, and a 304 resolves an equal document that is not the same object", async () => {
    fetchMock.mockResolvedValueOnce(tagged({ n: 1, list: [1, 2] }, 'W/"a"'));
    const first = await revalidatedRequest<{ n: number; list: number[] }>(PATH);
    fetchMock.mockResolvedValueOnce(notModified('W/"a"'));
    const second = await revalidatedRequest<{ n: number; list: number[] }>(PATH);
    expect(sentTag(fetchMock.mock.calls[1])).toBe('W/"a"');
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    // A page that mutated its copy cannot corrupt what a later 304 hands out.
    first.list.push(99);
    fetchMock.mockResolvedValueOnce(notModified('W/"a"'));
    expect((await revalidatedRequest<{ list: number[] }>(PATH)).list).toEqual([1, 2]);
  });

  test("a 200 with a new tag replaces the kept one", async () => {
    fetchMock.mockResolvedValueOnce(tagged({ n: 1 }, 'W/"a"'));
    await revalidatedRequest(PATH);
    fetchMock.mockResolvedValueOnce(tagged({ n: 2 }, 'W/"b"'));
    expect(await revalidatedRequest(PATH)).toEqual({ n: 2 });
    fetchMock.mockResolvedValueOnce(notModified('W/"b"'));
    expect(await revalidatedRequest(PATH)).toEqual({ n: 2 });
    expect(sentTag(fetchMock.mock.calls[1])).toBe('W/"a"');
    expect(sentTag(fetchMock.mock.calls[2])).toBe('W/"b"');
  });

  test("a 200 without an ETag drops the entry", async () => {
    fetchMock.mockResolvedValueOnce(tagged({ n: 1 }, 'W/"a"'));
    await revalidatedRequest(PATH);
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { n: 2 }));
    await revalidatedRequest(PATH);
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { n: 3 }));
    await revalidatedRequest(PATH);
    expect(sentTag(fetchMock.mock.calls[2])).toBeNull();
  });

  test.each([404, 500])("a %i throws ApiError and leaves the entry alone", async (status) => {
    fetchMock.mockResolvedValueOnce(tagged({ n: 1 }, 'W/"a"'));
    await revalidatedRequest(PATH);
    fetchMock.mockResolvedValueOnce(jsonResponse(status, { title: "x", status }));
    await expect(revalidatedRequest(PATH)).rejects.toMatchObject({ status });
    fetchMock.mockResolvedValueOnce(notModified('W/"a"'));
    expect(await revalidatedRequest(PATH)).toEqual({ n: 1 });
    expect(sentTag(fetchMock.mock.calls[2])).toBe('W/"a"');
  });

  test("a 304 after forgetRevalidated() re-reads ONCE without the header and resolves that answer", async () => {
    fetchMock.mockResolvedValueOnce(tagged({ n: 1 }, 'W/"a"'));
    await revalidatedRequest(PATH);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    fetchMock.mockImplementationOnce(async () => {
      await gate;
      return notModified('W/"a"');
    });
    fetchMock.mockResolvedValueOnce(tagged({ n: 2 }, 'W/"c"'));
    const pending = revalidatedRequest(PATH);
    forgetRevalidated();
    release();
    expect(await pending).toEqual({ n: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sentTag(fetchMock.mock.calls[2])).toBeNull();
    // the plain answer is kept in turn
    fetchMock.mockResolvedValueOnce(notModified('W/"c"'));
    expect(await revalidatedRequest(PATH)).toEqual({ n: 2 });
  });

  test("a 304 whose re-read is not a 200 throws instead of looping", async () => {
    fetchMock.mockResolvedValueOnce(tagged({ n: 1 }, 'W/"a"'));
    await revalidatedRequest(PATH);
    fetchMock.mockImplementationOnce(async () => {
      forgetRevalidated();
      return notModified('W/"a"');
    });
    fetchMock.mockResolvedValueOnce(notModified('W/"a"'));
    await expect(revalidatedRequest(PATH)).rejects.toBeInstanceOf(ApiError);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  test("an entry read under one identity is not sent under another", async () => {
    fetchMock.mockResolvedValueOnce(tagged({ user: 1 }, 'W/"a"'));
    await revalidatedRequest(PATH);
    // Another tab's sign-in changes the stored identity without this tab's boundary running.
    localStorage.setItem("astrolabe.auth.sessionIdentity", "another-identity");
    fetchMock.mockResolvedValueOnce(tagged({ user: 2 }, 'W/"b"'));
    expect(await revalidatedRequest(PATH)).toEqual({ user: 2 });
    expect(sentTag(fetchMock.mock.calls[1])).toBeNull();
  });

  test("an answer arriving after the identity changed is not kept", async () => {
    const identityA = localStorage.getItem(IDENTITY_KEY);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    fetchMock.mockImplementationOnce(async () => {
      await gate;
      return tagged({ user: 1 }, 'W/"a"');
    });
    const pending = revalidatedRequest(PATH);
    persistSession(session(2, "t2"));
    release();
    await pending;
    // Identity A is signed in again: were the late answer kept, its tag would be sent now.
    localStorage.setItem(IDENTITY_KEY, identityA ?? "");
    fetchMock.mockResolvedValueOnce(tagged({ user: 2 }, 'W/"b"'));
    await revalidatedRequest(PATH);
    expect(sentTag(fetchMock.mock.calls[1])).toBeNull();
  });

  test.each([
    ["another login", () => persistSession(session(2, "t2"))],
    ["a sign-out", () => clearSession()],
  ])("a 304 arriving after %s makes no request and rejects without handing out the previous text", async (_name, change) => {
    fetchMock.mockResolvedValueOnce(tagged({ user: 1 }, 'W/"a"'));
    await revalidatedRequest(PATH);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    fetchMock.mockImplementationOnce(async () => {
      await gate;
      return notModified('W/"a"');
    });
    const pending = revalidatedRequest(PATH);
    change();
    release();
    await expect(pending).rejects.toThrow("session changed");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("a malformed 200 carrying an ETag drops the previous entry", async () => {
    fetchMock.mockResolvedValueOnce(tagged({ n: 1 }, 'W/"a"'));
    await revalidatedRequest(PATH);
    fetchMock.mockResolvedValueOnce(new Response("{not json", { status: 200, headers: { ETag: 'W/"b"' } }));
    await expect(revalidatedRequest(PATH)).rejects.toThrow();
    fetchMock.mockResolvedValueOnce(tagged({ n: 3 }, 'W/"c"'));
    await revalidatedRequest(PATH);
    expect(sentTag(fetchMock.mock.calls[2])).toBeNull();
  });

  test("nothing is kept or sent without a session identity", async () => {
    clearSession();
    fetchMock.mockImplementation(async () => tagged({ n: 1 }, 'W/"a"'));
    await revalidatedRequest(PATH);
    await revalidatedRequest(PATH);
    expect(sentTag(fetchMock.mock.calls[1])).toBeNull();
  });

  test("the seventeenth address evicts the least recently used, and a read makes an address the most recent", async () => {
    const path = (i: number) => `/api/v1/views/project/${i}`;
    fetchMock.mockImplementation(async (url) => tagged({ url }, `W/"${url}"`));
    for (let i = 1; i <= 16; i += 1) await revalidatedRequest(path(i));
    await revalidatedRequest(path(1)); // address 1 is now the most recent, address 2 the oldest
    await revalidatedRequest(path(17)); // evicts address 2
    fetchMock.mockClear();
    await revalidatedRequest(path(2)); // no tag: it was evicted (and this read evicts address 3)
    await revalidatedRequest(path(1)); // still kept
    expect(fetchMock.mock.calls.map(sentTag)).toEqual([null, `W/"${path(1)}"`]);
  });

  test("the character bound evicts the oldest documents, and a document over the bound is never kept", async () => {
    const big = (chars: number) => ({ text: "x".repeat(chars) });
    const a = "/api/v1/views/project/1";
    const b = "/api/v1/views/project/2";
    const huge = "/api/v1/views/project/3";
    fetchMock.mockImplementation(async (url) => {
      const chars = url === huge ? 8_100_000 : 4_500_000;
      return tagged(big(chars), `W/"${url}"`);
    });
    await revalidatedRequest(a);
    await revalidatedRequest(b); // 9,000,000 characters in all: a goes
    await revalidatedRequest(a);
    await revalidatedRequest(b);
    expect(sentTag(fetchMock.mock.calls[2])).toBeNull();
    expect(sentTag(fetchMock.mock.calls[3])).toBeNull();
    await revalidatedRequest(huge);
    await revalidatedRequest(huge);
    expect(sentTag(fetchMock.mock.calls[5])).toBeNull();
  });

  test("the If-None-Match header survives the refresh-and-retry of a 401", async () => {
    fetchMock.mockResolvedValueOnce(tagged({ n: 1 }, 'W/"a"'));
    await revalidatedRequest(PATH);
    fetchMock.mockClear();
    fetchMock.mockImplementation(async (url, init) => {
      if (isRefresh(url)) return jsonResponse(200, session(1, "t2", "r2"));
      return new Headers(init?.headers).get("Authorization") === "Bearer t2" ? notModified('W/"a"') : jsonResponse(401, {});
    });
    expect(await revalidatedRequest(PATH)).toEqual({ n: 1 });
    const reads = fetchMock.mock.calls.filter(([url]) => !isRefresh(url));
    expect(reads).toHaveLength(2);
    expect(reads.map(sentTag)).toEqual(['W/"a"', 'W/"a"']);
  });

  test("a token rotation keeps the kept document", async () => {
    fetchMock.mockResolvedValueOnce(tagged({ n: 1 }, 'W/"a"'));
    await revalidatedRequest(PATH);
    localStorage.setItem("astrolabe.auth.token", "rotated");
    fetchMock.mockResolvedValueOnce(notModified('W/"a"'));
    expect(await revalidatedRequest(PATH)).toEqual({ n: 1 });
  });

  test("nothing is written to browser storage beyond the session keys", async () => {
    const before = Object.keys(localStorage).sort();
    const sessionBefore = Object.keys(sessionStorage).sort();
    fetchMock.mockResolvedValueOnce(tagged({ n: 1 }, 'W/"a"'));
    await revalidatedRequest(PATH);
    expect(Object.keys(localStorage).sort()).toEqual(before);
    expect(Object.keys(sessionStorage).sort()).toEqual(sessionBefore);
  });
});
