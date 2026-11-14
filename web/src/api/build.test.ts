import { afterEach, describe, expect, test, vi } from "vitest";
import { getServedBuild } from "./build";
import { jsonResponse } from "../test/http";

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/html" } });
}

function stubShell(body: string, status = 200) {
  const fetchMock = vi.fn(() => Promise.resolve(htmlResponse(body, status)));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("getServedBuild", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("answers the stamp whatever the attribute order or quoting", async () => {
    stubShell('<html><head><meta content="abc1234" name="astrolabe-build"></head></html>');
    await expect(getServedBuild()).resolves.toBe("abc1234");
    stubShell("<html><head><meta name='astrolabe-build' content='def5678+dirty' /></head></html>");
    await expect(getServedBuild()).resolves.toBe("def5678+dirty");
  });

  test("reads index.html uncached, with the deadline and no credentials", async () => {
    const fetchMock = stubShell('<meta name="astrolabe-build" content="abc1234">');
    await getServedBuild();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/index\.html$/);
    expect(init.cache).toBe("no-store");
    expect(init.signal).toBeDefined();
    expect(new Headers(init.headers).has("Authorization")).toBe(false);
  });

  test("rejects when it cannot say", async () => {
    stubShell('<meta name="astrolabe-build" content="abc1234">', 503);
    await expect(getServedBuild()).rejects.toThrow();
    stubShell("<html><head><title>Astrolabe</title></head></html>");
    await expect(getServedBuild()).rejects.toThrow();
    stubShell('<meta name="astrolabe-build" content="  ">');
    await expect(getServedBuild()).rejects.toThrow();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonResponse(200, { items: [] }))));
    await expect(getServedBuild()).rejects.toThrow();
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))));
    await expect(getServedBuild()).rejects.toThrow();
  });
});
