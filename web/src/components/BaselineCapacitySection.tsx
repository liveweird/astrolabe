import { Badge, Group, Stack, Table, Text, Title } from "@mantine/core";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { BaselineCapacity, BaselineCapacityFigure } from "../api/baselines";
import ScrollRegion from "./ScrollRegion";

const NO_WRAP = { whiteSpace: "nowrap" } as const;
const TABLE_MAX_HEIGHT = 420;

/** A capacity figure in words (man-days per week and the WIP limit); null = no capacity in force, a figure of its own, not zero. */
function figureText(figure: BaselineCapacityFigure | null, t: TFunction): string {
  if (figure === null) return t("baselines.compare.capacity.noCapacity");
  return t(figure.wipLimit === null ? "baselines.compare.capacity.figureNoWip" : "baselines.compare.capacity.figure", { md: figure.mdPerWeek, wip: figure.wipLimit });
}

/**
 * The Capacity section of the comparison page (1.26, h3): per team, the maximal date ranges on which its capacity (man-days per week AND WIP
 * limit) differs between the baseline and now (or the other baseline) - the server's ranges, read as they arrive (to = null: no end). Only the
 * changed teams are listed (at most 2,000 change rows, `truncated` says so). The facts are information, so every badge is gray. `captured` false
 * is UNKNOWN, not "no capacity": a baseline taken before baselines froze capacity.
 */
export default function BaselineCapacitySection({ capacity, sides }: { capacity: BaselineCapacity; sides: { then: string; now: string } | null }) {
  const { t } = useTranslation();
  const tableLabel = t("baselines.compare.capacity.tableAria");
  return (
    <Stack gap="sm">
      <Title order={3} size="h4">
        {t("baselines.compare.capacity.title")}
      </Title>
      {!capacity.captured ? (
        <Text size="sm" c="dimmed">
          {t(sides === null ? "baselines.compare.capacity.notCaptured" : "baselines.compare.capacity.notCapturedAgainst")}
        </Text>
      ) : (
        <>
          <Text size="sm" c="dimmed">
            {t("baselines.compare.capacity.intro")}
          </Text>
          <Group gap="xs" wrap="wrap">
            <Badge color="gray" tt="none">
              {t("baselines.compare.capacity.totals", { changed: capacity.totals.changedTeams, total: capacity.totals.teams })}
            </Badge>
          </Group>
          {capacity.teams.length === 0 ? (
            <Text size="sm" c="dimmed">
              {t("baselines.compare.capacity.none")}
            </Text>
          ) : (
            <ScrollRegion label={tableLabel} minWidth={760} maxHeight={TABLE_MAX_HEIGHT}>
              <Table aria-label={tableLabel} stickyHeader>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>{t("baselines.compare.capacity.column.from")}</Table.Th>
                    <Table.Th>{t("baselines.compare.capacity.column.to")}</Table.Th>
                    <Table.Th>{sides === null ? t("baselines.compare.column.baseline") : t("baselines.compare.column.then", sides)}</Table.Th>
                    <Table.Th>{sides === null ? t("baselines.compare.column.current") : t("baselines.compare.column.now", sides)}</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                {/* One rowgroup per team: its name row heads the ranges under it. */}
                {capacity.teams.map((team) => (
                  <Table.Tbody key={team.teamId}>
                    <Table.Tr>
                      <Table.Th scope="rowgroup" colSpan={4}>
                        {team.teamName}
                      </Table.Th>
                    </Table.Tr>
                    {team.changes.map((change) => (
                      <Table.Tr key={change.from}>
                        <Table.Td style={NO_WRAP} ps="xl">
                          {change.from}
                        </Table.Td>
                        <Table.Td style={NO_WRAP}>{change.to ?? t("baselines.compare.capacity.openEnd")}</Table.Td>
                        <Table.Td>{figureText(change.then, t)}</Table.Td>
                        <Table.Td>{figureText(change.now, t)}</Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                ))}
              </Table>
            </ScrollRegion>
          )}
          {capacity.truncated && (
            <Text size="sm" c="dimmed" role="note">
              {t("baselines.compare.capacity.truncated", { count: capacity.teams.reduce((sum, team) => sum + team.changes.length, 0) })}
            </Text>
          )}
        </>
      )}
    </Stack>
  );
}
