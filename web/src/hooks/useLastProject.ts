import { useEffect } from "react";
import { readStoredJson, writeStoredJson } from "./useStoredState";

/** The view-settings key of the project `/projects` opens (`astrolabe.viewSettings.projects.last`): an id, or absent. */
const LAST_PROJECT_KEY = "projects.last";

/** The remembered project id, or `null` when none is stored or the stored value is not an id. */
export function readLastProject(): number | null {
  const stored = readStoredJson(LAST_PROJECT_KEY);
  return typeof stored === "number" && Number.isInteger(stored) && stored > 0 ? stored : null;
}

/** Forgets the remembered project, but only when it is `id` (a bare `/projects` that finds it gone, a project deleted from its own page). */
export function forgetLastProject(id: number): void {
  if (readLastProject() === id) writeStoredJson(LAST_PROJECT_KEY, null);
}

/** Remembers `id` once its page has loaded (any way in: the picker, a link, the address): a project that does not exist is never remembered. */
export function useRememberProject(id: number, loaded: boolean): void {
  useEffect(() => {
    if (loaded) writeStoredJson(LAST_PROJECT_KEY, id);
  }, [id, loaded]);
}
