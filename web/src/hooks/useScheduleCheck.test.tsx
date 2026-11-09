import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useScheduleCheck } from "./useScheduleCheck";
import type { ScheduleProposalMove } from "../api/teams";
import { jsonResponse } from "../test/http";

const CHECK_URL = "/api/v1/schedule-proposals/check";

const move = (milestoneId: number, start: string, end: string): ScheduleProposalMove => ({
  milestoneId,
  name: `m${milestoneId}`,
  projectId: 7,
  projectName: "Invoices",
  estimateMd: 4,
  from: null,
  to: { start, end },
  workingDays: 3,
  shiftDays: null,
});

const MOVES = [move(1, "2042-01-07", "2042-01-09"), move(2, "2042-01-07", "2042-01-08"), move(3, "2042-01-13", "2042-01-15")];
const ANSWER = { teams: [{ teamId: 1, weeks: [], weeksTruncated: false, dependencies: [] }] };

type Props = { selected: number[]; enabled?: boolean; revision?: number; scopeHash?: string; teamIds?: number[] };

let client: QueryClient;
let mockFetch: ReturnType<typeof vi.fn>;
let answer: () => Response | Promise<Response>;

const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;

const mount = (initial: Props) =>
  renderHook(
    ({ selected, enabled = true, revision = 10, scopeHash = "a".repeat(64), teamIds = [1] }: Props) =>
      useScheduleCheck({ teamIds, revision, scopeHash, moves: MOVES, selected: new Set(selected), enabled }),
    { wrapper, initialProps: initial },
  );

