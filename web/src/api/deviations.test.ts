import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { jsonResponse } from "../test/http";
import { view } from "../test/deviations";
import { acknowledgeDeviation, getDeviations, isStaleDeviations, unacknowledgeDeviation } from "./deviations";
import { createJiraBinding, deleteJiraBinding, isAlreadyBound, isJiraMappingInvalid, listJiraBindings } from "./jira";
import { ApiError } from "./http";

type FetchMock = ReturnType<typeof vi.fn>;

describe("deviations and bindings API wrappers", () => {
  let mockFetch: FetchMock;
  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    localStorage.setItem("astrolabe.auth.token", "fake-token");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });
  const lastCall = () => mockFetch.mock.calls.at(-1) as [string, RequestInit | undefined];

  test("getDeviations sends only the filters that are set (ids, enums, all), nothing for none", async () => {
    mockFetch.mockImplementation(() => Promise.resolve(jsonResponse(200, view())));
    await getDeviations();
    expect(lastCall()[0]).toBe("/api/v1/views/deviations");
    await getDeviations({ projectId: 7, severity: "WARNING", level: "MILESTONE", all: true, connectionId: 0 });
    const url = new URL(lastCall()[0], "http://x");
    expect(Object.fromEntries(url.searchParams)).toEqual({ projectId: "7", severity: "WARNING", level: "MILESTONE", all: "true", connectionId: "0" });
  });

  test("listJiraBindings sends the level and the name filter as level= and q=", async () => {
    mockFetch.mockImplementation(() => Promise.resolve(jsonResponse(200, { items: [], page: 1, pageSize: 20, total: 0 })));
    await listJiraBindings({ page: 2, pageSize: 20, connectionId: 4, level: "PROJECT", q: "pay", sort: "-createdAt" });
    expect(Object.fromEntries(new URL(lastCall()[0], "http://x").searchParams)).toEqual({ page: "2", pageSize: "20", connectionId: "4", level: "PROJECT", q: "pay", sort: "-createdAt" });
  });

  test("createJiraBinding POSTs the bind request; deleteJiraBinding DELETEs by id", async () => {
    mockFetch.mockImplementation(() => Promise.resolve(jsonResponse(201, { id: 3 })));
    await createJiraBinding({ connectionId: 1, level: "MILESTONE", nodeId: 11, issueKey: "E2E-3" });
    const [url, init] = lastCall();
    expect(url).toBe("/api/v1/integrations/jira/bindings");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({ connectionId: 1, level: "MILESTONE", nodeId: 11, issueKey: "E2E-3" });
    mockFetch.mockImplementation(() => Promise.resolve(new Response(null, { status: 204 })));
    await deleteJiraBinding(3);
    expect(lastCall()[0]).toBe("/api/v1/integrations/jira/bindings/3");
    expect(lastCall()[1]?.method).toBe("DELETE");
  });

  test("the two bind-specific 409s are told apart by their problem type, not by status alone", async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve(jsonResponse(409, { type: "urn:astrolabe:problem:already-bound", title: "Conflict", status: 409, detail: "E2E-3 is already linked to milestone X" })),
    );
    const err = await createJiraBinding({ connectionId: 1, level: "MILESTONE", nodeId: 11, issueKey: "E2E-3" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(isAlreadyBound(err)).toBe(true);
    expect(isJiraMappingInvalid(err)).toBe(false);
  });

  test("getDeviations sends acknowledged=false as well as true (a set boolean is sent, only an absent one is not)", async () => {
    mockFetch.mockImplementation(() => Promise.resolve(jsonResponse(200, view())));
    await getDeviations({ acknowledged: false });
    expect(lastCall()[0]).toBe("/api/v1/views/deviations?acknowledged=false");
    await getDeviations({ acknowledged: true, all: false, projectId: 7 });
    expect(Object.fromEntries(new URL(lastCall()[0], "http://x").searchParams)).toEqual({ acknowledged: "true", all: "false", projectId: "7" });
  });

  test("acknowledgeDeviation POSTs exactly {fingerprint} to the binding's acknowledge path; unacknowledgeDeviation DELETEs it", async () => {
    mockFetch.mockImplementation(() => Promise.resolve(jsonResponse(200, { bindingId: 4, fingerprint: "b".repeat(64), acknowledgedAt: 1, acknowledgedBy: "Ada" })));
    const result = await acknowledgeDeviation(4, "b".repeat(64));
    expect(result.acknowledgedBy).toBe("Ada");
    const [url, init] = lastCall();
    expect(url).toBe("/api/v1/integrations/jira/bindings/4/acknowledge");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({ fingerprint: "b".repeat(64) });
    mockFetch.mockImplementation(() => Promise.resolve(new Response(null, { status: 204 })));
    await unacknowledgeDeviation(4);
    expect(lastCall()[0]).toBe("/api/v1/integrations/jira/bindings/4/acknowledge");
    expect(lastCall()[1]?.method).toBe("DELETE");
    expect(lastCall()[1]?.body).toBeUndefined();
  });

  test("a 409 is the stale-deviations state only by its problem type", async () => {
    mockFetch.mockImplementation(() => Promise.resolve(jsonResponse(409, { type: "urn:astrolabe:problem:stale-deviations", title: "Conflict", status: 409, detail: "changed" })));
    expect(isStaleDeviations(await acknowledgeDeviation(4, "c".repeat(64)).catch((e: unknown) => e))).toBe(true);
    mockFetch.mockImplementation(() => Promise.resolve(jsonResponse(409, { type: "urn:astrolabe:problem:already-bound", title: "Conflict", status: 409 })));
    expect(isStaleDeviations(await acknowledgeDeviation(4, "c".repeat(64)).catch((e: unknown) => e))).toBe(false);
    expect(isStaleDeviations(new Error("x"))).toBe(false);
  });
});
