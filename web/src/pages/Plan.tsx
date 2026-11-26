import { useMemo, useRef, type CSSProperties } from "react";
import { Button, Stack, Text, VisuallyHidden } from "@mantine/core";
import { useElementSize } from "@mantine/hooks";
import { IconFilterOff, IconPlus, IconSitemap } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { getPlanView, planViewKey } from "../api/plan";
import EmptyState from "../components/EmptyState";
import ErrorAlert from "../components/ErrorAlert";
import FormErrorAlert from "../components/FormErrorAlert";
import LoadingBlock from "../components/LoadingBlock";
import PageHeader from "../components/PageHeader";
import PlanBreadcrumb, { type Crumb } from "../components/PlanBreadcrumb";
import PlanDialogs from "../components/PlanDialogs";
import PlanPinned from "../components/PlanPinned";
import PlanToolbar from "../components/PlanToolbar";
import PlanTree from "../components/PlanTree";
import { usePlanDialogs } from "../hooks/usePlanDialogs";
import { usePlanFilters } from "../hooks/usePlanFilters";
import { usePlanFocusReturn } from "../hooks/usePlanFocusReturn";
import { usePlanFolds } from "../hooks/usePlanFolds";
import { usePlanPins } from "../hooks/usePlanPins";
import { useStatusAnnouncer } from "../hooks/useStatusAnnouncer";
import type { PlanViewActions } from "../utils/planActions";
import { isPlainClick } from "../utils/planLinks";
import { focusTrail, foldableKeys, isFiltered, planRows, type NodeRow } from "../utils/planTree";

/**
 * The Plan page (`/plan`): the whole hierarchy work stream → program → project as ONE tree table, readable by everyone. What each row offers
 * comes from the server's `can:{}` flags in the view (the same arithmetic as the guards), never from the session's roles. This file only
 * composes: the filters and the focus in the address (`usePlanFilters`), the folds (`usePlanFolds`), the pins (`usePlanPins`), the dialogs and their
 * actions (`usePlanDialogs`), the pinned section, the breadcrumb and the table.
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
  const pins = usePlanPins(data, announce);
  const returnFocus = usePlanFocusReturn(titleRef, filters.address);
  const dialogs = usePlanDialogs(data, titleRef, folds.expand);
  // The sticky pinned section covers the top of the page: the tree's rows keep clear of it when they take the focus (`scroll-margin-top`).
  const { ref: pinnedRef, height: pinnedHeight } = useElementSize<HTMLDivElement>();

  const rows = useMemo(() => (data ? planRows(data, folds.collapsed, filter) : []), [data, folds.collapsed, filter]);
  const trail = useMemo(() => (data ? focusTrail(data, filter.focus) : []), [data, filter.focus]);
  const canCreate = data?.can.createWorkStream ?? false;
  const filtered = isFiltered(filter);

  const nodeFocus = (row: NodeRow) => ({ kind: row.kind, id: row.kind === "workStream" ? row.stream.id : row.program.id });
  const nameOf = (row: NodeRow) => (row.kind === "workStream" ? row.stream.name : row.program.name);
  const view: PlanViewActions = {
    isPinned: (key) => pins.pinned.has(key),
    pin: pins.pin,
    unpin: pins.unpin,
    releasePin: (key, name) => {
      returnFocus.afterUnpin(pins.roots, key);
      pins.unpin(key, name);
    },
    focusHref: (row) => filters.focusHref(nodeFocus(row)),
    focused: (row, event) => {
      if (isPlainClick(event)) announce(t("plan.focus.announce", { name: nameOf(row) }));
    },
  };
  // The way back up from a focus: each step is a link, says where it went, and sends the focus to the row of the node it left.
  // Whichever step is followed, the focus goes back to the row of the node the user is leaving: the deepest step of the trail.
  const left = trail[trail.length - 1];
  const crumbs: Crumb[] = trail.map((step, index) => ({
    key: step.key,
    name: step.name,
    href: index === trail.length - 1 ? null : filters.focusHref({ kind: step.kind, id: step.id }),
    onFollow: (event) => {
      if (!isPlainClick(event)) return;
      announce(t("plan.focus.announce", { name: step.name }));
      returnFocus.afterRow(left.key);
    },
  }));

  return (
    <Stack gap="md" style={{ "--plan-pinned-height": `${pins.roots.length > 0 ? pinnedHeight : 0}px` } as CSSProperties}>
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
          {trail.length > 0 && (
            <PlanBreadcrumb
              allHref={filters.focusHref(null)}
              onAll={(event) => {
                if (!isPlainClick(event)) return;
                announce(t("plan.focus.announceAll"));
                returnFocus.afterRow(left.key);
              }}
              trail={crumbs}
            />
          )}
          {pins.roots.length > 0 && (
            <PlanPinned
              outerRef={pinnedRef}
              rows={pins.rows}
              count={pins.roots.length}
              open={pins.open}
              onOpen={pins.setOpen}
              actions={dialogs.actions}
              view={view}
              onToggle={pins.toggleFold}
            />
          )}
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
            <PlanTree rows={rows} actions={dialogs.actions} view={view} highlight={filter.q} onToggle={folds.toggle} />
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
