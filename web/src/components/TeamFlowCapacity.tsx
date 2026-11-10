import { useTranslation } from "react-i18next";
import { Group, Stack, Text } from "@mantine/core";
import type { CapacityDeviation, CapacityDeviationItem } from "../api/capacityDeviations";
import type { CapacityAcknowledge } from "../hooks/useCapacityAcknowledge";
import { capacityAckAllKey, capacityAckKey, countCapacityDeviations } from "../utils/capacityDeviations";
import { CapacityAckOrphanNotice } from "./CapacityAckCell";
import CapacityDeviationList from "./CapacityDeviationList";
import ErrorAlert from "./ErrorAlert";
import SeverityBadge from "./SeverityBadge";
import { Fact } from "./SyncFacts";

/**
 * What the team page knows of its capacity against Flow, from the Deviations document asked for this team alone: `rows` are the team's sprints
 * (an empty list = in line), `undefined` while the answer is on its way or failed (`failed`). A Flow team that left Flow's document
 * (`TEAM_GONE`) is already told by the panel's own "No longer in Flow" badge, so it adds nothing here. `failed` is true for any failed read,
 * also a re-read that keeps older `rows` (they stay, under the alert). `current` is whether the binding's connection is enabled and CURRENT: only then
 * may "no difference" be said as agreement. `item` is the team's own entry of the document (its binding and `can`, what the acknowledge needs); the
 * document asks for this team, so it lists the acknowledged rows too, each carrying its state.
 */
export type CapacityComparison = { rows: readonly CapacityDeviation[] | undefined; item: CapacityDeviationItem | undefined; failed: boolean; error: unknown; current: boolean };

function isGone(rows: readonly CapacityDeviation[]): boolean {
  return rows.some((row) => row.kind === "TEAM_GONE");
}

/**
 * The facts table's **Capacity vs Flow** row: an orange badge while the plan has more than Flow for some OPEN sprint, gray when it only has less, a
 * gray one for open sprints without capacity, green text when nothing differs. Acknowledged sprints do not count as open: a dimmed "· N acknowledged"
 * follows the badges, and with only acknowledged rows left the row reads "No open difference · N acknowledged" - never "In line with Flow", for the
 * figures still differ.
 */
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
  const { differs, warnings, missing, acknowledged } = countCapacityDeviations(rows);
  return (
    <Fact label={t("flow.panel.fact.capacity")}>
      {differs === 0 && missing === 0 ? (
        acknowledged > 0 ? (
          <Text size="sm" c="dimmed">
            {t("flow.panel.capacity.noneOpen", { count: acknowledged })}
          </Text>
        ) : current ? (
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
          {acknowledged > 0 && (
            <Text size="sm" c="dimmed">
              {t("flow.panel.capacity.acknowledged", { count: acknowledged })}
            </Text>
          )}
        </Group>
      )}
    </Fact>
  );
}

/**
 * Under the facts: the team's sprints in words, each with its acknowledge cell (the item's `can`; `ack` is the section's write) and, for whoever may
 * import, the one-click remedy; a failed comparison is the usual inline alert. A team whose Flow team is gone (`TEAM_GONE`, or the panel's `gone`) has no
 * sprint lines: only its own row is shown, with its cell, because the open row counts in the page header's flag and the manager silences it where they
 * plan. There is no import remedy for it.
 */
export function CapacityDetails({ comparison, canImport, ack, panelGone = false }: { comparison: CapacityComparison; canImport: boolean; ack: CapacityAcknowledge; panelGone?: boolean }) {
  const { t } = useTranslation();
  const { rows, item, failed, error } = comparison;
  const gone = rows !== undefined && isGone(rows);
  const shown = rows === undefined ? [] : gone ? rows.filter((row) => row.kind === "TEAM_GONE") : panelGone ? [] : rows;
  const showRows = shown.length > 0;
  if (!failed && !showRows) return null;
  return (
    <Stack gap="xs">
      {failed && <ErrorAlert error={error} title={t("flow.panel.capacity.loadFailed")} />}
      {showRows && item !== undefined && <CapacityAckOrphanNotice hook={ack} listedKeys={new Set([capacityAckAllKey(item.bindingId), ...shown.map((row) => capacityAckKey(item.bindingId, row.detail.sprintId))])} />}
      {showRows && <CapacityDeviationList deviations={shown} label={t("flow.panel.capacity.listAria")} ack={item === undefined ? undefined : { can: item.can, bindingId: item.bindingId, team: item.team.name, hook: ack }} />}
      {showRows && !gone && canImport && <Text size="sm">{t("flow.panel.capacity.fix")}</Text>}
    </Stack>
  );
}
