import { Badge, Group, Stack, Table, Text, Title } from "@mantine/core";
import { useTranslation } from "react-i18next";
import type { WeekLoad } from "../api/teams";
import { isoWeekOf, toEpochDay } from "../utils/timelineScale";
import ScrollRegion from "./ScrollRegion";
import TableDisclosure from "./TableDisclosure";

const NO_WRAP = { whiteSpace: "nowrap" } as const;
const TABLE_MAX_HEIGHT = 420;

/** "W05 · 2027-02-01": the ISO week number and its Monday (the date sorts and is what the strip positions). */
const weekLabel = (weekStart: string) => `W${String(isoWeekOf(toEpochDay(weekStart)).week).padStart(2, "0")} · ${weekStart}`;

/** Man-days with their two decimals, the figure the server flags on ("4.80", never "4.8"). */
const md = (value: number) => value.toFixed(2);

/**
 * A week's verdicts as words — never colour alone: ORANGE "Overloaded · +2.50 MD" and/or ORANGE "Over WIP limit" (both warnings, nothing
 * moves), else a gray "OK" or, when the team has no capacity yet that week, a gray "No capacity". A week the server marks `flowCapacity`
 * (1.9: an open Flow capacity deviation's held days meet it) adds "Differs from Flow" beside the verdict — orange for WARNING, gray for INFO.
 */
function Status({ week }: { week: WeekLoad }) {
  const { t } = useTranslation();
  const warned = week.overloaded || week.wipExceeded;
  return (
    <Group gap={6} wrap="nowrap">
      {week.overloaded && (
        // miw max-content: a badge shrinks (and clips its sentence with an ellipsis) when the table is tight; the column grows instead.
        <Badge color="orange" variant="light" tt="none" miw="max-content">
          {t("teams.view.status.overloaded", { md: md(week.overloadMd ?? week.load - (week.capacity ?? 0)) })}
        </Badge>
      )}
      {week.wipExceeded && (
        <Badge color="orange" variant="light" tt="none" miw="max-content">
          {t("teams.view.status.wipExceeded")}
        </Badge>
      )}
      {!warned && (
        <Badge color="gray" variant="light" tt="none" miw="max-content">
          {t(week.capacity === null ? "teams.view.status.noCapacity" : "teams.view.status.ok")}
        </Badge>
      )}
      {week.flowCapacity != null && (
        <Badge color={week.flowCapacity === "WARNING" ? "orange" : "gray"} variant="light" tt="none" miw="max-content" data-flow-badge={week.flowCapacity}>
          {t("teams.view.status.flowCapacity")}
        </Badge>
      )}
    </Group>
  );
}

/** Another wording and heading level for the same table (the cross-team page's per-team "proposed load", an h4 under the team's h3). */
export type WeeklyLoadLabels = { title: string; intro: string; aria: string; headingOrder: 3 | 4; showLabel: string; hideLabel: string };

/**
 * The Weekly load section: the ACCESSIBLE surface of the Timeline's decorative strip. One row per ISO week the view lists — the load, the
 * capacity ("—" before the team has one), the peak of milestones in progress and the verdict — behind a disclosure (a long plan runs to
 * hundreds of weeks). The intro is the strip's legend.
 */
export default function TeamWeeklyLoad({ weeks, truncated, labels }: { weeks: readonly WeekLoad[]; truncated: boolean; labels?: WeeklyLoadLabels }) {
  const { t } = useTranslation();
  const aria = labels?.aria ?? t("teams.view.weeklyAria");
  return (
    <Stack gap="xs">
      <Title order={labels?.headingOrder ?? 3} size="h4">
        {labels?.title ?? t("teams.view.weeklyTitle")}
      </Title>
      <Text size="sm" c="dimmed">
        {labels?.intro ?? t("teams.view.weeklyIntro")}
      </Text>
      {weeks.length === 0 ? (
        <Text c="dimmed">{t("teams.view.weeklyEmpty")}</Text>
      ) : (
        <TableDisclosure showLabel={labels?.showLabel ?? t("teams.view.showWeekly")} hideLabel={labels?.hideLabel ?? t("teams.view.hideWeekly")}>
          <Stack gap="xs">
            {truncated && (
              <Text size="sm" c="dimmed">
                {t("teams.view.weeklyTruncated", { count: weeks.length })}
              </Text>
            )}
            <ScrollRegion label={aria} minWidth={560} maxHeight={TABLE_MAX_HEIGHT}>
              <Table aria-label={aria} stickyHeader>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>{t("teams.view.week")}</Table.Th>
                    <Table.Th>{t("teams.view.load")}</Table.Th>
                    <Table.Th>{t("teams.view.capacity")}</Table.Th>
                    <Table.Th>{t("teams.view.wip")}</Table.Th>
                    <Table.Th>{t("teams.view.statusColumn")}</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {weeks.map((week) => (
                    <Table.Tr key={week.weekStart}>
                      <Table.Td style={NO_WRAP}>{weekLabel(week.weekStart)}</Table.Td>
                      <Table.Td>{md(week.load)}</Table.Td>
                      <Table.Td>{week.capacity === null ? "—" : md(week.capacity)}</Table.Td>
                      <Table.Td>{week.maxWip}</Table.Td>
                      <Table.Td style={NO_WRAP}>
                        <Status week={week} />
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </ScrollRegion>
          </Stack>
        </TableDisclosure>
      )}
    </Stack>
  );
}
