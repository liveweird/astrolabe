import { MultiSelect, Select, Switch } from "@mantine/core";
import { useTranslation } from "react-i18next";
import type { RoadmapView } from "../api/roadmap";
import { ownerOptions, programOptions, workStreamOptions, type NamedId, type RoadmapFilters } from "../utils/roadmapRows";

const toOptions = (options: readonly NamedId[]) => options.map((option) => ({ value: String(option.id), label: option.name }));

/**
 * The fields of the roadmap's filter panel: work stream, team (a project matches when it has milestones on the team), owner, "flagged only" and
 * the program pick (a multi-select, empty = every program; the key is shared with the programs page). The page keeps the state and the persistence;
 * the options come from the view, so they only offer what the plan has.
 */
export default function RoadmapFilterFields({
  view,
  filters,
  onFilters,
  pick,
  onPick,
}: {
  view: RoadmapView;
  filters: RoadmapFilters;
  onFilters: (change: Partial<RoadmapFilters>) => void;
  /** The ids of the picked programs that still exist. */
  pick: readonly number[];
  onPick: (ids: number[]) => void;
}) {
  const { t } = useTranslation();
  const programs = programOptions(view);
  const sameName = (name: string) => programs.filter((program) => program.name === name).length > 1;
  const idOf = (value: string | null) => (value === null ? null : Number(value));
  return (
    <>
      <MultiSelect
        label={t("roadmap.filter.programs")}
        placeholder={pick.length === 0 ? t("roadmap.filter.allPrograms") : undefined}
        data={programs.map((program) => ({ value: String(program.id), label: sameName(program.name) ? `${program.name} (${program.workStreamName})` : program.name }))}
        value={pick.map(String)}
        onChange={(values) => onPick(values.map(Number))}
        searchable
        clearable
        clearButtonProps={{ "aria-label": t("roadmap.filter.clearPrograms") }}
        miw={220}
      />
      <Select
        label={t("roadmap.filter.workStream")}
        placeholder={t("common.state.any")}
        data={toOptions(workStreamOptions(view))}
        value={filters.workStreamId === null ? null : String(filters.workStreamId)}
        onChange={(value) => onFilters({ workStreamId: idOf(value) })}
        searchable
        clearable
        clearButtonProps={{ "aria-label": t("roadmap.filter.clearWorkStream") }}
      />
      <Select
        label={t("roadmap.filter.team")}
        placeholder={t("common.state.any")}
        data={toOptions(view.teams)}
        value={filters.teamId === null ? null : String(filters.teamId)}
        onChange={(value) => onFilters({ teamId: idOf(value) })}
        searchable
        clearable
        clearButtonProps={{ "aria-label": t("roadmap.filter.clearTeam") }}
      />
      <Select
        label={t("roadmap.filter.owner")}
        placeholder={t("common.state.any")}
        data={toOptions(ownerOptions(view))}
        value={filters.ownerPersonId === null ? null : String(filters.ownerPersonId)}
        onChange={(value) => onFilters({ ownerPersonId: idOf(value) })}
        searchable
        clearable
        clearButtonProps={{ "aria-label": t("roadmap.filter.clearOwner") }}
      />
      <Switch label={t("roadmap.filter.flaggedOnly")} checked={filters.flaggedOnly} onChange={(event) => onFilters({ flaggedOnly: event.currentTarget.checked })} pb={6} />
    </>
  );
}
