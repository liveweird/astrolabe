import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { jsonResponse } from "../test/http";
import { applyHolidayPreset, createPublicHoliday, deletePublicHoliday, listPublicHolidays } from "./calendar";

type FetchMock = ReturnType<typeof vi.fn>;

describe("public-holiday API wrappers", () => {
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

  test("listPublicHolidays GETs the dictionary and unwraps its items", async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, { items: [{ id: 1, date: "2027-01-06", name: "Epiphany" }] }));
    expect(await listPublicHolidays()).toEqual([{ id: 1, date: "2027-01-06", name: "Epiphany" }]);
    expect(lastCall()[0]).toBe("/api/v1/public-holidays");
  });

  test("createPublicHoliday POSTs the date and name and answers the row", async () => {
    mockFetch.mockResolvedValue(jsonResponse(201, { id: 5, date: "2027-05-03", name: "Constitution Day" }));
    expect((await createPublicHoliday({ date: "2027-05-03", name: "Constitution Day" })).id).toBe(5);
    const [url, init] = lastCall();
    expect(url).toBe("/api/v1/public-holidays");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ date: "2027-05-03", name: "Constitution Day" });
  });

  test("deletePublicHoliday DELETEs by id", async () => {
    mockFetch.mockResolvedValue(new Response(null, { status: 204 }));
    await deletePublicHoliday(5);
    const [url, init] = lastCall();
    expect(url).toBe("/api/v1/public-holidays/5");
    expect(init.method).toBe("DELETE");
  });

  test("applyHolidayPreset POSTs the preset and year and answers what was added and skipped", async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, { added: [{ id: 1, date: "2027-01-01", name: "New Year" }], skipped: ["2027-01-06"] }));
    const result = await applyHolidayPreset({ preset: "POLISH", year: 2027 });
    expect(result.added).toHaveLength(1);
    expect(result.skipped).toEqual(["2027-01-06"]);
    const [url, init] = lastCall();
    expect(url).toBe("/api/v1/public-holidays/apply-preset");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ preset: "POLISH", year: 2027 });
  });
});
