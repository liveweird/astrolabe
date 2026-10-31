import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { jsonResponse } from "../test/http";
import { createMilestone, deleteMilestone, getProjectView, scheduleMilestone, updateMilestone } from "./milestones";

type FetchMock = ReturnType<typeof vi.fn>;

describe("milestones API wrappers", () => {
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
  const BODY = { name: "Discovery", description: null, teamId: 3, estimateMd: 12.25 };

  test("getProjectView GETs the project's view document", async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, { revision: 4, scheduled: [], unscheduled: [] }));
    expect((await getProjectView(9)).revision).toBe(4);
    expect(lastCall()[0]).toBe("/api/v1/views/project/9");
  });

  test("createMilestone POSTs the plan fields under the project", async () => {
    mockFetch.mockResolvedValue(jsonResponse(201, { id: 5 }));
    expect(await createMilestone(9, BODY)).toEqual({ id: 5 });
    const [url, init] = lastCall();
    expect(url).toBe("/api/v1/projects/9/milestones");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual(BODY);
  });

  test("updateMilestone PUTs the full replace; deleteMilestone DELETEs", async () => {
    mockFetch.mockResolvedValue(new Response(null, { status: 204 }));
    await updateMilestone(5, BODY);
    expect(lastCall()[0]).toBe("/api/v1/milestones/5");
    expect(lastCall()[1].method).toBe("PUT");
    await deleteMilestone(5);
    expect(lastCall()[0]).toBe("/api/v1/milestones/5");
    expect(lastCall()[1].method).toBe("DELETE");
  });

  test("scheduleMilestone PUTs the expected revision and the dates (a null pair unschedules) and answers the new revision", async () => {
    mockFetch.mockImplementation(() => Promise.resolve(jsonResponse(200, { revision: 12 })));
    expect(await scheduleMilestone(5, { expectedRevision: 11, startDate: "2027-01-04", endDate: "2027-01-10" })).toEqual({ revision: 12 });
    const [url, init] = lastCall();
    expect(url).toBe("/api/v1/milestones/5/schedule");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({ expectedRevision: 11, startDate: "2027-01-04", endDate: "2027-01-10" });
    await scheduleMilestone(5, { expectedRevision: 12, startDate: null, endDate: null });
    expect(JSON.parse(lastCall()[1].body as string)).toEqual({ expectedRevision: 12, startDate: null, endDate: null });
  });
});
