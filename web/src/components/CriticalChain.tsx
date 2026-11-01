import { Anchor, Stack, Table, Text, Title } from "@mantine/core";
import { Link as RouterLink } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { ProjectView, UpstreamEntity } from "../api/milestones";
import { projectPath } from "../utils/planLinks";
import { chainEntries } from "../utils/projectDependencies";
import ScrollRegion from "./ScrollRegion";
import TableDisclosure from "./TableDisclosure";

const NO_WRAP = { whiteSpace: "nowrap" } as const;
const TABLE_MAX_HEIGHT = 420;

/** One table of upstream entries (the server's order): hops, the name as the way into its project, kind, project, dates, slack. */
function UpstreamTable({ entries, label, stickyHeader }: { entries: readonly UpstreamEntity[]; label: string; stickyHeader?: boolean }) {
  const { t } = useTranslation();
  return (
    <ScrollRegion label={label} minWidth={720} maxHeight={TABLE_MAX_HEIGHT}>
      <Table aria-label={label} stickyHeader={stickyHeader}>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t("project.critical.column.hops")}</Table.Th>
            <Table.Th>{t("project.critical.column.name")}</Table.Th>
            <Table.Th>{t("project.critical.column.kind")}</Table.Th>
            <Table.Th>{t("project.critical.column.project")}</Table.Th>
            <Table.Th>{t("project.critical.column.dates")}</Table.Th>
            <Table.Th>{t("project.critical.column.slack")}</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {entries.map((entry) => (
            <Table.Tr key={`${entry.kind}:${entry.id}`}>
              <Table.Td>{entry.hops}</Table.Td>
              <Table.Td>
                {/* The accessible name keeps the visible text and says where the link goes (label-content-name-mismatch), like a ghost row's. */}
                <Anchor component={RouterLink} to={projectPath(entry.projectId)} aria-label={t("project.ghostLinkAria", { text: entry.name, project: entry.projectName })}>
                  {entry.name}
                </Anchor>
              </Table.Td>
              <Table.Td>{t(`project.dependency.kind.${entry.kind}`)}</Table.Td>
              <Table.Td>{entry.projectName}</Table.Td>
              <Table.Td style={NO_WRAP}>{t("project.critical.span", { start: entry.startDate, end: entry.endDate })}</Table.Td>
              <Table.Td style={NO_WRAP}>{t("project.critical.slackDays", { count: entry.slackDays })}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </ScrollRegion>
  );
}

/**
 * The Critical chain section of the project page (v0.7, mounted only while the critical-path toggle is on): the ACCESSIBLE surface of the
 * chain beyond the direct neighbours. The server's `criticalPath.upstream` minus the entities already drawn as ghost rows (by kind + id; the
 * rows show their own slack), in the server's order: "On the chain" = the zero-slack members from the chain's origin, "Upstream with slack"
 * (behind a disclosure) = the rest by slack, with a note (counting the rows listed) when the server cut it at its cap. Information only; nothing moves.
 */
export default function CriticalChain({ view }: { view: ProjectView }) {
  const { t } = useTranslation();
  const { onChain, withSlack } = chainEntries(view);
  const { upstreamTruncated } = view.criticalPath;
  // "Empty" means two things: no critical member upstream at all (the chain lies inside this project), or every one is a neighbour already drawn as a ghost row.
  const neighboursOnly = onChain.length === 0 && view.criticalPath.upstream.some((entry) => entry.critical);
  return (
    <Stack gap="xs">
      <Title order={3} size="h4">
        {t("project.critical.title")}
      </Title>
      <Text size="sm" c="dimmed">
        {t("project.critical.intro")}
      </Text>
      <Text size="sm" fw={600}>
        {t("project.critical.onChain")}
      </Text>
      {onChain.length === 0 ? <Text c="dimmed">{t(neighboursOnly ? "project.critical.emptyNeighbours" : "project.critical.empty")}</Text> : <UpstreamTable entries={onChain} label={t("project.critical.onChainAria")} />}
      <Text size="sm" fw={600}>
        {t("project.critical.withSlack")}
      </Text>
      {withSlack.length === 0 ? (
        <Text c="dimmed">{t("project.critical.emptySlack")}</Text>
      ) : (
        <TableDisclosure showLabel={t("project.critical.show")} hideLabel={t("project.critical.hide")}>
          <UpstreamTable entries={withSlack} label={t("project.critical.withSlackAria")} stickyHeader />
        </TableDisclosure>
      )}
      {upstreamTruncated && (
        <Text size="sm" c="dimmed">
          {withSlack.length === 0 ? t("project.critical.truncatedNone") : t("project.critical.truncated", { count: withSlack.length })}
        </Text>
      )}
    </Stack>
  );
}
