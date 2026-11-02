import { useEffect } from "react";
import { isUnknownBaseline } from "../api/baselines";
import { readStoredJson, useStoredState } from "./useStoredState";

/** A remembered pick is a baseline id (a positive integer) or `null`; anything else stored is ignored. */
const isPick = (value: unknown): value is number | null => value === null || (typeof value === "number" && Number.isInteger(value) && value > 0);

/** The stored key, shared by every timeline page (one pick, like `timeline.zoom`). */
const BASELINE_PICK_KEY = "timeline.baseline";

/**
 * The baseline the timeline pages compare with (v0.9): ONE browser-remembered pick for the project, team, roadmap and programs pages
 * (`localStorage` through `useStoredState`, best-effort: without storage the pick lives for the page only). `null` = no baseline, the default.
 * The page sends the stored id straight away (one fetch in the common case); {@link useDropUnknownPick} clears it when the server says the
 * baseline is gone.
 */
export function useBaselinePick(): { pick: number | null; setPick: (id: number | null) => void } {
  const [pick, setPick] = useStoredState<number | null>(BASELINE_PICK_KEY, null, isPick);
  return { pick, setPick };
}

/**
 * Clears the pick when the page's view answered the typed 400 `unknown-baseline` (the baseline was deleted since it was picked, here or
 * elsewhere). The view's query key carries the pick, so clearing it fetches the plain view: there is no loop, and `dropping` is true for the
 * render in between so the page shows "loading" instead of a flash of the error. Returns `dropping`.
 * Another tab may have changed the remembered pick meanwhile: the stored value is re-read first and `null` is written only if it still is the
 * deleted id - otherwise the page adopts what is stored (a stored value that is no usable id reads as no pick).
 */
export function useDropUnknownPick(error: unknown, pick: number | null, setPick: (id: number | null) => void): boolean {
  const dropping = pick !== null && isUnknownBaseline(error);
  useEffect(() => {
    if (!dropping) return;
    const stored = readStoredJson(BASELINE_PICK_KEY);
    setPick(stored === pick || !isPick(stored) ? null : stored);
  }, [dropping, pick, setPick]);
  return dropping;
}

/**
 * Every `baseline` overlay block of a document, however deep: the roadmap and programs views carry one on each project row (programs: also on
 * program and work stream nodes). Parts with no overlay inside keep their identity, so a plain placeholder copy is returned as it is.
 */
function withoutBaselines(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = value.map(withoutBaselines);
    return items.every((item, index) => item === value[index]) ? value : items;
  }
  if (typeof value !== "object" || value === null) return value;
  const entries = Object.entries(value);
  const kept = entries.flatMap(([key, child]) => (key === "baseline" ? [] : [[key, withoutBaselines(child)] as const]));
  const unchanged = kept.length === entries.length && kept.every(([key, child], index) => entries[index][0] === key && entries[index][1] === child);
  return unchanged ? value : Object.fromEntries(kept);
}

/**
 * The cached view WITHOUT any baseline overlay while it is only the previous pick's copy (`keepPreviousData` keeps the page mounted - and the
 * picker focused - while another pick loads, but every overlay in it belongs to the old pick: the top-level block and the project, program and
 * work stream blocks of the plan views). Anything else is returned as it is.
 */
export function withoutStaleOverlay<V extends { baseline?: unknown }>(data: V | undefined, placeholder: boolean): V | undefined {
  return data !== undefined && placeholder ? (withoutBaselines(data) as V) : data;
}
