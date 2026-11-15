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
