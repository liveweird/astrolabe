import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useScheduleProposal } from "./useScheduleProposal";
import { useTeamOrder } from "./useTeamOrder";
import { teamViewKey, useTeamSchedule } from "./useTeamSchedule";
import type { TeamView } from "../api/teams";
import { jsonResponse } from "../test/http";

// A team-page write is stamped with its answered revision in the entry it was made on ONLY. The view's cache key carries the baseline pick, so a
// sibling entry visited earlier holds the OLD order and OLD dates: if it got the new revision, a reorder (or a move of the same milestone) made on it
// before its invalidated refetch lands would go out with a current revision, the server would accept it, and the earlier change would be reverted.

const STALE = { type: "urn:astrolabe:problem:stale-revision", title: "Conflict", status: 409, detail: "stale" };
const START = "2042-03-02";

let client: QueryClient;
/** The server: the plan revision, the team's order (and its revision), each milestone's dates and the plan revision it was last scheduled at. */
let server: { revision: number; orderRevision: number; order: number[]; start: Record<number, string>; scheduledAt: Record<number, number> };
let puts: { url: string; body: { expectedRevision: number; milestoneIds?: number[]; startDate?: string } }[];
/** While set, a schedule PUT is only decided (and answered) once it resolves: a save that is still running. */
let holdSchedulePut: Promise<void> | null;
/** While set, a GET of the baseline-5 entry waits for it (the invalidated refetch still in flight). */
let holdPick5: Promise<void> | null;

const view = (): TeamView =>
  ({
    revision: server.revision,
    team: { id: 1, can: { schedule: true, editCapacity: true, editOrder: true } },
    scheduled: server.order.map((id) => ({ id, name: `m${id}`, projectId: 7, projectName: "Invoices", rankPosition: 1, startDate: server.start[id], endDate: server.start[id] })),
    unscheduled: [],
    order: { custom: true, revision: server.orderRevision, milestoneIds: server.order },
  }) as unknown as TeamView;

const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  server = { revision: 12, orderRevision: 1, order: [5, 6, 7], start: { 5: START, 6: START, 7: START }, scheduledAt: { 5: 3, 6: 3, 7: 3 } };
  puts = [];
  holdPick5 = null;
  holdSchedulePut = null;
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        const body = JSON.parse(init.body as string) as { expectedRevision: number; milestoneIds?: number[]; startDate?: string };
        puts.push({ url, body });
        const schedule = /\/milestones\/(\d+)\/schedule$/.exec(url);
        const decide = () => {
          const stale = schedule ? server.scheduledAt[Number(schedule[1])] > body.expectedRevision : server.orderRevision > body.expectedRevision;
          if (stale || body.expectedRevision > server.revision) return jsonResponse(409, STALE);
          server.revision += 1;
          if (schedule) {
            server.start[Number(schedule[1])] = body.startDate as string;
            server.scheduledAt[Number(schedule[1])] = server.revision;
          } else {
            server.order = body.milestoneIds as number[];
            server.orderRevision = server.revision;
          }
          return jsonResponse(200, { revision: server.revision });
        };
        return schedule && holdSchedulePut ? holdSchedulePut.then(decide) : Promise.resolve(decide());
      }
      if (url === "/api/v1/teams/1/schedule-proposal") {
        const to = { start: "2042-04-06", end: "2042-04-06" };
        return Promise.resolve(
          jsonResponse(200, {
            revision: server.revision,
            scopeHash: "b".repeat(64),
            asOf: "2042-01-05",
            teamId: 1,
            moves: [{ milestoneId: 6, name: "m6", projectId: 7, projectName: "Invoices", estimateMd: 1, from: null, to, workingDays: 1, shiftDays: null }],
            unchanged: [],
            unplaced: [],
            pinned: [],
            weeks: [],
            weeksTruncated: false,
            dependencies: [],
          }),
        );
      }
      if (url === "/api/v1/teams/1/milestone-schedules") {
        server.revision += 1;
        server.start[6] = "2042-04-06";
        server.scheduledAt[6] = server.revision;
        return Promise.resolve(jsonResponse(200, { revision: server.revision, accepted: [6], skipped: [] }));
      }
      const snapshot = view();
      return url.endsWith("?baseline=5") && holdPick5 ? holdPick5.then(() => jsonResponse(200, view())) : Promise.resolve(jsonResponse(200, snapshot));
    }),
  );
  localStorage.setItem("astrolabe.auth.token", "fake-token");
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

