import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { jsonResponse } from "../test/http";
import {
  createProgram,
  createProject,
  createWorkStream,
  deleteProgram,
  deleteProject,
  deleteWorkStream,
  getPlanView,
  setProjectTargetWindow,
  updateProgram,
  updateProject,
  updateWorkStream,
} from "./plan";

type FetchMock = ReturnType<typeof vi.fn>;

describe("plan API wrappers", () => {
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

  const lastCall = () => mockFetch.mock.calls.at(-1) as [string, RequestInit];
  const lastBody = () => JSON.parse(lastCall()[1].body as string);

  test("getPlanView GETs the view", async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, { revision: 3, can: { createWorkStream: false }, workStreams: [] }));
    expect((await getPlanView()).revision).toBe(3);
    const [url, init] = lastCall();
    expect(url).toBe("/api/v1/views/plan");
    expect(init.method).toBeUndefined();
  });

  test("work streams: POST the collection, PUT and DELETE the id path, dates as ISO strings", async () => {
    const body = { name: "Platform", description: null, ownerPersonId: 4, startDate: "2026-01-05", endDate: null };
    mockFetch.mockResolvedValue(jsonResponse(201, { id: 9, ...body }));
    await createWorkStream(body);
    expect(lastCall()[0]).toBe("/api/v1/work-streams");
    expect(lastCall()[1].method).toBe("POST");
    expect(lastBody()).toEqual(body);

    mockFetch.mockResolvedValue(new Response(null, { status: 204 }));
    await updateWorkStream(9, { ...body, endDate: "2026-06-30" });
    expect(lastCall()[0]).toBe("/api/v1/work-streams/9");
    expect(lastCall()[1].method).toBe("PUT");
    expect(lastBody().endDate).toBe("2026-06-30");

    await deleteWorkStream(9);
    expect(lastCall()[0]).toBe("/api/v1/work-streams/9");
    expect(lastCall()[1].method).toBe("DELETE");
  });

  test("programs are created under their work stream and edited by their own id", async () => {
    const body = { name: "Billing", description: "d", ownerPersonId: 5 };
    mockFetch.mockResolvedValue(jsonResponse(201, { id: 3, workStreamId: 9, ...body }));
    await createProgram(9, body);
    expect(lastCall()[0]).toBe("/api/v1/work-streams/9/programs");
    expect(lastCall()[1].method).toBe("POST");
    expect(lastBody()).toEqual(body);

    mockFetch.mockResolvedValue(new Response(null, { status: 204 }));
    await updateProgram(3, body);
    expect(lastCall()[0]).toBe("/api/v1/programs/3");
    expect(lastCall()[1].method).toBe("PUT");
    await deleteProgram(3);
    expect(lastCall()[0]).toBe("/api/v1/programs/3");
    expect(lastCall()[1].method).toBe("DELETE");
  });

  test("projects: create under the program, PUT the fields, PUT the target window on its own path", async () => {
    const created = { name: "Rollout", description: null, ownerPersonId: 6, targetStart: "2026-02-01", targetEnd: "2026-03-31" };
    mockFetch.mockResolvedValue(jsonResponse(201, { id: 12, programId: 3, workStreamId: 9, ...created }));
    await createProject(3, created);
    expect(lastCall()[0]).toBe("/api/v1/programs/3/projects");
    expect(lastBody()).toEqual(created);

    mockFetch.mockResolvedValue(new Response(null, { status: 204 }));
    await updateProject(12, { name: "Rollout 2", description: null, ownerPersonId: 6 });
    expect(lastCall()[0]).toBe("/api/v1/projects/12");
    expect(lastCall()[1].method).toBe("PUT");

    await setProjectTargetWindow(12, { targetStart: null, targetEnd: null });
    expect(lastCall()[0]).toBe("/api/v1/projects/12/target-window");
    expect(lastCall()[1].method).toBe("PUT");
    expect(lastBody()).toEqual({ targetStart: null, targetEnd: null });

    await deleteProject(12);
    expect(lastCall()[0]).toBe("/api/v1/projects/12");
    expect(lastCall()[1].method).toBe("DELETE");
  });
});
