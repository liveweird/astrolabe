import { useTranslation } from "react-i18next";
import { Box, Stack, Table, Text } from "@mantine/core";
import type { CapacityDeviation } from "../api/capacityDeviations";
import { capacityDeviationSentence, capacityEntries, capacityKindLabel, formatMd, type CapacityEntry } from "../utils/capacityDeviations";
import ScrollRegion from "./ScrollRegion";
import SeverityBadge from "./SeverityBadge";
import TableDisclosure from "./TableDisclosure";

/** How many lines of one team's list show before the rest goes behind a disclosure. */
const VISIBLE_ENTRIES = 5;

/** The sprints without capacity, one table row each: the sprint, its dates and Flow's figure. */
function MissingTable({ rows }: { rows: readonly CapacityDeviation[] }) {
  const { t } = useTranslation();
  const label = t("deviations.capacity.missingTableAria");
  return (
    <ScrollRegion label={label} minWidth={420}>
      <Table aria-label={label}>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t("deviations.capacity.column.sprint")}</Table.Th>
            <Table.Th>{t("deviations.capacity.column.dates")}</Table.Th>
            <Table.Th ta="right">{t("deviations.capacity.column.flow")}</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {rows.map(({ detail }) => (
            <Table.Tr key={detail.sprintId ?? detail.start ?? "row"}>
              <Table.Td>{detail.sprintName ?? detail.sprintId ?? "—"}</Table.Td>
              <Table.Td>{detail.start === null || detail.end === null ? "—" : `${detail.start} – ${detail.end}`}</Table.Td>
              <Table.Td ta="right">{detail.flowMd === null ? "—" : formatMd(detail.flowMd)}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </ScrollRegion>
  );
}

function Entry({ entry }: { entry: CapacityEntry }) {
  const { t } = useTranslation();
  if (entry.type === "row" || entry.rows.length === 1) {
    const deviation = entry.type === "row" ? entry.deviation : entry.rows[0];
    return (
      <div>
        <SeverityBadge severity={deviation.severity} mr={6}>
          {capacityKindLabel(deviation.kind, t)}
        </SeverityBadge>
        <Text span size="sm">
          {capacityDeviationSentence(deviation, t)}
        </Text>
      </div>
    );
  }
  // Up to ~25 identical "no capacity" sprints are ONE line; the sprints themselves are a table behind the disclosure.
  const count = entry.rows.length;
  return (
    <Stack gap={4} align="flex-start">
      <div>
        <SeverityBadge severity="INFO" mr={6}>
          {capacityKindLabel("CAPACITY_MISSING", t)}
        </SeverityBadge>
        <Text span size="sm">
          {entry.from === null ? t("deviations.capacity.missingSummaryNoDate", { count }) : t("deviations.capacity.missingSummary", { count, date: entry.from })}
        </Text>
      </div>
      <TableDisclosure showLabel={t("deviations.capacity.missingShow")} hideLabel={t("deviations.capacity.missingHide")}>
        <MissingTable rows={entry.rows} />
      </TableDisclosure>
    </Stack>
  );
}

function Lines({ entries, label }: { entries: readonly CapacityEntry[]; label?: string }) {
  return (
    // role="list": Safari/VoiceOver drops the list semantics of a `list-style: none` list otherwise.
    <Box component="ul" role="list" aria-label={label} m={0} p={0} style={{ listStyle: "none" }}>
      {entries.map((entry) => (
        <li key={entry.key} style={{ marginBottom: 6 }}>
          <Entry entry={entry} />
        </li>
      ))}
    </Box>
  );
}

/**
 * One team's capacity deviations as lines: warnings first, the sprints without capacity folded into one line behind a table disclosure, and
 * everything past the first {@link VISIBLE_ENTRIES} lines behind a second disclosure. Shared by the Deviations page's section and the team page's
 * Flow section; `label` names the list when it stands alone.
 */
export default function CapacityDeviationList({ deviations, label }: { deviations: readonly CapacityDeviation[]; label?: string }) {
  const { t } = useTranslation();
  const entries = capacityEntries(deviations);
  const rest = entries.slice(VISIBLE_ENTRIES);
  return (
    <Stack gap={6}>
      <Lines entries={entries.slice(0, VISIBLE_ENTRIES)} label={label} />
      {rest.length > 0 && (
        <TableDisclosure showLabel={t("deviations.capacity.moreShow", { n: rest.length })} hideLabel={t("deviations.capacity.moreHide", { n: rest.length })}>
          <Lines entries={rest} />
        </TableDisclosure>
      )}
    </Stack>
  );
}
