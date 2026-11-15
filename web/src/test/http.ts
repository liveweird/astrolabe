import { vi } from "vitest";

// Shared test helper: a JSON Response for fetch mocks (previously copy-pasted per test file).
export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/** A `304 Not Modified` for a view read: no body, the tag the client sent. */
export function notModified(etag: string): Response {
  return new Response(null, { status: 304, headers: { ETag: etag } });
}

/** What a handler of `routeFetch` is told: the call as the app made it, and the `:name` segments the pattern matched. */
interface RoutedCall {
  method: string;
  /** The path alone, no query string (`/api/v1/teams/3`). */
  path: string;
  /** The query string with its `?`, or `""`. */
  search: string;
  params: Record<string, string>;
  init: RequestInit | undefined;
  /** The request body parsed as JSON; `undefined` when there is none (or it is not a JSON string). */
  json: () => unknown;
}

/** A body (answered `200` as JSON), a ready `Response`, or a function of the call returning either (or a promise of either). */
type RouteHandler = Response | object | string | number | boolean | null | ((call: RoutedCall) => unknown);

const unrouted: string[] = [];

/** Fails the test that made a call `routeFetch` had no route for, and forgets the calls it reports. `setup.ts` runs it after every test. */
export function assertNoUnroutedCalls(): void {
  const calls = unrouted.splice(0);
  if (calls.length > 0) throw new Error(`fetch called without a route: ${calls.join(", ")}`);
}

const escaped = (text: string) => text.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

/** `:name` matches one path segment, `*` anything; every other character is literal. */
function patternOf(path: string): RegExp {
  const source = path
    .split(/(:[A-Za-z]\w*|\*)/)
    .map((part) => (part === "*" ? ".*" : part.startsWith(":") ? `(?<${part.slice(1)}>[^/]+)` : escaped(part)))
    .join("");
  return new RegExp(`^${source}$`);
}

function splitUrl(url: string): { path: string; search: string } {
  if (/^https?:\/\//.test(url)) {
    const { pathname, search } = new URL(url);
    return { path: pathname, search };
  }
  const at = url.indexOf("?");
  return at < 0 ? { path: url, search: "" } : { path: url.slice(0, at), search: url.slice(at) };
}

/**
 * A `fetch` that answers by method and path. `table` maps `"METHOD /path"` to a handler: the path is exact, or a pattern
 * (`:name` = one segment, `*` = anything; an exact key wins, then the patterns in table order). The query string is not part
 * of the match, a handler reads it from `call.search`. A handler is a body (`200`, JSON), a `Response` (cloned per call, so a
 * route can answer repeatedly) or a function of the call returning either. A call no key matches rejects with an error naming
 * its method and path AND fails the test in `afterEach`, so an app that swallows the rejection does not hide it.
 * Returns the mock (`.mock.calls`); install it with `vi.stubGlobal("fetch", …)`.
 */
export function routeFetch(table: Record<string, RouteHandler>) {
  const routes = Object.entries(table).map(([key, handler]) => {
    const [method, path, ...rest] = key.split(" ");
    if (rest.length > 0 || path === undefined || !path.startsWith("/")) throw new Error(`routeFetch: "${key}" is not "METHOD /path"`);
    return { method: method.toUpperCase(), path, pattern: patternOf(path), handler };
  });
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : null;
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    const { path, search } = splitUrl(request?.url ?? String(input));
    const sameMethod = routes.filter((route) => route.method === method);
    const route = sameMethod.find((candidate) => candidate.path === path) ?? sameMethod.find((candidate) => candidate.pattern.test(path));
    if (!route) {
      unrouted.push(`${method} ${path}`);
      throw new Error(`routeFetch: no route for ${method} ${path}`);
    }
    const params = { ...route.pattern.exec(path)?.groups };
    const json = () => (typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined);
    const { handler } = route;
    const answer = typeof handler === "function" ? await handler({ method, path, search, params, init, json }) : handler;
    return answer instanceof Response ? answer.clone() : jsonResponse(200, answer);
  });
}
