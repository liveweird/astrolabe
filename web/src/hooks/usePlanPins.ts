import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { PlanView } from "../api/plan";
import { livePins, pinnedFoldKey, rootOfFold, pinnedRows, withPinnedFolds, withPins, type PinnedRow } from "../utils/planPins";
import { rowName, type NodeRow, type PlanTreeRow } from "../utils/planTree";
import { foldSentence } from "./usePlanFolds";
import { isBoolean, useStoredState } from "./useStoredState";

const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");

/**
 * The Plan page's pins, remembered in this browser: `astrolabe.viewSettings.plan.pins` (the pinned node keys, in the order they were pinned),
 * `plan.pinnedCollapsed` (composite `root>key` folds INSIDE the pinned section, apart from the tree's) and `plan.pinnedOpen` (the section's own fold,
 * open by default). A pin whose node is gone matches nothing and draws nothing; storage is pruned only when the user changes a pin, with a settled
 * view in hand (never by an effect, never during a failed load). Each pin, unpin and fold is said through `announce`.
 */
export function usePlanPins(view: PlanView | undefined, announce: (text: string) => void) {
  const { t } = useTranslation();
  const [stored, setStored] = useStoredState<string[]>("plan.pins", [], isStringArray);
  const [foldedStored, setFolded] = useStoredState<string[]>("plan.pinnedCollapsed", [], isStringArray);
  const [open, setOpen] = useStoredState<boolean>("plan.pinnedOpen", true, isBoolean);
  const folded = useMemo(() => new Set(foldedStored), [foldedStored]);
  const roots = useMemo(() => (view === undefined ? [] : livePins(view, stored)), [view, stored]);
  const rows: PinnedRow[] = useMemo(() => (view === undefined ? [] : pinnedRows(view, roots, folded)), [view, roots, folded]);
  const pinned = useMemo(() => new Set(roots), [roots]);

  /** Stores the pins after a change by the user; the folds of a root that is no longer pinned go with it (a later pin of it starts open). */
  const store = (next: string[]) => {
    setStored(next);
    const kept = foldedStored.filter((composite) => next.includes(rootOfFold(composite)));
    if (kept.length !== foldedStored.length) setFolded(kept);
  };

  return {
    /** The pinned roots that still exist, in pin order. */
    roots,
    /** The keys of those roots, for the pin marker and the menu's Pin / Unpin. */
    pinned,
    rows,
    open,
    setOpen,
    pin: (row: PlanTreeRow) => {
      if (view === undefined) return;
      store(withPins(view, stored, { add: row.key }));
      // A folded section would hide the new pin: pinning opens it.
      setOpen(true);
      announce(t("plan.pin.announcePinned", { name: rowName(row) }));
    },
    unpin: (key: string, name: string) => {
      if (view === undefined) return;
      store(withPins(view, stored, { remove: key }));
      announce(t("plan.pin.announceUnpinned", { name }));
    },
    /** Fold or unfold a node INSIDE a pinned subtree (its own set, never the tree's). */
    toggleFold: (row: NodeRow & { root: string }) => {
      if (view === undefined) return;
      setFolded(withPinnedFolds(view, folded, { toggle: pinnedFoldKey(row.root, row.key) }));
      announce(foldSentence(t, row));
    },
  };
}