const checkCalls = () => mockFetch.mock.calls.filter(([url]) => url === CHECK_URL);
const sentItems = () => checkCalls().map(([, init]) => (JSON.parse((init as RequestInit).body as string) as { teamIds: number[]; items: { milestoneId: number }[] }).items.map((i) => i.milestoneId));
// Fake clock (real time still flows for waitFor): the debounce window is advanced by hand, so the "not yet" assertions never depend on load.
const wait = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  answer = () => jsonResponse(200, ANSWER);
  mockFetch = vi.fn((url: string) => Promise.resolve(url === CHECK_URL ? answer() : jsonResponse(404, { title: "Not Found", status: 404 })));
  vi.stubGlobal("fetch", mockFetch);
  localStorage.setItem("astrolabe.auth.token", "fake-token");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("useScheduleCheck", () => {
  test("every move ticked is the proposal's own answer: mode all, no request, nothing pending", async () => {
    const { result } = mount({ selected: [1, 2, 3] });
    await wait(400);
    expect(result.current).toEqual({ mode: "all", byTeam: null, pending: false, failed: false });
    expect(checkCalls()).toEqual([]);
  });

  test("no move ticked changes nothing: mode none, no request", async () => {
    const { result } = mount({ selected: [] });
    await wait(400);
    expect(result.current).toEqual({ mode: "none", byTeam: null, pending: false, failed: false });
    expect(checkCalls()).toEqual([]);
  });

  test("without an open proposal there is no check, whatever the ticks", async () => {
    const { result } = mount({ selected: [1], enabled: false });
    await wait(400);
    expect(result.current.mode).toBe("all");
    expect(checkCalls()).toEqual([]);
  });

  test("some ticked: pending from the first change, one request after the 300 ms debounce with exactly the ticked items, then the answer by team", async () => {
    const { result, rerender } = mount({ selected: [1, 2, 3] });
    rerender({ selected: [1, 3] });
    expect(result.current).toMatchObject({ mode: "some", byTeam: null, pending: true, failed: false });
    await wait(299);
    expect(checkCalls()).toEqual([]);
    expect(result.current.pending).toBe(true);
    await wait(1);
    await waitFor(() => expect(result.current.byTeam).not.toBeNull());
    expect(checkCalls()).toHaveLength(1);
    expect(JSON.parse((checkCalls()[0][1] as RequestInit).body as string)).toEqual({
      teamIds: [1],
      items: [
        { milestoneId: 1, startDate: "2042-01-07", endDate: "2042-01-09" },
        { milestoneId: 3, startDate: "2042-01-13", endDate: "2042-01-15" },
      ],
    });
    expect(result.current.pending).toBe(false);
    expect(result.current.byTeam?.get(1)).toEqual(ANSWER.teams[0]);
  });

  test("a run of clicks inside the window is one question about the final ticks", async () => {
    const { result, rerender } = mount({ selected: [1, 2, 3] });
    rerender({ selected: [1, 2] });
    await wait(100);
    rerender({ selected: [1] });
    await wait(100);
    rerender({ selected: [2] });
    await wait(299);
    expect(checkCalls()).toEqual([]);
    await wait(1);
    await waitFor(() => expect(result.current.byTeam).not.toBeNull());
    expect(sentItems()).toEqual([[2]]);
  });

  test("ticking everything again before the window ends sends nothing", async () => {
    const { result, rerender } = mount({ selected: [1, 2, 3] });
    rerender({ selected: [1] });
    await wait(299);
    rerender({ selected: [1, 2, 3] });
    await wait(450);
    expect(result.current).toEqual({ mode: "all", byTeam: null, pending: false, failed: false });
    expect(checkCalls()).toEqual([]);
  });

  test("an answer for an older selection is never shown for the current one", async () => {
    let release: ((response: Response) => void) | null = null;
    answer = () =>
      new Promise<Response>((resolve) => {
        release = resolve;
      });
    const { result, rerender } = mount({ selected: [1, 2, 3] });
    rerender({ selected: [1] });
    await wait(300);
    await waitFor(() => expect(checkCalls()).toHaveLength(1));
    // the first request is still in flight when the ticks move on
    rerender({ selected: [2] });
    await wait(300);
    expect(result.current).toMatchObject({ byTeam: null, pending: true });
    await act(async () => release?.(jsonResponse(200, { teams: [{ teamId: 1, weeks: [], weeksTruncated: false, dependencies: [] }] })));
    expect(result.current.byTeam).toBeNull();
    expect(result.current.pending).toBe(true);
    await wait(300);
    await waitFor(() => expect(checkCalls()).toHaveLength(2));
    expect(sentItems()).toEqual([[1], [2]]);
  });

  test("a failed check is reported as failed, with no answer to show", async () => {
    answer = () => jsonResponse(403, { title: "Forbidden", status: 403 });
    const { result, rerender } = mount({ selected: [1, 2, 3] });
    rerender({ selected: [1] });
    await wait(300);
    await waitFor(() => expect(result.current.failed).toBe(true));
    expect(result.current).toMatchObject({ mode: "some", byTeam: null, pending: false });
  });

  test("a new revision or a new scope hash (a fresh proposal) asks again for the same ticks; the team order does not matter", async () => {
    const { result, rerender } = mount({ selected: [1, 2, 3], teamIds: [2, 1] });
    rerender({ selected: [1], teamIds: [2, 1] });
    await wait(300);
    await waitFor(() => expect(result.current.byTeam).not.toBeNull());
    expect(JSON.parse((checkCalls()[0][1] as RequestInit).body as string).teamIds).toEqual([1, 2]);
    rerender({ selected: [1], teamIds: [1, 2] });
    await wait(10);
    expect(checkCalls()).toHaveLength(1);
    rerender({ selected: [1], teamIds: [1, 2], revision: 11 });
    await waitFor(() => expect(checkCalls()).toHaveLength(2));
    rerender({ selected: [1], teamIds: [1, 2], revision: 11, scopeHash: "b".repeat(64) });
    await waitFor(() => expect(checkCalls()).toHaveLength(3));
  });

  test("a check cancelled in flight (a write cancels the plan queries) is asked again instead of staying pending forever", async () => {
    let calls = 0;
    answer = () => {
      calls += 1;
      return calls === 1 ? new Promise<Response>(() => {}) : jsonResponse(200, ANSWER);
    };
    const { result, rerender } = mount({ selected: [1, 2, 3] });
    rerender({ selected: [1] });
    await wait(300);
    await waitFor(() => expect(checkCalls()).toHaveLength(1));
    await act(async () => {
      await client.cancelQueries({ queryKey: ["plan"] });
    });
    await waitFor(() => expect(checkCalls()).toHaveLength(2));
    await waitFor(() => expect(result.current.byTeam).not.toBeNull());
    expect(result.current.pending).toBe(false);
  });
});
