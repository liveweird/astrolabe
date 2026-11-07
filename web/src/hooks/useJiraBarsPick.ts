import { isBoolean, useStoredState } from "./useStoredState";

/** The stored key, shared by every timeline page (one choice, like `timeline.zoom` and `timeline.baseline`). */
const JIRA_BARS_KEY = "timeline.jiraBars";

/**
 * Whether the timeline pages draw the Jira shadow bar (1.3, the "Jira dates" toggle): ONE browser-remembered boolean shared by the four timeline pages (the
 * roadmap, programs, project and team pages), through `localStorage` and `useStoredState` (best-effort: without storage the choice lives
 * for the page only). **On by default**: seeing
 * Jira's dates beside the plan's is the point of the markers, and the bar is a thin outline; whoever finds it noisy hides it once. A stored value that
 * is not a boolean is ignored.
 */
export function useJiraBarsPick(): { shown: boolean; setShown: (next: boolean) => void } {
  const [shown, setShown] = useStoredState<boolean>(JIRA_BARS_KEY, true, isBoolean);
  return { shown, setShown };
}
