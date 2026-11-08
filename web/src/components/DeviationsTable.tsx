import { Link as RouterLink } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Anchor, Badge, Stack, Table, Text } from "@mantine/core";
import type { DeviationConnection, DeviationItem } from "../api/deviations";
import type { Acknowledge } from "../hooks/useAcknowledge";
import { ageText, deviationKindLabel, deviationSentence } from "../utils/deviations";
import { formatDateTime } from "../utils/formatDate";
import { projectPath } from "../utils/planLinks";
import DeviationAckCell from "./DeviationAckCell";
import JiraKeyLink from "./JiraKeyLink";
import JiraRollupText from "./JiraRollupText";
import ScrollRegion from "./ScrollRegion";
import SeverityBadge from "./SeverityBadge";

const levelWord = (kind: DeviationItem["level"]) => `jira.mapping.level.${kind.toLowerCase() as "program" | "project" | "milestone"}` as const;

/** The plan node's name (a project's, and a milestone's through its project, link to the project page; a program has no page) and where it sits. */
function PlanCell({ item }: { item: DeviationItem }) {
  const { t } = useTranslation();
  const { node } = item;
  const context = [node.kind === "MILESTONE" ? node.projectName : null, node.kind === "PROGRAM" ? null : node.programName, node.workStreamName].filter((part): part is string => Boolean(part)).join(" · ");
  return (
    <>
      {node.kind === "PROJECT" ? (
        <Anchor component={RouterLink} to={projectPath(node.id)} size="sm" fw={500} aria-label={t("deviations.node.openProjectAria", { name: node.name })}>
          {node.name}
        </Anchor>
      ) : node.kind === "MILESTONE" && node.projectId !== null ? (
        <Anchor component={RouterLink} to={projectPath(node.projectId)} size="sm" fw={500} aria-label={t("deviations.node.openMilestoneAria", { name: node.name, project: node.projectName ?? "" })}>
          {node.name}
        </Anchor>
      ) : (
        <Text size="sm" fw={500}>
          {node.name}
        </Text>
      )}
      <Text size="xs" c="dimmed">
        {t(levelWord(item.level))}
        {node.teamName ? ` · ${t("deviations.node.team", { name: node.teamName })}` : ""}
      </Text>
      {context !== "" && (
        <Text size="xs" c="dimmed">
          {context}
        </Text>
      )}
    </>
  );
}

/** The Jira item as last read: the key (an external link), its type and status, the summary - and whether it is gone or its connection is disabled (both leave the figures stale). */
function JiraCell({ item, connection, showConnection }: { item: DeviationItem; connection: DeviationConnection | undefined; showConnection: boolean }) {
  const { t } = useTranslation();
  const { jira } = item;
  const meta = [jira.typeName, jira.statusName].filter((part): part is string => Boolean(part)).join(" · ");
  return (
    <>
      <Text size="sm" fw={500}>
        <JiraKeyLink issueKey={jira.key} siteUrl={connection?.siteUrl} underline="always" />
      </Text>
      {jira.summary && (
        <Text size="xs" lineClamp={2} title={jira.summary}>
          {jira.summary}
        </Text>
      )}
      {meta !== "" && (
        <Text size="xs" c="dimmed">
          {meta}
        </Text>
      )}
      {jira.rollup !== null && (
        <div>
          <JiraRollupText rollup={jira.rollup} />
        </div>
      )}
      {showConnection && connection && (
        <Text size="xs" c="dimmed">
          {connection.name}
        </Text>
      )}
      {jira.gone && (
        <Badge color="orange" variant="light" tt="none" mt={2}>
          {t("deviations.jira.gone")}
        </Badge>
      )}
      {connection && !connection.enabled && (
        <Badge color="gray" variant="light" tt="none" mt={2}>
          {t("deviations.jira.connectionDisabled")}
        </Badge>
      )}
    </>
  );
}

