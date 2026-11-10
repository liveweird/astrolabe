import { useTranslation } from "react-i18next";
import { Box, Stack, Table, Text } from "@mantine/core";
import type { CapacityDeviation } from "../api/capacityDeviations";
import { capacityAckKey, capacityDeviationSentence, capacityEntries, capacityKindLabel, entryRows, formatMd, isOpen, type CapacityEntry } from "../utils/capacityDeviations";
import CapacityAckCell, { type CapacityAckContext } from "./CapacityAckCell";
import ScrollRegion from "./ScrollRegion";
import SeverityBadge from "./SeverityBadge";
import TableDisclosure from "./TableDisclosure";

/** How many lines of one team's list show before the rest goes behind a disclosure. */
const VISIBLE_ENTRIES = 5;

/** The keys of the rows beside `row` in the whole list, next first: where the focus goes if the row leaves the list after a write. */
type Neighbours = (row: CapacityDeviation) => readonly string[];

/** The sprints without capacity, one table row each: the sprint, its dates and Flow's figure, then (with the acknowledge) the row's acknowledgement. */
function MissingTable({ rows, ack, neighbours }: { rows: readonly CapacityDeviation[]; ack?: CapacityAckContext; neighbours: Neighbours }) {
  const { t } = useTranslation();
  const label = t("deviations.capacity.missingTableAria");
  return (
    <ScrollRegion label={label} minWidth={ack === undefined ? 420 : 640}>
      <Table aria-label={label}>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t("deviations.capacity.column.sprint")}</Table.Th>
            <Table.Th>{t("deviations.capacity.column.dates")}</Table.Th>
            <Table.Th ta="right">{t("deviations.capacity.column.flow")}</Table.Th>
            {ack !== undefined && <Table.Th>{t("deviations.capacity.column.acknowledgement")}</Table.Th>}
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {rows.map((row) => (
            <Table.Tr key={row.detail.sprintId ?? row.detail.start ?? "row"}>
              <Table.Td>{row.detail.sprintName ?? row.detail.sprintId ?? "—"}</Table.Td>
              <Table.Td>{row.detail.start === null || row.detail.end === null ? "—" : `${row.detail.start} – ${row.detail.end}`}</Table.Td>
              <Table.Td ta="right">{row.detail.flowMd === null ? "—" : formatMd(row.detail.flowMd)}</Table.Td>
              {ack !== undefined && (
                <Table.Td>
                  <CapacityAckCell row={row} ack={ack} neighbours={neighbours(row)} />
                </Table.Td>
              )}
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </ScrollRegion>
  );
}

/** One row's line: the severity badge, the sentence and (with the acknowledge) the cell under it. */
function RowLine({ deviation, ack, neighbours }: { deviation: CapacityDeviation; ack?: CapacityAckContext; neighbours: Neighbours }) {
  const { t } = useTranslation();
  return (
    <Stack gap={4} align="flex-start">
      <div>
        <SeverityBadge severity={deviation.severity} mr={6} dimmed={!isOpen(deviation)}>
          {capacityKindLabel(deviation.kind, t)}
        </SeverityBadge>
        <Text span size="sm">
          {capacityDeviationSentence(deviation, t)}
        </Text>
      </div>
      {ack !== undefined && <CapacityAckCell row={deviation} ack={ack} neighbours={neighbours(deviation)} />}
    </Stack>
  );
}

function Entry({ entry, ack, neighbours }: { entry: CapacityEntry; ack?: CapacityAckContext; neighbours: Neighbours }) {
  const { t } = useTranslation();
  if (entry.type === "row" || entry.rows.length === 1) {
    return <RowLine deviation={entry.type === "row" ? entry.deviation : entry.rows[0]} ack={ack} neighbours={neighbours} />;
  }
  // Up to ~25 identical "no capacity" sprints are ONE line (counting the OPEN ones); the sprints themselves are a table behind the disclosure.
  const open = entry.rows.filter(isOpen).length;
  const acknowledged = entry.rows.length - open;
  const summary =
    open === 0
      ? t("deviations.capacity.ack.missingSummaryAcknowledged", { count: entry.rows.length })
      : entry.from === null
        ? t("deviations.capacity.missingSummaryNoDate", { count: open })
        : t("deviations.capacity.missingSummary", { count: open, date: entry.from });
  return (
    <Stack gap={4} align="flex-start">
      <div>
        <SeverityBadge severity="INFO" mr={6} dimmed={open === 0}>
          {capacityKindLabel("CAPACITY_MISSING", t)}
        </SeverityBadge>
        <Text span size="sm">
          {summary}
        </Text>
        {open > 0 && acknowledged > 0 && (
          <Text span size="sm" c="dimmed">
            {` ${t("deviations.capacity.ack.acknowledgedCount", { count: acknowledged })}`}
          </Text>
        )}
      </div>
      <TableDisclosure showLabel={t("deviations.capacity.missingShow")} hideLabel={t("deviations.capacity.missingHide")}>
        <MissingTable rows={entry.rows} ack={ack} neighbours={neighbours} />
      </TableDisclosure>
    </Stack>
  );
}

function Lines({ entries, label, ack, neighbours }: { entries: readonly CapacityEntry[]; label?: string; ack?: CapacityAckContext; neighbours: Neighbours }) {
  return (
    // role="list": Safari/VoiceOver drops the list semantics of a `list-style: none` list otherwise.
    <Box component="ul" role="list" aria-label={label} m={0} p={0} style={{ listStyle: "none" }}>
      {entries.map((entry) => (
        <li key={entry.key} style={{ marginBottom: 6 }}>
          <Entry entry={entry} ack={ack} neighbours={neighbours} />
        </li>
      ))}
    </Box>
  );
}

/**
 * One team's capacity deviations as lines: warnings first, the sprints without capacity folded into one line behind a table disclosure, and
 * everything past the first {@link VISIBLE_ENTRIES} lines behind a second disclosure. Shared by the Deviations page's section and the team page's
 * Flow section; `label` names the list when it stands alone. With `ack` (the item's `can`, its binding and the write's state machine) every line
 * carries the acknowledge cell - for the folded sprints inside their table, whose summary counts the OPEN ones - and acknowledged rows read as such
 * (their severity badge goes gray: a current acknowledgement dims it, a stale one keeps its colour).
 */
export default function CapacityDeviationList({ deviations, label, ack }: { deviations: readonly CapacityDeviation[]; label?: string; ack?: CapacityAckContext }) {
  const { t } = useTranslation();
  const entries = capacityEntries(deviations);
  const rest = entries.slice(VISIBLE_ENTRIES);
  const order = entries.flatMap(entryRows).map((row) => capacityAckKey(ack?.bindingId ?? 0, row.detail.sprintId));
  const neighbours: Neighbours = (row) => {
    const at = order.indexOf(capacityAckKey(ack?.bindingId ?? 0, row.detail.sprintId));
    return [order[at + 1], order[at - 1]].filter((key): key is string => key !== undefined);
  };
  return (
    <Stack gap={6}>
      <Lines entries={entries.slice(0, VISIBLE_ENTRIES)} label={label} ack={ack} neighbours={neighbours} />
      {rest.length > 0 && (
        <TableDisclosure showLabel={t("deviations.capacity.moreShow", { n: rest.length })} hideLabel={t("deviations.capacity.moreHide", { n: rest.length })}>
          <Lines entries={rest} ack={ack} neighbours={neighbours} />
        </TableDisclosure>
      )}
    </Stack>
  );
}
