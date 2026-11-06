import type { DeviationConnection, DeviationItem, DeviationView } from "../api/deviations";
import { countDeviations, staleConnection } from "./deviations";

/** What a page shows of one linked plan node: its Jira key (with the connection's site for the link) and its deviations by severity. */
export type JiraMark = {
  bindingId: number;
  connectionId: number;
  key: string;
  siteUrl: string | null;
  warnings: number;
  infos: number;
  gone: boolean;
};

/** `PROJECT:7` / `MILESTONE:12`: a node's key in a {@link JiraMarks} map. */
export const markKey = (level: DeviationItem["level"], nodeId: number) => `${level}:${nodeId}`;

export type JiraMarks = {
  byNode: ReadonlyMap<string, JiraMark>;
  /** The server's totals over the filtered bindings (a project's or team's list also holds the ones with no deviation). */
  warnings: number;
  infos: number;
  /** The query has answered (a failed or pending one has not): the chip and the link actions wait for it. */
  answered: boolean;
  /** What the marks show may be out of date: a connection one of the marked items uses is disabled, its mapping does not fit or its newest run did not succeed. */
  stale: boolean;
  /** The document's `connections[]` (every active connection), for the bind dialog; null before it has answered. */
  connections: readonly DeviationConnection[] | null;
};

/** Nothing linked (or nothing known yet): what a page shows while its separate deviations query is loading or has failed. */
export const EMPTY_MARKS: JiraMarks = { byNode: new Map(), warnings: 0, infos: 0, answered: false, stale: false, connections: null };

/** One mark per linked node of a `?projectId=` / `?teamId=` deviations document (at most one binding per node). */
export function jiraMarksOf(view: DeviationView): JiraMarks {
  const sites = new Map(view.connections.map((connection) => [connection.id, connection.siteUrl]));
  const byNode = new Map<string, JiraMark>();
  for (const item of view.items) {
    const { warnings, infos } = countDeviations(item.deviations);
    byNode.set(markKey(item.level, item.node.id), {
      bindingId: item.bindingId,
      connectionId: item.connectionId,
      key: item.jira.key,
      siteUrl: sites.get(item.connectionId) ?? null,
      warnings,
      infos,
      gone: item.jira.gone,
    });
  }
  const used = new Set(view.items.map((item) => item.connectionId));
  const stale = view.connections.some((connection) => used.has(connection.id) && staleConnection(connection));
  return { byNode, warnings: view.totals.warnings, infos: view.totals.infos, answered: true, stale, connections: view.connections };
}
