import { Stack, Table, Text, Title } from "@mantine/core";
import { useTranslation } from "react-i18next";
import type { TeamView } from "../api/teams";
import ScrollRegion from "./ScrollRegion";

const NO_WRAP = { whiteSpace: "nowrap" } as const;

/**
 * The capacity the picked baseline froze, beside the page's current Capacity table (1.26, under it): "was" next to "is", as the shadow bars
 * show "was" dates. The server's ranges as they arrive (each period to the day before the next, the last without end), read-only; nothing is
 * recomputed. `captured` false (a baseline taken before baselines froze capacity) is UNKNOWN: one dimmed note and no heading; captured with
 * no periods says the team had no capacity then.
 */
export default function TeamBaselineCapacity({ baseline }: { baseline: NonNullable<TeamView["baseline"]> }) {
  const { t } = useTranslation();
  const { name, capacity } = baseline;
  if (!capacity.captured) {
    return (
      <Text size="sm" c="dimmed">
        {t("teams.view.baselineCapacity.notCaptured", { name })}
      </Text>
    );
  }
  const label = t("teams.view.baselineCapacity.aria", { name });
  return (
    <Stack gap="xs">
      <Title order={4} size="h5">
        {t("teams.view.baselineCapacity.title", { name })}
      </Title>
      {capacity.periods.length === 0 ? (
        <Text size="sm" c="dimmed">
          {t("teams.view.baselineCapacity.none")}
        </Text>
      ) : (
        <ScrollRegion label={label} minWidth={520}>
          <Table aria-label={label}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t("teams.view.baselineCapacity.column.from")}</Table.Th>
                <Table.Th>{t("teams.view.baselineCapacity.column.to")}</Table.Th>
                <Table.Th>{t("teams.view.period.mdPerWeek")}</Table.Th>
                <Table.Th>{t("teams.view.period.wipLimit")}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {capacity.periods.map((period) => (
                <Table.Tr key={period.from}>
                  <Table.Td style={NO_WRAP}>{period.from}</Table.Td>
                  <Table.Td style={NO_WRAP}>{period.to ?? t("teams.view.baselineCapacity.openEnd")}</Table.Td>
                  <Table.Td>{period.mdPerWeek}</Table.Td>
                  <Table.Td>{period.wipLimit ?? "—"}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </ScrollRegion>
      )}
    </Stack>
  );
}
