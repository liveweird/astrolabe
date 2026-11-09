import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { useScheduleProposal } from "./useScheduleProposal";
import { teamViewKey, useTeamSchedule } from "./useTeamSchedule";
import type { ScheduleProposal, TeamView } from "../api/teams";
import { jsonResponse } from "../test/http";

const toast = vi.hoisted(() => vi.fn());
vi.mock("../utils/toast", () => ({ showSuccessToast: toast }));

const STALE_SCOPE = { type: "urn:astrolabe:problem:stale-scope", title: "Conflict", status: 409, detail: "scope" };
const STALE = { type: "urn:astrolabe:problem:stale-revision", title: "Conflict", status: 409, detail: "stale" };

const move = (milestoneId: number, start: string, end: string, over: Record<string, unknown> = {}) => ({
  milestoneId,
  name: `m${milestoneId}`,
  projectId: 7,
  projectName: "Invoices",
  estimateMd: 4,
  from: null,
  to: { start, end },
  workingDays: 3,
  shiftDays: null,
  ...over,
});

const PROPOSAL: ScheduleProposal = {
  revision: 12,
  scopeHash: "b".repeat(64),
  asOf: "2042-01-05",
  teamId: 1,
  moves: [move(1, "2042-01-07", "2042-01-09"), move(2, "2042-01-07", "2042-01-08"), move(3, "2042-01-13", "2042-01-15")],
  unchanged: [4],
  unplaced: [],
  pinned: [],
  weeks: [],
  weeksTruncated: false,
  dependencies: [],
};

const row = (id: number, startDate: string | null, endDate: string | null) => ({
  id,
  name: `m${id}`,
  projectId: 7,
  projectName: "Invoices",
  rankPosition: 1,
  startDate,
  endDate,
});

const VIEW = {
  revision: 12,
  team: { id: 1, can: { schedule: true, editCapacity: true, editOrder: true } },
  scheduled: [row(5, "2042-03-02", "2042-03-03")],
  unscheduled: [row(1, null, null), row(2, null, null), row(3, null, null)],
  order: { custom: false, revision: 1, milestoneIds: [] },
} as unknown as TeamView;

let client: QueryClient;
let mockFetch: ReturnType<typeof vi.fn>;
let proposalAnswer: Response | (() => Response);
let batchAnswer: Response | Promise<Response>;
const announce = vi.fn();

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={client}>
    <MemoryRouter>{children}</MemoryRouter>
  </QueryClientProvider>
);

const bodies = (matcher: RegExp) =>
  mockFetch.mock.calls.filter(([url]) => matcher.test(url as string)).map(([, init]) => JSON.parse((init as RequestInit).body as string));

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  proposalAnswer = jsonResponse(200, PROPOSAL);
  batchAnswer = jsonResponse(200, { revision: 13, accepted: [1, 2, 3], skipped: [] });
  mockFetch = vi.fn((url: string, init?: RequestInit) => {
    if (url === "/api/v1/teams/1/schedule-proposal") return Promise.resolve(typeof proposalAnswer === "function" ? proposalAnswer() : proposalAnswer.clone());
    if (url === "/api/v1/teams/1/milestone-schedules") return Promise.resolve(batchAnswer instanceof Response ? batchAnswer.clone() : batchAnswer);
    if (url === "/api/v1/views/team/1" && init?.method === undefined) return Promise.resolve(jsonResponse(200, VIEW));
    return Promise.resolve(jsonResponse(404, { title: "Not Found", status: 404 }));
  });
  vi.stubGlobal("fetch", mockFetch);
  localStorage.setItem("astrolabe.auth.token", "fake-token");
  announce.mockClear();
  toast.mockClear();
  client.setQueryData(teamViewKey(1, null), VIEW);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2042, 0, 5, 12, 0, 0));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

async function opened() {
  const rendered = renderHook(() => useScheduleProposal(1, announce, false, null), { wrapper });
  act(() => {
    expect(rendered.result.current.propose()).toBe(true);
  });
  await waitFor(() => expect(rendered.result.current.proposal).not.toBeNull());
  return rendered;
}

