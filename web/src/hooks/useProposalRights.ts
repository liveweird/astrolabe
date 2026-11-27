import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { listProposalTeams } from "../api/scheduleProposals";

/** The one cache key of "the teams whose proposed moves the caller may accept". */
const PROPOSAL_TEAMS_KEY = ["schedule-proposals", "teams"] as const;

/**
 * What the viewer may accept of a cross-team run (1.33): every login previews one, but only the teams `GET /schedule-proposals/teams` lists
 * (an administrator's are all, a manager's their own) have moves the viewer may tick and accept. `acceptable` holds their ids (empty until
 * `ready`: a host asks for no run before then, so the first ticks are right). A FIRST load that fails degrades to a preview: `ready` with an
 * empty set and `error` set (the host may say so), so nothing is offered that the server has not said; a failed background refetch keeps the
 * last list and `ready`. The set keeps its identity until the list changes.
 */
export function useProposalRights(): { acceptable: ReadonlySet<number>; ready: boolean; error: Error | null } {
  const teams = useQuery({ queryKey: PROPOSAL_TEAMS_KEY, queryFn: listProposalTeams });
  const items = teams.data?.items;
  const acceptable = useMemo<ReadonlySet<number>>(() => new Set(items?.map((team) => team.id)), [items]);
  return { acceptable, ready: teams.data !== undefined || teams.isError, error: teams.error };
}
