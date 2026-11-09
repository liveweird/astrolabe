import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useCrossTeamProposal } from "./useCrossTeamProposal";
import type { CrossTeamProposal } from "../api/scheduleProposals";
import { ACCEPT_URL, block, move, RUN, RUN_URL, STALE_REVISION, STALE_SCOPE } from "../test/crossTeamRun";
import { jsonResponse } from "../test/http";

let client: QueryClient;
let mockFetch: ReturnType<typeof vi.fn>;
let runAnswer: Response | (() => Response);
let acceptAnswer: Response | Promise<Response>;
const announce = vi.fn();

const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;

const bodies = (url: string) => mockFetch.mock.calls.filter(([u]) => u === url).map(([, init]) => JSON.parse((init as RequestInit).body as string));

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  runAnswer = jsonResponse(200, RUN);
  acceptAnswer = jsonResponse(200, { revision: 13, accepted: [11, 12, 21], skipped: [] });
  mockFetch = vi.fn((url: string) => {
    if (url === RUN_URL) return Promise.resolve(typeof runAnswer === "function" ? runAnswer() : runAnswer.clone());
    if (url === ACCEPT_URL) return Promise.resolve(acceptAnswer instanceof Response ? acceptAnswer.clone() : acceptAnswer);
    return Promise.resolve(jsonResponse(404, { title: "Not Found", status: 404 }));
  });
  vi.stubGlobal("fetch", mockFetch);
  localStorage.setItem("astrolabe.auth.token", "fake-token");
  announce.mockClear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2042, 0, 5, 12, 0, 0));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

async function opened() {
  const rendered = renderHook(() => useCrossTeamProposal(announce), { wrapper });
  act(() => {
    expect(rendered.result.current.propose([1, 2])).toBe(true);
  });
  await waitFor(() => expect(rendered.result.current.proposal).not.toBeNull());
  return rendered;
}

describe("propose", () => {
  test("POSTs the team set with the viewer's local day, opens the run with every move of every team ticked and says so", async () => {
    const { result } = await opened();
    expect(bodies(RUN_URL)).toEqual([{ asOf: "2042-01-05", teamIds: [1, 2] }]);
    expect(result.current.proposal?.revision).toBe(12);
    expect([...result.current.selected]).toEqual([11, 12, 21]);
    expect(announce).toHaveBeenCalledWith("Proposed schedule ready: 3 moves");
    expect(result.current.error).toBeNull();
  });

  test("no team, or a run already open, sends nothing", async () => {
    const { result } = await opened();
    act(() => {
      expect(result.current.propose([1])).toBe(false);
    });
    expect(bodies(RUN_URL)).toHaveLength(1);
    const fresh = renderHook(() => useCrossTeamProposal(announce), { wrapper });
    act(() => {
      expect(fresh.result.current.propose([])).toBe(false);
    });
    expect(bodies(RUN_URL)).toHaveLength(1);
  });

  test("a run with no move in any team opens nothing and leaves the note", async () => {
    runAnswer = jsonResponse(200, { ...RUN, teams: [block(1, "Platform", [], { unchanged: [11] }), block(2, "Payments", [], { unchanged: [21] })] });
    const { result } = renderHook(() => useCrossTeamProposal(announce), { wrapper });
    act(() => void result.current.propose([1, 2]));
    await waitFor(() => expect(result.current.note).toBe("nothing"));
    expect(result.current.proposal).toBeNull();
    expect(announce).toHaveBeenCalledWith("Nothing to propose: every milestone has started or stays where it is.");
    act(() => result.current.dismiss());
    expect(result.current.note).toBeNull();
  });

  test("the server's refusals read in the page's words: 403, 404 and 400", async () => {
    const { result } = renderHook(() => useCrossTeamProposal(announce), { wrapper });
    for (const [status, words] of [
      [403, "Only a manager of every listed team or an administrator can propose or accept a schedule across teams"],
      [404, "A team of the proposal no longer exists — reload the page"],
      [400, "The proposal could not be applied — propose again"],
    ] as const) {
      runAnswer = () => jsonResponse(status, { title: "x", status });
      act(() => void result.current.propose([1, 2]));
      await waitFor(() => expect(result.current.error).toBe(words));
      expect(result.current.proposal).toBeNull();
    }
  });
});

describe("the selection", () => {
  test("select none / all act on ONE team's moves and are announced with the run-wide figures", async () => {
    const { result } = await opened();
    act(() => result.current.selectNone(1));
    expect([...result.current.selected]).toEqual([21]);
    expect(announce).toHaveBeenLastCalledWith("1 of 3 selected");
    act(() => result.current.selectAll(1));
    expect([...result.current.selected].sort()).toEqual([11, 12, 21]);
    expect(announce).toHaveBeenLastCalledWith("3 of 3 selected");
    act(() => result.current.toggle(12));
    expect([...result.current.selected].sort()).toEqual([11, 21]);
  });

  test("discard closes the preview and sends nothing", async () => {
    const { result } = await opened();
    act(() => {
      expect(result.current.discard()).toBe(true);
    });
    expect(result.current.proposal).toBeNull();
    expect(bodies(ACCEPT_URL)).toEqual([]);
  });
});