describe("propose", () => {
  test("POSTs the viewer's local day as asOf, opens the proposal with every move selected and says so", async () => {
    const { result } = await opened();
    expect(bodies(/schedule-proposal$/)).toEqual([{ asOf: "2042-01-05" }]);
    expect(result.current.proposal?.revision).toBe(12);
    expect([...result.current.selected]).toEqual([1, 2, 3]);
    expect(announce).toHaveBeenCalledWith("Proposed schedule ready: 3 moves");
    expect(result.current.note).toBeNull();
    expect(result.current.error).toBeNull();
  });

  test("while a proposal is open another propose is not sent", async () => {
    const { result } = await opened();
    act(() => {
      expect(result.current.propose()).toBe(false);
    });
    expect(bodies(/schedule-proposal$/)).toHaveLength(1);
  });

  test("a proposal with nothing to show opens nothing: the note and the live-region sentence", async () => {
    proposalAnswer = jsonResponse(200, { ...PROPOSAL, moves: [], unchanged: [4] });
    const { result } = renderHook(() => useScheduleProposal(1, announce, false, null), { wrapper });
    act(() => void result.current.propose());
    await waitFor(() => expect(result.current.note).toBe("nothing"));
    expect(result.current.proposal).toBeNull();
    expect(announce).toHaveBeenCalledWith("Nothing to propose: every milestone has started or stays where it is.");
  });

  test("nothing placed for lack of capacity: the no-capacity note counts from the day after asOf; dismiss clears it", async () => {
    proposalAnswer = jsonResponse(200, { ...PROPOSAL, moves: [], unchanged: [], unplaced: [{ milestoneId: 1, name: "m1", projectId: 7, projectName: "Invoices", reason: "NO_CAPACITY" }] });
    const { result } = renderHook(() => useScheduleProposal(1, announce, false, null), { wrapper });
    act(() => void result.current.propose());
    await waitFor(() => expect(result.current.note).toBe("noCapacity"));
    // the note names the request's own asOf, whatever weekday it is
    expect(result.current.noteDate).toBe("2042-01-05");
    expect(announce).toHaveBeenCalledWith("Nothing could be placed: the team has no capacity after 2042-01-05 — add a capacity period first.");
    act(() => result.current.dismiss());
    expect(result.current.note).toBeNull();
  });

  test("the server's refusals read in the page's words: 403 forbidden, 404 gone, anything else a generic failure", async () => {
    const { result } = renderHook(() => useScheduleProposal(1, announce, false, null), { wrapper });
    proposalAnswer = () => jsonResponse(403, { title: "Forbidden", status: 403 });
    act(() => void result.current.propose());
    await waitFor(() => expect(result.current.error).toBe("Only the team's manager or an administrator can propose a schedule"));
    proposalAnswer = () => jsonResponse(404, { title: "Not Found", status: 404 });
    act(() => void result.current.propose());
    await waitFor(() => expect(result.current.error).toBe("This team no longer exists — reload the page"));
    proposalAnswer = () => jsonResponse(500, { title: "Boom", status: 500 });
    act(() => void result.current.propose());
    await waitFor(() => expect(result.current.error).toBe("Action failed (500)"));
    expect(result.current.proposal).toBeNull();
  });
});

describe("the selection", () => {
  test("toggle, select none and select all; the last two are announced with the figures", async () => {
    const { result } = await opened();
    act(() => result.current.toggle(2));
    expect([...result.current.selected]).toEqual([1, 3]);
    act(() => result.current.toggle(2));
    expect([...result.current.selected].sort()).toEqual([1, 2, 3]);
    act(() => result.current.selectNone());
    expect([...result.current.selected]).toEqual([]);
    expect(announce).toHaveBeenLastCalledWith("0 of 3 selected");
    act(() => result.current.selectAll());
    expect([...result.current.selected]).toEqual([1, 2, 3]);
    expect(announce).toHaveBeenLastCalledWith("3 of 3 selected");
  });

  test("discard closes the preview and sends nothing", async () => {
    const { result } = await opened();
    act(() => {
      expect(result.current.discard()).toBe(true);
    });
    expect(result.current.proposal).toBeNull();
    expect([...result.current.selected]).toEqual([]);
    expect(bodies(/milestone-schedules$/)).toEqual([]);
  });
});