/** The page's write paths over one pick, as the team page composes them. */
function useTeamWrites(pick: number | null) {
  const schedule = useTeamSchedule(1, pick);
  const order = useTeamOrder(1, schedule.view, () => undefined, pick, schedule.placeholder);
  const proposal = useScheduleProposal(1, () => undefined, schedule.placeholder, pick);
  return { schedule, order, proposal };
}

/** Visit pick 5 (its entry holds the current server state), then come back to None: the page is on None, pick 5's entry is cached. */
async function visitPick5ThenNone() {
  const hook = renderHook(({ pick }: { pick: number | null }) => useTeamWrites(pick), { wrapper, initialProps: { pick: null as number | null } });
  await waitFor(() => expect(hook.result.current.schedule.view?.revision).toBe(12));
  hook.rerender({ pick: 5 });
  await waitFor(() => expect(hook.result.current.schedule.placeholder).toBe(false));
  await waitFor(() => expect(client.isFetching()).toBe(0));
  hook.rerender({ pick: null });
  await waitFor(() => expect(client.isFetching()).toBe(0));
  return hook;
}

/** Back to pick 5, whose entry is now stale (invalidated, not refetched) and whose refetch is held. */
async function returnToPick5(hook: Awaited<ReturnType<typeof visitPick5ThenNone>>) {
  await waitFor(() => expect(hook.result.current.order.pending).toBe(false));
  await waitFor(() => expect(client.isFetching()).toBe(0));
  holdPick5 = new Promise<void>(() => undefined);
  hook.rerender({ pick: 5 });
  await waitFor(() => expect(client.isFetching()).toBe(1));
  expect(hook.result.current.schedule.placeholder).toBe(false);
}

/** Visit pick 5, come back to None, then change something on None; pick 5's entry is now stale and its refetch is held. */
async function writeOnNoneThenReturnToPick5(write: (writes: ReturnType<typeof useTeamWrites>) => void) {
  const hook = await visitPick5ThenNone();
  act(() => write(hook.result.current));
  await returnToPick5(hook);
  return hook;
}

