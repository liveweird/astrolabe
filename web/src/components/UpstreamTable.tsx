import { Anchor, Badge, Table, Text } from "@mantine/core";
import { Link as RouterLink } from "react-router-dom";
import { useTranslation } from "react-i18next";
import ScrollRegion from "./ScrollRegion";

const NO_WRAP = { whiteSpace: "nowrap" } as const;
const TABLE_MAX_HEIGHT = 420;

/**
 * One row of the upstream table, already phrased by the page: the project page's rows are the server's milestones and projects upstream of one
 * project's end (`UpstreamEntity`), the roadmap's are the projects upstream of the picked target (`RoadmapCriticalProject`). The server's figures
 * (hops, slack, `critical`) are carried through as they came.
 */
export type UpstreamRow = {
  key: string;
  hops: number;
  /** The visible text of the link into the project. */
  name: string;
  to: string;
  /** The link's accessible name; it keeps the visible text. */
  ariaLabel: string;
  /** The "Kind" column's text (only when the table has that column). */
  kind?: string;
  /** The context column's text: the project of a milestone (project page), the program of a project (roadmap). */
  context: string;
  startDate: string | null;
  endDate: string | null;
  slackDays: number;
  critical: boolean;
  /** A dimmed note after the name (the roadmap's "(not shown)"). */
  note?: string;
};

/**
 * The upstream table shared by the project page's Critical chain and the roadmap's panel (1.7): hops, the name as the way into its project, the optional
 * kind, a context column (`contextHeader`), dates, slack and, with `chainBadge`, a column whose "On the chain" badge marks a zero-slack row (never colour
 * alone). Rows keep the order they come in.
 */
export default function UpstreamTable({
  rows,
  label,
  contextHeader,
  kindColumn = false,
  chainBadge = false,
  stickyHeader,
}: {
  rows: readonly UpstreamRow[];
  label: string;
  contextHeader: string;
  kindColumn?: boolean;
  chainBadge?: boolean;
  stickyHeader?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <ScrollRegion label={label} minWidth={720} maxHeight={TABLE_MAX_HEIGHT}>
      <Table aria-label={label} stickyHeader={stickyHeader}>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t("project.critical.column.hops")}</Table.Th>
            <Table.Th>{t("project.critical.column.name")}</Table.Th>
            {kindColumn && <Table.Th>{t("project.critical.column.kind")}</Table.Th>}
            <Table.Th>{contextHeader}</Table.Th>
            <Table.Th>{t("project.critical.column.dates")}</Table.Th>
            <Table.Th>{t("project.critical.column.slack")}</Table.Th>
            {chainBadge && <Table.Th>{t("project.critical.column.chain")}</Table.Th>}
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {rows.map((row) => (
            <Table.Tr key={row.key}>
              <Table.Td>{row.hops}</Table.Td>
              <Table.Td>
                {/* The accessible name keeps the visible text and says where the link goes (label-content-name-mismatch), like a ghost row's. */}
                <Anchor component={RouterLink} to={row.to} aria-label={row.ariaLabel}>
                  {row.name}
                </Anchor>
                {row.note !== undefined && (
                  <Text span size="sm" c="dimmed">
                    {" "}
                    {row.note}
                  </Text>
                )}
              </Table.Td>
              {kindColumn && <Table.Td>{row.kind}</Table.Td>}
              <Table.Td>{row.context}</Table.Td>
              <Table.Td style={NO_WRAP}>{row.startDate === null || row.endDate === null ? "—" : t("project.critical.span", { start: row.startDate, end: row.endDate })}</Table.Td>
              <Table.Td style={NO_WRAP}>{t("project.critical.slackDays", { count: row.slackDays })}</Table.Td>
              {chainBadge && (
                <Table.Td>
                  {row.critical && (
                    <Badge color="gray" variant="light" tt="none">
                      {t("project.critical.onChain")}
                    </Badge>
                  )}
                </Table.Td>
              )}
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </ScrollRegion>
  );
}