describe("accept", () => {
  test("sends the SELECTED moves with the proposal's revision as ONE batch; adopts the answered revision, closes and keeps the outcome", async () => {
    const { result } = await opened();
    act(() => result.current.toggle(2));
    act(() => {
      expect(result.current.accept()).toBe(true);
    });
    await waitFor(() => expect(result.current.outcome).not.toBeNull());
    expect(bodies(/milestone-schedules$/)).toEqual([
      {
        expectedRevision: 12,
        scopeHash: "b".repeat(64),
        items: [
          { milestoneId: 1, startDate: "2042-01-07", endDate: "2042-01-09" },
          { milestoneId: 3, startDate: "2042-01-13", endDate: "2042-01-15" },
        ],
      },
    ]);
    expect(client.getQueryData<TeamView>(teamViewKey(1, null))?.revision).toBe(13);
    expect(result.current.proposal).toBeNull();
    expect(result.current.outcome).toEqual({ accepted: 3, skipped: [] });
    // no success toast: the outcome note and the polite sentence say it
    expect(toast).not.toHaveBeenCalled();
    expect(announce).toHaveBeenLastCalledWith("3 scheduled");
  });

  test("the accepted milestones take their proposed dates in the cached view BEFORE the preview closes; a skipped one keeps its old dates", async () => {
    batchAnswer = jsonResponse(200, { revision: 13, accepted: [1, 3], skipped: [{ milestoneId: 2, reason: "STALE" }] });
    const { result } = await opened();
    act(() => void result.current.accept());
    await waitFor(() => expect(result.current.outcome).not.toBeNull());
    const view = client.getQueryData<TeamView>(teamViewKey(1, null));
    const scheduled = Object.fromEntries((view?.scheduled ?? []).map((m) => [m.id, [m.startDate, m.endDate]]));
    expect(scheduled).toEqual({ 1: ["2042-01-07", "2042-01-09"], 3: ["2042-01-13", "2042-01-15"], 5: ["2042-03-02", "2042-03-03"] });
    expect(view?.unscheduled.map((m) => [m.id, m.startDate])).toEqual([[2, null]]);
    expect(view?.revision).toBe(13);
  });

  test("it cancels the in-flight plan reads first, as every optimistic write does", async () => {
    const { result } = await opened();
    const cancel = vi.spyOn(client, "cancelQueries");
    act(() => void result.current.accept());
    expect(cancel).toHaveBeenCalledWith({ queryKey: ["plan"] });
    await waitFor(() => expect(result.current.outcome).not.toBeNull());
  });

  test("a milestone skipped by the server is reported with its reason; the rest counts as written", async () => {
    batchAnswer = jsonResponse(200, { revision: 13, accepted: [1, 3], skipped: [{ milestoneId: 2, reason: "STALE" }] });
    const { result } = await opened();
    act(() => void result.current.accept());
    await waitFor(() => expect(result.current.outcome).not.toBeNull());
    expect(result.current.outcome).toEqual({ accepted: 2, skipped: [{ milestoneId: 2, reason: "STALE" }] });
    expect(announce).toHaveBeenLastCalledWith("2 scheduled · 1 skipped: rescheduled in the meantime");
  });

  test("an all-skipped batch is reported with its reason and toasts nothing", async () => {
    batchAnswer = jsonResponse(200, { revision: 13, accepted: [], skipped: [{ milestoneId: 1, reason: "GONE" }] });
    const { result } = await opened();
    act(() => void result.current.accept());
    await waitFor(() => expect(result.current.outcome).not.toBeNull());
    expect(result.current.outcome).toEqual({ accepted: 0, skipped: [{ milestoneId: 1, reason: "GONE" }] });
    expect(toast).not.toHaveBeenCalled();
  });

  test("nothing selected: accept sends no request", async () => {
    const { result } = await opened();
    act(() => result.current.selectNone());
    act(() => {
      expect(result.current.accept()).toBe(false);
    });
    expect(bodies(/milestone-schedules$/)).toEqual([]);
  });

  test("a whole-batch stale 409 closes the preview, says so and reloads; the view is left to the refetch", async () => {
    batchAnswer = jsonResponse(409, STALE);
    const { result } = await opened();
    act(() => void result.current.accept());
    await waitFor(() => expect(result.current.stale).toBe(true));
    expect(result.current.proposal).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.outcome).toBeNull();
    expect(announce).toHaveBeenLastCalledWith(expect.stringContaining("The plan changed in the meantime"));
    expect(client.getQueryData<TeamView>(teamViewKey(1, null))?.revision).toBe(12);
  });

  test("a stale-scope refusal proposes again at once and keeps the ticks of the milestones that still move", async () => {
    batchAnswer = jsonResponse(409, STALE_SCOPE);
    const { result } = await opened();
    act(() => result.current.toggle(2));
    // The fresh proposal: 1 and 3 still move, 2 no longer does, 4 is new (it was not ticked before, so it stays unticked).
    const fresh: ScheduleProposal = {
      ...PROPOSAL,
      revision: 14,
      scopeHash: "c".repeat(64),
      moves: [move(1, "2042-01-08", "2042-01-10"), move(3, "2042-01-14", "2042-01-16"), move(4, "2042-01-14", "2042-01-15")],
    };
    proposalAnswer = jsonResponse(200, fresh);
    act(() => void result.current.accept());
    await waitFor(() => expect(result.current.rescoped).toBe(true));
    await waitFor(() => expect(result.current.proposal?.revision).toBe(14));
    expect([...result.current.selected]).toEqual([1, 3]);
    expect(result.current.stale).toBe(false);
    expect(result.current.error).toBeNull();
    expect(bodies(/schedule-proposal$/)).toEqual([{ asOf: "2042-01-05" }, { asOf: "2042-01-05" }]);
    expect(bodies(/milestone-schedules$/)).toHaveLength(1);
    expect(announce).toHaveBeenCalledWith("The team's plan changed since the proposal: here is a fresh one. Your selection was kept for the milestones that still move.");
    // The next accept carries the FRESH hash and revision.
    batchAnswer = jsonResponse(200, { revision: 15, accepted: [1, 3], skipped: [] });
    act(() => void result.current.accept());
    await waitFor(() => expect(result.current.outcome).not.toBeNull());
    expect(bodies(/milestone-schedules$/)[1]).toMatchObject({ expectedRevision: 14, scopeHash: "c".repeat(64) });
    expect(result.current.rescoped).toBe(false);
  });

  test("a stale-scope refusal whose fresh proposal has nothing to show opens nothing and leaves the usual note", async () => {
    batchAnswer = jsonResponse(409, STALE_SCOPE);
    const { result } = await opened();
    proposalAnswer = jsonResponse(200, { ...PROPOSAL, revision: 14, moves: [], unchanged: [1, 2, 3] });
    act(() => void result.current.accept());
    await waitFor(() => expect(result.current.note).toBe("nothing"));
    expect(result.current.proposal).toBeNull();
    expect(result.current.rescoped).toBe(false);
    expect(result.current.error).toBeNull();
  });

  test("a fresh proposal that FAILS after a stale-scope refusal shows its error and does not leak the old ticks into the next proposal", async () => {
    batchAnswer = jsonResponse(409, STALE_SCOPE);
    const { result } = await opened();
    act(() => result.current.toggle(2));
    proposalAnswer = jsonResponse(500, { title: "Server Error", status: 500 });
    act(() => void result.current.accept());
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.proposal).toBeNull();
    expect(result.current.rescoped).toBe(false);
    expect(result.current.stale).toBe(false);
    // A later, ordinary proposal selects every move: the voided ticks were cleared.
    proposalAnswer = jsonResponse(200, PROPOSAL);
    act(() => {
      expect(result.current.propose()).toBe(true);
    });
    await waitFor(() => expect(result.current.proposal).not.toBeNull());
    expect([...result.current.selected]).toEqual([1, 2, 3]);
    expect(result.current.rescoped).toBe(false);
  });

  test("any other failure stays inline with the preview open: 403 and 400 in words", async () => {
    batchAnswer = jsonResponse(403, { title: "Forbidden", status: 403 });
    const { result } = await opened();
    act(() => void result.current.accept());
    await waitFor(() => expect(result.current.error).toBe("Only the team's manager or an administrator can propose a schedule"));
    expect(result.current.proposal).not.toBeNull();
    expect(result.current.stale).toBe(false);
    batchAnswer = jsonResponse(400, { title: "Bad", status: 400 });
    act(() => void result.current.accept());
    await waitFor(() => expect(result.current.error).toBe("The proposal could not be applied — propose again"));
  });

  test("it is a write on the page's team key: while it runs, a schedule change is refused out loud, accept and discard hold", async () => {
    let release!: (response: Response) => void;
    batchAnswer = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const { result } = renderHook(() => ({ proposal: useScheduleProposal(1, announce, false, null), schedule: useTeamSchedule(1, null) }), { wrapper });
    await waitFor(() => expect(result.current.schedule.view).toBeDefined());
    act(() => void result.current.proposal.propose());
    await waitFor(() => expect(result.current.proposal.proposal).not.toBeNull());
    act(() => void result.current.proposal.accept());
    await waitFor(() => expect(result.current.proposal.applying).toBe(true));
    expect(result.current.schedule.pending).toBe(true);
    act(() => {
      expect(result.current.schedule.commit(5, "2042-03-09", "2042-03-10")).toBe(false);
      expect(result.current.proposal.accept()).toBe(false);
      expect(result.current.proposal.discard()).toBe(false);
    });
    expect(result.current.schedule.refused).toBe(true);
    // the accept was refused out loud too: the flag, the sentence, and no second batch
    expect(result.current.proposal.refused).toBe(true);
    expect(announce).toHaveBeenCalledWith("A save is still running — try your change again in a moment.");
    expect(bodies(/milestone-schedules$/)).toHaveLength(1);
    expect(mockFetch.mock.calls.filter(([url]) => /\/schedule$/.test(url as string))).toEqual([]);
    await act(async () => {
      release(jsonResponse(200, { revision: 13, accepted: [1, 2, 3], skipped: [] }));
    });
    await waitFor(() => expect(result.current.schedule.pending).toBe(false));
    expect(result.current.schedule.refused).toBe(false);
    expect(result.current.proposal.refused).toBe(false);
  });
});
