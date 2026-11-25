import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { PlanView } from "../api/plan";
import { foldableKeys, toggledCollapsed, type NodeRow } from "../utils/planTree";
import { useStoredState } from "./useStoredState";

const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");

/**
 * The Plan page's folds, remembered per browser (`astrolabe.viewSettings.plan.collapsed`): the keys of the FOLDED nodes, so a first visit
 * shows everything open and a node nobody folded (a new one included) is open. A key of a node the plan no longer holds matches nothing and is
 * dropped the next time the user changes a fold. Each change is said through `announce` (the page's one polite status region); the toggled
 * button keeps its focus because its row never leaves the list.
 */
export function usePlanFolds(view: PlanView | undefined, announce: (text: string) => void) {
  const { t } = useTranslation();
  const [stored, setStored] = useStoredState<string[]>("plan.collapsed", [], isStringArray);
  const collapsed = useMemo(() => new Set(stored), [stored]);

  return {
    collapsed,
    /** Fold or unfold a node and say which it did and how much it holds. */
    toggle: (row: NodeRow) => {
      if (view === undefined) return;
      setStored(toggledCollapsed(view, collapsed, row.key));
      announce(
        row.expanded
          ? t("plan.announce.collapsed", { name: row.kind === "workStream" ? row.stream.name : row.program.name })
          : row.kind === "workStream"
            ? t("plan.announce.expandedStream", { name: row.stream.name, count: row.childCount })
            : t("plan.announce.expandedProgram", { name: row.program.name, count: row.childCount }),
      );
    },
    expandAll: () => {
      setStored([]);
      announce(t("plan.announce.expandedAll"));
    },
    collapseAll: () => {
      if (view === undefined) return;
      setStored(foldableKeys(view));
      announce(t("plan.announce.collapsedAll"));
    },
    /** Open nodes without a sentence: something was just created, moved or imported under them, and the user must see it. */
    expand: (...keys: string[]) => {
      if (view === undefined) return;
      const folded = keys.filter((key) => collapsed.has(key));
      if (folded.length === 0) return;
      const rest = toggledCollapsed(view, collapsed, folded[0]);
      setStored(rest.filter((key) => !folded.includes(key)));
    },
  };
}
