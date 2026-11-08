import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useRoadmapRanking } from "./useRoadmapRanking";
import type { RoadmapView } from "../api/roadmap";
import { jsonResponse } from "../test/http";

// A ranking write is stamped with the new revision in the entry it was made on ONLY. The view's cache key carries the baseline pick and the
// critical-path target, so a sibling entry visited earlier holds the OLD order: if it got the new revision, a drop made on it before its
// invalidated refetch lands would PUT the old order with a current revision, the server would accept it and the earlier move would be reverted.

const project = (id: number) => ({ id, name: `p${id}`, rankPosition: id, span: null });
const STALE = { type: "urn:astrolabe:problem:stale-revision", title: "Conflict", status: 409, detail: "stale" };

let client: QueryClient;
/** The server: its ranking and its revision; a PUT is accepted only with the current revision (otherwise the stale 409). */
let server: { revision: number; order: number[] };
let puts: { projectIds: number[]; expectedRevision: number }[];
/** While set, a GET of the target-3 entry waits for it (the invalidated refetch still in flight). */
let holdTarget3: Promise<void> | null;

const roadmap = (): RoadmapView =>
  ({ revision: server.revision, can: { editRank: true }, teams: [], links: [], ranked: server.order.map((id, index) => ({ position: index + 1, project: project(id) })), unranked: [] }) as unknown as RoadmapView;

const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  server = { revision: 7, order: [1, 2, 3] };
  puts = [];
  holdTarget3 = null;
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        const body = JSON.parse(init.body as string) as { projectIds: number[]; expectedRevision: number };
        puts.push(body);
        if (body.expectedRevision !== server.revision) return Promise.resolve(jsonResponse(409, STALE));
        server = { revision: server.revision + 1, order: body.projectIds };
        return Promise.resolve(jsonResponse(200, { revision: server.revision }));
      }
      const snapshot = roadmap();
      return url.endsWith("?criticalPath=3") && holdTarget3 ? holdTarget3.then(() => jsonResponse(200, roadmap())) : Promise.resolve(jsonResponse(200, snapshot));
    }),
  );
  localStorage.setItem("astrolabe.auth.token", "fake-token");
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

const orderOf = (view: RoadmapView | undefined) => view?.ranked.map((entry) => entry.project.id);

describe("useRoadmapRanking across cached targets", () => {
  test("a move on one target does not stamp its revision into the other target's older entry: a drop there before its refetch lands is a 409, not a revert", async () => {
    const { result, rerender } = renderHook(({ target }: { target: number | null }) => useRoadmapRanking(null, target), { wrapper, initialProps: { target: null as number | null } });
    await waitFor(() => expect(result.current.view?.revision).toBe(7));
    // visit target 3 (its entry holds the order 1,2,3 at revision 7), then come back to None
    rerender({ target: 3 });
    await waitFor(() => expect(result.current.placeholder).toBe(false));
    await waitFor(() => expect(result.current.query.isFetching).toBe(false));
    rerender({ target: null });
    await waitFor(() => expect(result.current.query.isFetching).toBe(false));
    // the move on None: accepted, the server is at revision 8 with the order 2,1,3
    act(() => void result.current.move(2, -1, [1, 2, 3]));
    await waitFor(() => expect(result.current.pending).toBe(false));
    expect(server).toEqual({ revision: 8, order: [2, 1, 3] });
    // back to target 3 with its refetch still in flight: the cached copy is the OLD order at the OLD revision
    let release!: () => void;
    holdTarget3 = new Promise<void>((resolve) => {
      release = resolve;
    });
    rerender({ target: 3 });
    await waitFor(() => expect(result.current.query.isFetching).toBe(true));
    expect(result.current.placeholder).toBe(false);
    expect(orderOf(result.current.view)).toEqual([1, 2, 3]);
    expect(result.current.view?.revision).toBe(7);
    act(() => void result.current.move(3, -1, [1, 2, 3]));
    // the write went out with the entry's own (old) revision, so the server refused it and kept the earlier move
    await waitFor(() => expect(puts).toHaveLength(2));
    expect(puts.at(-1)).toEqual({ projectIds: [1, 3, 2], expectedRevision: 7 });
    expect(server).toEqual({ revision: 8, order: [2, 1, 3] });
    // the refresh brings the server's truth
    await act(async () => {
      release();
    });
    await waitFor(() => expect(result.current.stale).toBe(true));
    await waitFor(() => expect(orderOf(result.current.view)).toEqual([2, 1, 3]));
    expect(result.current.view?.revision).toBe(8);
  });

  test("the entry the change was made on gets the new revision, so the next move there goes out at once", async () => {
    const { result } = renderHook(() => useRoadmapRanking(null, null), { wrapper });
    await waitFor(() => expect(result.current.view?.revision).toBe(7));
    act(() => void result.current.move(2, -1, [1, 2, 3]));
    await waitFor(() => expect(result.current.pending).toBe(false));
    await waitFor(() => expect(result.current.view?.revision).toBe(8));
    act(() => void result.current.move(3, -1, [2, 1, 3]));
    await waitFor(() => expect(server).toEqual({ revision: 9, order: [2, 3, 1] }));
    expect(puts.map((put) => put.expectedRevision)).toEqual([7, 8]);
  });
});
