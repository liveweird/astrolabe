import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useJiraImport } from "./useJiraImport";
import { jsonResponse } from "../test/http";
import { hangUntilAborted, installImportApi } from "../test/jiraImportHarness";
import { PREVIEW_ITEMS, previewOf } from "../test/jiraImport";

const SCOPE = { workStreamId: 3, ownerPersonId: 8, copyDates: true };
const BODY = { ...SCOPE, items: [{ jiraId: "95001", expected: { action: "CREATE" as const, level: "PROGRAM" as const } }] };

let queryClient: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

const refreshedKeys = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map(([filters]) => JSON.stringify((filters as { queryKey?: unknown } | undefined)?.queryKey));

describe("useJiraImport", () => {
  test("a second call in the same tick sends nothing: the ref guard refuses it, whatever the buttons look like", async () => {
    const api = installImportApi({ preview: () => jsonResponse(200, previewOf(PREVIEW_ITEMS)), apply: () => jsonResponse(500, { title: "x", status: 500 }) });
    const { result } = renderHook(() => useJiraImport(1), { wrapper });
    await act(async () => {
      void result.current.runPreview(SCOPE);
      void result.current.runPreview(SCOPE);
      void result.current.runApply(BODY);
    });
    expect(api.previews()).toHaveLength(1);
    expect(api.applies()).toHaveLength(0);
    await waitFor(() => expect(result.current.phase).toBe("preview"));
  });

  test("leaving the page cancels a preview in flight", async () => {
    let signal: AbortSignal | undefined;
    installImportApi({ preview: (_body, init) => ((signal = init.signal ?? undefined), hangUntilAborted(_body, init)) });
    const { result, unmount } = renderHook(() => useJiraImport(1), { wrapper });
    act(() => void result.current.runPreview(SCOPE));
    await waitFor(() => expect(signal).toBeDefined());
    unmount();
    expect(signal?.aborted).toBe(true);
  });

  test("leaving the page does NOT abort an apply: it finishes, and the plan and Jira queries are still refreshed", async () => {
    const gate: { release?: (response: Response) => void } = {};
    let signal: AbortSignal | undefined;
    installImportApi({
      preview: () => jsonResponse(200, previewOf(PREVIEW_ITEMS)),
      apply: (_body, init) => new Promise<Response>((resolve) => ((signal = init.signal ?? undefined), (gate.release = resolve))),
    });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const { result, unmount } = renderHook(() => useJiraImport(1), { wrapper });
    act(() => void result.current.runApply(BODY));
    await waitFor(() => expect(signal).toBeDefined());
    unmount();
    expect(signal?.aborted).toBe(false);
    gate.release?.(jsonResponse(200, { revision: 13, created: [], bound: [], skipped: [] }));
    await waitFor(() => expect(refreshedKeys(invalidate)).toEqual(expect.arrayContaining(['["jira"]', '["plan"]', '["roadmap"]'])));
  });
});
