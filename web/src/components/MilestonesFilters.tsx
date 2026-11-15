import { useTranslation } from "react-i18next";
import { Select } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { listTeams } from "../api/teams";
import { narrowingCount, scheduleChoice, scheduledOf, type MilestoneFilter, type ScheduleChoice } from "../utils/milestoneFilters";
import ClearableTextInput from "./ClearableTextInput";
import FilterPanel from "./FilterPanel";
import ProjectScopeChip from "./ProjectScopeChip";

const CHOICES: readonly ScheduleChoice[] = ["all", "unscheduled", "scheduled"];

/**
 * The Milestones page's filters, which live in the URL (`utils/milestoneFilters.ts`): the Schedule select (All / Not scheduled / Scheduled, never
 * clearable: a choice always applies), a team select (the teams list, the Deviations panel's options entry) and the name search inside the collapsible
 * panel; a `projectId` from a link is a removable chip beside the toggle. `name` is the text as typed; the page debounces it for the request.
 */
export default function MilestonesFilters({
  filter,
  name,
  onName,
  onChange,
}: {
  filter: MilestoneFilter;
  name: string;
  onName: (name: string) => void;
  onChange: (patch: Partial<MilestoneFilter>) => void;
}) {
  const { t } = useTranslation();
  const teams = useQuery({ queryKey: ["teams", "options"], queryFn: () => listTeams({ page: 1, pageSize: 100, sort: "name" }) });
  return (
    <FilterPanel
      activeFilterCount={narrowingCount(filter)}
      storageKey="milestones"
      aside={filter.projectId === undefined ? undefined : <ProjectScopeChip projectId={filter.projectId} onRemove={() => onChange({ projectId: undefined })} />}
    >
      <Select
        label={t("milestoneList.filter.schedule")}
        data={CHOICES.map((choice) => ({ value: choice, label: t(`milestoneList.schedule.${choice}`) }))}
        value={scheduleChoice(filter)}
        onChange={(selected) => selected !== null && onChange({ scheduled: scheduledOf(selected as ScheduleChoice) })}
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
      <ClearableTextInput label={t("common.field.name")} value={name} onChange={onName} clearLabel={t("common.filter.clearName")} />
    </FilterPanel>
  );
}
