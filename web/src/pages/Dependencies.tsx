import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import { Badge, Button, Group, Stack, Text } from "@mantine/core";
import { IconLink, IconPlus } from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { DEPENDENCY_LIST_KEY, getDependencyListView, type DependencyListView } from "../api/dependencyList";
import { deleteDependency } from "../api/dependencies";
import { getPlanView, planViewKey } from "../api/plan";
import { useDeleteConfirm } from "../hooks/useDeleteConfirm";
import { useDialogFocus } from "../hooks/useDialogFocus";
import { refreshQueriesAfterMutation } from "../utils/queryRefresh";
import { addableProjects } from "../utils/dependencyForm";
import { resolveDependencyList, type DependencyListRow } from "../utils/dependencyListRows";
import DependencyAddModal from "../components/DependencyAddModal";
import DependencyDeleteModal from "../components/DependencyDeleteModal";
import DependencyEditorModal from "../components/DependencyEditorModal";
import DependencyListFilters from "../components/DependencyListFilters";
import DependencyListTable from "../components/DependencyListTable";
import EmptyState from "../components/EmptyState";
import ErrorAlert from "../components/ErrorAlert";
import LoadingBlock from "../components/LoadingBlock";
import PageHeader from "../components/PageHeader";
import {
  dependencyListFilterParams,
  matchesDependencyFilter,
  narrowingCount,
  parseDependencyListFilter,
  type DependencyListFilter,
} from "../utils/dependencyListFilters";

/**
 * The document with its names joined onto the rows, in the query function so the cache holds the resolved list. A reference the lists do not hold throws
 * here, which is the query's error (the inline alert; an earlier answer's rows stay). Not a `select`: a throwing `select` over a kept document makes TanStack
 * Query 5.105 re-render without end (its error result carries a fresh `errorUpdatedAt` each time).
 */
async function readDependencyList() {
  return resolveDependencyList(await getDependencyListView());
}

/** The facts line: the totals exactly as the server counted them over EVERY dependency (never recounted from the rows a filter or the cap left); a zero figure is no claim, so its badge is absent. */
function DependencyListFacts({ totals }: { totals: DependencyListView["totals"] }) {
  const { t } = useTranslation();
  return (
    <Group gap="md" role="group" aria-label={t("dependencyList.factsAria")}>
      <Text size="sm">{t("dependencyList.facts.links", { count: totals.links })}</Text>
      {totals.violated > 0 && (
        <Badge color="red" tt="none">
          {t("home.roadmap.conflicts", { count: totals.violated })}
        </Badge>
      )}
      {totals.unscheduled > 0 && (
        <Badge color="gray" tt="none">
          {t("dependencyList.facts.unscheduled", { count: totals.unscheduled })}
        </Badge>
      )}
    </Group>
  );
}

/**
 * The Dependencies page (`/dependencies`, everyone; changes by the row's `can`): every dependency of the plan from the one unpaged `GET /views/dependencies` (at most
 * 1,000 rows, the ones that do not hold first, each the project view's own item; the document names each end once, and the query function joins
 * the names back onto the rows - a reference it cannot resolve is a failed read). The status, team and project filters are in the URL
 * (`utils/dependencyListFilters.ts`; a change `replace`s the entry, so Home's and the plan pages' links, a reload and Back all restore the view) and only
 * hide rows in the browser: the facts line always shows the server's totals over every dependency. A row's menu (by the row's `can`, 1.22) opens the
 * project page's own editor (the type and the lag; the ends are read-only and each names its project) or its delete confirmation; a save or a
 * delete refreshes the plan and the roadmap groups. "Add dependency" (1.27) is in the header for whoever the plan view lets add to at least one
 * project (`can.createDependency`); its dialog offers only those projects as the successor's, any project or milestone as the predecessor. The
 * button is absent, never disabled, while the plan view is unread or failed or nothing in it may be added to; the new link may be hidden by the
 * filters or cut by the row cap, which the page does not change.
 */
export default function Dependencies() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const filter = parseDependencyListFilter(params);
  const { data, isLoading, isError, error } = useQuery({ queryKey: DEPENDENCY_LIST_KEY, queryFn: readDependencyList });
  const queryClient = useQueryClient();
  const titleRef = useRef<HTMLHeadingElement>(null);
  const [editing, setEditing] = useState<DependencyListRow | null>(null);
  const [adding, setAdding] = useState(false);
  const plan = useQuery({ queryKey: planViewKey, queryFn: getPlanView });
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
    focusAfterDelete: titleRef,
  });
  useDialogFocus(editing !== null || adding);
  // A stable callback for the memoized rows: `requestDelete` is a new function each render (it only touches setters and refs, so the latest is always right).
  const requestDelete = useRef(removal.requestDelete);
  useEffect(() => {
    requestDelete.current = removal.requestDelete;
  });
  const onDelete = useCallback((row: DependencyListRow) => requestDelete.current(row), []);

  const change = (patch: Partial<DependencyListFilter>) => setParams(dependencyListFilterParams({ ...filter, ...patch }), { replace: true });
  const rows = (data?.dependencies ?? []).filter((row) => matchesDependencyFilter(row, filter));
  // An empty list is a claim about a READ: made only from an answer, never over a failed refresh, and never about a list the cap cut.
  const settled = data !== undefined && !isError;

  return (
    <Stack gap="md">
      <PageHeader
        title={t("dependencyList.title")}
        description={t("dependencyList.intro")}
        titleRef={titleRef}
        actions={
          canAdd && (
            <Button leftSection={<IconPlus size={16} />} onClick={() => setAdding(true)}>
              {t("project.dependency.add")}
            </Button>
          )
        }
      />

      <DependencyListFilters filter={filter} onChange={change} />

      {isError && <ErrorAlert error={error} title={t("dependencyList.loadFailed")} />}
      {isLoading && <LoadingBlock />}
      {data && data.totals.links > 0 && <DependencyListFacts totals={data.totals} />}

      {settled && data.totals.links === 0 && <EmptyState icon={IconLink} label={t("dependencyList.empty")} />}
      {settled && data.totals.links > 0 && rows.length === 0 && (
        <Stack gap="sm" align="center">
          {/* On a cut list the claim is only about the rows read, never "nothing matches"; the way out stays. */}
          <EmptyState
            icon={IconLink}
            label={
              data.truncated
                ? t("dependencyList.noMatchShown", { count: data.dependencies.length })
                : t("dependencyList.noMatch")
            }
          />
          {narrowingCount(filter) > 0 && (
            <Button variant="default" size="compact-sm" onClick={() => setParams(new URLSearchParams(), { replace: true })}>
              {t("milestoneList.clear")}
            </Button>
          )}
        </Stack>
      )}
      {data && rows.length > 0 && <DependencyListTable rows={rows} onEdit={setEditing} onDelete={onDelete} />}
      {data?.truncated && (
        <Text size="sm" c="dimmed">
          {t("dependencyList.truncated", { count: data.dependencies.length })}
        </Text>
      )}
      {editing && (
        <DependencyEditorModal
          project={null}
          target={editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await refresh();
          }}
        />
      )}
      {adding && (
        <DependencyAddModal
          projects={addable}
          initialProjectId={filter.projectId ?? null}
          onClose={() => setAdding(false)}
          onSaved={async () => {
            setAdding(false);
            await refresh();
          }}
        />
      )}
      <DependencyDeleteModal confirm={removal} ownProjectId={null} />
    </Stack>
  );
}
