import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { QueryClient } from "@tanstack/react-query";
import { act, renderWithProviders, screen, waitFor } from "../test/render";
import { jsonResponse } from "../test/http";
import { GONE_ROW, acknowledgedRow, differsRow, missingRow } from "../test/flow";
import { useCapacityAcknowledge } from "./useCapacityAcknowledge";

const ROW_2 = differsRow();
const ROW_3 = differsRow({ sprintId: 90003, sprintName: "E2E Flow Sprint 3", start: "2047-02-04", end: "2047-02-15", planMd: 44, flowMd: 48 });
const ROW_4 = missingRow(90004, "2047-02-18", "2047-03-01");
const URL_5 = "/api/v1/integrations/flow/team-bindings/5/acknowledge";
const STALE = { type: "urn:astrolabe:problem:stale-deviations", title: "Conflict", status: 409, detail: "changed" };

/** Three buttons that write (each names its neighbours as a list does) and the hook's state in text, so the machine is read the way a list reads it. */
function Harness({ scope = "a" }: { scope?: string }) {
  const fallback = useRef<HTMLHeadingElement>(null);
  const ack = useCapacityAcknowledge(fallback, scope);
  return (
    <div>
      <h4 ref={fallback} tabIndex={-1}>
        list
      </h4>
      <button data-ack-for="5:90002" onClick={() => ack.run({ kind: "acknowledge", bindingId: 5, row: ROW_2 }, ["5:90003"])}>
        ack 2
      </button>
      <button data-ack-for="5:90003" onClick={() => ack.run({ kind: "unacknowledge", bindingId: 5, row: acknowledgedRow(ROW_3) }, ["5:90002"])}>
        unack 3
      </button>
      <button onClick={() => ack.run({ kind: "acknowledge", bindingId: 5, row: ROW_4 }, [])}>ack 4</button>
      <button onClick={() => ack.run({ kind: "acknowledge", bindingId: 6, row: GONE_ROW }, [])}>ack gone</button>
      <output data-testid="busy">{ack.busyKey ?? "idle"}</output>
      <output data-testid="notice">{ack.notice === null ? "none" : `${ack.notice.key} ${ack.notice.kind}${ack.notice.kind === "failure" ? `: ${ack.notice.text}` : ""}`}</output>
    </div>
  );
}

