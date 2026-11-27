import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { movesOf, useCrossTeamProposal, type CrossTeamProposalOptions } from "./useCrossTeamProposal";
import { useScheduleCheck } from "./useScheduleCheck";
import { ACCEPT_URL, block, CHECK_URL, ids, move, RUN, RUN_URL, STALE_SCOPE } from "../test/crossTeamRun";
import { jsonResponse } from "../test/http";
import { requestsAnswered } from "../test/requestsAnswered";

// The viewer of 1.33: every login previews a run, only the teams of `acceptable` have moves to tick. RUN: Platform (1) x1 x2, Payments (2) y1.
let client: QueryClient;
let mockFetch: ReturnType<typeof vi.fn>;
let runAnswer: Response | (() => Response);
let acceptAnswer: Response;
const announce = vi.fn();

const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
const bodies = (url: string) => mockFetch.mock.calls.filter(([u]) => u === url).map(([, init]) => JSON.parse((init as RequestInit).body as string));

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  runAnswer = jsonResponse(200, RUN);
  acceptAnswer = jsonResponse(200, { revision: 13, accepted: [21], skipped: [] });
  mockFetch = vi.fn((url: string) => {
    if (url === RUN_URL) return Promise.resolve(typeof runAnswer === "function" ? runAnswer() : runAnswer.clone());
    if (url === ACCEPT_URL) return Promise.resolve(acceptAnswer.clone());
    if (url === CHECK_URL) return Promise.resolve(jsonResponse(200, { teams: [] }));
    return Promise.resolve(jsonResponse(404, { title: "Not Found", status: 404 }));
  });
  vi.stubGlobal("fetch", mockFetch);
  localStorage.setItem("astrolabe.auth.token", "fake-token");
  announce.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

async function opened(options: CrossTeamProposalOptions) {
  const rendered = renderHook((props: CrossTeamProposalOptions) => useCrossTeamProposal(announce, props), { wrapper, initialProps: options });
  act(() => {
    expect(rendered.result.current.propose([1, 2])).toBe(true);
  });
  await waitFor(() => expect(rendered.result.current.proposal).not.toBeNull());
  return rendered;
}

describe("what the viewer may tick", () => {
  test("a manager of one team: only that team's moves start ticked and are tickable; the other team's checkboxes do nothing", async () => {
    const { result } = await opened({ acceptable: new Set([2]) });
    expect([...result.current.selected]).toEqual([21]);
    expect([...result.current.tickable]).toEqual([21]);
    expect(result.current.canAccept).toBe(true);
    act(() => result.current.toggle(11));
    expect([...result.current.selected]).toEqual([21]);
    act(() => result.current.toggle(21));
    expect(result.current.selected.size).toBe(0);
  });

  test("an administrator (every team acceptable) ticks every move, as before", async () => {
    const { result } = await opened({ acceptable: new Set([1, 2]) });
    expect([...result.current.selected].sort()).toEqual([11, 12, 21]);
    expect(result.current.canAccept).toBe(true);
  });

  test("select all / none act on the tickable moves of ONE team and say 'n of N' over the tickable ones", async () => {
    const { result } = await opened({ acceptable: new Set([1]) });
    // the announcement counts what the viewer may tick (2 of the run's 3 moves)
    expect(announce).toHaveBeenCalledWith("Proposed schedule ready: 2 moves");
    act(() => result.current.selectNone(1));
    expect(result.current.selected.size).toBe(0);
    expect(announce).toHaveBeenLastCalledWith("0 of 2 selected");
    act(() => result.current.selectAll(2));
    expect(result.current.selected.size).toBe(0);
    act(() => result.current.selectAll(1));
    expect([...result.current.selected].sort()).toEqual([11, 12]);
    expect(announce).toHaveBeenLastCalledWith("2 of 2 selected");
  });

  test("a viewer who may accept nothing: no tick, no Accept, and an accept sends nothing", async () => {
    const { result } = await opened({ acceptable: new Set() });
    expect(result.current.selected.size).toBe(0);
    expect(result.current.canAccept).toBe(false);
    act(() => result.current.toggle(11));
    expect(result.current.selected.size).toBe(0);
    act(() => {
      expect(result.current.accept()).toBe(false);
    });
    expect(bodies(ACCEPT_URL)).toEqual([]);
  });

  test("a project slice offers only that project's moves of the acceptable teams, and initialTicks narrows the default ticks", async () => {
    runAnswer = jsonResponse(200, { ...RUN, teams: [block(1, "Platform", [move(11, "x1", "2042-01-06", "2042-01-08"), move(12, "x2", "2042-01-09", "2042-01-09", { projectId: 9 })]), RUN.teams[1]] });
    const { result } = await opened({ acceptable: new Set([1, 2]), projectId: 7 });
    expect([...result.current.tickable].sort()).toEqual([11, 21]);
    expect([...result.current.selected].sort()).toEqual([11, 21]);
    act(() => result.current.selectAll(1));
    expect([...result.current.selected].sort()).toEqual([11, 21]);
    const narrowed = await opened({ acceptable: new Set([1, 2]), initialTicks: (m) => m.milestoneId === 12 });
    expect([...narrowed.result.current.selected]).toEqual([12]);
  });
});

