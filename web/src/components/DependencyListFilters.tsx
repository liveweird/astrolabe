import { useTranslation } from "react-i18next";
import { Select } from "@mantine/core";
import { useTeamOptions } from "../hooks/useTeamOptions";
import { narrowingCount, type DependencyListFilter, type DependencyListStatus } from "../utils/dependencyListFilters";
import FilterPanel from "./FilterPanel";
import PlanFilterSelect from "./PlanFilterSelect";
import ProjectScopeChip from "./ProjectScopeChip";
import TeamFilterSelect from "./TeamFilterSelect";

type StatusChoice = "all" | DependencyListStatus;
const CHOICES: readonly StatusChoice[] = ["all", "violated", "ok", "unscheduled"];

/**
 * The dependency panel's filters, which live in the URL (`utils/dependencyListFilters.ts`): the Status select (All / Violated / OK / Not scheduled yet,
 * never clearable: a choice always applies), a team select (EVERY team, `useTeamOptions`) and a project select (every project of the plan) inside the
 * collapsible panel; a `projectId` is also a removable chip beside the toggle, so the scope shows with the panel closed. They only hide rows that arrived.
 */
export default function DependencyListFilters({ filter, onChange }: { filter: DependencyListFilter; onChange: (patch: Partial<DependencyListFilter>) => void }) {
  const { t } = useTranslation();
  const teams = useTeamOptions();
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
      <TeamFilterSelect teamId={filter.teamId} onChange={(teamId) => onChange({ teamId })} teams={teams.teams} settled={teams.settled} />
      <PlanFilterSelect level="project" value={filter.projectId} onChange={(projectId) => onChange({ projectId })} />
    </FilterPanel>
  );
}
