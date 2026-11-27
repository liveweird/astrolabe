import { Stack, Table, Text, Title } from "@mantine/core";
import { useTranslation } from "react-i18next";
import type { WeekLoad } from "../api/teams";
import type { WeeklyLoadArrival } from "../hooks/useWeeklyLoadArrival";
import ScrollRegion from "./ScrollRegion";
import TableDisclosure from "./TableDisclosure";
import classes from "../theme.module.css";
import { mdText, weekLabel } from "../utils/weekLoadText";
import { WeekStatus } from "./WeekLoadCells";

const NO_WRAP = { whiteSpace: "nowrap" } as const;
const TABLE_MAX_HEIGHT = 420;

/** Another wording and heading level for the same table (the cross-team page's per-team "proposed load", an h4 under the team's h3). */
export type WeeklyLoadLabels = { title: string; intro: string; aria: string; headingOrder: 3 | 4; showLabel: string; hideLabel: string };

/**
 * The Weekly load section: the ACCESSIBLE surface of the Timeline's decorative strip. One row per ISO week the view lists — the load, the
 * capacity ("—" before the team has one), the peak of milestones in progress and the verdict — behind a disclosure (a long plan runs to
 * hundreds of weeks). The intro is the strip's legend. `arrival` (the team page's, 1.36: `useWeeklyLoadArrival`) hands the disclosure's state to the
 * page, so an address can open it, focus the table (or the heading while there is none) and mark the week it names (`marked`: `aria-current`, `.rowCurrent`); without it the disclosure is the section's own, closed at first.
 */
export default function TeamWeeklyLoad({
  weeks,
  truncated,
  labels,
  arrival,
}: {
  weeks: readonly WeekLoad[];
  truncated: boolean;
  labels?: WeeklyLoadLabels;
  arrival?: WeeklyLoadArrival;
}) {
  const { t } = useTranslation();
  const aria = labels?.aria ?? t("teams.view.weeklyAria");
  return (
    <Stack gap="xs">
      <Title order={labels?.headingOrder ?? 3} size="h4" ref={arrival?.headingRef} tabIndex={arrival === undefined ? undefined : -1}>
        {labels?.title ?? t("teams.view.weeklyTitle")}
      </Title>
      <Text size="sm" c="dimmed">
        {labels?.intro ?? t("teams.view.weeklyIntro")}
      </Text>
      {weeks.length === 0 ? (
        <Text c="dimmed">{t("teams.view.weeklyEmpty")}</Text>
      ) : (
        <TableDisclosure open={arrival?.open} onOpenChange={arrival?.onOpenChange} showLabel={labels?.showLabel ?? t("teams.view.showWeekly")} hideLabel={labels?.hideLabel ?? t("teams.view.hideWeekly")}>
          <Stack gap="xs">
            {truncated && (
              <Text size="sm" c="dimmed">
                {t("teams.view.weeklyTruncated", { count: weeks.length })}
              </Text>
            )}
            <ScrollRegion label={aria} minWidth={560} maxHeight={TABLE_MAX_HEIGHT} scrollRef={arrival?.regionRef}>
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
                    <Table.Tr
                      key={week.weekStart}
                      data-load-week={week.weekStart}
                      className={week.weekStart === arrival?.marked ? classes.rowCurrent : undefined}
                      aria-current={week.weekStart === arrival?.marked ? "true" : undefined}
                    >
                      <Table.Td style={NO_WRAP}>{weekLabel(week.weekStart)}</Table.Td>
                      <Table.Td>{mdText(week.load)}</Table.Td>
                      <Table.Td>{week.capacity === null ? "—" : mdText(week.capacity)}</Table.Td>
                      <Table.Td>{week.maxWip}</Table.Td>
                      <Table.Td style={NO_WRAP}>
                        <WeekStatus week={week} />
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