describe("useCapacityAcknowledge", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  let queryClient: QueryClient;
  let invalidated: string[][];
  const writes = () => mockFetch.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method !== undefined) as [string, RequestInit][];
  const renderHarness = () => renderWithProviders(<Harness />, { queryClient });
  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    localStorage.setItem("astrolabe.auth.token", "fake-token");
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    invalidated = [];
    vi.spyOn(queryClient, "invalidateQueries").mockImplementation((filters) => {
      invalidated.push([...(filters?.queryKey ?? [])] as string[]);
      return Promise.resolve();
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  test("acknowledging sends the sprint and the row's fingerprint, then re-reads the capacity deviations AND the plan's views", async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, { bindingId: 5, sprintId: 90002, fingerprint: ROW_2.fingerprint, acknowledgedAt: 1, acknowledgedBy: "Ada" }));
    renderHarness();
    await userEvent.click(screen.getByRole("button", { name: "ack 2" }));
    await waitFor(() => expect(invalidated).toEqual([["flow", "deviations"], ["plan"]]));
    expect(writes()).toHaveLength(1);
    expect(writes()[0][0]).toBe(URL_5);
    expect(JSON.parse(writes()[0][1].body as string)).toEqual({ sprintId: 90002, fingerprint: ROW_2.fingerprint });
    expect(screen.getByTestId("notice")).toHaveTextContent("none");
  });

  test("withdrawing is a DELETE naming the sprint", async () => {
    mockFetch.mockImplementation(() => Promise.resolve(new Response(null, { status: 204 })));
    renderHarness();
    await userEvent.click(screen.getByRole("button", { name: "unack 3" }));
    await waitFor(() => expect(invalidated).toEqual([["flow", "deviations"], ["plan"]]));
    expect(writes()[0][0]).toBe(`${URL_5}?sprintId=90003`);
    expect(writes()[0][1].method).toBe("DELETE");
  });

  test("the gone team's own row is acknowledged with `sprintId: null`", async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, { bindingId: 6, sprintId: null, fingerprint: GONE_ROW.fingerprint, acknowledgedAt: 1, acknowledgedBy: null }));
    renderHarness();
    await userEvent.click(screen.getByRole("button", { name: "ack gone" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0][0]).toBe("/api/v1/integrations/flow/team-bindings/6/acknowledge");
    expect(JSON.parse(writes()[0][1].body as string)).toEqual({ sprintId: null, fingerprint: GONE_ROW.fingerprint });
  });

  test("a 409 stale-deviations is a note tied to the row (never a toast or a failure) and the same re-read", async () => {
    mockFetch.mockResolvedValue(jsonResponse(409, STALE));
    renderHarness();
    await userEvent.click(screen.getByRole("button", { name: "ack 2" }));
    await waitFor(() => expect(screen.getByTestId("notice")).toHaveTextContent("5:90002 stale"));
    expect(invalidated).toEqual([["flow", "deviations"], ["plan"]]);
  });

  test("a 403 is an inline refusal in words and re-reads the links (the rights or the link changed)", async () => {
    mockFetch.mockResolvedValue(jsonResponse(403, { title: "Forbidden", status: 403 }));
    renderHarness();
    await userEvent.click(screen.getByRole("button", { name: "ack 2" }));
    await waitFor(() => expect(screen.getByTestId("notice")).toHaveTextContent("5:90002 failure: Only the team's manager or an administrator can acknowledge its capacity differences."));
    expect(invalidated).toEqual([["flow", "teams"], ["flow", "team"], ["flow", "deviations"]]);
  });

  test("a 404 reads as the link being gone when acknowledging and as already withdrawn when withdrawing", async () => {
    mockFetch.mockResolvedValue(jsonResponse(404, { title: "Not found", status: 404 }));
    renderHarness();
    await userEvent.click(screen.getByRole("button", { name: "ack 2" }));
    await waitFor(() => expect(screen.getByTestId("notice")).toHaveTextContent("This link no longer exists. The list has been read again."));
    await userEvent.click(screen.getByRole("button", { name: "unack 3" }));
    await waitFor(() => expect(screen.getByTestId("notice")).toHaveTextContent("5:90003 failure: That acknowledgement was already withdrawn. The list has been read again."));
  });

  test("any other failure is the generic line with the status, and re-reads nothing", async () => {
    mockFetch.mockResolvedValue(jsonResponse(500, { title: "Boom", status: 500 }));
    renderHarness();
    await userEvent.click(screen.getByRole("button", { name: "ack 2" }));
    await waitFor(() => expect(screen.getByTestId("notice")).toHaveTextContent("5:90002 failure:"));
    expect(invalidated).toEqual([]);
  });

  test("while a write runs it is the only one: the busy key names its row and a second click is ignored", async () => {
    let finish: (response: Response) => void = () => {};
    mockFetch.mockImplementation(() => new Promise<Response>((resolve) => (finish = resolve)));
    renderHarness();
    await userEvent.click(screen.getByRole("button", { name: "ack 2" }));
    await waitFor(() => expect(screen.getByTestId("busy")).toHaveTextContent("5:90002"));
    await userEvent.click(screen.getByRole("button", { name: "ack 4" }));
    expect(writes()).toHaveLength(1);
    await act(async () => finish(jsonResponse(200, { bindingId: 5, sprintId: 90002, fingerprint: ROW_2.fingerprint, acknowledgedAt: 1, acknowledgedBy: null })));
    await waitFor(() => expect(screen.getByTestId("busy")).toHaveTextContent("idle"));
  });

  test("the messages belong to the list they were made on: another scope drops them", async () => {
    mockFetch.mockResolvedValue(jsonResponse(409, STALE));
    const view = renderHarness();
    await userEvent.click(screen.getByRole("button", { name: "ack 2" }));
    await waitFor(() => expect(screen.getByTestId("notice")).toHaveTextContent("stale"));
    view.rerender(<Harness scope="b" />);
    expect(screen.getByTestId("notice")).toHaveTextContent("none");
  });

  test("after a write that re-reads, the focus the browser dropped on body goes to the row's neighbour", async () => {
    renderHarness();
    const first = screen.getByRole("button", { name: "ack 2" });
    first.focus();
    // The row's own button is gone after the re-read (as an Open list drops an acknowledged row): the focus falls to body, then to the neighbour.
    mockFetch.mockImplementation(() => {
      first.remove();
      (document.activeElement as HTMLElement | null)?.blur();
      return Promise.resolve(jsonResponse(200, { bindingId: 5, sprintId: 90002, fingerprint: ROW_2.fingerprint, acknowledgedAt: 1, acknowledgedBy: null }));
    });
    await userEvent.click(first);
    await waitFor(() => expect(screen.getByRole("button", { name: "unack 3" })).toHaveFocus());
  });

  test("with no neighbour left the focus goes to the list's heading; a focus the user put elsewhere is left alone", async () => {
    renderHarness();
    const only = screen.getByRole("button", { name: "ack 4" });
    only.focus();
    mockFetch.mockImplementation(() => {
      only.remove();
      (document.activeElement as HTMLElement | null)?.blur();
      return Promise.resolve(jsonResponse(200, { bindingId: 5, sprintId: 90004, fingerprint: ROW_4.fingerprint, acknowledgedAt: 1, acknowledgedBy: null }));
    });
    await userEvent.click(only);
    await waitFor(() => expect(screen.getByRole("heading", { name: "list" })).toHaveFocus());

    const other = screen.getByRole("button", { name: "ack 2" });
    mockFetch.mockImplementation(() => {
      screen.getByRole("button", { name: "unack 3" }).focus();
      return Promise.resolve(jsonResponse(200, { bindingId: 5, sprintId: 90002, fingerprint: ROW_2.fingerprint, acknowledgedAt: 1, acknowledgedBy: null }));
    });
    await userEvent.click(other);
    await waitFor(() => expect(invalidated.length).toBeGreaterThanOrEqual(4));
    expect(screen.getByRole("button", { name: "unack 3" })).toHaveFocus();
  });
});
