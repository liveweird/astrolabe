import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import { Button, Stack } from "@mantine/core";
import { IconPlus } from "@tabler/icons-react";
import PageHeader from "../components/PageHeader";
import PlanDependenciesContent from "../components/PlanDependenciesContent";
import { usePlanDependencies } from "../hooks/usePlanDependencies";
import { dependencyListFilterParams, parseDependencyListFilter, type DependencyListFilter } from "../utils/dependencyListFilters";

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
 *
 * Since 1.29 the body is `PlanDependenciesContent` over `usePlanDependencies`, the same pieces the Roadmap's and Programs' panel (`PlanDependenciesPanel`)
 * mounts; this page is the always-open host with the page's own parameter names, until the panel replaces it.
 */
export default function Dependencies() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const filter = parseDependencyListFilter(params);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const state = usePlanDependencies({ filter, enabled: true, focusAfterDelete: titleRef });
  const change = (patch: Partial<DependencyListFilter>) => setParams(dependencyListFilterParams({ ...filter, ...patch }), { replace: true });

  return (
    <Stack gap="md">
      <PageHeader
        title={t("dependencyList.title")}
        description={t("dependencyList.intro")}
        titleRef={titleRef}
        actions={
          state.canAdd && (
            <Button leftSection={<IconPlus size={16} />} onClick={() => state.setAdding(true)}>
              {t("project.dependency.add")}
            </Button>
          )
        }
      />
      <PlanDependenciesContent state={state} filter={filter} onChange={change} onClear={() => setParams(new URLSearchParams(), { replace: true })} />
    </Stack>
  );
}