describe("ticks that are not the viewer's", () => {
  test("a stored run opened with ticks on a team the viewer may not accept keeps only the tickable ones", () => {
    const { result } = renderHook(() => useCrossTeamProposal(announce, { acceptable: new Set([2]) }), { wrapper });
    act(() => {
      expect(result.current.open(RUN, new Set([11, 21]))).toBe(true);
    });
    expect([...result.current.selected]).toEqual([21]);
  });

  test("an unrestricted hook still opens a stored run with its ticks exactly", () => {
    const { result } = renderHook(() => useCrossTeamProposal(announce), { wrapper });
    act(() => void result.current.open(RUN, new Set([11, 21])));
    expect([...result.current.selected].sort()).toEqual([11, 21]);
  });

  test("rights that shrink after the ticks were set shrink the accept with them: items and acceptTeamIds follow selected and tickable", async () => {
    const { result, rerender } = await opened({ acceptable: new Set([1, 2]) });
    rerender({ acceptable: new Set([2]) });
    act(() => {
      expect(result.current.accept()).toBe(true);
    });
    await waitFor(() => expect(bodies(ACCEPT_URL)).toHaveLength(1));
    expect(bodies(ACCEPT_URL)[0].acceptTeamIds).toEqual([2]);
    expect(ids(bodies(ACCEPT_URL)[0])).toEqual([21]);
  });

  test("rights that vanish leave nothing to accept: no request", async () => {
    const { result, rerender } = await opened({ acceptable: new Set([1, 2]) });
    rerender({ acceptable: new Set() });
    act(() => {
      expect(result.current.accept()).toBe(false);
    });
    expect(bodies(ACCEPT_URL)).toEqual([]);
  });
});