/** "Plan 2044-03-07 → 2044-03-10", "Jira …" and, for a project that deviates from Jira's project dates, its target window. An absent side is "no dates", never a made-up date. */
function DatesCell({ item }: { item: DeviationItem }) {
  const { t } = useTranslation();
  const range = (start: string | null, end: string | null) => (start === null && end === null ? t("deviations.dates.none") : `${start ?? "…"} → ${end ?? "…"}`);
  const lines = [
    { key: "plan", label: t("deviations.dates.plan"), text: range(item.plan.start, item.plan.end) },
    { key: "jira", label: t("deviations.dates.jira"), text: range(item.jira.start, item.jira.end) },
    ...(item.deviations.some((deviation) => deviation.kind === "TARGET_DIFFERS")
      ? [{ key: "target", label: t("deviations.dates.target"), text: range(item.plan.targetStart, item.plan.targetEnd) }]
      : []),
  ];
  return (
    <>
      {lines.map((line) => (
        <Text key={line.key} size="xs" style={{ whiteSpace: "nowrap" }}>
          <Text span c="dimmed">
            {line.label}{" "}
          </Text>
          {line.text}
        </Text>
      ))}
    </>
  );
}

/** Every deviation of the binding: the severity in words (never colour alone), a kind badge (orange warning, gray info) and the sentence. */
function DeviationsCell({ item }: { item: DeviationItem }) {
  const { t } = useTranslation();
  if (item.deviations.length === 0) {
    return (
      <Text size="sm" c="dimmed">
        {t("deviations.inLine")}
      </Text>
    );
  }
  return (
    <Stack gap={6}>
      {item.deviations.map((deviation) => (
        <div key={deviation.kind}>
          <SeverityBadge severity={deviation.severity} mr={6}>
            {deviationKindLabel(deviation.kind, t)}
          </SeverityBadge>
          <Text span size="sm">
            {deviationSentence(deviation, item, t)}
          </Text>
        </div>
      ))}
    </Stack>
  );
}

/**
 * The differences list: one row per linked plan node with its Jira item, both sides' dates, every deviation of the binding and how long ago the server
 * last READ the item from Jira (`observedAt` - not when it was linked; a disabled connection or a gone item is marked stale). Unpaged: the view is
 * capped at 2,000 items by the server. In a focusable scroll region so it reads at a phone's width. The last column is the acknowledgement
 * (`DeviationAckCell`); `ack` is the page's `useAcknowledge`.
 */
export default function DeviationsTable({ items, connections, now, ack }: { items: readonly DeviationItem[]; connections: readonly DeviationConnection[]; now: number; ack: Acknowledge }) {
  const { t } = useTranslation();
  const label = t("deviations.list.tableAria");
  const byId = new Map(connections.map((connection) => [connection.id, connection]));
  return (
    <ScrollRegion label={label} minWidth={1180}>
      <Table aria-label={label}>
        <Table.Thead>
          <Table.Tr>
            <Table.Th miw={190}>{t("deviations.column.planItem")}</Table.Th>
            <Table.Th miw={200}>{t("deviations.column.jira")}</Table.Th>
            <Table.Th miw={190}>{t("deviations.column.dates")}</Table.Th>
            <Table.Th miw={340}>{t("deviations.column.deviations")}</Table.Th>
            <Table.Th miw={120}>{t("deviations.column.observed")}</Table.Th>
            <Table.Th miw={180}>{t("deviations.column.acknowledgement")}</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {items.map((item, index) => {
            const connection = byId.get(item.connectionId);
            const stale = item.jira.gone || connection?.enabled === false;
            return (
              <Table.Tr key={item.bindingId}>
                <Table.Td>
                  <PlanCell item={item} />
                </Table.Td>
                <Table.Td>
                  <JiraCell item={item} connection={connection} showConnection={connections.length > 1} />
                </Table.Td>
                <Table.Td>
                  <DatesCell item={item} />
                </Table.Td>
                <Table.Td>
                  <DeviationsCell item={item} />
                </Table.Td>
                <Table.Td>
                  {item.jira.observedAt === null ? (
                    <Text size="sm" c="dimmed">
                      {t("deviations.jira.notRead")}
                    </Text>
                  ) : (
                    <Text size="sm" title={formatDateTime(item.jira.observedAt)}>
                      {ageText(item.jira.observedAt, now, t)}
                      {stale ? ` · ${t("deviations.observed.stale")}` : ""}
                    </Text>
                  )}
                </Table.Td>
                <Table.Td>
                  <DeviationAckCell item={item} ack={ack} neighbours={[items[index + 1]?.bindingId, items[index - 1]?.bindingId].filter((id) => id !== undefined)} />
                </Table.Td>
              </Table.Tr>
            );
          })}
        </Table.Tbody>
      </Table>
    </ScrollRegion>
  );
}
