import { useTranslation } from "react-i18next";
import { Select } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { getPlanView, planViewKey } from "../api/plan";
import { useTeamOptions } from "../hooks/useTeamOptions";
import { cascadePatch, narrowingCount, scheduleChoice, scheduledOf, type MilestoneFilter, type ScheduleChoice } from "../utils/milestoneFilters";
import { planParents } from "../utils/planNames";
import ClearableTextInput from "./ClearableTextInput";
import FilterPanel from "./FilterPanel";
import PlanFilterSelect from "./PlanFilterSelect";
import ProjectScopeChip from "./ProjectScopeChip";
import TeamFilterSelect from "./TeamFilterSelect";

const CHOICES: readonly ScheduleChoice[] = ["all", "unscheduled", "scheduled"];

/**
 * The Work stream, Program and Project selects (the plan view's three levels, read when the panel is open): each lists only the nodes under what is
 * picked above it, and a pick of a work stream or program drops an earlier pick outside it (`cascadePatch`, over the parents the same plan read gives).
 */
function ScopeSelects({ filter, onChange }: { filter: MilestoneFilter; onChange: (patch: Partial<MilestoneFilter>) => void }) {
  const plan = useQuery({ queryKey: planViewKey, queryFn: getPlanView });
  const parents = plan.data === undefined ? undefined : planParents(plan.data);
  const pick = (patch: Partial<MilestoneFilter>) => onChange(cascadePatch(filter, patch, parents));
  return (
    <>
      <PlanFilterSelect level="workStream" value={filter.workStreamId} onChange={(workStreamId) => pick({ workStreamId })} />
      <PlanFilterSelect level="program" value={filter.programId} onChange={(programId) => pick({ programId })} within={{ workStreamId: filter.workStreamId }} />
      <PlanFilterSelect
        level="project"
        value={filter.projectId}
        onChange={(projectId) => pick({ projectId })}
        within={{ workStreamId: filter.workStreamId, programId: filter.programId }}
      />
    </>
  );
}

/**
 * The Milestones page's filters, which live in the URL (`utils/milestoneFilters.ts`): the Schedule select (All / Not scheduled / Scheduled, never
 * clearable: a choice always applies), a team select (EVERY team, `useTeamOptions`), the work stream, program and project selects (the plan's, narrowing
 * one another) and the name search inside the collapsible panel; a `projectId` is also a removable chip beside the toggle, so the scope shows with the
 * panel closed (a work stream or program counts in the badge only). `name` is the text as typed; the page debounces it for the request.
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
      <ScopeSelects filter={filter} onChange={onChange} />
      <ClearableTextInput label={t("common.field.name")} value={name} onChange={onName} clearLabel={t("common.filter.clearName")} />
    </FilterPanel>
  );
}