describe("the accept names the teams it writes", () => {
  test("acceptTeamIds = the teams of the ticked moves; the run's teamIds stay the whole run", async () => {
    const { result } = await opened({ acceptable: new Set([2]) });
    act(() => {
      expect(result.current.accept()).toBe(true);
    });
    await waitFor(() => expect(result.current.outcome).not.toBeNull());
    expect(bodies(ACCEPT_URL)).toEqual([
      { expectedRevision: 12, scopeHash: "b".repeat(64), teamIds: [1, 2], acceptTeamIds: [2], items: [{ milestoneId: 21, startDate: "2042-01-12", endDate: "2042-01-14" }] },
    ]);
    expect(result.current.proposal).toBeNull();
  });

  test("unticking a whole team drops it from acceptTeamIds, ascending ids", async () => {
    const { result } = await opened({ acceptable: new Set([1, 2]) });
    act(() => result.current.selectNone(1));
    act(() => void result.current.accept());
    await waitFor(() => expect(bodies(ACCEPT_URL)).toHaveLength(1));
    expect(bodies(ACCEPT_URL)[0].acceptTeamIds).toEqual([2]);
    expect(ids(bodies(ACCEPT_URL)[0])).toEqual([21]);
  });

  test("without rights given the body is today's (no acceptTeamIds: the server reads it as the run's teams)", async () => {
    const { result } = await opened({});
    act(() => void result.current.accept());
    await waitFor(() => expect(bodies(ACCEPT_URL)).toHaveLength(1));
    expect(bodies(ACCEPT_URL)[0]).not.toHaveProperty("acceptTeamIds");
  });

  test("a stale scope re-proposes the run ONCE and keeps the ticks of the tickable moves that still exist", async () => {
    const { result } = await opened({ acceptable: new Set([1, 2]) });
    act(() => result.current.toggle(12));
    acceptAnswer = jsonResponse(409, STALE_SCOPE);
    act(() => void result.current.accept());
    await waitFor(() => expect(result.current.rescoped).toBe(true));
    expect(bodies(RUN_URL)).toHaveLength(2);
    expect([...result.current.selected].sort()).toEqual([11, 21]);
    expect(movesOf(result.current.proposal)).toHaveLength(3);
  });
});

describe("a kept selection and initialTicks", () => {
  test("after a stale scope the kept ticks win over initialTicks (only the first run starts from it)", async () => {
    const { result } = await opened({ acceptable: new Set([1, 2]), initialTicks: (m) => m.milestoneId === 12 });
    expect([...result.current.selected]).toEqual([12]);
    act(() => result.current.toggle(11));
    acceptAnswer = jsonResponse(409, STALE_SCOPE);
    act(() => void result.current.accept());
    await waitFor(() => expect(result.current.rescoped).toBe(true));
    expect([...result.current.selected].sort()).toEqual([11, 12]);
  });
});

describe("the ticked-subset check beside the hook", () => {
  const withCheck = (options: CrossTeamProposalOptions) =>
    renderHook(
      () => {
        const flow = useCrossTeamProposal(announce, options);
        const run = flow.proposal;
        const check = useScheduleCheck({
          teamIds: run?.teams.map((team) => team.teamId) ?? [],
          revision: run?.revision ?? 0,
          scopeHash: run?.scopeHash ?? "",
          moves: movesOf(run),
          selected: flow.selected,
          enabled: run !== null && flow.canAccept,
        });
        return { flow, check };
      },
      { wrapper },
    );

  test("a viewer who may accept nothing asks no check at all; the run itself is asked once, never in a loop", async () => {
    // the check's 300 ms debounce is the only thing that could still ask: run it out on a fake clock before asserting the absence
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const { result } = withCheck({ acceptable: new Set() });
    act(() => void result.current.flow.propose([1, 2]));
    await waitFor(() => expect(result.current.flow.proposal).not.toBeNull());
    await vi.advanceTimersByTimeAsync(500);
    await requestsAnswered(client);
    expect(bodies(CHECK_URL)).toEqual([]);
    expect(result.current.check.mode).toBe("all");
    expect(bodies(RUN_URL)).toHaveLength(1);
  });

  test("a manager of one team asks the check for exactly the ticked moves of the whole run's teams", async () => {
    const { result } = withCheck({ acceptable: new Set([2]) });
    act(() => void result.current.flow.propose([1, 2]));
    await waitFor(() => expect(bodies(CHECK_URL)).toHaveLength(1));
    expect(bodies(CHECK_URL)[0]).toEqual({ teamIds: [1, 2], items: [{ milestoneId: 21, startDate: "2042-01-12", endDate: "2042-01-14" }] });
    expect(bodies(RUN_URL)).toHaveLength(1);
  });
});
