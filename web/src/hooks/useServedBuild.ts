import { useQuery } from "@tanstack/react-query";
import { getServedBuild } from "../api/build";

const RECHECK_MS = 5 * 60_000;

/**
 * Whether the server now serves another build than the one this tab runs (the deploy check; the notice is
 * components/UpdateBanner.tsx). Checked on mount, when the tab regains focus (staleTime 0, so every return
 * re-checks) and every five minutes while visible. A check that fails says nothing: the query keeps its last
 * answer, so the notice does not blink. Off where the build has no commit (`unknown`: no git). The commit is
 * compared for inequality, so a rollback is announced too.
 */
export function useServedBuild(): { outdated: boolean } {
  const bundle = __APP_COMMIT__;
  const { data } = useQuery({
    queryKey: ["build"],
    queryFn: getServedBuild,
    enabled: bundle !== "unknown",
    retry: false,
    staleTime: 0, // explicit: every focus re-checks, whatever the app-wide default becomes
    refetchOnWindowFocus: true,
    refetchInterval: RECHECK_MS,
  });
  return { outdated: data !== undefined && data !== bundle };
}
