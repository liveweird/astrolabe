import { Box, Button, Group, Select, Switch } from "@mantine/core";
import { IconArrowsMaximize, IconArrowsMinimize } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import type { usePlanFilters } from "../hooks/usePlanFilters";
import { MAX_QUERY } from "../utils/planTreeParams";
import ClearableTextInput from "./ClearableTextInput";
import FilterPanel from "./FilterPanel";

/**
 * The strip above the plan table: the name search beside the Filters toggle (owner and "Hide closed" inside its panel), and Expand all / Collapse all
 * (the folds themselves are `usePlanFolds`, the filters `usePlanFilters`, which lives in the address). It is no content, so it does not print.
 */
export default function PlanToolbar({
  filters,
  canFold,
  onExpandAll,
  onCollapseAll,
}: {
  filters: ReturnType<typeof usePlanFilters>;
  /** Some node has children, so there is something to fold. */
  canFold: boolean;
  onExpandAll: () => void;
  onCollapseAll: () => void;
}) {
  const { t } = useTranslation();
  const { filter } = filters;
  return (
    <Group gap="sm" justify="space-between" align="flex-start" wrap="wrap" data-print="hide">
      <FilterPanel
        activeFilterCount={filters.activeCount}
        storageKey="plan"
        aside={
          <Box w={{ base: "100%", xs: 360 }}>
            <ClearableTextInput hideLabel inputRef={filters.searchRef} maxLength={MAX_QUERY} label={t("plan.filter.search")} placeholder={t("plan.filter.search")} clearLabel={t("plan.filter.clearSearch")} value={filters.typed} onChange={filters.setQuery} />
          </Box>
        }
      >
        <Select
          label={t("plan.filter.owner")}
          placeholder={t("common.state.any")}
          data={filters.owners.map((owner) => ({ value: String(owner.id), label: owner.name }))}
          value={filter.ownerPersonId === null ? null : String(filter.ownerPersonId)}
          onChange={(value) => filters.setOwner(value === null ? null : Number(value))}
          searchable
          clearable
          clearButtonProps={{ "aria-label": t("plan.filter.clearOwner") }}
        />
        <Switch label={t("plan.filter.hideClosed")} checked={filter.hideClosed} onChange={(event) => filters.setHideClosed(event.currentTarget.checked)} pb={6} />
      </FilterPanel>
      {canFold && (
        <Group gap="xs">
          <Button variant="default" size="xs" leftSection={<IconArrowsMaximize size={14} />} onClick={onExpandAll}>
            {t("plan.tree.expandAll")}
          </Button>
          <Button variant="default" size="xs" leftSection={<IconArrowsMinimize size={14} />} onClick={onCollapseAll}>
            {t("plan.tree.collapseAll")}
          </Button>
        </Group>
      )}
    </Group>
  );
}
