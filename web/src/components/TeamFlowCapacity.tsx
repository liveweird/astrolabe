import { useTranslation } from "react-i18next";
import { Group, Stack, Text } from "@mantine/core";
import type { CapacityDeviation } from "../api/capacityDeviations";
import { countCapacityDeviations } from "../utils/capacityDeviations";
import CapacityDeviationList from "./CapacityDeviationList";
import ErrorAlert from "./ErrorAlert";
import SeverityBadge from "./SeverityBadge";
import { Fact } from "./SyncFacts";

/**
 * What the team page knows of its capacity against Flow, from the Deviations document asked for this team alone: `rows` are the team's sprints
 * (an empty list = in line), `undefined` while the answer is on its way or failed (`failed`). A Flow team that left Flow's document
 * (`TEAM_GONE`) is already told by the panel's own "No longer in Flow" badge, so it adds nothing here. `failed` is true for any failed read,
 * also a re-read that keeps older `rows` (they stay, under the alert). `current` is whether the binding's connection is enabled and CURRENT: only then
 * may "no difference" be said as agreement.
 */
export type CapacityComparison = { rows: readonly CapacityDeviation[] | undefined; failed: boolean; error: unknown; current: boolean };

function isGone(rows: readonly CapacityDeviation[]): boolean {
  return rows.some((row) => row.kind === "TEAM_GONE");
}

/** The facts table's **Capacity vs Flow** row: an orange badge while the plan has more than Flow for some sprint, gray when it only has less, a gray one for sprints without capacity, green text when nothing differs. */
export function CapacityFact({ comparison }: { comparison: CapacityComparison }) {
  const { t } = useTranslation();
  const { rows, failed, current } = comparison;
  if (rows === undefined ? failed : isGone(rows)) return null;
  if (rows === undefined) {
    return (
      <Fact label={t("flow.panel.fact.capacity")}>
        <Text size="sm" c="dimmed">
          {t("flow.panel.capacity.loading")}
        </Text>
      </Fact>
    );
  }
  const { differs, warnings, missing } = countCapacityDeviations(rows);
  return (
    <Fact label={t("flow.panel.fact.capacity")}>
      {differs === 0 && missing === 0 ? (
        current ? (
          // The AA-tested green ink of a light surface (`LIGHT_VARIANT_INKS`): Mantine's plain green text fails 4.5:1 on white.
          <Text size="sm" fw={500} style={{ color: "var(--mantine-color-green-light-color)" }}>
            {t("flow.panel.capacity.inLine")}
          </Text>
        ) : (
          // A disabled or not-CURRENT connection (or one that never mirrored) cannot vouch for agreement: only the absence of a difference in what was read.
          <Text size="sm" c="dimmed">
            {t("flow.panel.capacity.noneSoFar")}
          </Text>
        )
      ) : (
        <Group gap="xs" wrap="wrap">
          {differs > 0 && (
            <SeverityBadge severity={warnings > 0 ? "WARNING" : "INFO"}>{t("flow.panel.capacity.differs", { count: differs })}</SeverityBadge>
          )}
          {missing > 0 && (
            <SeverityBadge severity="INFO">{t("flow.panel.capacity.missing", { count: missing })}</SeverityBadge>
          )}
        </Group>
      )}
    </Fact>
  );
}

/** Under the facts: the team's sprints in words and, for whoever may import, the one-click remedy; a failed comparison is the usual inline alert. */
export function CapacityDetails({ comparison, canImport }: { comparison: CapacityComparison; canImport: boolean }) {
  const { t } = useTranslation();
  const { rows, failed, error } = comparison;
  const showRows = rows !== undefined && rows.length > 0 && !isGone(rows);
  if (!failed && !showRows) return null;
  return (
    <Stack gap="xs">
      {failed && <ErrorAlert error={error} title={t("flow.panel.capacity.loadFailed")} />}
      {showRows && <CapacityDeviationList deviations={rows} label={t("flow.panel.capacity.listAria")} />}
      {showRows && canImport && <Text size="sm">{t("flow.panel.capacity.fix")}</Text>}
    </Stack>
  );
}
