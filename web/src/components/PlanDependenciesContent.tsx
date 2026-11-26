import { Badge, Button, Group, Stack, Text } from "@mantine/core";
import { IconLink } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import type { DependencyListView } from "../api/dependencyList";
import type { PlanDependencies } from "../hooks/usePlanDependencies";
import { narrowingCount, type DependencyListFilter } from "../utils/dependencyListFilters";
import DependencyAddModal from "./DependencyAddModal";
import DependencyDeleteModal from "./DependencyDeleteModal";
import DependencyEditorModal from "./DependencyEditorModal";
import DependencyListFilters from "./DependencyListFilters";
import DependencyListTable from "./DependencyListTable";
import EmptyState from "./EmptyState";
import ErrorAlert from "./ErrorAlert";
import LoadingBlock from "./LoadingBlock";

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
 * The body of the plan-wide dependency list, in the dependency panel and (1.29) in the Roadmap's and Programs' panel: the filters, the facts line, the
 * list or its empty states, the truncation note and the editor, add and delete dialogs (all over the `usePlanDependencies` state the host owns). The
 * host owns the filters' address spelling (`filter`, `onChange`, `onClear`) and its heading; "Add dependency" is the host's button over `state.setAdding`.
 */
export default function PlanDependenciesContent({
  state,
  filter,
  onChange,
  onClear,
}: {
  state: PlanDependencies;
  filter: DependencyListFilter;
  onChange: (patch: Partial<DependencyListFilter>) => void;
  onClear: () => void;
}) {
  const { t } = useTranslation();
  const { data, rows, isLoading, isError, error } = state;
  // An empty list is a claim about a READ: made only from an answer, never over a failed refresh, and never about a list the cap cut.
  const settled = data !== undefined && !isError;
  return (
    <Stack gap="md">
      <DependencyListFilters filter={filter} onChange={onChange} />

      {isError && <ErrorAlert error={error} title={t("dependencyList.loadFailed")} />}
      {isLoading && <LoadingBlock />}
      {data && data.totals.links > 0 && <DependencyListFacts totals={data.totals} />}

      {settled && data.totals.links === 0 && <EmptyState icon={IconLink} label={t("dependencyList.empty")} />}
      {settled && data.totals.links > 0 && rows.length === 0 && (
        <Stack gap="sm" align="center">
          {/* On a cut list the claim is only about the rows read, never "nothing matches"; the way out stays. */}
          <EmptyState icon={IconLink} label={data.truncated ? t("dependencyList.noMatchShown", { count: data.dependencies.length }) : t("dependencyList.noMatch")} />
          {narrowingCount(filter) > 0 && (
            <Button variant="default" size="compact-sm" onClick={onClear}>
              {t("dependencyList.clear")}
            </Button>
          )}
        </Stack>
      )}
      {data && rows.length > 0 && <DependencyListTable rows={rows} onEdit={state.setEditing} onDelete={state.onDelete} />}
      {data?.truncated && (
        <Text size="sm" c="dimmed">
          {t("dependencyList.truncated", { count: data.dependencies.length })}
        </Text>
      )}
      {state.editing && (
        <DependencyEditorModal
          project={null}
          target={state.editing}
          onClose={() => state.setEditing(null)}
          onSaved={async () => {
            state.setEditing(null);
            await state.refresh();
          }}
        />
      )}
      {state.adding && (
        <DependencyAddModal
          projects={state.addable}
          initialProjectId={filter.projectId ?? null}
          onClose={() => state.setAdding(false)}
          onSaved={async () => {
            state.setAdding(false);
            await state.refresh();
          }}
        />
      )}
      <DependencyDeleteModal confirm={state.removal} ownProjectId={null} />
    </Stack>
  );
}
