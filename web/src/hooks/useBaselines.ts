import { useQuery } from "@tanstack/react-query";
import { listBaselines, type Baseline } from "../api/baselines";

/** The list's key, under the `["baselines"]` prefix a baseline write refreshes (the comparison view is `["baselines","view",id]`). */
export const BASELINES_LIST_KEY = ["baselines", "list"] as const;

/**
 * Another login's baseline reaches this client on the next refetch, so a copy is trusted for a minute only (the holiday dictionary's rule);
 * this client's own writes refresh it at once.
 */
const STALE_MS = 60 * 1000;

/** Stable between renders while the data is. */
const NONE: readonly Baseline[] = [];

/** What {@link useBaselines} answers. `failed` is true only when there is NO list to show (a failed refetch keeps the last copy); `error` is the latest failure either way. */
export type Baselines = {
  items: readonly Baseline[];
  can: { manage: boolean };
  loading: boolean;
  failed: boolean;
  error: unknown;
};

/**
 * The active baselines, newest first, as ONE cached query (the registry page and the timelines' picker share it). Never blocks a page: while
 * it loads — or if it failed — the list is empty and nobody may manage (the server's guard is the rule).
 */
export function useBaselines(): Baselines {
  const { data, isLoading, isError, error } = useQuery({ queryKey: BASELINES_LIST_KEY, queryFn: listBaselines, staleTime: STALE_MS });
  return { items: data?.items ?? NONE, can: { manage: data?.can.manage ?? false }, loading: isLoading, failed: isError && data === undefined, error: isError ? error : null };
}
