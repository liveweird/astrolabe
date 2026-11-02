import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { useRoadmapRanking } from "./useRoadmapRanking";
import { useScheduleProposal } from "./useScheduleProposal";
import { useTeamOrder } from "./useTeamOrder";
import { teamViewKey, useTeamSchedule } from "./useTeamSchedule";
import { roadmapViewKey, type RoadmapView } from "../api/roadmap";
import type { TeamView } from "../api/teams";
import { jsonResponse } from "../test/http";

// v0.9: the write paths with a baseline pick. The view's cache key carries the pick, so a write must (a) never start from the previous pick's
// placeholder copy, (b) roll back into the entry it was made on, and (c) store its answered revision into EVERY cached pick entry of the view.

vi.mock("../utils/toast", () => ({ showSuccessToast: vi.fn() }));

const row = (id: number, startDate: string | null, endDate: string | null) => ({ id, name: `m${id}`, projectId: 7, projectName: "Invoices", rankPosition: 1, startDate, endDate });
const BASELINE = { id: 5, name: "Q1", planRevision: 4, milestones: [], removed: [] };

const teamView = (over: Record<string, unknown> = {}) =>
  ({
    revision: 12,
    team: { id: 1, can: { schedule: true, editCapacity: true, editOrder: true } },
    scheduled: [row(5, "2042-03-02", "2042-03-03"), row(6, "2042-03-09", "2042-03-10")],
    unscheduled: [row(1, null, null)],
    order: { custom: false, revision: 1, milestoneIds: [] },
    ...over,
  }) as unknown as TeamView;

let client: QueryClient;
let mockFetch: ReturnType<typeof vi.fn>;
/** Held answers by URL suffix: a request for it waits until the test releases it. */
let held: Map<string, { promise: Promise<Response>; release: (response: Response) => void }>;
let puts: { url: string; body: unknown }[];
let putAnswer: () => Response;
/** When set, a PUT waits for it (a save that is still running). */
let putGate: Promise<Response> | null;
const announce = vi.fn();

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={client}>
    <MemoryRouter>{children}</MemoryRouter>
  </QueryClientProvider>
);

