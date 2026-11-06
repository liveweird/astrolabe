import { useEffect } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { getDeviations, type DeviationConnection, type DeviationFilter } from "../api/deviations";
import { EMPTY_MARKS, jiraMarksOf, type JiraMarks } from "../utils/jiraMarks";
import { DEVIATIONS_POLL_MS } from "../utils/syncRuns";
import { useBoundedPoll } from "./useBoundedPoll";
import { isBoolean, useStoredState } from "./useStoredState";

/**
 * The deviations queries live under the `["jira"]` prefix (a bind, an unlink, a refresh and the connection page's mutations refresh it) and
 * under NO plan prefix: no timeline view query is ever invalidated by anything here.
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
 * The Jira links of one project (its own and its milestones') or one team (its milestones), for the chips and the link actions. A SEPARATE query
 * from the page's view: a failed or slow answer never touches the timeline (the marks stay empty and `answered` false, so the chip and the actions
 * do not show), and nothing waits for it. **The page view's plan `revision` is part of the key** (kept data shows meanwhile): any plan write - a drag
 * onto Jira's date, a milestone edit, a new schedule - bumps it and so re-reads the chip, without touching a single mutation hook. `connections` is
 * the document's `connections[]`, which the bind dialog reads instead of asking for itself.
 */
export function useJiraLinks(scope: { projectId: number } | { teamId: number }, enabled = true, revision: number | null = null) {
  const query = useQuery({
    queryKey: ["jira", "deviations", "chip", scope, revision],
    queryFn: () => getDeviations(scope),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    retry: false,
    enabled,
  });
  const marks: JiraMarks = query.data === undefined ? EMPTY_MARKS : jiraMarksOf(query.data);
  return { ...marks, failed: query.isError && query.data === undefined, retry: () => void query.refetch() };
}

/**
 * {@link useJiraLinks} for a page that renders a view document: asked once the view is in (never before, so it cannot delay the page), keyed by the
 * view's plan `revision`, and not at all for an id that is not a whole number (a malformed route).
 */
export function useViewJiraLinks(scope: { projectId: number } | { teamId: number }, view: { revision: number } | undefined) {
  return useJiraLinks(scope, view !== undefined && Object.values(scope).every(Number.isInteger), view?.revision ?? null);
}

/**
 * Whether the team timeline has its Jira column. The column exists while something is linked, but the answer comes from a separate query, so the
 * answer of the LAST visit (remembered per team) is what the first render uses: only a team's first visit - or a visit after the links changed -
 * can add or remove the column when the query answers; a repeat visit lays the table out once.
 */
export function useJiraColumn(teamId: number, links: { answered: boolean; byNode: ReadonlyMap<string, unknown> }): boolean {
  const [remembered, setRemembered] = useStoredState(`teams.jiraColumn.${teamId}`, false, isBoolean);
  const linked = links.byNode.size > 0;
  const shown = links.answered ? linked : remembered;
  useEffect(() => {
    // Persist the settled answer (a localStorage write; the state mirrors it).
    if (links.answered && remembered !== linked) setRemembered(linked);
  });
  return shown;
}
