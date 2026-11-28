import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type { DependencyEndpoint } from "../api/dependencies";
import type { CrossTeamProposal } from "../api/scheduleProposals";
import type { ScheduleProposal, TeamView } from "../api/teams";
import { ACCEPT_URL, block, CHECK_URL, move, RUN_URL, TEAMS_URL } from "../test/crossTeamRun";
import { jsonResponse } from "../test/http";
import { useTeamOrder } from "./useTeamOrder";
import { useTeamProposals } from "./useTeamProposals";
import { useTeamSchedule } from "./useTeamSchedule";

// The team page's proposals in both forms (1.38): alone (the per-team route, today's behaviour) and together (one cross-team run over this team and the chosen ones).
// Team 1 is the page's: milestones 5 and 7 scheduled, 6 in the tray; team 2's milestone 21 is linked to 5, team 3's 31 to nothing.

const PER_TEAM_URL = "/api/v1/teams/1/schedule-proposal";
const SCHEDULES_URL = "/api/v1/teams/1/milestone-schedules";
const ORDER_URL = "/api/v1/teams/1/milestone-order";

const row = (id: number, startDate: string | null, endDate: string | null) => ({ id, name: `m${id}`, projectId: 7, projectName: "Invoices", rankPosition: 1, flags: [], startDate, endDate });
const end = (kind: "MILESTONE", id: number, teamId: number): DependencyEndpoint => ({ kind, id, name: `m${id}`, projectId: 7, projectName: "Invoices", teamId, teamName: `Team ${teamId}`, startDate: null, endDate: null });

let VIEW: TeamView;

const SOLO: ScheduleProposal = {
  revision: 12,
  scopeHash: "a".repeat(64),
  asOf: "2042-01-05",
  teamId: 1,
  moves: [move(6, "m6", "2042-04-06", "2042-04-07")],
  unchanged: [],
  unplaced: [],
  pinned: [],
  weeks: [],
  weeksTruncated: false,
  dependencies: [],
};

const RUN: CrossTeamProposal = {
  revision: 12,
  asOf: "2042-01-05",
  passes: 1,
  settled: true,
  scopeHash: "b".repeat(64),
  projects: [],
  teams: [
    block(1, "Alpha", [move(6, "m6", "2042-04-06", "2042-04-07")]),
    block(2, "Beta", [move(21, "b1", "2042-04-13", "2042-04-14", { from: { start: "2042-03-02", end: "2042-03-03" } })]),
    block(3, "Gamma", [move(31, "g1", "2042-04-20", "2042-04-21", { from: { start: "2042-03-09", end: "2042-03-10" } })]),
  ],
};

let client: QueryClient;
let mockFetch: ReturnType<typeof vi.fn>;
/** While set, a GET of the team view is only answered once it resolves: the refetch an accept starts, still on its way. */
let holdView: Promise<void> | null;
let manages: number[];
const announce = vi.fn();

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={client}>
    <MemoryRouter>{children}</MemoryRouter>
  </QueryClientProvider>
);

const bodies = (url: string) => mockFetch.mock.calls.filter(([u, init]) => u === url && typeof (init as RequestInit | undefined)?.body === "string").map(([, init]) => JSON.parse((init as RequestInit).body as string));
const calls = (url: string) => mockFetch.mock.calls.filter(([u]) => u === url);

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  holdView = null;
  manages = [1, 2];
  VIEW = {
    revision: 12,
    team: { id: 1, can: { schedule: true, editCapacity: true, editOrder: true } },
    scheduled: [row(5, "2042-03-02", "2042-03-03"), row(7, "2042-03-09", "2042-03-10")],
    unscheduled: [row(6, null, null)],
    order: { custom: true, revision: 1, milestoneIds: [5, 7] },
    dependencies: [
      { id: 1, predecessor: end("MILESTONE", 21, 2), successor: end("MILESTONE", 5, 1), type: "FS", lagDays: 0, check: { status: "OK" }, critical: false, can: { edit: false, delete: false } },
    ],
  } as unknown as TeamView;
  mockFetch = vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url === "/api/v1/views/team/1") return holdView ? holdView.then(() => jsonResponse(200, VIEW)) : Promise.resolve(jsonResponse(200, VIEW));
    if (url === PER_TEAM_URL) return Promise.resolve(jsonResponse(200, SOLO));
    if (url === RUN_URL) return Promise.resolve(jsonResponse(200, RUN));
    if (url === TEAMS_URL) return Promise.resolve(jsonResponse(200, { items: manages.map((id) => ({ id, name: `Team ${id}` })), truncated: false }));
    if (url === CHECK_URL) return Promise.resolve(jsonResponse(200, { teams: [], projects: [] }));
    if (url === ACCEPT_URL || url === SCHEDULES_URL) return Promise.resolve(jsonResponse(200, { revision: 13, accepted: [6, 21], skipped: [] }));
    if (url === ORDER_URL && method === "PUT") return Promise.resolve(jsonResponse(200, { revision: 14 }));
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

