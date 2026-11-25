import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { PlanView } from "../api/plan";
import { foldableKeys, isSearching, NO_FILTER, toggledCollapsed, withFolds, type NodeRow, type PlanFilter } from "../utils/planTree";
import { useStoredState } from "./useStoredState";

const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");

const EMPTY: ReadonlySet<string> = new Set();

/**
 * The Plan page's folds, remembered per browser (`astrolabe.viewSettings.plan.collapsed`): the keys of the FOLDED nodes, so a first visit
 * shows everything open and a node nobody folded (a new one included) is open. A key of a node the plan no longer holds matches nothing and is
 * dropped the next time the user changes a fold. Each change is said through `announce` (the page's one polite status region); the toggled
 * button keeps its focus because its row never leaves the list.
 *
 * While a search or an owner narrows the tree the stored folds do not apply and are never touched: the rows start fully open (the way to every
 * match is open) and the user's folds go to a TRANSIENT set that starts afresh whenever the filter changes. Clearing the search brings the stored
 * folds back exactly as they were.
 */
export function usePlanFolds(view: PlanView | undefined, announce: (text: string) => void, filter: PlanFilter = NO_FILTER) {
  const { t } = useTranslation();
  const [stored, setStored] = useStoredState<string[]>("plan.collapsed", [], isStringArray);
  const storedSet = useMemo(() => new Set(stored), [stored]);
  const searching = isSearching(filter);

  // The transient folds belong to the filter they were made under: another filter starts them afresh (during render, effect-free).
  const filterKey = JSON.stringify(filter);
  const [transient, setTransient] = useState<{ key: string; folded: ReadonlySet<string> }>({ key: filterKey, folded: EMPTY });
  const folded = transient.key === filterKey ? transient.folded : EMPTY;
  if (transient.key !== filterKey) setTransient({ key: filterKey, folded: EMPTY });
  const setFolded = (next: Iterable<string>) => setTransient({ key: filterKey, folded: new Set(next) });

  const collapsed = searching ? folded : storedSet;

  return {
    collapsed,
    /** Fold or unfold a node and say which it did and how much it holds. */
    toggle: (row: NodeRow) => {
      if (view === undefined) return;
      if (searching) setFolded(toggledSet(folded, row.key));
      else setStored(toggledCollapsed(view, storedSet, row.key));
      announce(
        row.expanded
          ? t("plan.announce.collapsed", { name: row.kind === "workStream" ? row.stream.name : row.program.name })
          : row.kind === "workStream"
            ? t("plan.announce.expandedStream", { name: row.stream.name, count: row.childCount })
            : t("plan.announce.expandedProgram", { name: row.program.name, count: row.childCount }),
      );
    },
    // Both act on the SHOWN nodes only: a fold of a node the filter hides (a closed stream under Hide closed) is kept as it was.
    expandAll: () => {
      if (view === undefined) return;
      if (searching) setFolded([]);
      else setStored(filter.hideClosed ? withFolds(view, storedSet, { open: foldableKeys(view, filter) }) : []);
      announce(t("plan.announce.expandedAll"));
    },
    collapseAll: () => {
      if (view === undefined) return;
      if (searching) setFolded(foldableKeys(view, filter));
      else setStored(withFolds(view, storedSet, { fold: foldableKeys(view, filter) }));
      announce(t("plan.announce.collapsedAll"));
    },
    /** Open nodes without a sentence: something was just created, moved or imported under them, and the user must see it. */
    expand: (...keys: string[]) => {
      if (view === undefined) return;
      if (searching) {
        setFolded([...folded].filter((key) => !keys.includes(key)));
        return;
      }
      const closed = keys.filter((key) => storedSet.has(key));
      if (closed.length === 0) return;
      setStored(withFolds(view, storedSet, { open: closed }));
    },
  };
}

function toggledSet(set: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(set);
  if (!next.delete(key)) next.add(key);
  return next;
}
