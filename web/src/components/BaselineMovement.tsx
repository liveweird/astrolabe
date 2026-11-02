import { useState } from "react";
import { Anchor, Group, Stack, Switch, Table, Text, Title, VisuallyHidden } from "@mantine/core";
import { Link as RouterLink } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { estimateText } from "../utils/baselineCompare";
import { movementRows, movementTotalsOf, rowChanged, signedDays, type LiveMilestone, type MilestoneBaseline } from "../utils/baselineOverlay";
import { projectPath } from "../utils/planLinks";
import { Figures, StatusBadge, TotalsBadges } from "./BaselineParts";
import ScrollRegion from "./ScrollRegion";
import TableDisclosure from "./TableDisclosure";

const NO_WRAP = { whiteSpace: "nowrap" } as const;
const SHRINK = { width: 1, whiteSpace: "nowrap" } as const;
const TABLE_MAX_HEIGHT = 420;

/**
 * The Movement section of the project and the team page (v0.9, h3 after the Idle gaps): the ACCESSIBLE surface of the shadow bars. A first line with the
 * totals of the page's milestones against the baseline (ORANGE for those whose end is later), then - behind a disclosure, the Idle gaps shape - the
 * table: one row per milestone with its baseline and current dates, the signed WORKING-day start and end deltas (positive = later), the estimate
 * ("10 → 12.5") and the status badge ("Later" orange when the end is later, gray otherwise). "Changed only" is on by default; an estimate-only change
 * counts as a change. The team page (`scope="team"`) adds the Project column, and a milestone that moved to another team says where. The server's
 * figures are only read; the rows are the baseline's entries for the page's live milestones plus the ones gone from it (`movementRows`).
 */
export default function BaselineMovement({ baseline, live, scope }: { baseline: MilestoneBaseline; live: readonly LiveMilestone[]; scope: "project" | "team" }) {
  const { t } = useTranslation();
  const [changedOnly, setChangedOnly] = useState(true);
  const rows = movementRows(baseline, live);
  const shown = changedOnly ? rows.filter(rowChanged) : rows;
  const team = scope === "team";
  return (
    <Stack gap="xs">
      <Title order={3} size="h4">
        {t("timeline.baseline.movement.title", { name: baseline.name })}
      </Title>
      <Text size="sm" c="dimmed">
        {t("timeline.baseline.movement.intro")}
      </Text>
      <TotalsBadges totals={movementTotalsOf(rows.map((row) => row.movement))} estimateOnly={rows.filter((row) => row.status.key === "estimate").length} />
      <TableDisclosure showLabel={t("timeline.baseline.movement.show")} hideLabel={t("timeline.baseline.movement.hide")}>
        <Stack gap="xs">
          <Group>
            <Switch label={t("timeline.baseline.movement.changedOnly")} checked={changedOnly} onChange={(event) => setChangedOnly(event.currentTarget.checked)} />
          </Group>
          {shown.length === 0 ? (
            <Text c="dimmed">{t(rows.length === 0 ? "timeline.baseline.movement.empty" : "timeline.baseline.movement.emptyChanged")}</Text>
          ) : (
            <ScrollRegion label={t("timeline.baseline.movement.tableAria")} minWidth={team ? 1000 : 880} maxHeight={TABLE_MAX_HEIGHT}>
              <Table aria-label={t("timeline.baseline.movement.tableAria")} stickyHeader>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>{t("timeline.baseline.movement.column.milestone")}</Table.Th>
                    {team && <Table.Th>{t("timeline.baseline.movement.column.project")}</Table.Th>}
                    <Table.Th>{t("timeline.baseline.movement.column.baseline")}</Table.Th>
                    <Table.Th>{t("timeline.baseline.movement.column.current")}</Table.Th>
                    <Table.Th ta="right">
                      {t("timeline.baseline.movement.column.start")}
                      <VisuallyHidden> {t("baselines.compare.column.workingDays")}</VisuallyHidden>
                    </Table.Th>
                    <Table.Th ta="right">
                      {t("timeline.baseline.movement.column.end")}
                      <VisuallyHidden> {t("baselines.compare.column.workingDays")}</VisuallyHidden>
                    </Table.Th>
                    <Table.Th>{t("timeline.baseline.movement.column.estimate")}</Table.Th>
                    <Table.Th style={SHRINK}>{t("timeline.baseline.movement.column.status")}</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {shown.map((row) => (
                    <Table.Tr key={row.key}>
                      <Table.Td>{row.name}</Table.Td>
                      {team && (
                        <Table.Td>
                          {row.projectName !== null && (
                            <Anchor component={RouterLink} to={projectPath(row.projectId)} size="sm" aria-label={t("teams.view.openProjectAria", { name: row.projectName })}>
                              {row.projectName}
                            </Anchor>
                          )}
                        </Table.Td>
                      )}
                      <Table.Td>
                        <Figures figures={row.frozen} />
                      </Table.Td>
                      <Table.Td>{row.movedTo === null ? <Figures figures={row.live} /> : t("timeline.baseline.movedTo", { team: row.movedTo })}</Table.Td>
                      <Table.Td ta="right">{signedDays(row.movement.startDays)}</Table.Td>
                      <Table.Td ta="right">{signedDays(row.movement.endDays)}</Table.Td>
                      <Table.Td style={NO_WRAP}>{estimateText(row)}</Table.Td>
                      <Table.Td style={SHRINK}>
                        <StatusBadge status={row.status} />
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </ScrollRegion>
          )}
        </Stack>
      </TableDisclosure>
    </Stack>
  );
}
