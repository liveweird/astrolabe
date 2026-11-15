import { useTranslation } from "react-i18next";
import { Select } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { listTeams } from "../api/teams";
import { narrowingCount, type DependencyListFilter, type DependencyListStatus } from "../utils/dependencyListFilters";
import FilterPanel from "./FilterPanel";
import ProjectScopeChip from "./ProjectScopeChip";

type StatusChoice = "all" | DependencyListStatus;
const CHOICES: readonly StatusChoice[] = ["all", "violated", "ok", "unscheduled"];

/**
 * The Dependencies page's filters, which live in the URL (`utils/dependencyListFilters.ts`): the Status select (All / Violated / OK / Not scheduled yet,
 * never clearable: a choice always applies) and a team select (the Milestones page's options read) inside the collapsible panel; a `projectId` from a
 * link is a removable chip beside the toggle. They only hide rows that arrived.
 */
export default function DependencyListFilters({ filter, onChange }: { filter: DependencyListFilter; onChange: (patch: Partial<DependencyListFilter>) => void }) {
  const { t } = useTranslation();
  const teams = useQuery({ queryKey: ["teams", "options"], queryFn: () => listTeams({ page: 1, pageSize: 100, sort: "name" }) });
  const labels: Record<StatusChoice, string> = {
    all: t("dependencyList.status.all"),
    violated: t("dependencyList.status.violated"),
    ok: t("project.dependency.status.ok"),
    unscheduled: t("project.dependency.status.unscheduled"),
  };
  return (
    <FilterPanel
      activeFilterCount={narrowingCount(filter)}
      storageKey="dependencyList"
      aside={filter.projectId === undefined ? undefined : <ProjectScopeChip projectId={filter.projectId} onRemove={() => onChange({ projectId: undefined })} />}
    >
      <Select
        label={t("project.dependency.column.status")}
        data={CHOICES.map((choice) => ({ value: choice, label: labels[choice] }))}
        value={filter.status ?? "all"}
        onChange={(selected) => selected !== null && onChange({ status: selected === "all" ? undefined : (selected as DependencyListStatus) })}
        allowDeselect={false}
      />
      <Select
        label={t("roadmap.filter.team")}
        placeholder={t("common.state.any")}
        data={(teams.data?.items ?? []).map((team) => ({ value: String(team.id), label: team.name }))}
        value={filter.teamId === undefined ? null : String(filter.teamId)}
        onChange={(selected) => onChange({ teamId: selected === null ? undefined : Number(selected) })}
        searchable
        clearable
        clearButtonProps={{ "aria-label": t("roadmap.filter.clearTeam") }}
      />
    </FilterPanel>
  );
}
