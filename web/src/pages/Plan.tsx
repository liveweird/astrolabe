import { useMemo, useRef } from "react";
import { Button, Stack, Text, VisuallyHidden } from "@mantine/core";
import { IconFilterOff, IconPlus, IconSitemap } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { getPlanView, planViewKey } from "../api/plan";
import EmptyState from "../components/EmptyState";
import ErrorAlert from "../components/ErrorAlert";
import FormErrorAlert from "../components/FormErrorAlert";
import LoadingBlock from "../components/LoadingBlock";
import PageHeader from "../components/PageHeader";
import PlanDialogs from "../components/PlanDialogs";
import PlanToolbar from "../components/PlanToolbar";
import PlanTree from "../components/PlanTree";
import { usePlanDialogs } from "../hooks/usePlanDialogs";
import { usePlanFilters } from "../hooks/usePlanFilters";
import { usePlanFolds } from "../hooks/usePlanFolds";
import { useStatusAnnouncer } from "../hooks/useStatusAnnouncer";
import { foldableKeys, isFiltered, planRows } from "../utils/planTree";

/**
 * The Plan page (`/plan`): the whole hierarchy work stream → program → project as ONE tree table, readable by everyone. What each row offers
 * comes from the server's `can:{}` flags in the view (the same arithmetic as the guards), never from the session's roles. This file only
 * composes: the filters in the address (`usePlanFilters`), the folds (`usePlanFolds`), the dialogs and their actions (`usePlanDialogs`), the table (`PlanTree`).
 */
export default function Plan() {
  const { t } = useTranslation();
  const { data, isLoading, isError, error } = useQuery({ queryKey: planViewKey, queryFn: getPlanView });
  const titleRef = useRef<HTMLHeadingElement>(null);
  // The page's one polite status region: a fold keeps the focus on its button, so this is what says the tree changed.
  const [status, announce] = useStatusAnnouncer();
  const filters = usePlanFilters(data, announce);
  const { filter } = filters;
  const folds = usePlanFolds(data, announce, filter);
  const dialogs = usePlanDialogs(data, titleRef, folds.expand);

  const rows = useMemo(() => (data ? planRows(data, folds.collapsed, filter) : []), [data, folds.collapsed, filter]);
  const filtered = isFiltered(filter);
  const canCreate = data?.can.createWorkStream ?? false;

  return (
    <Stack gap="md">
      <PageHeader
        titleRef={titleRef}
        title={t("plan.title")}
        description={t("plan.intro")}
        actions={
          canCreate && (
            <Button leftSection={<IconPlus size={16} />} onClick={dialogs.newWorkStream}>
              {t("plan.newWorkStream")}
            </Button>
          )
        }
      />

      {isError && <ErrorAlert error={error} title={t("plan.loadFailed")} />}
      {dialogs.closeError !== null && <FormErrorAlert>{dialogs.closeError}</FormErrorAlert>}

      {isLoading && <LoadingBlock />}
      {data && data.workStreams.length === 0 && (
        <EmptyState icon={IconSitemap} label={t("plan.empty")} hint={canCreate ? t("plan.emptyHintCreate") : t("plan.emptyHint")} />
      )}
      {data && data.workStreams.length > 0 && (
        <>
          <PlanToolbar filters={filters} canFold={foldableKeys(data, filter).length > 0} onExpandAll={folds.expandAll} onCollapseAll={folds.collapseAll} />
          {/* On paper only: a filtered plan says so, so nobody takes the printed rows for the whole plan. */}
          {filtered && (
            <Text size="sm" data-print="only">
              {t("plan.print.filtered")}
            </Text>
          )}
          {rows.length === 0 ? (
            <EmptyState
              icon={IconFilterOff}
              label={t("plan.filter.none")}
              hint={t("plan.filter.noneHint")}
              action={
                <Button variant="default" size="xs" onClick={filters.clear}>
                  {t("plan.filter.clear")}
                </Button>
              }
            />
          ) : (
            <PlanTree rows={rows} actions={dialogs.actions} highlight={filter.q} onToggle={folds.toggle} />
          )}
        </>
      )}
      <VisuallyHidden role="status" aria-live="polite">
        {status}
      </VisuallyHidden>

      <PlanDialogs model={dialogs.model} />
    </Stack>
  );
}
