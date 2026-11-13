import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LINK_CONNECTION, linksView, nodeLink } from "../test/jiraLinks";
import { jsonResponse } from "../test/http";
import { useJiraPlanLinks } from "./useJiraPlanLinks";

const URL_ = "/api/v1/views/jira-links";

describe("useJiraPlanLinks", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  let client: QueryClient;
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;

  beforeEach(() => {
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    localStorage.setItem("astrolabe.auth.token", "fake-token");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  test("asks nothing while disabled; once enabled it answers the programs and the projects by node id, and the connections", async () => {
    const program = nodeLink("PROGRAM", 10, "IMC-1");
    const projectLink = nodeLink("PROJECT", 10, "IMC-2", { gone: true });
    mockFetch.mockImplementation(() => Promise.resolve(jsonResponse(200, linksView({ links: [program, projectLink] }))));
    const { result, rerender } = renderHook(({ enabled }) => useJiraPlanLinks(enabled), { wrapper, initialProps: { enabled: false } });
    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.current).toMatchObject({ connections: null, failed: false });
    expect(result.current.programs.size + result.current.projects.size).toBe(0);
    rerender({ enabled: true });
    await waitFor(() => expect(result.current.connections).toEqual([LINK_CONNECTION]));
    expect(mockFetch.mock.calls.map(([url]) => url)).toEqual([URL_]);
    expect(result.current.programs.get(10)).toEqual(program);
    expect(result.current.projects.get(10)).toEqual(projectLink);
    expect(result.current.failed).toBe(false);
  });

  test("reads under [jira, links] with a 30 s stale time and no retry, so every [jira] invalidation re-reads it", async () => {
    mockFetch.mockImplementation(() => Promise.resolve(jsonResponse(200, linksView())));
    const { result } = renderHook(() => useJiraPlanLinks(true), { wrapper });
    await waitFor(() => expect(result.current.connections).not.toBeNull());
    const options = client.getQueryCache().find({ queryKey: ["jira", "links"] })?.observers[0].options;
    expect(options?.staleTime).toBe(30_000);
    expect(options?.retry).toBe(false);
    await client.invalidateQueries({ queryKey: ["jira"] });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  test("a failed read is reported as failed with a retry, and the maps stay empty", async () => {
    mockFetch.mockImplementationOnce(() => Promise.resolve(jsonResponse(500, { title: "x", status: 500 })));
    const { result } = renderHook(() => useJiraPlanLinks(true), { wrapper });
    await waitFor(() => expect(result.current.failed).toBe(true));
    expect(result.current.connections).toBeNull();
    expect(result.current.programs.size + result.current.projects.size).toBe(0);
    mockFetch.mockImplementation(() => Promise.resolve(jsonResponse(200, linksView({ links: [nodeLink("PROJECT", 3, "IMC-3")] }))));
    result.current.retry();
    await waitFor(() => expect(result.current.projects.has(3)).toBe(true));
    expect(result.current.failed).toBe(false);
  });
});
