import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { getJiraLinks, type JiraNodeLink } from "../api/jira";

/**
 * Every LINKED program and project and the connections, from ONE read (`GET /views/jira-links`, 1.15; any signed-in user may read it). It is two
 * statements on the server whatever the size of the plan, so the page asks on every visit that can use it: `staleTime` 30 s and the default focus
 * refetch (the 5 minutes of 1.14 went with the deviation computation it avoided). It lives under `["jira", "links"]`, so a bind, an unlink, an
 * import or a refresh (every `["jira"]` invalidation) re-reads it. `programs` / `projects` are keyed by the node's id. The Plan page asks only while
 * its view holds a row that could use a link (`enabled`; an optimisation, never the rule); a failed read is silent there (the entries are simply
 * absent) and is also the rooted dialog's source (`failed`, `retry`), so no second connections request follows.
 */
export function useJiraPlanLinks(enabled: boolean) {
  const query = useQuery({ queryKey: ["jira", "links"], queryFn: getJiraLinks, staleTime: 30_000, retry: false, enabled });
  const { programs, projects } = useMemo(() => {
    const links = query.data?.links ?? [];
    const byNode = (level: JiraNodeLink["level"]) => new Map<number, JiraNodeLink>(links.filter((link) => link.level === level).map((link) => [link.nodeId, link] as const));
    return { programs: byNode("PROGRAM"), projects: byNode("PROJECT") };
  }, [query.data]);
  return { programs, projects, connections: query.data?.connections ?? null, failed: query.isError && query.data === undefined, retry: () => void query.refetch() };
}
