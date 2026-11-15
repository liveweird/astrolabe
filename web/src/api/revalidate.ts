// Revalidating reads (1.22) - the ten view documents answer `304` to `If-None-Match`, but every /api/ answer is `Cache-Control: no-store`, so the
// browser never revalidates by itself. This module keeps the last tag and the exact text it came with, IN MEMORY ONLY (never localStorage,
// sessionStorage, IndexedDB or the Cache API), sends the tag and hands the kept text back on a `304`. Transport stays in ./http.

import { ApiError, authedFetch, safeJson } from "./http";
import { getSessionSnapshot } from "./session";

/** At most this many documents are kept; the least recently used goes first. */
const MAX_DOCUMENTS = 16;
/** At most this many characters of kept text in all. */
const MAX_CHARACTERS = 8_000_000;

type Kept = { identity: string; etag: string; text: string };

// Insertion order IS the recency order: a use deletes and re-sets the entry, the oldest is the first key.
const kept = new Map<string, Kept>();
let keptCharacters = 0;

function drop(path: string): void {
  const entry = kept.get(path);
  if (entry === undefined) return;
  kept.delete(path);
  keptCharacters -= entry.text.length;
}

/** The entry of this address for this session identity, made the most recent; an entry of another identity is dropped, never returned. */
function lookup(path: string, identity: string): Kept | undefined {
  const entry = kept.get(path);
  if (entry === undefined) return undefined;
  if (entry.identity !== identity) {
    drop(path);
    return undefined;
  }
  kept.delete(path);
  kept.set(path, entry);
  return entry;
}

function keep(path: string, entry: Kept): void {
  drop(path);
  if (entry.text.length > MAX_CHARACTERS) return;
  kept.set(path, entry);
  keptCharacters += entry.text.length;
  for (const oldest of kept.keys()) {
    if (kept.size <= MAX_DOCUMENTS && keptCharacters <= MAX_CHARACTERS) break;
    drop(oldest);
  }
}

/** Forget every kept document (the session boundary calls it when the session identity changes). */
export function forgetRevalidated(): void {
  kept.clear();
  keptCharacters = 0;
}

/** The session identity changed while a conditional read was out: the kept text belongs to the previous identity and nothing may be re-sent for the new one. */
class SessionChangedError extends Error {
  constructor() {
    super("session changed");
    this.name = "SessionChangedError";
  }
}

/**
 * Settles a `200`: parse, then keep or drop the entry. A request of an identity that is no longer the current one touches nothing. A body that does not
 * parse drops the previous entry (rule 5: a 200 replaces or drops) and throws as `res.json()` would.
 */
async function settle<T>(res: Response, path: string, identity: string | null): Promise<T> {
  const text = await res.text();
  const owner = identity !== null && getSessionSnapshot().identity === identity ? identity : null;
  let document: T;
  try {
    document = JSON.parse(text) as T;
  } catch (error) {
    if (owner !== null) drop(path);
    throw error;
  }
  if (owner !== null) {
    const etag = res.headers.get("ETag");
    if (etag === null || etag === "") drop(path);
    else keep(path, { identity: owner, etag, text });
  }
  return document;
}

/**
 * A GET whose answer may be "the one you have": sends the kept tag for this address and session, and answers a `304` with a fresh parse of the text
 * that tag came with - never with query data or an optimistic state. With no kept tag the request is exactly `jsonRequest`'s.
 */
export async function revalidatedRequest<T>(path: string): Promise<T> {
  const identity = getSessionSnapshot().identity;
  const entry = identity === null ? undefined : lookup(path, identity);
  const res = await authedFetch(path, entry === undefined ? undefined : { headers: { "If-None-Match": entry.etag } });
  if (res.status === 304 && entry !== undefined) {
    // Another identity is signed in now (or none): no request is made for it from here and A's text is never handed out.
    if (getSessionSnapshot().identity !== entry.identity) throw new SessionChangedError();
    if (kept.get(path) === entry) return JSON.parse(entry.text) as T;
    // Same identity, but the entry was evicted, forgotten or replaced while the request was out: ONE plain re-read, never a guess.
    return plainRead<T>(path, entry.identity);
  }
  if (!res.ok) throw new ApiError(res.status, await safeJson(res));
  return settle<T>(res, path, identity);
}

async function plainRead<T>(path: string, identity: string): Promise<T> {
  const res = await authedFetch(path);
  if (!res.ok) throw new ApiError(res.status, await safeJson(res));
  return settle<T>(res, path, identity);
}
