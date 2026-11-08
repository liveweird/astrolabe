import { useTranslation } from "react-i18next";
import { Stack, Table, Text, Title } from "@mantine/core";
import type { FlowRoster } from "../api/flow";
import { formatDateTime } from "../utils/formatDate";
import ScrollRegion from "./ScrollRegion";
import TableDisclosure from "./TableDisclosure";

/**
 * The linked Flow team's observed roster (read from the mirror, display names and dates only - never an account id or an email): the current
 * members with the day each joined, the former ones behind a `TableDisclosure` ("N former members", from - to), and when the mirror last saw
 * the team. Information only: nothing here is a domain concept of Astrolabe, and a person with two intervals appears once per interval.
 * `roster` is null when the Flow team is gone from the mirror.
 */
export default function FlowRosterPanel({ roster, observedAt }: { roster: FlowRoster | null; observedAt: number | null }) {
  const { t } = useTranslation();
  const currentLabel = t("flow.roster.currentAria");
  const formerLabel = t("flow.roster.formerAria");
  return (
    <Stack gap="xs">
      <Title order={4} size="h5">
        {t("flow.roster.title")}
      </Title>
      {roster === null ? (
        <Text size="sm" c="dimmed">
          {t("flow.roster.unavailable")}
        </Text>
      ) : (
        <>
          {roster.current.length === 0 ? (
            <Text size="sm" c="dimmed">
              {t("flow.roster.noCurrent")}
            </Text>
          ) : (
            <ScrollRegion label={currentLabel} minWidth={360}>
              <Table aria-label={currentLabel}>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>{t("flow.roster.column.name")}</Table.Th>
                    <Table.Th>{t("flow.roster.column.since")}</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {roster.current.map((member, index) => (
                    // A person with two intervals is two rows: name + start is the identity, the index breaks a (never seen) tie.
                    <Table.Tr key={`${member.displayName}|${member.since}|${index}`}>
                      <Table.Td>{member.displayName}</Table.Td>
                      <Table.Td>{member.since}</Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </ScrollRegion>
          )}
          {roster.former.length > 0 && (
            <TableDisclosure showLabel={t("flow.roster.showFormer", { count: roster.former.length })} hideLabel={t("flow.roster.hideFormer", { count: roster.former.length })}>
              <ScrollRegion label={formerLabel} minWidth={420}>
                <Table aria-label={formerLabel}>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>{t("flow.roster.column.name")}</Table.Th>
                      <Table.Th>{t("flow.roster.column.from")}</Table.Th>
                      <Table.Th>{t("flow.roster.column.to")}</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {roster.former.map((member, index) => (
                      <Table.Tr key={`${member.displayName}|${member.from}|${index}`}>
                        <Table.Td>{member.displayName}</Table.Td>
                        <Table.Td>{member.from}</Table.Td>
                        <Table.Td>{member.to}</Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </ScrollRegion>
            </TableDisclosure>
          )}
        </>
      )}
      <Text size="xs" c="dimmed">
        {t("flow.roster.observedAt")}: {observedAt === null ? "—" : formatDateTime(observedAt)}
      </Text>
    </Stack>
  );
}