describe("accept", () => {
  test("sends the ticked moves of ALL teams with the run's revision, hash and team set as ONE request; closes and keeps the outcome", async () => {
    const { result } = await opened();
    act(() => result.current.toggle(12));
    act(() => {
      expect(result.current.accept()).toBe(true);
    });
    await waitFor(() => expect(result.current.outcome).not.toBeNull());
    expect(bodies(ACCEPT_URL)).toEqual([
      {
        expectedRevision: 12,
        scopeHash: "b".repeat(64),
        teamIds: [1, 2],
        items: [
          { milestoneId: 11, startDate: "2042-01-06", endDate: "2042-01-08" },
          { milestoneId: 21, startDate: "2042-01-12", endDate: "2042-01-14" },
        ],
      },
    ]);
    expect(result.current.proposal).toBeNull();
    expect(result.current.outcome).toEqual({ accepted: 3, skipped: [] });
    expect(announce).toHaveBeenLastCalledWith("3 scheduled");
  });

  test("a skipped milestone is reported with the server's reason", async () => {
    acceptAnswer = jsonResponse(200, { revision: 13, accepted: [11, 12], skipped: [{ milestoneId: 21, reason: "STALE" }] });
    const { result } = await opened();
    act(() => void result.current.accept());
    await waitFor(() => expect(result.current.outcome).not.toBeNull());
    expect(result.current.outcome).toEqual({ accepted: 2, skipped: [{ milestoneId: 21, reason: "STALE" }] });
    expect(announce).toHaveBeenLastCalledWith("2 scheduled · 1 skipped: rescheduled in the meantime");
  });

  test("it refreshes the plan's and the roadmap's cached views after a success", async () => {
    const { result } = await opened();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    act(() => void result.current.accept());
    await waitFor(() => expect(result.current.outcome).not.toBeNull());
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ["plan"] }));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["roadmap"] });
  });

  test("two accepts in the same tick (a double click) send ONE request; the second is refused out loud", async () => {
    let release!: (response: Response) => void;
    acceptAnswer = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const { result } = await opened();
    const sent: boolean[] = [];
    act(() => {
      sent.push(result.current.accept(), result.current.accept());
    });
    expect(sent).toEqual([true, false]);
    await waitFor(() => expect(bodies(ACCEPT_URL)).toHaveLength(1));
    expect(result.current.refused).toBe(true);
    expect(announce).toHaveBeenCalledWith("A save is still running — try your change again in a moment.");
    await act(async () => {
      release(jsonResponse(200, { revision: 13, accepted: [11, 12, 21], skipped: [] }));
    });
    await waitFor(() => expect(result.current.applying).toBe(false));
    // settled: the next run may be accepted again
    act(() => void result.current.propose([1, 2]));
    await waitFor(() => expect(result.current.proposal).not.toBeNull());
    acceptAnswer = jsonResponse(200, { revision: 14, accepted: [11], skipped: [] });
    act(() => {
      expect(result.current.accept()).toBe(true);
    });
  });

  test("a run that did not settle says so in the SAME announcement as the ready sentence", async () => {
    runAnswer = jsonResponse(200, { ...RUN, passes: 5, settled: false });
    await opened();
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce.mock.calls[0][0]).toMatch(/^Proposed schedule ready: 3 moves\. Not settled after 5 passes: the teams depend on each other in a loop/);
  });

  test("no capacity is worded for the chosen teams", async () => {
    runAnswer = jsonResponse(200, { ...RUN, teams: [block(1, "Platform", [], { unplaced: [{ milestoneId: 11, name: "x1", projectId: 7, projectName: "Invoices", reason: "NO_CAPACITY" }] })] });
    const { result } = renderHook(() => useCrossTeamProposal(announce), { wrapper });
    act(() => void result.current.propose([1]));
    await waitFor(() => expect(result.current.note).toBe("noCapacity"));
    expect(announce).toHaveBeenCalledWith("Nothing could be placed: the chosen teams have no capacity after 2042-01-05 for the milestones to place — add a capacity period first.");
  });

  test("nothing ticked: accept sends no request", async () => {
    const { result } = await opened();
    act(() => result.current.selectNone(1));
    act(() => result.current.selectNone(2));
    act(() => {
      expect(result.current.accept()).toBe(false);
    });
    expect(bodies(ACCEPT_URL)).toEqual([]);
  });

  test("a whole-request stale-revision 409 closes the preview and says so", async () => {
    acceptAnswer = jsonResponse(409, STALE_REVISION);
    const { result } = await opened();
    act(() => void result.current.accept());
    await waitFor(() => expect(result.current.stale).toBe(true));
    expect(result.current.proposal).toBeNull();
    expect(result.current.error).toBeNull();
    expect(announce).toHaveBeenLastCalledWith("The plan changed in the meantime — nothing was saved. Propose again.");
  });

  test("a stale-scope refusal proposes again at once for the SAME teams and keeps the ticks of the moves that still exist", async () => {
    acceptAnswer = jsonResponse(409, STALE_SCOPE);
    const { result } = await opened();
    act(() => result.current.toggle(12));
    // The fresh run: 11 and 21 still move, 12 no longer does, 13 is new (it was not ticked before, so it stays unticked).
    const fresh: CrossTeamProposal = {
      ...RUN,
      revision: 14,
      scopeHash: "c".repeat(64),
      teams: [block(1, "Platform", [move(11, "x1", "2042-01-07", "2042-01-09"), move(13, "x3", "2042-01-12", "2042-01-12")]), block(2, "Payments", [move(21, "y1", "2042-01-13", "2042-01-15")])],
    };
    runAnswer = jsonResponse(200, fresh);
    act(() => void result.current.accept());
    await waitFor(() => expect(result.current.rescoped).toBe(true));
    await waitFor(() => expect(result.current.proposal?.revision).toBe(14));
    expect([...result.current.selected].sort()).toEqual([11, 21]);
    expect(result.current.stale).toBe(false);
    expect(result.current.error).toBeNull();
    expect(bodies(RUN_URL)).toEqual([
      { asOf: "2042-01-05", teamIds: [1, 2] },
      { asOf: "2042-01-05", teamIds: [1, 2] },
    ]);
    expect(announce).toHaveBeenCalledWith("The plan of the chosen teams changed since the proposal: here is a fresh one. Your selection was kept for the milestones that still move.");
    // The next accept carries the FRESH hash and revision.
    acceptAnswer = jsonResponse(200, { revision: 15, accepted: [11, 21], skipped: [] });
    act(() => void result.current.accept());
    await waitFor(() => expect(result.current.outcome).not.toBeNull());
    expect(bodies(ACCEPT_URL)[1]).toMatchObject({ expectedRevision: 14, scopeHash: "c".repeat(64) });
    expect(result.current.rescoped).toBe(false);
  });

  test("a fresh run that FAILS after a stale-scope refusal shows its error and does not leak the old ticks into the next run", async () => {
    acceptAnswer = jsonResponse(409, STALE_SCOPE);
    const { result } = await opened();
    act(() => result.current.toggle(12));
    runAnswer = jsonResponse(500, { title: "Server Error", status: 500 });
    act(() => void result.current.accept());
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.proposal).toBeNull();
    expect(result.current.rescoped).toBe(false);
    runAnswer = jsonResponse(200, RUN);
    act(() => {
      expect(result.current.propose([1, 2])).toBe(true);
    });
    await waitFor(() => expect(result.current.proposal).not.toBeNull());
    expect([...result.current.selected].sort()).toEqual([11, 12, 21]);
  });

  test("any other failure stays inline with the preview open: 403 and 400 in words", async () => {
    acceptAnswer = jsonResponse(403, { title: "Forbidden", status: 403 });
    const { result } = await opened();
    act(() => void result.current.accept());
    await waitFor(() => expect(result.current.error).toBe("Only a manager of every listed team or an administrator can propose or accept a schedule across teams"));
    expect(result.current.proposal).not.toBeNull();
    expect(result.current.stale).toBe(false);
    acceptAnswer = jsonResponse(400, { title: "Bad", status: 400 });
    act(() => void result.current.accept());
    await waitFor(() => expect(result.current.error).toBe("The proposal could not be applied — propose again"));
  });

  test("an accept while one runs is refused out loud, and discard holds; both clear when the write is over", async () => {
    let release!: (response: Response) => void;
    acceptAnswer = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const { result } = await opened();
    act(() => void result.current.accept());
    await waitFor(() => expect(result.current.applying).toBe(true));
    act(() => {
      expect(result.current.accept()).toBe(false);
      expect(result.current.discard()).toBe(false);
    });
    expect(result.current.refused).toBe(true);
    expect(announce).toHaveBeenCalledWith("A save is still running — try your change again in a moment.");
    expect(bodies(ACCEPT_URL)).toHaveLength(1);
    await act(async () => {
      release(jsonResponse(200, { revision: 13, accepted: [11, 12, 21], skipped: [] }));
    });
    await waitFor(() => expect(result.current.applying).toBe(false));
    expect(result.current.refused).toBe(false);
  });
});
