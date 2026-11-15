import { describe, expect, test } from "vitest";
import { assertNoUnroutedCalls, jsonResponse, notModified, routeFetch } from "./http";

describe("jsonResponse and notModified", () => {
  test("a JSON body with its status and headers; a 304 carries the tag and no body", async () => {
    const response = jsonResponse(201, { id: 3 }, { ETag: "W/\"1\"" });
    expect([response.status, response.headers.get("ETag"), await response.json()]).toEqual([201, "W/\"1\"", { id: 3 }]);
    const kept = notModified("W/\"2\"");
    expect([kept.status, kept.headers.get("ETag"), await kept.text()]).toEqual([304, "W/\"2\"", ""]);
  });
});

describe("routeFetch", () => {
  test("a body answers 200 as JSON; the method is part of the route and defaults to GET", async () => {
    const fetch = routeFetch({ "GET /api/v1/teams": { items: [] }, "PUT /api/v1/teams": { saved: true } });
    expect(await (await fetch("/api/v1/teams")).json()).toEqual({ items: [] });
    expect(await (await fetch("/api/v1/teams", { method: "put" })).json()).toEqual({ saved: true });
  });

  test("the query string is not part of the match; a handler reads it from the call", async () => {
    const fetch = routeFetch({ "GET /api/v1/teams": (call) => ({ search: call.search, path: call.path }) });
    expect(await (await fetch("/api/v1/teams?page=2")).json()).toEqual({ search: "?page=2", path: "/api/v1/teams" });
  });

  test("a Response is answered as is, again on every call", async () => {
    const fetch = routeFetch({ "DELETE /api/v1/teams/3": new Response(null, { status: 204 }), "GET /api/v1/gone": jsonResponse(404, { status: 404 }) });
    expect((await fetch("/api/v1/teams/3", { method: "DELETE" })).status).toBe(204);
    expect((await fetch("/api/v1/teams/3", { method: "DELETE" })).status).toBe(204);
    expect((await fetch("/api/v1/gone")).status).toBe(404);
    expect((await fetch("/api/v1/gone")).status).toBe(404);
  });

  test("a pattern: :name is one segment and reaches the handler; * is anything; an exact route beats a pattern", async () => {
    const fetch = routeFetch({
      "GET /api/v1/teams/:id": (call) => ({ id: call.params.id }),
      "GET /api/v1/teams/7": { id: "seven" },
      "GET /api/v1/views/*": (call) => ({ path: call.path }),
      "GET /api/v1/teams/:id/capacity": { capacity: true },
    });
    expect(await (await fetch("/api/v1/teams/12")).json()).toEqual({ id: "12" });
    expect(await (await fetch("/api/v1/teams/7")).json()).toEqual({ id: "seven" });
    expect(await (await fetch("/api/v1/teams/12/capacity")).json()).toEqual({ capacity: true });
    expect(await (await fetch("/api/v1/views/project/4")).json()).toEqual({ path: "/api/v1/views/project/4" });
  });

  test("a function may be async, reads the JSON body, and may answer a Response", async () => {
    const fetch = routeFetch({
      "POST /api/v1/teams": async (call) => {
        const body = call.json() as { name: string };
        return body.name === "" ? jsonResponse(400, { status: 400 }) : { name: body.name };
      },
    });
    const post = (name: string) => fetch("/api/v1/teams", { method: "POST", body: JSON.stringify({ name }) });
    expect(await (await post("Core")).json()).toEqual({ name: "Core" });
    expect((await post("")).status).toBe(400);
  });

  test("it accepts a URL and a Request, and records every call for the test to read", async () => {
    const fetch = routeFetch({ "GET /api/v1/teams": [], "POST /api/v1/teams": [] });
    await fetch(new URL("http://localhost/api/v1/teams"));
    expect(fetch.mock.calls).toHaveLength(1);
    await fetch(new Request("http://localhost/api/v1/teams", { method: "POST", body: "{}" }));
    expect(fetch.mock.calls).toHaveLength(2);
  });

  test("a call without a route rejects naming its method and path, and the test is failed afterwards", async () => {
    const fetch = routeFetch({ "GET /api/v1/teams": [] });
    await expect(fetch("/api/v1/teams/3?x=1", { method: "DELETE" })).rejects.toThrow("no route for DELETE /api/v1/teams/3");
    await expect(fetch("/api/v1/people")).rejects.toThrow("no route for GET /api/v1/people");
    // What setup.ts's afterEach runs; here it is called (and so emptied) by the test that provoked the calls on purpose.
    expect(() => assertNoUnroutedCalls()).toThrow("fetch called without a route: DELETE /api/v1/teams/3, GET /api/v1/people");
    expect(() => assertNoUnroutedCalls()).not.toThrow();
  });

  test("a key that is not METHOD /path is refused when the router is built", () => {
    expect(() => routeFetch({ "/api/v1/teams": [] })).toThrow("not \"METHOD /path\"");
    expect(() => routeFetch({ "GET api/v1/teams": [] })).toThrow("not \"METHOD /path\"");
  });
});
