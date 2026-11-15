import { useTranslation } from "react-i18next";
import { Select } from "@mantine/core";
import type { TeamOption } from "../hooks/useTeamOptions";

/**
 * The Team select of the list pages' filter panels (Milestones, Dependencies): every team (`useTeamOptions`, which the panel calls where its read
 * starts), searchable and clearable, `undefined` = any. A `teamId` from a link that the settled list does not hold is one more option, "Team 12",
 * so the field is never blank over a filtered list; while the read runs or after it failed there is no such option (nothing is said about a team
 * from data that has not arrived).
 */
export default function TeamFilterSelect({
  teamId,
  onChange,
  teams,
  settled,
}: {
  teamId: number | undefined;
  onChange: (teamId: number | undefined) => void;
  teams: readonly TeamOption[];
  settled: boolean;
}) {
  const { t } = useTranslation();
  const data = teams.map((team) => ({ value: String(team.id), label: team.name }));
  if (teamId !== undefined && settled && !teams.some((team) => team.id === teamId)) {
    data.push({ value: String(teamId), label: t("common.filter.teamUnknown", { id: teamId }) });
  }
  return (
    <Select
      label={t("roadmap.filter.team")}
      placeholder={t("common.state.any")}
      data={data}
      value={teamId === undefined ? null : String(teamId)}
      onChange={(selected) => onChange(selected === null ? undefined : Number(selected))}
      searchable
      clearable
      clearButtonProps={{ "aria-label": t("roadmap.filter.clearTeam") }}
    />
  );
}