/** The page's own paths over one team, as it composes them: the view, the order, the proposals. */
function useTeamPage() {
  const schedule = useTeamSchedule(1, null, false);
  const order = useTeamOrder(1, schedule.view, announce, null, schedule.placeholder, false);
  const proposals = useTeamProposals(1, announce, schedule.placeholder, null, false, schedule.view);
  return { schedule, order, proposals };
}

async function page() {
  const rendered = renderHook(useTeamPage, { wrapper });
  await waitFor(() => expect(rendered.result.current.schedule.view).toBeDefined());
  return rendered;
}

describe("alone (nothing chosen)", () => {
  test("Propose is the per-team route, today's proposal: no run, no rights read, the proposal is the team's own", async () => {
    const { result } = await page();
    expect(result.current.proposals.proposable).toBe(true);
    act(() => {
      expect(result.current.proposals.propose()).toBe(true);
    });
    await waitFor(() => expect(result.current.proposals.proposal).not.toBeNull());
    expect(bodies(PER_TEAM_URL)).toEqual([{ asOf: "2042-01-05" }]);
    expect(calls(RUN_URL)).toHaveLength(0);
    expect(calls(TEAMS_URL)).toHaveLength(0);
    expect(result.current.proposals.run).toBeNull();
    expect(result.current.proposals.proposal).toMatchObject({ revision: 12, scopeHash: "a".repeat(64) });
    expect(result.current.proposals.preview).toBeNull();
    expect([...result.current.proposals.selected]).toEqual([6]);
    act(() => {
      expect(result.current.proposals.accept()).toBe(true);
    });
    await waitFor(() => expect(result.current.proposals.proposal).toBeNull());
    expect(bodies(SCHEDULES_URL)).toEqual([{ expectedRevision: 12, scopeHash: "a".repeat(64), items: [{ milestoneId: 6, startDate: "2042-04-06", endDate: "2042-04-07" }] }]);
    expect(calls(ACCEPT_URL)).toHaveLength(0);
  });
});

