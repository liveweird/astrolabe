import { Stack, Text, Title } from "@mantine/core";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { ProjectView, UpstreamEntity } from "../api/milestones";
import { projectPath } from "../utils/planLinks";
import { chainEntries } from "../utils/projectDependencies";
import TableDisclosure from "./TableDisclosure";
import UpstreamTable, { type UpstreamRow } from "./UpstreamTable";

/** The server's upstream entries as the shared table's rows: the name links into the entity's own project. */
function rowsOf(entries: readonly UpstreamEntity[], t: TFunction): UpstreamRow[] {
  return entries.map((entry) => ({
    key: `${entry.kind}:${entry.id}`,
    hops: entry.hops,
    name: entry.name,
    to: projectPath(entry.projectId),
    ariaLabel: t("project.ghostLinkAria", { text: entry.name, project: entry.projectName }),
    kind: t(`project.dependency.kind.${entry.kind}`),
    context: entry.projectName,
    startDate: entry.startDate,
    endDate: entry.endDate,
    slackDays: entry.slackDays,
    critical: entry.critical,
  }));
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
      {onChain.length === 0 ? <Text c="dimmed">{t(neighboursOnly ? "project.critical.emptyNeighbours" : "project.critical.empty")}</Text> : <UpstreamTable rows={rowsOf(onChain, t)} label={t("project.critical.onChainAria")} contextHeader={t("project.critical.column.project")} kindColumn />}
      <Text size="sm" fw={600}>
        {t("project.critical.withSlack")}
      </Text>
      {withSlack.length === 0 ? (
        <Text c="dimmed">{t("project.critical.emptySlack")}</Text>
      ) : (
        <TableDisclosure showLabel={t("project.critical.show")} hideLabel={t("project.critical.hide")}>
          <UpstreamTable rows={rowsOf(withSlack, t)} label={t("project.critical.withSlackAria")} contextHeader={t("project.critical.column.project")} kindColumn stickyHeader />
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
