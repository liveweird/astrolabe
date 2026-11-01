import { Stack, Table, Text, Title } from "@mantine/core";
import { useTranslation } from "react-i18next";
import type { IdleGap } from "../api/milestones";
import ScrollRegion from "./ScrollRegion";
import TableDisclosure from "./TableDisclosure";

const NO_WRAP = { whiteSpace: "nowrap" } as const;
const TABLE_MAX_HEIGHT = 420;

/**
 * The Idle gaps section of the project and the team page (v0.7): the ACCESSIBLE surface of the timeline's hatched `idle` bands. One table
 * row per gap the server lists (from, to, length in working days; the first and last dates are working days), behind a disclosure.
 * Information only: an idle gap is not a warning and nothing moves. `scope` only picks the intro sentence ("no milestone of this project"
 * / "of this team" is in progress).
 */
export default function IdleGaps({ gaps, scope }: { gaps: readonly IdleGap[]; scope: "project" | "team" }) {
  const { t } = useTranslation();
  return (
    <Stack gap="xs">
      <Title order={3} size="h4">
        {t("timeline.idle.title")}
      </Title>
      <Text size="sm" c="dimmed">
        {t(scope === "project" ? "timeline.idle.introProject" : "timeline.idle.introTeam")}
      </Text>
      {gaps.length === 0 ? (
        <Text c="dimmed">{t("timeline.idle.empty")}</Text>
      ) : (
        <TableDisclosure showLabel={t("timeline.idle.show")} hideLabel={t("timeline.idle.hide")}>
          <ScrollRegion label={t("timeline.idle.tableAria")} minWidth={360} maxHeight={TABLE_MAX_HEIGHT}>
            <Table aria-label={t("timeline.idle.tableAria")} stickyHeader>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t("timeline.idle.from")}</Table.Th>
                  <Table.Th>{t("timeline.idle.to")}</Table.Th>
                  <Table.Th>{t("timeline.idle.workingDays")}</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {gaps.map((gap) => (
                  <Table.Tr key={gap.start}>
                    <Table.Td style={NO_WRAP}>{gap.start}</Table.Td>
                    <Table.Td style={NO_WRAP}>{gap.end}</Table.Td>
                    <Table.Td>{gap.workingDays}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </ScrollRegion>
        </TableDisclosure>
      )}
    </Stack>
  );
}
