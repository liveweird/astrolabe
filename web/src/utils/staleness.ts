/**
 * The connector-agnostic half of "may this list be out of date": each connector (Jira's `utils/deviations.ts`, Flow's
 * `utils/capacityDeviations.ts`) says what makes ONE of its connections stale and, for the dated claim, when its newest run succeeded; the
 * folds over the connections live here once.
 */

/** True when an ENABLED connection is stale (a disabled one has its own note): the list may be out of date. */
export function hasStaleSource<C extends { enabled: boolean }>(connections: readonly C[], isStale: (connection: C) => boolean): boolean {
  return connections.some((connection) => connection.enabled && isStale(connection));
}

/**
 * When an empty list may be called "in line in the data read at T": the OLDEST `succeededAt` among the connections, and only when there is a
 * connection and none is stale and every one has a success to date the claim by (`succeededAt` returns null when it has none). Dated, never in the present tense.
 */
export function verifiedAt<C>(connections: readonly C[], isStale: (connection: C) => boolean, succeededAt: (connection: C) => number | null): number | null {
  if (connections.length === 0) return null;
  const times: number[] = [];
  for (const connection of connections) {
    const at = succeededAt(connection);
    if (isStale(connection) || at === null) return null;
    times.push(at);
  }
  return Math.min(...times);
}
