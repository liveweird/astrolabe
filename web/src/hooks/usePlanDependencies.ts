import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { deleteDependency } from "../api/dependencies";
import { DEPENDENCY_LIST_KEY, getDependencyListView } from "../api/dependencyList";
import { getPlanView, planViewKey } from "../api/plan";
import { addableProjects } from "../utils/dependencyForm";
import { matchesDependencyFilter, type DependencyListFilter } from "../utils/dependencyListFilters";
import { resolveDependencyList, type DependencyListRow } from "../utils/dependencyListRows";
import { refreshQueriesAfterMutation } from "../utils/queryRefresh";
import { useDeleteConfirm } from "./useDeleteConfirm";
import { useDialogFocus } from "./useDialogFocus";

/**
 * The document with its names joined onto the rows, in the query function so the cache holds the resolved list. A reference the lists do not hold throws
 * here, which is the query's error (the inline alert; an earlier answer's rows stay). Not a `select`: a throwing `select` over a kept document makes TanStack
 * Query 5.105 re-render without end (its error result carries a fresh `errorUpdatedAt` each time).
 */
async function readDependencyList() {
  return resolveDependencyList(await getDependencyListView());
}

/**
 * The state of the plan-wide dependency list, used by the Roadmap's dependency panel (both modes): the ONE unpaged
 * `GET /views/dependencies` and the plan view (for who may add), the rows the filters keep, the editor, the add dialog and the delete confirmation.
 * `enabled: false` (a closed panel) reads nothing. A save or a delete refreshes the plan and the roadmap groups (`["roadmap"]` holds the Roadmap's and the
 * Programs' views, so their arrows follow); `focusAfterDelete` is the heading the host owns.
 */
export function usePlanDependencies({ filter, enabled, focusAfterDelete }: { filter: DependencyListFilter; enabled: boolean; focusAfterDelete: RefObject<HTMLElement | null> }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const list = useQuery({ queryKey: DEPENDENCY_LIST_KEY, queryFn: readDependencyList, enabled });
  const plan = useQuery({ queryKey: planViewKey, queryFn: getPlanView, enabled });
  const [editing, setEditing] = useState<DependencyListRow | null>(null);
  const [adding, setAdding] = useState(false);
  const addable = useMemo(() => addableProjects(plan.data), [plan.data]);
  // A failed refresh of the plan view keeps the last document: whether the caller may add is then no claim, so no button.
  const canAdd = addable.length > 0 && !plan.isError;
  const refresh = () => refreshQueriesAfterMutation(queryClient, ["plan"], ["roadmap"]);
  // The delete flow is declared before the editor's focus hook, as it always was; since 1.23 the order no longer matters: the editor's watch
  // ends when the focus enters the delete confirmation (`useDialogFocus`), so a delete made within seconds of a save is never answered by it.
  const removal = useDeleteConfirm<DependencyListRow>({
    mutationFn: (row) => deleteDependency(row.id),
    onSuccess: refresh,
    successMessage: t("project.toast.dependencyDeleted"),
    focusAfterDelete,
  });
  useDialogFocus(editing !== null || adding);
  // A stable callback for the memoized rows: `requestDelete` is a new function each render (it only touches setters and refs, so the latest is always right).
  const requestDelete = useRef(removal.requestDelete);
  useEffect(() => {
    requestDelete.current = removal.requestDelete;
  });
  const onDelete = useCallback((row: DependencyListRow) => requestDelete.current(row), []);

  const data = list.data;
  const rows = (data?.dependencies ?? []).filter((row) => matchesDependencyFilter(row, filter));
  return {
    data,
    isLoading: list.isLoading,
    isError: list.isError,
    error: list.error,
    rows,
    addable,
    canAdd,
    editing,
    setEditing,
    adding,
    setAdding,
    removal,
    onDelete,
    refresh,
  };
}

export type PlanDependencies = ReturnType<typeof usePlanDependencies>;