describe("together (teams chosen)", () => {
  async function together(chosen: number[]) {
    const rendered = await page();
    act(() => rendered.result.current.proposals.picker.onChange(chosen));
    await waitFor(() => expect(rendered.result.current.proposals.rights.ready).toBe(true));
    return rendered;
  }

  test("Propose asks one run over [this team, ...chosen] (teamIds) and the proposal is this team's block; the per-team route stays unasked", async () => {
    const { result } = await together([3, 2]);
    act(() => {
      expect(result.current.proposals.propose()).toBe(true);
    });
    await waitFor(() => expect(result.current.proposals.proposal).not.toBeNull());
    expect(bodies(RUN_URL)).toEqual([{ asOf: "2042-01-05", teamIds: [1, 2, 3] }]);
    expect(calls(PER_TEAM_URL)).toHaveLength(0);
    expect(result.current.proposals.run).not.toBeNull();
    expect(result.current.proposals.proposal).toMatchObject({ teamId: 1, revision: 12, scopeHash: "b".repeat(64), asOf: "2042-01-05" });
    expect(result.current.proposals.proposal?.moves.map((m) => m.milestoneId)).toEqual([6]);
  });

  test("another team's moves the viewer manages are ticked and tickable, the others (Gamma) are a preview and keep their dash; the linked ones are rows", async () => {
    const { result } = await together([2, 3]);
    await waitFor(() => expect(result.current.proposals.waitingFor).toBeNull());
    act(() => void result.current.proposals.propose());
    await waitFor(() => expect(result.current.proposals.proposal).not.toBeNull());
    expect([...result.current.proposals.selected].sort((a, b) => a - b)).toEqual([6, 21]);
    expect([...(result.current.proposals.tickable ?? [])].sort((a, b) => a - b)).toEqual([6, 21]);
    // Beta's linked milestone is a row (ticked, so drawn), Gamma's is not linked (no row)
    expect(result.current.proposals.preview?.rows.map((entry) => [entry.id, entry.drawn])).toEqual([[21, true]]);
    expect(result.current.proposals.preview?.byRow.get("ghost:m:31")?.drawn).toBe(true);
    act(() => result.current.proposals.toggle(21));
    expect(result.current.proposals.preview?.rows.map((entry) => [entry.id, entry.drawn])).toEqual([[21, false]]);
  });

  test("accept sends the run's one accept with acceptTeamIds = the teams of the ticked moves (an unticked team drops out)", async () => {
    const { result } = await together([2, 3]);
    act(() => void result.current.proposals.propose());
    await waitFor(() => expect(result.current.proposals.proposal).not.toBeNull());
    act(() => result.current.proposals.toggle(21));
    act(() => {
      expect(result.current.proposals.accept()).toBe(true);
    });
    await waitFor(() => expect(result.current.proposals.proposal).toBeNull());
    expect(bodies(ACCEPT_URL)).toEqual([
      { expectedRevision: 12, scopeHash: "b".repeat(64), teamIds: [1, 2, 3], acceptTeamIds: [1], items: [{ milestoneId: 6, startDate: "2042-04-06", endDate: "2042-04-07" }] },
    ]);
    expect(calls(SCHEDULES_URL)).toHaveLength(0);
  });

  test("rights that do not list this team: only the other team's move is ticked and the accept names that team alone", async () => {
    manages = [2];
    const { result } = await together([2]);
    act(() => void result.current.proposals.propose());
    await waitFor(() => expect(result.current.proposals.proposal).not.toBeNull());
    expect([...result.current.proposals.selected]).toEqual([21]);
    act(() => void result.current.proposals.accept());
    await waitFor(() => expect(bodies(ACCEPT_URL)).toHaveLength(1));
    expect(bodies(ACCEPT_URL)[0].acceptTeamIds).toEqual([2]);
  });

  test("Add linked teams adds the teams at the far ends of the team's links, once each, and keeps those already chosen", async () => {
    const { result } = await page();
    expect(result.current.proposals.picker.linked).toEqual([2]);
    act(() => result.current.proposals.picker.onChange([3]));
    act(() => result.current.proposals.picker.addLinked());
    expect(result.current.proposals.picker.value).toEqual([2, 3]);
    act(() => result.current.proposals.picker.addLinked());
    expect(result.current.proposals.picker.value).toEqual([2, 3]);
  });

  test("clearing the picker is today's Propose again: the per-team route", async () => {
    const { result } = await together([2]);
    act(() => result.current.proposals.picker.onChange([]));
    act(() => void result.current.proposals.propose());
    await waitFor(() => expect(result.current.proposals.proposal).not.toBeNull());
    expect(calls(RUN_URL)).toHaveLength(0);
    expect(bodies(PER_TEAM_URL)).toHaveLength(1);
  });

  test("the picker is off while the proposal is requested or open", async () => {
    const { result } = await together([2]);
    expect(result.current.proposals.picker.disabled).toBe(false);
    act(() => void result.current.proposals.propose());
    expect(result.current.proposals.picker.disabled).toBe(true);
    await waitFor(() => expect(result.current.proposals.proposal).not.toBeNull());
    expect(result.current.proposals.picker.disabled).toBe(true);
    act(() => void result.current.proposals.discard());
    expect(result.current.proposals.picker.disabled).toBe(false);
  });

  test("over 50 teams keeps Propose off (the reason is tooMany)", async () => {
    const { result } = await page();
    act(() => result.current.proposals.picker.onChange(Array.from({ length: 50 }, (_, index) => index + 2)));
    expect(result.current.proposals.waitingFor).toBe("tooMany");
    expect(result.current.proposals.proposable).toBe(false);
    act(() => {
      expect(result.current.proposals.propose()).toBe(false);
    });
    expect(calls(RUN_URL)).toHaveLength(0);
  });

  test("the accept puts the newly scheduled milestone into the page's cached view BEFORE the refetch lands: a Move up at once lists it in the order PUT", async () => {
    const { result } = await together([2]);
    act(() => void result.current.proposals.propose());
    await waitFor(() => expect(result.current.proposals.proposal).not.toBeNull());
    // the refetch the accept starts is still on its way: only the patch can tell the page that 6 now has dates
    holdView = new Promise<void>(() => undefined);
    act(() => void result.current.proposals.accept());
    await waitFor(() => expect(result.current.proposals.proposal).toBeNull());
    expect(result.current.schedule.view?.scheduled.map((m) => m.id)).toEqual([5, 7, 6]);
    expect(result.current.schedule.view?.revision).toBe(13);
    act(() => {
      expect(result.current.order.move(6, -1)).toBe(true);
    });
    await waitFor(() => expect(calls(ORDER_URL)).toHaveLength(1));
    expect(bodies(ORDER_URL)).toEqual([{ milestoneIds: [5, 6, 7], expectedRevision: 1 }]);
  });
});

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

