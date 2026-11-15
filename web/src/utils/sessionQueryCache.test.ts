import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { jsonResponse, notModified } from "../test/http";
import { forgetRevalidated, revalidatedRequest } from "../api/revalidate";
import { clearSession, getSessionSnapshot, persistRefreshedSession, persistSession } from "../api/session";
import type { components } from "../api/schema";
import { bindSessionQueryCache } from "./sessionQueryCache";

type LoginSuccess = components["schemas"]["LoginResponse"];

const session = (userId: number, token: string): LoginSuccess => ({
  token,
  expiresAt: 1,
  refreshToken: `refresh-${token}`,
  refreshExpiresAt: 2,
  userId,
  roles: [],
  disabledFeatures: [],
  language: "en",
});

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

describe("session query cache", () => {
  let queryClient: QueryClient;
  let unbind: () => void;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    unbind = bindSessionQueryCache(queryClient);
  });

  afterEach(() => {
    unbind();
    queryClient.clear();
    forgetRevalidated();
    vi.unstubAllGlobals();
  });

  test("a replacement login removes the previous caller's cached notifications", () => {
    persistSession(session(1, "token-a"));
    queryClient.setQueryData(["notifications", "unread"], { total: 3 });
    queryClient.setQueryData(["notifications", "list", 1], { items: [{ id: 41 }], total: 1 });
    const unreadObserver = new QueryObserver(queryClient, {
      queryKey: ["notifications", "unread"],
      queryFn: async () => ({ total: 0 }),
      enabled: false,
    });
    const unsubscribe = unreadObserver.subscribe(() => undefined);

    persistSession(session(2, "token-b"));

    expect(queryClient.getQueryData(["notifications", "unread"])).toBeUndefined();
    expect(queryClient.getQueryData(["notifications", "list", 1])).toBeUndefined();
    expect(unreadObserver.getCurrentResult().data).toBeUndefined();
    unsubscribe();
  });

  test("a late response from the previous caller cannot repopulate the replacement session", async () => {
    persistSession(session(1, "token-a"));
    const response = deferred<{ total: number }>();
    const pending = queryClient.fetchQuery({
      queryKey: ["notifications", "unread"],
      queryFn: () => response.promise,
    });

    persistSession(session(2, "token-b"));
    response.resolve({ total: 7 });
    await pending.catch(() => undefined);

    expect(queryClient.getQueryData(["notifications", "unread"])).toBeUndefined();
  });

  test("another tab replacing the stored identity clears caller-scoped data", () => {
    persistSession(session(1, "token-a"));
    queryClient.setQueryData(["notifications", "unread"], { total: 2 });
    localStorage.setItem("astrolabe.auth.token", "token-b");
    localStorage.setItem("astrolabe.auth.sessionIdentity", "external-session-b");

    window.dispatchEvent(new StorageEvent("storage", {
      key: "astrolabe.auth.sessionIdentity",
      newValue: "external-session-b",
      storageArea: localStorage,
    }));

    expect(queryClient.getQueryData(["notifications", "unread"])).toBeUndefined();
  });

  test("silent refresh preserves cache within the same logical session", () => {
    persistSession(session(1, "token-a"));
    const beforeRefresh = getSessionSnapshot();
    queryClient.setQueryData(["notifications", "unread"], { total: 4 });

    expect(persistRefreshedSession(session(1, "token-a2"), beforeRefresh)).not.toBeNull();

    expect(queryClient.getQueryData(["notifications", "unread"])).toEqual({ total: 4 });
  });

  describe("the kept view documents", () => {
    const sentTag = (call: unknown[]) => new Headers((call[1] as RequestInit | undefined)?.headers).get("If-None-Match");

    async function keepOne() {
      const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
      vi.stubGlobal("fetch", fetchMock);
      fetchMock.mockImplementationOnce(async () => jsonResponse(200, { n: 1 }, { ETag: 'W/"a"' }));
      await revalidatedRequest("/api/v1/views/home");
      return fetchMock;
    }

    // Each case puts the OLD identity string back after the change, so that the entry's own identity check cannot hide a missing
    // `forgetRevalidated()`: only the boundary's call can make the next read go out without a tag.
    const IDENTITY_KEY = "astrolabe.auth.sessionIdentity";

    async function expectEmptiedBy(change: () => void) {
      persistSession(session(1, "token-a"));
      const identityA = localStorage.getItem(IDENTITY_KEY) ?? "";
      const fetchMock = await keepOne();
      change();
      localStorage.setItem(IDENTITY_KEY, identityA);
      fetchMock.mockImplementationOnce(async () => jsonResponse(200, { n: 2 }, { ETag: 'W/"b"' }));
      await revalidatedRequest("/api/v1/views/home");
      expect(sentTag(fetchMock.mock.calls[1])).toBeNull();
    }

    test("a replacement login empties them", async () => {
      await expectEmptiedBy(() => persistSession(session(2, "token-b")));
    });

    test("a sign-out empties them", async () => {
      await expectEmptiedBy(() => clearSession());
    });

    test("another tab changing the stored identity empties them", async () => {
      await expectEmptiedBy(() => {
        localStorage.setItem(IDENTITY_KEY, "external-session-b");
        window.dispatchEvent(new StorageEvent("storage", { key: IDENTITY_KEY, newValue: "external-session-b", storageArea: localStorage }));
      });
    });

    test("a token rotation within one identity keeps them", async () => {
      persistSession(session(1, "token-a"));
      const fetchMock = await keepOne();
      expect(persistRefreshedSession(session(1, "token-a2"), getSessionSnapshot())).not.toBeNull();
      fetchMock.mockImplementationOnce(async () => notModified('W/"a"'));
      expect(await revalidatedRequest("/api/v1/views/home")).toEqual({ n: 1 });
      expect(sentTag(fetchMock.mock.calls[1])).toBe('W/"a"');
    });
  });
});
