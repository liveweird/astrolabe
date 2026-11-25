import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useScheduleProposal } from "./useScheduleProposal";
import { useTeamOrder } from "./useTeamOrder";
import { teamViewKey, useTeamSchedule } from "./useTeamSchedule";
import type { TeamView } from "../api/teams";
import { jsonResponse } from "../test/http";

// A team-page write is stamped with its answered revision in the entry it was made on ONLY, and the INACTIVE sibling entries of the team (the view's
// cache key carries the baseline pick and the Critical path toggle) are removed: a sibling visited earlier holds the OLD order, tray and dates, so
// coming back to it would show that copy until its refetch lands - a change made from it in that window (a reorder of a stale list, a move of a
// milestone it still has in the tray) would be built on what the write has outdated. With no copy the page shows the placeholder, which refuses writes.

const STALE = { type: "urn:astrolabe:problem:stale-revision", title: "Conflict", status: 409, detail: "stale" };
const START = "2042-03-02";

let client: QueryClient;
/** The server: the plan revision, the team's order (and its revision), each milestone's dates and the plan revision it was last scheduled at. */
let server: { revision: number; orderRevision: number; order: number[]; tray: number[]; start: Record<number, string>; scheduledAt: Record<number, number> };
let puts: { url: string; body: { expectedRevision: number; milestoneIds?: number[]; startDate?: string } }[];
/** While set, a schedule PUT is only decided (and answered) once it resolves: a save that is still running. */
let holdSchedulePut: Promise<void> | null;
/** While set, a GET of the baseline-5 entry waits for it (the invalidated refetch still in flight). */
let holdPick5: Promise<void> | null;
/** While set, a GET of the critical-chain entry waits for it. */
let holdChain: Promise<void> | null;

/** The document of one entry: with `chain`, the `?criticalChain=true` one, which alone carries the block. */
const view = (chain = false): TeamView =>
  ({
    ...(chain ? { criticalChain: { members: [], links: [], truncated: false } } : {}),
    revision: server.revision,
    team: { id: 1, can: { schedule: true, editCapacity: true, editOrder: true } },
    scheduled: server.order.map((id) => ({ id, name: `m${id}`, projectId: 7, projectName: "Invoices", rankPosition: 1, flags: [], startDate: server.start[id], endDate: server.start[id] })),
    unscheduled: server.tray.map((id) => ({ id, name: `m${id}`, projectId: 7, projectName: "Invoices", rankPosition: 1, flags: [], startDate: null, endDate: null })),
    order: { custom: true, revision: server.orderRevision, milestoneIds: server.order },
  }) as unknown as TeamView;

const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  server = { revision: 12, orderRevision: 1, order: [5, 6, 7], tray: [], start: { 5: START, 6: START, 7: START }, scheduledAt: { 5: 3, 6: 3, 7: 3 } };
  puts = [];
  holdPick5 = null;
  holdChain = null;
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
            const id = Number(schedule[1]);
            server.start[id] = body.startDate as string;
            // a tray milestone that gets dates joins the scheduled rows
            if (server.tray.includes(id)) {
              server.tray = server.tray.filter((trayed) => trayed !== id);
              server.order = [...server.order, id];
            }
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
      const chain = url.includes("criticalChain=true");
      const snapshot = view(chain);
      if (chain && holdChain) return holdChain.then(() => jsonResponse(200, view(true)));
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
function useTeamWrites(pick: number | null, chain = false) {
  const schedule = useTeamSchedule(1, pick, chain);
  const order = useTeamOrder(1, schedule.view, () => undefined, pick, schedule.placeholder, chain);
  const proposal = useScheduleProposal(1, () => undefined, schedule.placeholder, pick, chain);
  return { schedule, order, proposal };
}