describe("a viewer who may not schedule this team (1.39)", () => {
  const ONLY_THIS_TEAM: CrossTeamProposal = { ...RUN, teams: [RUN.teams[0]] };

  async function stranger(chosen: number[] = []) {
    VIEW = { ...VIEW, team: { ...VIEW.team, can: { schedule: false, editCapacity: false, editOrder: false } } } as TeamView;
    const rendered = await page();
    if (chosen.length > 0) act(() => rendered.result.current.proposals.picker.onChange(chosen));
    await waitFor(() => expect(rendered.result.current.proposals.waitingFor).toBeNull());
    return rendered;
  }

  test("Propose asks the run over this team alone, never the per-team route (403); the rights are read first, so nothing is tickable and no Accept is offered", async () => {
    manages = [2];
    const { result } = await stranger();
    expect(calls(TEAMS_URL)).toHaveLength(1);
    const impl = mockFetch.getMockImplementation() as Fetch;
    mockFetch.mockImplementation((url: string, init?: RequestInit) => (url === RUN_URL ? Promise.resolve(jsonResponse(200, ONLY_THIS_TEAM)) : impl(url, init)));
    act(() => {
      expect(result.current.proposals.propose()).toBe(true);
    });
    await waitFor(() => expect(result.current.proposals.proposal).not.toBeNull());
    expect(bodies(RUN_URL)).toEqual([{ asOf: "2042-01-05", teamIds: [1] }]);
    expect(calls(PER_TEAM_URL)).toHaveLength(0);
    expect(result.current.proposals.run).not.toBeNull();
    expect(result.current.proposals.together.canAccept).toBe(false);
    // a pure preview announces the moves it shows, not "0 moves"
    expect(announce).toHaveBeenCalledWith("Proposed schedule ready: 1 move");
    expect([...result.current.proposals.selected]).toEqual([]);
    expect(result.current.proposals.accept()).toBe(false);
    expect(calls(ACCEPT_URL)).toHaveLength(0);
    // nothing of theirs is ticked, yet the proposal is drawn whole: the check does not overlay this team's block (that would be the plan as it is, no proposed load)
    expect(result.current.proposals.shown?.weeks).toEqual(RUN.teams[0].weeks);
    expect(result.current.proposals.shown?.drawn.map((m) => m.milestoneId)).toEqual([6]);
    expect(calls(CHECK_URL)).toHaveLength(0);
  });

  test("Propose waits for the rights while they are read", async () => {
    VIEW = { ...VIEW, team: { ...VIEW.team, can: { schedule: false, editCapacity: false, editOrder: false } } } as TeamView;
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    const impl = mockFetch.getMockImplementation() as Fetch;
    mockFetch.mockImplementation((url: string, init?: RequestInit) => (url === TEAMS_URL ? held.then(() => jsonResponse(200, { items: [], truncated: false })) : impl(url, init)));
    const { result } = await page();
    expect(result.current.proposals.waitingFor).toBe("rights");
    expect(result.current.proposals.proposable).toBe(false);
    act(() => {
      expect(result.current.proposals.propose()).toBe(false);
    });
    expect(calls(RUN_URL)).toHaveLength(0);
    act(() => release());
    await waitFor(() => expect(result.current.proposals.proposable).toBe(true));
  });

  test("with chosen teams they manage, those moves are ticked and accepted (acceptTeamIds = those teams); this team's block stays the run's own preview", async () => {
    manages = [2];
    const { result } = await stranger([2]);
    act(() => void result.current.proposals.propose());
    await waitFor(() => expect(result.current.proposals.proposal).not.toBeNull());
    expect(bodies(RUN_URL)).toEqual([{ asOf: "2042-01-05", teamIds: [1, 2] }]);
    expect([...result.current.proposals.selected]).toEqual([21]);
    // none of the viewer's ticks is this team's: untick Beta's move, the check says "none" and still must not blank this team's proposed load
    act(() => result.current.proposals.toggle(21));
    expect(result.current.proposals.shown?.weeks).toEqual(RUN.teams[0].weeks);
    act(() => result.current.proposals.toggle(21));
    act(() => void result.current.proposals.accept());
    await waitFor(() => expect(bodies(ACCEPT_URL)).toHaveLength(1));
    expect(bodies(ACCEPT_URL)[0]).toMatchObject({ teamIds: [1, 2, 3], acceptTeamIds: [2], items: [{ milestoneId: 21 }] });
  });

  test("a viewer who may schedule it keeps the per-team proposal with nothing chosen, and the rights are not read", async () => {
    const { result } = await page();
    act(() => void result.current.proposals.propose());
    await waitFor(() => expect(result.current.proposals.proposal).not.toBeNull());
    expect(calls(TEAMS_URL)).toHaveLength(0);
    expect(calls(RUN_URL)).toHaveLength(0);
    expect(bodies(PER_TEAM_URL)).toHaveLength(1);
  });
});
