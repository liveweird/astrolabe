import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { listTeams } from "../api/teams";
import SearchPicker, { type PickedOption } from "./SearchPicker";

/**
 * A searchable, clearable picker over the teams registry (`GET /teams` is open to every signed-in user): a milestone's one team,
 * the team whose manager schedules it. Options read the team's name; the caller holds the pick (its label survives later searches).
 */
export default function TeamSelect({
  label,
  description,
  picked,
  onPick,
  disabled,
  error,
}: {
  /** Replaces the milestone editor's field label / hint where the team means something else (the import's default team). */
  label?: string;
  description?: string;
  picked: PickedOption | null;
  onPick: (picked: PickedOption | null) => void;
  disabled?: boolean;
  /** A field error (a validation or a server answer the form maps onto this control). */
  error?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <SearchPicker
      label={label ?? t("common.field.team")}
      description={description ?? t("project.milestone.teamHint")}
      placeholder={t("project.milestone.pickTeam")}
      clearLabel={t("project.milestone.clearTeam")}
      noMatchLabel={t("project.milestone.noMatchingTeams")}
      queryKey={["teams", "picker"]}
      search={async (term) => {
        const page = await listTeams({ page: 1, pageSize: 50, sort: "name", name: term || undefined });
        return page.items.map((team) => ({ value: String(team.id), label: team.name }));
      }}
      picked={picked}
      onPick={onPick}
      disabled={disabled}
      error={error}
    />
  );
}
