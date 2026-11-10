import { useQuery } from "@tanstack/react-query";
import { getCapacityDeviations } from "../api/capacityDeviations";
import { getDeviations } from "../api/deviations";

/** One source's OPEN counts (the views' `totals`, which count open rows whatever the list holds). */
export type OpenCounts = { warnings: number; infos: number };

/**
 * The Home page's two figures: the open Jira and Flow-capacity deviation counts, read from the two EXISTING views asked with `acknowledged=true`.
 * Their `totals` count the open rows by contract (every filter but the acknowledgement state), while the body then carries only the acknowledged
 * items - a few KB instead of the default list's hundreds. The keys sit under the `["jira"]` and `["flow"]` prefixes the refresh helpers
 * invalidate. `null` for a source = no connection to count (the view lists none): Home says nothing for it. `error` is the first failed read.
 */
export function useOpenDeviationCounts(): { jira: OpenCounts | null; flow: OpenCounts | null; error: unknown } {
  const jira = useQuery({ queryKey: ["jira", "deviations", "totals"], queryFn: () => getDeviations({ acknowledged: true }), staleTime: 60_000 });
  const flow = useQuery({ queryKey: ["flow", "deviations", "totals"], queryFn: () => getCapacityDeviations({ acknowledged: true }), staleTime: 60_000 });
  return {
    jira: jira.data && jira.data.connections.length > 0 ? { warnings: jira.data.totals.warnings, infos: jira.data.totals.infos } : null,
    flow: flow.data && flow.data.connections.length > 0 ? { warnings: flow.data.totals.warnings, infos: flow.data.totals.infos } : null,
    error: jira.error ?? flow.error,
  };
}