describe("the team page's writes across cached baseline picks", () => {
  test("a reorder on one pick does not stamp its order revision into the other pick's older entry: a reorder there before its refetch lands is a 409, not a revert", async () => {
    const { result } = await writeOnNoneThenReturnToPick5((writes) => void writes.order.move(6, -1));
    expect(server).toMatchObject({ order: [6, 5, 7], orderRevision: 13 });
    // pick 5's cached copy is the OLD order at the OLD order revision
    expect(result.current.schedule.view?.scheduled.map((m) => m.id)).toEqual([5, 6, 7]);
    expect(result.current.schedule.view?.order.revision).toBe(1);
    act(() => void result.current.order.move(7, -1));
    await waitFor(() => expect(puts).toHaveLength(2));
    // the write went out with the entry's own (old) revision, so the server refused it and kept the earlier reorder
    expect(puts.at(-1)?.body).toMatchObject({ milestoneIds: [5, 7, 6], expectedRevision: 1 });
    expect(server).toMatchObject({ order: [6, 5, 7], orderRevision: 13 });
  });

  test("a move of a milestone on one pick does not stamp its plan revision into the other pick's older entry: moving the same milestone there before its refetch lands is a 409, not an overwrite", async () => {
    const { result } = await writeOnNoneThenReturnToPick5((writes) => void writes.schedule.commit(5, "2042-03-16", "2042-03-16"));
    expect(server).toMatchObject({ revision: 13, start: { 5: "2042-03-16" } });
    // pick 5's cached copy still has the old dates and the old plan revision
    expect(result.current.schedule.view?.scheduled.find((m) => m.id === 5)?.startDate).toBe(START);
    expect(result.current.schedule.view?.revision).toBe(12);
    act(() => void result.current.schedule.commit(5, "2042-03-23", "2042-03-23"));
    await waitFor(() => expect(puts).toHaveLength(2));
    expect(puts.at(-1)?.body).toMatchObject({ startDate: "2042-03-23", expectedRevision: 12 });
    expect(server.start[5]).toBe("2042-03-16");
  });

  test("the entry the change was made on gets the new revision, so the next change there goes out at once", async () => {
    const { result } = renderHook(() => useTeamWrites(null), { wrapper });
    await waitFor(() => expect(result.current.schedule.view?.revision).toBe(12));
    act(() => void result.current.order.move(6, -1));
    await waitFor(() => expect(result.current.order.pending).toBe(false));
    await waitFor(() => expect(result.current.schedule.view?.order.revision).toBe(13));
    act(() => void result.current.order.move(7, -1));
    await waitFor(() => expect(server.order).toEqual([6, 7, 5]));
    expect(puts.map((put) => put.body.expectedRevision)).toEqual([1, 13]);
  });

  test("an accepted proposal on one pick does not stamp its plan revision into the other pick's older entry: moving a milestone there before its refetch lands is a 409, not a revert", async () => {
    const hook = await visitPick5ThenNone();
    // a move of milestone 5 on None (plan revision 13, milestone 5 scheduled at 13) ...
    act(() => void hook.result.current.schedule.commit(5, "2042-03-16", "2042-03-16"));
    await waitFor(() => expect(hook.result.current.schedule.pending).toBe(false));
    await waitFor(() => expect(client.isFetching()).toBe(0));
    // ... then a proposal accepted on None (plan revision 14)
    act(() => void hook.result.current.proposal.propose());
    await waitFor(() => expect(hook.result.current.proposal.proposal).not.toBeNull());
    act(() => void hook.result.current.proposal.accept());
    await waitFor(() => expect(hook.result.current.proposal.applying).toBe(false));
    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect(server).toMatchObject({ revision: 14, start: { 5: "2042-03-16", 6: "2042-04-06" } });
    // the entry the accept was made on adopted the answer
    expect(client.getQueryData<TeamView>(teamViewKey(1, null))?.revision).toBe(14);
    await returnToPick5(hook);
    // pick 5's cached copy is untouched: the old dates AND the old plan revision
    expect(hook.result.current.schedule.view?.scheduled.find((m) => m.id === 5)?.startDate).toBe(START);
    expect(hook.result.current.schedule.view?.revision).toBe(12);
    act(() => void hook.result.current.schedule.commit(5, "2042-03-23", "2042-03-23"));
    await waitFor(() => expect(puts).toHaveLength(2));
    expect(puts.at(-1)?.body).toMatchObject({ startDate: "2042-03-23", expectedRevision: 12 });
    expect(server.start[5]).toBe("2042-03-16");
  });

  test("the pick changing while a write runs: the entry the change was made on still gets the answered revision", async () => {
    let release!: () => void;
    holdSchedulePut = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { result, rerender } = renderHook(({ pick }: { pick: number | null }) => useTeamWrites(pick), { wrapper, initialProps: { pick: null as number | null } });
    await waitFor(() => expect(result.current.schedule.view?.revision).toBe(12));
    act(() => void result.current.schedule.commit(5, "2042-03-16", "2042-03-16"));
    await waitFor(() => expect(puts).toHaveLength(1));
    rerender({ pick: 5 });
    await waitFor(() => expect(result.current.schedule.placeholder).toBe(false));
    await act(async () => {
      release();
    });
    await waitFor(() => expect(result.current.schedule.pending).toBe(false));
    expect(server.revision).toBe(13);
    expect(client.getQueryData<TeamView>(teamViewKey(1, null))?.revision).toBe(13);
    expect(client.getQueryData<TeamView>(teamViewKey(1, null))?.scheduled.find((m) => m.id === 5)?.startDate).toBe("2042-03-16");
  });
});
