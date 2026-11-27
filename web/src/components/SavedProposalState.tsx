import { Badge, Group, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import type { SavedProposalRecord } from "../api/savedProposals";

/**
 * The state line of a saved proposal on the Roadmap overview: the badge (green CURRENT, gray otherwise, never red: nothing here blocks), what the state means,
 * and the two reasons a CURRENT run still cannot be accepted here: it was computed for an earlier day (`outdated`), or the viewer may not
 * accept it. A FRESH run on screen is said to be the viewer's own, not the saved one.
 */
export default function SavedProposalState({ record, fresh, outdated, editable }: { record: SavedProposalRecord; fresh: boolean; outdated: boolean; editable: boolean }) {
  const { t } = useTranslation();
  const current = record.state === "CURRENT";
  return (
    <>
      <Group gap="sm" align="center" wrap="wrap">
        <Badge color={current ? "green" : "gray"} tt="none" data-state={record.state}>
          {t(`scheduleProposals.saved.state.${record.state}`)}
        </Badge>
        <Text size="sm" c="dimmed" role="note">
          {fresh ? t("scheduleProposals.saved.fresh") : t(`scheduleProposals.saved.stateNote.${record.state}`)}
        </Text>
      </Group>
      {current && outdated && !editable && (
        <Text size="sm" c="dimmed" role="note">
          {t("scheduleProposals.saved.outdated", { date: record.asOf })}
        </Text>
      )}
      {current && !record.can.accept && (
        <Text size="sm" c="dimmed" role="note">
          {t("scheduleProposals.saved.readOnly")}
        </Text>
      )}
    </>
  );
}
