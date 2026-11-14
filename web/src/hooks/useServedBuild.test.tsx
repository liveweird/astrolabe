import { type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { focusManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useServedBuild } from "./useServedBuild";

const BUNDLE = "bundle1";

function shell(commit: string): Response {
  return new Response(`<html><head><meta name="astrolabe-build" content="${commit}"></head></html>`, { status: 200 });
}

function renderCheck() {
  const client = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return renderHook(() => useServedBuild(), { wrapper });
}

describe("useServedBuild", () => {
  let served: () => Promise<Response>;

  beforeEach(() => {
    vi.stubGlobal("__APP_COMMIT__", BUNDLE);
    served = () => Promise.resolve(shell(BUNDLE));
    vi.stubGlobal("fetch", vi.fn(() => served()));
  });

  afterEach(() => {
    // Unmount first: a still-mounted observer would re-check (real fetch) when the focus manager or the timers are restored.
    cleanup();
    focusManager.setFocused(undefined);
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  test("the served build equal to the bundle's is not outdated", async () => {
    const { result } = renderCheck();
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(result.current.outdated).toBe(false);
  });

  test("another served build is outdated, and nothing arrived yet is not", async () => {
    served = () => Promise.resolve(shell("other99"));
    const { result } = renderCheck();
    expect(result.current.outdated).toBe(false);
    await waitFor(() => expect(result.current.outdated).toBe(true));
  });

  test("a failed check says nothing", async () => {
    served = () => Promise.reject(new TypeError("Failed to fetch"));
    const { result } = renderCheck();
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(result.current.outdated).toBe(false);
  });

  test("a build without a commit is never checked", async () => {
    vi.stubGlobal("__APP_COMMIT__", "unknown");
    const { result } = renderCheck();
    await act(() => Promise.resolve());
    expect(fetch).not.toHaveBeenCalled();
    expect(result.current.outdated).toBe(false);
  });

  test("regaining focus re-checks; a failed re-check keeps the answer; an equal answer clears it", async () => {
    served = () => Promise.resolve(shell("other99"));
    const { result } = renderCheck();
    await waitFor(() => expect(result.current.outdated).toBe(true));

    served = () => Promise.reject(new TypeError("Failed to fetch"));
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(result.current.outdated).toBe(true);

    served = () => Promise.resolve(shell(BUNDLE));
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await waitFor(() => expect(result.current.outdated).toBe(false));
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  test("checks again after five minutes", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderCheck();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 100);
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
