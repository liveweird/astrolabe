import { isBoolean, useStoredState } from "./useStoredState";

/** The stored key, shared by the project page and the team page (ONE remembered choice, like `timeline.zoom` and `timeline.jiraBars`). */
const CRITICAL_PATH_KEY = "timeline.criticalPath";

/**
 * Whether a timeline page draws the critical path (v0.7 on the project page, 1.7 on the team page): the Slack column, the bar and arrow emphasis and, on
 * the project page, the badges and the Critical chain section. ONE browser-remembered boolean, off by default; a stored value that is not a boolean is ignored.
 */
export function useCriticalPathPick(): { shown: boolean; setShown: (next: boolean) => void } {
  const [shown, setShown] = useStoredState<boolean>(CRITICAL_PATH_KEY, false, isBoolean);
  return { shown, setShown };
}
