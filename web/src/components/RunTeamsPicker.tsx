import { Button, Group, MultiSelect } from "@mantine/core";
import { IconRestore } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { useTeamOptions } from "../hooks/useTeamOptions";
import { TOOLBAR_CONTROL_SIZE } from "../utils/timelineModel";

/**
 * The teams a schedule proposal is asked over (1.38), any active team (`useTeamOptions`): a searchable multi-select named "Teams in the run" (or by the `label` a page shows), and, only
 * while `value` differs from `defaultIds` as a set, a "Use this page's teams" reset that puts the defaults back. A team the settled list lacks (deleted since) stays in the field as "Team 12";
 * while the read is on its way a held id shows as "…" (nothing is said about a team from data that has not arrived), and as "Team 12" too once it has failed. A disabled picker has no reset. No page knowledge: the page owns `value` (`useRunTeams`).
 * A page may word it itself (`ariaLabel`, `placeholder`, `resetLabel`) and leave one team out of the options (`excludeId`: the team page's own team, always in its run).
 */
export default function RunTeamsPicker({
  value,
  onChange,
  defaultIds,
  disabled = false,
  label,
  ariaLabel,
  placeholder,
  resetLabel,
  excludeId,
}: {
  value: readonly number[];
  onChange: (ids: number[]) => void;
  defaultIds: readonly number[];
  disabled?: boolean;
  label?: string;
  ariaLabel?: string;
  placeholder?: string;
  resetLabel?: string;
  excludeId?: number;
}) {
  const { t } = useTranslation();
  const { teams, settled, failed } = useTeamOptions();
  const data = teams.filter((team) => team.id !== excludeId).map((team) => ({ value: String(team.id), label: team.name }));
  for (const id of value) {
    if (!teams.some((team) => team.id === id)) data.push({ value: String(id), label: settled || failed ? t("common.filter.teamUnknown", { id }) : "…" });
  }
  const differs = value.length !== defaultIds.length || value.some((id) => !defaultIds.includes(id));
  return (
    <Group gap="xs" align="center" wrap="wrap" style={{ flex: "1 1 16rem", minWidth: 0, maxWidth: "36rem" }}>
      <MultiSelect
        size={TOOLBAR_CONTROL_SIZE}
        style={{ flex: "1 1 14rem", minWidth: 0 }}
        label={label}
        aria-label={label === undefined ? (ariaLabel ?? t("common.runTeams.label")) : undefined}
        placeholder={value.length === 0 ? (placeholder ?? t("common.runTeams.placeholder")) : undefined}
        nothingFoundMessage={t("common.runTeams.none")}
        data={data}
        value={value.map(String)}
        onChange={(picked) => onChange(picked.map(Number))}
        disabled={disabled}
        searchable
        clearable
        clearButtonProps={{ "aria-label": t("common.runTeams.clear") }}
      />
      {differs && !disabled && (
        <Button variant="subtle" size="compact-sm" leftSection={<IconRestore size={14} />} onClick={() => onChange([...defaultIds])}>
          {resetLabel ?? t("common.runTeams.reset")}
        </Button>
      )}
    </Group>
  );
}