function hold(suffix: string) {
  let release!: (response: Response) => void;
  const promise = new Promise<Response>((resolve) => {
    release = resolve;
  });
  held.set(suffix, { promise, release });
  return { release: (response: Response) => held.get(suffix)?.release(response) };
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  held = new Map();
  puts = [];
  putAnswer = () => jsonResponse(200, { revision: 13 });
  putGate = null;
  announce.mockClear();
  mockFetch = vi.fn((url: string, init?: RequestInit) => {
    if (init?.method === "PUT") {
      puts.push({ url, body: JSON.parse(init.body as string) });
      return putGate ?? Promise.resolve(putAnswer());
    }
    const gate = [...held].find(([suffix]) => url.endsWith(suffix));
    if (gate) return gate[1].promise;
    if (url.startsWith("/api/v1/views/team/1")) return Promise.resolve(jsonResponse(200, url.endsWith("?baseline=5") ? teamView({ baseline: BASELINE }) : teamView()));
    return Promise.resolve(jsonResponse(404, { title: "x", status: 404 }));
  });
  vi.stubGlobal("fetch", mockFetch);
  localStorage.setItem("astrolabe.auth.token", "fake-token");
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

const entry = (pick: number | null) => client.getQueryData<TeamView>(teamViewKey(1, pick));
const startOf = (view: TeamView | undefined, id: number) => [...(view?.scheduled ?? []), ...(view?.unscheduled ?? [])].find((m) => m.id === id)?.startDate;

describe("the schedule path with a baseline pick", () => {
  test("the PUT carries the picked view's revision and its success stores the new revision into every cached pick entry", async () => {
    client.setQueryData(teamViewKey(1, null), teamView());
    const { result } = renderHook(() => useTeamSchedule(1, 5), { wrapper });
    await waitFor(() => expect(result.current.view?.baseline).toBeDefined());
    // the optimistic step keeps the overlay of the entry it ran on
    act(() => void result.current.commit(5, "2042-03-16", "2042-03-17"));
    expect(result.current.view?.baseline).toEqual(BASELINE);
    expect(startOf(entry(5), 5)).toBe("2042-03-16");
    await waitFor(() => expect(entry(null)?.revision).toBe(13));
    expect(puts).toEqual([{ url: "/api/v1/milestones/5/schedule", body: { expectedRevision: 12, startDate: "2042-03-16", endDate: "2042-03-17" } }]);
    // the entry of the other pick keeps ITS rows (the refetch brings the server's) but not the old revision
    expect(startOf(entry(null), 5)).toBe("2042-03-02");
  });

  test("a pick changed while the save runs: the failure rolls back the entry the change was made on and leaves the other pick's alone", async () => {
    let fail!: (response: Response) => void;
    putGate = new Promise<Response>((resolve) => {
      fail = resolve;
    });
    client.setQueryData(teamViewKey(1, null), teamView());
    const { result, rerender } = renderHook(({ pick }: { pick: number | null }) => useTeamSchedule(1, pick), { wrapper, initialProps: { pick: 5 as number | null } });
    await waitFor(() => expect(result.current.view?.baseline).toBeDefined());
    act(() => void result.current.commit(5, "2042-03-16", "2042-03-17"));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(startOf(entry(5), 5)).toBe("2042-03-16");
    rerender({ pick: null });
    expect(result.current.pending).toBe(true);
    await act(async () => {
      fail(jsonResponse(500, { title: "x", status: 500 }));
    });
    await waitFor(() => expect(result.current.pending).toBe(false));
    // rolled back into pick 5's entry, nothing leaked into the entry the page shows now
    expect(startOf(entry(5), 5)).toBe("2042-03-02");
    expect(startOf(entry(null), 5)).toBe("2042-03-02");
  });

  test("a change is refused out loud while the shown copy is only the previous pick's placeholder, and the overlay is not in it", async () => {
    const next = hold("?baseline=6");
    const { result, rerender } = renderHook(({ pick }: { pick: number | null }) => useTeamSchedule(1, pick), { wrapper, initialProps: { pick: 5 as number | null } });
    await waitFor(() => expect(result.current.view?.baseline).toBeDefined());
    rerender({ pick: 6 });
    await waitFor(() => expect(result.current.placeholder).toBe(true));
    expect(result.current.view?.baseline).toBeUndefined();
    act(() => {
      expect(result.current.commit(5, "2042-03-16", "2042-03-17")).toBe(false);
    });
    expect(result.current.refused).toBe(true);
    expect(announce).not.toHaveBeenCalled();
    expect(puts).toEqual([]);
    await act(async () => {
      next.release(jsonResponse(200, teamView({ baseline: { ...BASELINE, id: 6 } })));
    });
    await waitFor(() => expect(result.current.placeholder).toBe(false));
    expect(result.current.refused).toBe(false);
    expect(result.current.view?.baseline?.id).toBe(6);
    act(() => {
      expect(result.current.commit(5, "2042-03-16", "2042-03-17")).toBe(true);
    });
    await waitFor(() => expect(puts).toHaveLength(1));
  });
});

describe("the order path with a baseline pick", () => {
  test("refused while the view is the placeholder; otherwise its order revision goes into every cached pick entry", async () => {
    client.setQueryData(teamViewKey(1, null), teamView());
    client.setQueryData(teamViewKey(1, 5), teamView({ baseline: BASELINE }));
    const { result, rerender } = renderHook(({ loading }: { loading: boolean }) => useTeamOrder(1, client.getQueryData<TeamView>(teamViewKey(1, 5)), announce, 5, loading), {
      wrapper,
      initialProps: { loading: true },
    });
    act(() => {
      expect(result.current.move(5, 1)).toBe(false);
    });
    expect(result.current.refused).toBe(true);
    expect(announce).toHaveBeenCalledWith("A save is still running — try your change again in a moment.");
    expect(puts).toEqual([]);
    rerender({ loading: false });
    expect(result.current.refused).toBe(false);
    act(() => {
      expect(result.current.move(5, 1)).toBe(true);
    });
    await waitFor(() => expect(entry(null)?.order.revision).toBe(13));
    expect(entry(5)?.order.revision).toBe(13);
    expect(puts).toHaveLength(1);
  });
});

describe("the proposal's accept with a baseline pick", () => {
  test("is refused out loud while the view is the placeholder", async () => {
    mockFetch.mockImplementation((url: string) =>
      Promise.resolve(
        url.endsWith("/schedule-proposal")
          ? jsonResponse(200, {
              revision: 12,
              scopeHash: "b".repeat(64),
              asOf: "2042-01-05",
              teamId: 1,
              moves: [{ milestoneId: 1, name: "m1", projectId: 7, projectName: "Invoices", estimateMd: 4, from: null, to: { start: "2042-01-07", end: "2042-01-09" }, workingDays: 3, shiftDays: null }],
              unchanged: [],
              unplaced: [],
              weeks: [],
              weeksTruncated: false,
              dependencies: [],
            })
          : jsonResponse(404, { title: "x", status: 404 }),
      ),
    );
    const { result, rerender } = renderHook(({ loading }: { loading: boolean }) => useScheduleProposal(1, announce, loading), { wrapper, initialProps: { loading: false } });
    act(() => void result.current.propose());
    await waitFor(() => expect(result.current.proposal).not.toBeNull());
    rerender({ loading: true });
    act(() => {
      expect(result.current.accept()).toBe(false);
    });
    expect(result.current.refused).toBe(true);
    expect(mockFetch.mock.calls.some(([url]) => /milestone-schedules$/.test(url as string))).toBe(false);
  });
});

describe("the roadmap ranking with a baseline pick", () => {
  const project = (id: number) => ({ id, name: `p${id}`, rankPosition: id, span: null, baseline: { span: null, movement: { kind: "UNCHANGED" } } });
  let serverRevision = 7;
  const roadmap = (): RoadmapView =>
    ({ revision: serverRevision, can: { editRank: true }, teams: [], links: [], ranked: [{ position: 1, project: project(1) }, { position: 2, project: project(2) }], unranked: [], baseline: { id: 5, name: "Q1", planRevision: 4, removedProjects: [] } }) as unknown as RoadmapView;

  test("a success stores the ranking revision into every pick's entry; the placeholder copy has no overlay anywhere and takes no write", async () => {
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        puts.push({ url, body: JSON.parse(init.body as string) });
        serverRevision = 8;
        return Promise.resolve(jsonResponse(200, { revision: 8 }));
      }
      const gate = [...held].find(([suffix]) => url.endsWith(suffix));
      if (gate) return gate[1].promise;
      return Promise.resolve(jsonResponse(200, roadmap()));
    });
    client.setQueryData(roadmapViewKey(null), { ...roadmap(), baseline: undefined });
    const { result, rerender } = renderHook(({ pick }: { pick: number | null }) => useRoadmapRanking(pick), { wrapper, initialProps: { pick: 5 as number | null } });
    await waitFor(() => expect(result.current.view?.baseline).toBeDefined());
    act(() => void result.current.move(2, -1, [1, 2]));
    await waitFor(() => expect(client.getQueryData<RoadmapView>(roadmapViewKey(null))?.revision).toBe(8));
    expect(client.getQueryData<RoadmapView>(roadmapViewKey(5))?.revision).toBe(8);
    expect(puts).toEqual([{ url: "/api/v1/roadmap/ranking", body: { projectIds: [2, 1], expectedRevision: 7 } }]);
    await waitFor(() => expect(result.current.pending).toBe(false));
    // A -> B while B loads: no project row (nor the top-level block) still carries A's overlay, and a ranking change is refused
    const next = hold("?baseline=6");
    rerender({ pick: 6 });
    await waitFor(() => expect(result.current.placeholder).toBe(true));
    expect(result.current.view?.baseline).toBeUndefined();
    expect(JSON.stringify(result.current.view)).not.toContain("baseline");
    act(() => {
      expect(result.current.move(2, -1, [1, 2])).toBe(false);
    });
    expect(result.current.refused).toBe(true);
    expect(puts).toHaveLength(1);
    await act(async () => {
      next.release(jsonResponse(200, roadmap()));
    });
    await waitFor(() => expect(result.current.placeholder).toBe(false));
  });
});
