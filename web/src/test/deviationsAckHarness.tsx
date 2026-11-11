/* eslint-disable react-refresh/only-export-components */
// -- test scaffolding: the harness exports helpers beside the page wrapper; fast-refresh is irrelevant under vitest
import { afterEach, beforeEach, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { Route, Routes, useLocation } from "react-router-dom";
import { renderWithProviders } from "./render";
import { jsonResponse } from "./http";
import { endLater, item, stamped, view } from "./deviations";
import { NO_FLOW_VIEW } from "./flow";
import type { DeviationItem, DeviationView } from "../api/deviations";
import Deviations from "../pages/Deviations";

// The Deviations page's acknowledge tests share this harness (one file would be too long for the lint's function-size cap): the page over a
// stubbed fetch whose document and acknowledge route each test sets, a QueryClient it can spy on, and the rows that name their buttons.

const PLAN = { revision: 1, workStreams: [{ id: 700, name: "Platform", programs: [{ id: 70, name: "Billing", projects: [{ id: 7, name: "Invoices" }] }] }] };
const TEAMS = { items: [{ id: 3, name: "Backend" }], page: 1, pageSize: 100, total: 1 };
export const AT = Date.UTC(2026, 10, 6, 12, 30);
export const STALE_PROBLEM = { type: "urn:astrolabe:problem:stale-deviations", title: "Conflict", status: 409, detail: "The deviations changed" };

/** The query keys a spy on `cancelQueries` / `invalidateQueries` was asked to refresh, as JSON. */
export const keysOf = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map(([filters]) => JSON.stringify((filters as { queryKey: unknown }).queryKey));

/** The same keys as arrays, to ask whether one refreshed key is a prefix of a real query's key. */
export const keyArraysOf = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map(([filters]) => (filters as { queryKey: readonly unknown[] }).queryKey);
export const isPrefix = (prefix: readonly unknown[], key: readonly unknown[]) => prefix.length <= key.length && prefix.every((part, i) => JSON.stringify(part) === JSON.stringify(key[i]));

/** A row the caller may acknowledge: its Jira key names the buttons ("Acknowledge E2E-3: End"). */
export const row = (bindingId: number, key: string, over: Partial<DeviationItem> = {}): DeviationItem => {
  const base = item();
  return item({ bindingId, node: { ...base.node, id: 10 + bindingId, name: `Milestone ${key}` }, jira: { ...base.jira, key }, fingerprint: String(bindingId).repeat(64).slice(0, 64), can: { acknowledge: true }, ...over });
};
/** An item whose only line (the 3-day END_DIFFERS) is currently acknowledged; the deprecated item-level summary is kept in step (the UI does not read it). */
export const acknowledged = (over: Partial<DeviationItem> = {}) => ({ deviations: [stamped(endLater(3))], acknowledgement: { at: AT, by: "Ada Lovelace", current: true }, ...over });

function Where() {
  const location = useLocation();
  return <p data-testid="where">{location.pathname + location.search}</p>;
}

/**
 * Call inside a `describe`: registers the hooks and returns the harness. A test sets `doc` (what the view answers) and `onWrite` (what the
 * acknowledge route answers, by method; the default is a 500) and renders with `renderPage`.
 */
export function ackHarness() {
  const h = {
    doc: view({ items: [row(1, "E2E-3")] }) as DeviationView,
    onWrite: ((_method: string, _bindingId: number, _body: unknown, _url: string): Response | Promise<Response> => jsonResponse(500, { title: "x", status: 500 })),
    queryClient: new QueryClient(),
    mockFetch: vi.fn(),
    viewCalls: () => h.mockFetch.mock.calls.map(([url]) => url as string).filter((url) => url.startsWith("/api/v1/views/deviations")),
    writes: () => h.mockFetch.mock.calls.filter(([url]) => /\/bindings\/\d+\/acknowledge(\?.*)?$/.test(url as string)) as [string, RequestInit][],
    renderPage: (route = "/deviations") =>
      renderWithProviders(
        <Routes>
          <Route
            path="/deviations"
            element={
              <>
                <Deviations />
                <Where />
              </>
            }
          />
        </Routes>,
        { route, queryClient: h.queryClient },
      ),
  };
  beforeEach(() => {
    h.queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    h.mockFetch = vi.fn();
    vi.stubGlobal("fetch", h.mockFetch);
    localStorage.setItem("astrolabe.auth.token", "fake-token");
    localStorage.setItem("astrolabe.auth.roles", JSON.stringify(["USER"]));
    h.doc = view({ items: [row(1, "E2E-3")] });
    h.onWrite = () => jsonResponse(500, { title: "x", status: 500 });
    h.mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      const write = /\/bindings\/(\d+)\/acknowledge(\?.*)?$/.exec(url);
      if (write) return Promise.resolve(h.onWrite(init?.method ?? "GET", Number(write[1]), init?.body ? JSON.parse(init.body as string) : undefined, url));
      if (url.startsWith("/api/v1/views/deviations")) return Promise.resolve(jsonResponse(200, h.doc));
      if (url.startsWith("/api/v1/views/capacity-deviations")) return Promise.resolve(jsonResponse(200, NO_FLOW_VIEW));
      if (url === "/api/v1/views/plan") return Promise.resolve(jsonResponse(200, PLAN));
      if (url.startsWith("/api/v1/teams?")) return Promise.resolve(jsonResponse(200, TEAMS));
      if (url.startsWith("/api/v1/integrations/jira/bindings?")) return Promise.resolve(jsonResponse(200, { items: [], page: 1, pageSize: 1, total: 1 }));
      return Promise.resolve(jsonResponse(404, { title: "x", status: 404 }));
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    localStorage.clear();
  });
  return h;
}