/** The invariant under every write: a cached document has the shape its key promises - the chain block is in the `chain: true` entries and in no other. */
function expectDocumentsMatchKeys() {
  const entries = client.getQueryCache().findAll({ queryKey: ["plan", "team"] });
  expect(entries.length).toBeGreaterThan(0);
  for (const entry of entries) {
    const { chain } = (entry.queryKey as readonly [string, string, number, { baseline: number | null; chain: boolean }])[3];
    // an entry still being fetched has no document yet
    if (entry.state.data === undefined) continue;
    expect([entry.queryKey, (entry.state.data as TeamView).criticalChain !== undefined]).toEqual([entry.queryKey, chain]);
  }
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

/** Back to pick 5, whose entry the write removed: its fetch is held, so what the page shows is None's copy as a placeholder. */
async function returnToPick5(hook: Awaited<ReturnType<typeof visitPick5ThenNone>>) {
  await waitFor(() => expect(hook.result.current.order.pending).toBe(false));
  await waitFor(() => expect(client.isFetching()).toBe(0));
  expect(client.getQueryData<TeamView>(teamViewKey(1, 5))).toBeUndefined();
  holdPick5 = new Promise<void>(() => undefined);
  hook.rerender({ pick: 5 });
  await waitFor(() => expect(client.isFetching()).toBe(1));
  expect(hook.result.current.schedule.placeholder).toBe(true);
}

/** Visit pick 5, come back to None, then change something on None; pick 5's entry is gone and its fetch is held. */
async function writeOnNoneThenReturnToPick5(write: (writes: ReturnType<typeof useTeamWrites>) => void) {
  const hook = await visitPick5ThenNone();
  act(() => write(hook.result.current));
  await returnToPick5(hook);
  return hook;
}

describe("the team page's writes across cached baseline picks", () => {
  test("a reorder on one pick removes the other pick's older entry: coming back to it, a reorder is refused until its fresh copy lands, never built on the old list", async () => {
    const { result } = await writeOnNoneThenReturnToPick5((writes) => void writes.order.move(6, -1));
    expect(server).toMatchObject({ order: [6, 5, 7], orderRevision: 13 });
    act(() => void result.current.order.move(7, -1));
    expect(result.current.order.refused).toBe(true);
    expect(puts).toHaveLength(1);
    expect(server).toMatchObject({ order: [6, 5, 7], orderRevision: 13 });
  });

  test("a move of a milestone on one pick removes the other pick's older entry: moving the same milestone there before its fresh copy lands is refused, not sent", async () => {
    const { result } = await writeOnNoneThenReturnToPick5((writes) => void writes.schedule.commit(5, "2042-03-16", "2042-03-16"));
    expect(server).toMatchObject({ revision: 13, start: { 5: "2042-03-16" } });
    act(() => void result.current.schedule.commit(5, "2042-03-23", "2042-03-23"));
    expect(result.current.schedule.refused).toBe(true);
    expect(puts).toHaveLength(1);
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

  test("an accepted proposal on one pick removes the other pick's older entry: moving a milestone there before its fresh copy lands is refused, not a revert", async () => {
    const hook = await visitPick5ThenNone();
    // a proposal accepted on None (plan revision 13)
    act(() => void hook.result.current.proposal.propose());
    await waitFor(() => expect(hook.result.current.proposal.proposal).not.toBeNull());
    act(() => void hook.result.current.proposal.accept());
    await waitFor(() => expect(hook.result.current.proposal.applying).toBe(false));
    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect(server).toMatchObject({ revision: 13, start: { 6: "2042-04-06" } });
    // the entry the accept was made on adopted the answer
    expect(client.getQueryData<TeamView>(teamViewKey(1, null))?.revision).toBe(13);
    await returnToPick5(hook);
    // pick 5's older copy is gone: nothing to write from
    act(() => void hook.result.current.schedule.commit(6, "2042-03-23", "2042-03-23"));
    expect(hook.result.current.schedule.refused).toBe(true);
    expect(puts).toHaveLength(0);
    expect(server.start[6]).toBe("2042-04-06");
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

describe("the team page's writes across the Critical path toggle's cached entries (1.27)", () => {
  const CHAIN_KEY = teamViewKey(1, null, true);
  const PLAIN_KEY = teamViewKey(1, null);

  test("the key's chain defaults to the plain entry, and the two are different entries", () => {
    expect(teamViewKey(1, null)).toEqual(teamViewKey(1, null, false));
    expect(CHAIN_KEY).not.toEqual(PLAIN_KEY);
  });

  test("a schedule write made with the toggle on lands in the chain entry only: the plain entry is never created, and the chain block survives the step", async () => {
    const { result } = renderHook(() => useTeamWrites(null, true), { wrapper });
    await waitFor(() => expect(result.current.schedule.view?.revision).toBe(12));
    act(() => void result.current.schedule.commit(5, "2042-03-16", "2042-03-16"));
    // the optimistic step is in the entry the page shows, with its chain block, before the server answers
    expect(client.getQueryData<TeamView>(CHAIN_KEY)?.scheduled.find((m) => m.id === 5)?.startDate).toBe("2042-03-16");
    expect(client.getQueryData<TeamView>(CHAIN_KEY)?.criticalChain).toBeDefined();
    await waitFor(() => expect(result.current.schedule.pending).toBe(false));
    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect(client.getQueryData<TeamView>(CHAIN_KEY)?.revision).toBe(13);
    expect(client.getQueryData<TeamView>(PLAIN_KEY)).toBeUndefined();
    expect(puts[0].body).toMatchObject({ expectedRevision: 12, startDate: "2042-03-16" });
    expectDocumentsMatchKeys();
  });

  test("a reorder made with the toggle on lands in the chain entry only", async () => {
    const { result } = renderHook(() => useTeamWrites(null, true), { wrapper });
    await waitFor(() => expect(result.current.schedule.view?.revision).toBe(12));
    act(() => void result.current.order.move(6, -1));
    expect(client.getQueryData<TeamView>(CHAIN_KEY)?.scheduled.map((m) => m.id)).toEqual([6, 5, 7]);
    await waitFor(() => expect(result.current.order.pending).toBe(false));
    await waitFor(() => expect(client.getQueryData<TeamView>(CHAIN_KEY)?.order.revision).toBe(13));
    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect(client.getQueryData<TeamView>(PLAIN_KEY)).toBeUndefined();
    expectDocumentsMatchKeys();
  });

  test("an accepted proposal made with the toggle on lands in the chain entry only", async () => {
    const { result } = renderHook(() => useTeamWrites(null, true), { wrapper });
    await waitFor(() => expect(result.current.schedule.view?.revision).toBe(12));
    // the refetch the accept starts never lands, so what the chain entry holds is what the ACCEPT wrote into it
    holdChain = new Promise<void>(() => undefined);
    act(() => void result.current.proposal.propose());
    await waitFor(() => expect(result.current.proposal.proposal).not.toBeNull());
    act(() => void result.current.proposal.accept());
    await waitFor(() => expect(result.current.proposal.applying).toBe(false));
    expect(server).toMatchObject({ revision: 13, start: { 6: "2042-04-06" } });
    expect(client.getQueryData<TeamView>(CHAIN_KEY)?.revision).toBe(13);
    expect(client.getQueryData<TeamView>(CHAIN_KEY)?.scheduled.find((m) => m.id === 6)?.startDate).toBe("2042-04-06");
    expect(client.getQueryData<TeamView>(PLAIN_KEY)).toBeUndefined();
    expectDocumentsMatchKeys();
  });

  test("a write on the plain entry removes the chain entry visited earlier: toggling back, a change is refused until its fresh copy lands", async () => {
    const hook = renderHook(({ chain }: { chain: boolean }) => useTeamWrites(null, chain), { wrapper, initialProps: { chain: true } });
    await waitFor(() => expect(hook.result.current.schedule.view?.revision).toBe(12));
    hook.rerender({ chain: false });
    await waitFor(() => expect(hook.result.current.schedule.placeholder).toBe(false));
    await waitFor(() => expect(client.isFetching()).toBe(0));
    act(() => void hook.result.current.schedule.commit(5, "2042-03-16", "2042-03-16"));
    await waitFor(() => expect(hook.result.current.schedule.pending).toBe(false));
    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect(server).toMatchObject({ revision: 13, start: { 5: "2042-03-16" } });
    expect(client.getQueryData<TeamView>(PLAIN_KEY)?.revision).toBe(13);
    expect(client.getQueryData<TeamView>(CHAIN_KEY)).toBeUndefined();
    // back to the chain entry, which has to be fetched again (held): the page shows the plain copy as a placeholder and writes nothing
    holdChain = new Promise<void>(() => undefined);
    hook.rerender({ chain: true });
    await waitFor(() => expect(client.isFetching()).toBe(1));
    expect(hook.result.current.schedule.placeholder).toBe(true);
    act(() => void hook.result.current.schedule.commit(5, "2042-03-23", "2042-03-23"));
    expect(hook.result.current.schedule.refused).toBe(true);
    expect(puts).toHaveLength(1);
    expect(server.start[5]).toBe("2042-03-16");
    expectDocumentsMatchKeys();
  });

  test("the reviewer's sequence: toggle off, schedule a tray milestone, toggle on, Move up at once - no reorder goes out built on the chain copy's old list", async () => {
    server.order = [5, 6];
    server.tray = [7]; // 7 waits in the tray
    const hook = renderHook(({ chain }: { chain: boolean }) => useTeamWrites(null, chain), { wrapper, initialProps: { chain: true } });
    await waitFor(() => expect(hook.result.current.schedule.view?.revision).toBe(12));
    hook.rerender({ chain: false });
    await waitFor(() => expect(hook.result.current.schedule.placeholder).toBe(false));
    await waitFor(() => expect(client.isFetching()).toBe(0));
    act(() => void hook.result.current.schedule.commit(7, "2042-03-16", "2042-03-16"));
    await waitFor(() => expect(hook.result.current.schedule.pending).toBe(false));
    await waitFor(() => expect(client.isFetching()).toBe(0));
    holdChain = new Promise<void>(() => undefined);
    hook.rerender({ chain: true });
    await waitFor(() => expect(client.isFetching()).toBe(1));
    act(() => void hook.result.current.order.move(6, -1));
    expect(puts.filter((put) => put.url.endsWith("/milestone-order"))).toEqual([]);
    expect(hook.result.current.order.refused).toBe(true);
  });

  test("the toggle turned off while a write runs: the answered revision still goes into the entry the change was made on (the chain one), not the plain one now shown", async () => {
    let release!: () => void;
    holdSchedulePut = new Promise<void>((resolve) => {
      release = resolve;
    });
    const hook = renderHook(({ chain }: { chain: boolean }) => useTeamWrites(null, chain), { wrapper, initialProps: { chain: true } });
    await waitFor(() => expect(hook.result.current.schedule.view?.revision).toBe(12));
    act(() => void hook.result.current.schedule.commit(5, "2042-03-16", "2042-03-16"));
    await waitFor(() => expect(puts).toHaveLength(1));
    hook.rerender({ chain: false });
    await waitFor(() => expect(hook.result.current.schedule.placeholder).toBe(false));
    await act(async () => {
      release();
    });
    await waitFor(() => expect(hook.result.current.schedule.pending).toBe(false));
    expect(client.getQueryData<TeamView>(CHAIN_KEY)?.revision).toBe(13);
    expect(client.getQueryData<TeamView>(CHAIN_KEY)?.scheduled.find((m) => m.id === 5)?.startDate).toBe("2042-03-16");
    expectDocumentsMatchKeys();
  });
});
