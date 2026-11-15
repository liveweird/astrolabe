import { useTranslation } from "react-i18next";
import { Select } from "@mantine/core";
import { useTeamOptions } from "../hooks/useTeamOptions";
import { narrowingCount, scheduleChoice, scheduledOf, type MilestoneFilter, type ScheduleChoice } from "../utils/milestoneFilters";
import ClearableTextInput from "./ClearableTextInput";
import FilterPanel from "./FilterPanel";
import ProjectFilterSelect from "./ProjectFilterSelect";
import ProjectScopeChip from "./ProjectScopeChip";
import TeamFilterSelect from "./TeamFilterSelect";

const CHOICES: readonly ScheduleChoice[] = ["all", "unscheduled", "scheduled"];

/**
 * The Milestones page's filters, which live in the URL (`utils/milestoneFilters.ts`): the Schedule select (All / Not scheduled / Scheduled, never
 * clearable: a choice always applies), a team select (EVERY team, `useTeamOptions`), a project select (every project of the plan) and the name search
 * inside the collapsible panel; a `projectId` is also a removable chip beside the toggle, so the scope shows with the panel closed. `name` is the text as typed; the page debounces it for the request.
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
  const teams = useTeamOptions();
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
      <TeamFilterSelect teamId={filter.teamId} onChange={(teamId) => onChange({ teamId })} teams={teams.teams} settled={teams.settled} />
      <ProjectFilterSelect projectId={filter.projectId} onChange={(projectId) => onChange({ projectId })} />
      <ClearableTextInput label={t("common.field.name")} value={name} onChange={onName} clearLabel={t("common.filter.clearName")} />
    </FilterPanel>
  );
}
