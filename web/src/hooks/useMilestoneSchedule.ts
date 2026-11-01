import { getProjectView } from "../api/milestones";
import { applySchedule } from "../utils/projectViewUpdate";
import { useScheduleWritePath } from "./useScheduleWritePath";

/** The cache key of one project's view — under the `["plan"]` prefix, so the Plan page's refresh also refreshes a mounted project view. */
const projectViewKey = (projectId: number) => ["plan", "project", projectId] as const;

/**
 * The project view's data and its ONE schedule write path: the generic `useScheduleWritePath` (which documents the optimistic update,
 * the revision, the stale 409 and the refusal while a save runs) over `GET /views/project/{id}` and `applySchedule`.
 */
export function useMilestoneSchedule(projectId: number) {
  return useScheduleWritePath({
    queryKey: projectViewKey(projectId),
    queryFn: () => getProjectView(projectId),
    apply: applySchedule,
    enabled: Number.isInteger(projectId),
    writeKey: ["plan", "project-write", projectId],
  });
}
