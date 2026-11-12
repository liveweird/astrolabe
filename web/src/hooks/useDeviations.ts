import { useMemo } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { getDeviations, type DeviationConnection, type DeviationFilter } from "../api/deviations";
import { DEVIATIONS_POLL_MS } from "../utils/syncRuns";
import { useBoundedPoll } from "./useBoundedPoll";

/**
 * The deviations queries live under the `["jira"]` prefix (a bind, an unlink, a refresh and the connection page's mutations refresh it) and
 * under NO plan prefix. Reading never touches a timeline view; the writes that change the Jira flags those views carry (a bind, an unlink, the
 * import, an acknowledgement) also re-read `["plan"]` and `["roadmap"]` (`refreshJiraAndTimelines`).
 */
const deviationsKey = (filter: DeviationFilter) => ["jira", "deviations", "view", filter] as const;

/** Names what is running: every connection whose newest run is running, by connection and run id (the bounded poll's latch key); null = nothing. */
function runningKey(connections: readonly DeviationConnection[] | undefined): string | null {
  const running = (connections ?? []).filter((connection) => connection.lastRun?.running).map((connection) => `${connection.id}:${connection.lastRun?.id}`);
  return running.length === 0 ? null : running.join(",");
}

/**
 * The Deviations page's document. It refetches when the window regains focus (the react-query default, stated) and, while the SERVER says a
 * run is running (`lastRun.running`), at the bounded poll's period - the response that first reports the run finished carries the new data, so
 * "after a run completes" needs no invalidation of anything else.
 */
export function useDeviations(filter: DeviationFilter) {
  const poll = useBoundedPoll(DEVIATIONS_POLL_MS);
  return useQuery({
    queryKey: deviationsKey(filter),
    queryFn: () => getDeviations(filter),
    placeholderData: keepPreviousData,
    refetchOnWindowFocus: true,
    refetchInterval: (query) => poll(runningKey(query.state.data?.connections)),
  });
}

/**
 * The connections a dialog offers (`connections[]` of the deviations document, which every signed-in user may read, unlike the ADMIN-only registry):
 * the project page's bind dialog (`projectId`) and the Plan page's import (`workStreamId`). Nothing else of that document is used: the chips, the
 * Flags column and the bars come from the page's own view. Asked only while the dialog is open (`enabled`), so a page that never links or imports
 * anything never makes the request; a failed answer is the dialog's inline note with a Retry, never the page's. `null` = not answered yet.
 */
export function useJiraConnections(filter: Pick<DeviationFilter, "projectId" | "workStreamId">, enabled: boolean) {
  const query = useQuery({
    queryKey: ["jira", "deviations", "connections", filter],
    queryFn: () => getDeviations(filter),
    staleTime: 30_000,
    retry: false,
    enabled,
  });
  return { connections: query.data?.connections ?? null, failed: query.isError && query.data === undefined, retry: () => void query.refetch() };
}

/** The project page's bind dialog's connections (`useJiraConnections` for one project; a malformed id is never asked). */
export const useJiraLinks = (projectId: number, enabled: boolean) => useJiraConnections({ projectId }, enabled && Number.isInteger(projectId));

/** The Jira link of one program: the binding, the connection it goes through, the Jira key (the dialog's note names it) and whether the item is known gone. */
export type JiraProgramLink = { bindingId: number; connectionId: number; issueKey: string; gone: boolean };

/**
 * Every LINKED program (1.14: the Plan page's "Import from Jira…" on a program) and the connections, from ONE read
 * (`GET /views/deviations?level=PROGRAM&all=true`: at most one item per program, about 20; any signed-in user may read it). The response is small,
 * the READ is not: the server runs its full deviation computation over every binding before it filters the level, so each fetch costs about what
 * the Deviations page's own does. Hence `staleTime` 5 minutes and no refetch on window focus (a focus refetch on every Plan visit would repeat
 * that work for nothing); it still refreshes whenever a `["jira"]` query is invalidated (a bind, an unlink, an import, a refresh).
 * `links` is keyed by the program's id. The Plan page asks only while its view holds a program the caller may add a project to (`enabled`); a
 * failed read is silent there (the entry is simply absent) and is also the rooted dialog's source (`failed`, `retry`), so no second connections
 * request follows.
 */
export function useJiraProgramLinks(enabled: boolean) {
  const query = useQuery({
    queryKey: ["jira", "deviations", "links", { level: "PROGRAM" }],
    queryFn: () => getDeviations({ level: "PROGRAM", all: true }),
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    retry: false,
    enabled,
  });
  const links = useMemo(
    () =>
      new Map<number, JiraProgramLink>(
        (query.data?.items ?? [])
          .filter((item) => item.level === "PROGRAM")
          .map((item) => [item.node.id, { bindingId: item.bindingId, connectionId: item.connectionId, issueKey: item.jira.key, gone: item.jira.gone }] as const),
      ),
    [query.data],
  );
  return { links, connections: query.data?.connections ?? null, failed: query.isError && query.data === undefined, retry: () => void query.refetch() };
}
